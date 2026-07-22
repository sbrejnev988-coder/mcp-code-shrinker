// ═══ Project Graph v0.1.0 — Multi-type edges, import/export tracking, entrypoints ═══

import { readFileSync, readdirSync, lstatSync } from "fs";
import { join, relative, resolve, dirname, basename } from "path";
import { parseFile, detectLanguage, extractContract } from "../core/ast-engine.js";
import { createSymbolId, createFileRevision } from "../core/symbol-id.js";

// ═══ Edge types ═══
const EDGE_TYPES = {
  IMPORT:        "import",
  EXPORT:        "export",
  RE_EXPORT:     "re_export",
  CALLS:         "calls",
  INHERITS:      "inherits",
  IMPLEMENTS:    "implements",
  DECORATES:     "decorates",
  TYPE_REF:      "type_ref",
  READS:         "reads",
  WRITES:        "writes",
  CONFIG_REF:    "config_ref",
  TESTS:         "tests",
  ENTRYPOINT:    "entrypoint",
  PLUGIN_REG:    "plugin_reg",
  MCP_TOOL:      "mcp_tool",
};

const ENTRYPOINT_PATTERNS = [
  /^(index|main|app|server|cli|bin|entry|start|run)\.[jt]sx?$/,
  /\/bin\//, /\/cli\//, /\/scripts\//,
];

const TEST_PATTERNS = [
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /test_/, /_test\.py$/,
  /\/test\//, /\/tests\//, /\/__tests__\//,
];

const CONFIG_FILES = new Set([
  "package.json", "tsconfig.json", "pyproject.toml", "setup.py",
  "config.yaml", "config.yml", ".env.example", "jest.config.js",
]);

export class ProjectGraph {
  constructor(projectRoot = ".") {
    this.root = resolve(projectRoot);
    this.nodes = new Map();       // absPath → { symbols, language, exports, entrypoint }
    this.edges = new Map();       // symbolId → { callers, callees, importers, ... }
    this.fileRevisions = new Map();
    this.entrypoints = [];
    this.diagnostics = [];
    this._symIndex = new Map();   // qualifiedName → [symbolIds]
  }

  // ═══ Public API ═══

  scan(opts = {}) {
    this.diagnostics = [];
    const exclude = new Set(opts.exclude || [
      "node_modules", ".git", "__pycache__", "dist", "build",
      ".cache", ".next", ".nuxt", "coverage", "backups"
    ]);

    this._indexFiles(this.root, exclude);
    this._buildImports();
    this._buildContracts();
    this._buildAllEdges();
    this._detectEntrypoints();

    return {
      files: this.nodes.size,
      symbols: this.edges.size,
      entrypoints: this.entrypoints.length,
      diagnostics: this.diagnostics,
    };
  }

  callers(filePath, symbolName) {
    return this._queryEdge(filePath, symbolName, "callers");
  }

  callees(filePath, symbolName) {
    return this._queryEdge(filePath, symbolName, "callees");
  }

  imports(filePath, symbolName) {
    return this._queryEdge(filePath, symbolName, "importers");
  }

  exports(filePath) {
    const node = this.nodes.get(resolve(filePath));
    return node?.exports || [];
  }

  getSymbol(id) {
    return this._resolveRef(id);
  }

  getTests(filePath, symbolName) {
    const sym = this._findSymbol(filePath, symbolName);
    if (!sym) return [];
    const edge = this.edges.get(sym.id);
    return edge?.testers ? [...edge.testers].map(id => this._resolveRef(id)) : [];
  }

  toContextSlice(focusPaths, depth = 1) {
    const files = new Set();
    for (const p of focusPaths) {
      const rp = resolve(p);
      for (const [f] of this.nodes) {
        if (f === rp || f.startsWith(rp + "/")) files.add(f);
      }
    }
    const slice = { symbols: {}, edges: [] };
    const visited = new Set();
    for (const f of [...files].slice(0, 50)) this._collectSlice(f, depth, visited, slice);
    return slice;
  }

  // ═══ Private: Indexing ═══

  _indexFiles(dir, exclude) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (exclude.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { this._indexFiles(full, exclude); }
      else if (st.isFile()) {
        const lang = detectLanguage(full);
        if (lang === "text" && !CONFIG_FILES.has(basename(full))) {
          if (!TEST_PATTERNS.some(r => r.test(full))) continue;
        }
        this._indexFile(full, lang);
      }
    }
  }

  _indexFile(filePath, language) {
    try {
      const code = readFileSync(filePath, "utf-8");
      const parsed = parseFile(filePath);
      const symbols = (parsed.symbols || []).map(s => {
        const qname = s.qualifiedName || s.name;
        return {
          ...s,
          id: createSymbolId({
            repositoryId: this.root,
            relativePath: relative(this.root, filePath),
            language: language || parsed.language,
            qualifiedName: qname,
          }),
          repositoryId: this.root,
          relativePath: relative(this.root, filePath),
          language: language || parsed.language,
        };
      });

      const fileRev = createFileRevision(filePath, code);
      const isEntrypoint = ENTRYPOINT_PATTERNS.some(r => r.test(basename(filePath)));

      this.nodes.set(resolve(filePath), {
        symbols,
        language: language || parsed.language,
        fileRevision: fileRev.id,
        exports: symbols.filter(s => s.isExported).map(s => s.id),
        isEntrypoint,
      });

      for (const sym of symbols) {
        // Initialize edge container
        if (!this.edges.has(sym.id)) {
          this.edges.set(sym.id, {
            callers: new Set(), callees: new Set(),
            importers: new Set(), inheritors: new Set(),
            implementors: new Set(), decorators: new Set(),
            typeRefs: new Set(), readers: new Set(),
            writers: new Set(), testers: new Set(),
          });
        }
        // Name-based index
        const existing = this._symIndex.get(sym.qualifiedName) || [];
        existing.push(sym.id);
        this._symIndex.set(sym.qualifiedName, existing);
      }

      this.fileRevisions.set(resolve(filePath), fileRev);
    } catch (err) {
      this.diagnostics.push({ file: filePath, error: err.message });
    }
  }

  // ═══ Private: Import resolution ═══

  _buildImports() {
    for (const [filePath, node] of this.nodes) {
      for (const sym of node.symbols) {
        const contract = extractContract(sym, "", node.language);
        sym.contract = contract;
        sym.imports = this._resolveImports(contract?.imports || [], filePath);
      }
    }
  }

  _resolveImports(importList, filePath) {
    return importList.map(imp => {
      let resolved = null;
      try {
        const fromDir = dirname(filePath);
        let target = resolve(fromDir, imp.from || imp.path || "");
        if (!target.endsWith(".js") && !target.endsWith(".ts")) {
          for (const ext of [".js", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts"]) {
            const candidate = target + ext;
            if (this.nodes.has(candidate)) { target = candidate; break; }
          }
        }
        if (this.nodes.has(target)) resolved = target;
      } catch {}
      return { ...imp, resolvedFile: resolved, confidence: resolved ? 0.95 : 0.4 };
    });
  }

  _buildContracts() {
    for (const [filePath, node] of this.nodes) {
      const code = readFileSync(filePath, "utf-8");
      for (const sym of node.symbols) {
        const contract = extractContract(sym, code, node.language, this.nodes);
        sym.contract = contract;
      }
    }
  }

  // ═══ Private: Edge building ═══

  _buildAllEdges() {
    for (const [filePath, node] of this.nodes) {
      for (const sym of node.symbols) {
        const edge = this.edges.get(sym.id);
        if (!edge) continue;

        // Calls
        if (sym.contract?.calls?.length) {
          for (const calledName of sym.contract.calls) {
            const target = this._findSymbol(calledName, filePath, node);
            if (target && target.id !== sym.id) {
              edge.callees.add(target.id);
              const tEdge = this.edges.get(target.id);
              if (tEdge) tEdge.callers.add(sym.id);
            }
          }
        }

        // Inheritance (extends)
        if (sym.contract?.extends) {
          for (const extName of [sym.contract.extends].flat()) {
            const target = this._findSymbol(extName, filePath, node);
            if (target) {
              edge.callees.add(target.id); // inherits = callee edge
              const tEdge = this.edges.get(target.id);
              if (tEdge) tEdge.inheritors.add(sym.id);
            }
          }
        }

        // Implements
        if (sym.contract?.implements) {
          for (const implName of [sym.contract.implements].flat()) {
            const target = this._findSymbol(implName, filePath, node);
            if (target) {
              const tEdge = this.edges.get(target.id);
              if (tEdge) tEdge.implementors.add(sym.id);
            }
          }
        }
      }
    }

    // Test edges
    for (const [filePath, node] of this.nodes) {
      if (!TEST_PATTERNS.some(r => r.test(filePath))) continue;
      for (const sym of node.symbols) {
        if (sym.contract?.calls?.length) {
          for (const calledName of sym.contract.calls) {
            const target = this._findSymbol(calledName, filePath, node);
            if (target) {
              const tEdge = this.edges.get(target.id);
              if (tEdge) tEdge.testers.add(sym.id);
            }
          }
        }
      }
    }
  }

  _detectEntrypoints() {
    this.entrypoints = [];
    for (const [filePath, node] of this.nodes) {
      if (node.isEntrypoint) {
        this.entrypoints.push({
          file: relative(this.root, filePath),
          id: createSymbolId({ repositoryId: this.root, relativePath: relative(this.root, filePath), qualifiedName: "entrypoint" }),
          symbols: node.symbols.filter(s => s.isExported).map(s => s.id),
        });
      }
    }
  }

  // ═══ Private: Helpers ═══

  _findSymbol(name, currentFile, currentNode) {
    if (!name) return null;
    // Try same file first
    const local = currentNode.symbols.find(s => s.qualifiedName === name || s.name === name);
    if (local) return local;

    // Try name-based index across all files
    const matches = this._symIndex.get(name) || [];
    for (const id of matches) {
      const ref = this._resolveRef(id);
      if (ref) return ref;
    }
    return null;
  }

  _resolveRef(id) {
    for (const [filePath, node] of this.nodes) {
      const sym = node.symbols.find(s => s.id === id);
      if (sym) return {
        id, name: sym.name, qualifiedName: sym.qualifiedName,
        kind: sym.kind, file: relative(this.root, filePath),
        startLine: sym.startLine, endLine: sym.endLine,
        language: node.language, isExported: sym.isExported,
      };
    }
    return { id, name: "?", qualifiedName: "?", kind: "unknown", file: "?" };
  }

  _queryEdge(filePath, symbolName, edgeType) {
    const node = this.nodes.get(resolve(filePath));
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    if (!sym) return [];
    const edge = this.edges.get(sym.id);
    return edge?.[edgeType] ? [...edge[edgeType]].map(id => this._resolveRef(id)) : [];
  }

  _collectSlice(filePath, depth, visited, slice) {
    if (visited.has(filePath) || depth < 0) return;
    visited.add(filePath);
    const node = this.nodes.get(filePath);
    if (!node) return;
    for (const sym of node.symbols) {
      slice.symbols[sym.id] = {
        name: sym.qualifiedName, kind: sym.kind, file: relative(this.root, filePath),
      };
      const edge = this.edges.get(sym.id);
      if (edge && depth > 0) {
        slice.edges.push({
          from: sym.id,
          callees: [...edge.callees].slice(0, 20),
          callers: [...edge.callers].length,
          inheritors: [...edge.inheritors].length,
        });
        for (const calleeId of edge.callees) {
          const callee = this._resolveRef(calleeId);
          if (callee.file) this._collectSlice(resolve(this.root, callee.file), depth - 1, visited, slice);
        }
      }
    }
  }
}

export { EDGE_TYPES };
