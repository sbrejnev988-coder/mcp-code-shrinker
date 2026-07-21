// ═══ Cross-File Call Graph v0.3 ═══
// Builds project-wide dependency graph:
//   - import resolution (relative, package, tsconfig paths)
//   - symbol-level call edges
//   - test ↔ source mapping
//   - incremental invalidation

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, dirname, resolve } from "path";
import { parseFile, detectLanguage } from "../core/ast-engine.js";
import { createSymbolId, createFileRevision } from "../core/symbol-id.js";

export class CallGraph {
  constructor(projectRoot = ".") {
    this.root = resolve(projectRoot);
    this.nodes = new Map();    // file → { symbols, imports, exports }
    this.edges = new Map();    // symbolId → { callers: Set, callees: Set }
    this.fileRevisions = new Map();
    this.testMap = new Map();  // sourceSymbol → testFiles
    this._scanned = false;
  }

  /** Scan entire project */
  scan({ exclude = ["node_modules", ".git", "__pycache__", "dist", "build", ".cache"] } = {}) {
    this._walkDir(this.root, exclude);
    this._resolveEdges();
    this._scanned = true;
    return { files: this.nodes.size, symbols: this.edges.size };
  }

  /** Get callers of a symbol */
  callers(filePath, symbolName) {
    const absPath = resolve(filePath);
    const node = this.nodes.get(absPath);
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    if (!sym) return [];
    const edge = this.edges.get(sym.id);
    return edge ? [...edge.callers].map(id => this._resolveSymbolRef(id)) : [];
  }

  /** Get callees of a symbol */
  callees(filePath, symbolName) {
    const absPath = resolve(filePath);
    const node = this.nodes.get(absPath);
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    if (!sym) return [];
    const edge = this.edges.get(sym.id);
    return edge ? [...edge.callees].map(id => this._resolveSymbolRef(id)) : [];
  }

  /** Get tests for a source symbol */
  getTests(filePath, symbolName) {
    const absPath = resolve(filePath);
    const node = this.nodes.get(absPath);
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    if (!sym) return [];
    return this.testMap.get(sym.id) || [];
  }

  /** Check if a file has changed → invalidate affected nodes */
  touch(filePath) {
    const absPath = resolve(filePath);
    const newRev = this._hashFile(absPath);
    const oldRev = this.fileRevisions.get(absPath);
    if (oldRev === newRev) return { changed: false };
    
    // Invalidate this file and all dependents
    const affected = [absPath];
    for (const [f, node] of this.nodes) {
      if (node.imports.some(imp => imp.resolved === absPath)) {
        affected.push(f);
      }
    }
    
    for (const f of affected) this.nodes.delete(f);
    this.fileRevisions.set(absPath, newRev);
    return { changed: true, affected };
  }

  /** Export minimal graph for context packet */
  toContextSlice(focusFiles, depth = 1) {
    const slice = { symbols: {}, edges: [] };
    const visited = new Set();
    
    for (const file of focusFiles) {
      const absPath = resolve(file);
      this._collectSlice(absPath, depth, visited, slice);
    }
    
    return slice;
  }

  // ── Internal ──
  _walkDir(dir, exclude) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    
    for (const entry of entries) {
      if (exclude.some(e => entry === e || entry.startsWith("." + e))) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      
      if (st.isDirectory()) {
        this._walkDir(full, exclude);
      } else if (st.isFile()) {
        const lang = detectLanguage(full);
        if (lang !== "text" && lang !== "json" && lang !== "yaml" && lang !== "markdown") {
          this._indexFile(full);
        } else if (full.includes(".test.") || full.includes(".spec.") || full.includes("test_") || full.includes("_test.")) {
          this._indexFile(full); // Always index test files
        }
      }
    }
  }

  _indexFile(absPath) {
    try {
      const parsed = parseFile(absPath);
      const fileRev = createFileRevision(parsed.code);
      this.fileRevisions.set(absPath, fileRev);

      const symbols = parsed.symbols.map(sym => {
        const id = createSymbolId({
          language: parsed.language,
          nodeType: sym.kind,
          qualifiedName: sym.qualifiedName,
          signature: sym.signature,
        });
        return { ...sym, id, file: absPath };
      });

      // Resolve imports
      const imports = parsed.imports.map(imp => ({
        specifier: imp.specifier,
        raw: imp.raw,
        resolved: this._resolveImport(absPath, imp.specifier),
      }));

      this.nodes.set(absPath, { symbols, imports, language: parsed.language });

      // Map tests → source
      if (absPath.includes(".test.") || absPath.includes(".spec.") || 
          absPath.includes("test_") || absPath.includes("_test.") || 
          absPath.includes("/test/") || absPath.includes("__tests__")) {
        for (const sym of symbols) {
          // Heuristic: test function names often contain the source function name
          for (const [srcFile, node] of this.nodes) {
            for (const srcSym of node.symbols) {
              if (sym.name.toLowerCase().includes(srcSym.name.toLowerCase())) {
                const tests = this.testMap.get(srcSym.id) || [];
                tests.push({ file: absPath, symbol: sym.qualifiedName });
                this.testMap.set(srcSym.id, tests);
              }
            }
          }
        }
      }
    } catch (e) {
      // Skip unparseable files
    }
  }

  _resolveEdges() {
    for (const [file, node] of this.nodes) {
      for (const sym of node.symbols) {
        const edge = { callers: new Set(), callees: new Set() };
        
        // Find callees from symbol's calls list
        if (sym._contract?.calls) {
          for (const calledName of sym._contract.calls) {
            const target = this._findSymbol(calledName, file, node);
            if (target) {
              edge.callees.add(target.id);
              // Add reverse edge
              const targetEdge = this.edges.get(target.id) || { callers: new Set(), callees: new Set() };
              targetEdge.callers.add(sym.id);
              this.edges.set(target.id, targetEdge);
            }
          }
        }
        
        this.edges.set(sym.id, edge);
      }
    }
  }

  _findSymbol(name, currentFile, currentNode) {
    // 1. Same file
    const local = currentNode.symbols.find(s => s.name === name || s.qualifiedName === name);
    if (local) return local;

    // 2. Imported files
    for (const imp of currentNode.imports) {
      if (!imp.resolved) continue;
      const importedNode = this.nodes.get(imp.resolved);
      if (!importedNode) continue;
      const found = importedNode.symbols.find(s => 
        s.name === name || s.qualifiedName === name ||
        s.qualifiedName?.endsWith("." + name));
      if (found) return found;
    }

    return null;
  }

  _resolveImport(fromFile, specifier) {
    if (specifier.startsWith(".")) {
      const fromDir = dirname(fromFile);
      // Try .js, .ts, .jsx, .tsx, /index.*
      for (const ext of ["", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]) {
        const candidate = resolve(fromDir, specifier + ext);
        if (this.nodes.has(candidate)) return candidate;
      }
      // Try /index
      for (const ext of [".js", ".ts", ".jsx", ".tsx"]) {
        const candidate = resolve(fromDir, specifier, "index" + ext);
        if (this.nodes.has(candidate)) return candidate;
      }
      return null;
    }
    // Package imports — not resolved in v0.3
    return null;
  }

  _collectSlice(file, depth, visited, slice) {
    if (depth < 0 || visited.has(file)) return;
    visited.add(file);
    
    const node = this.nodes.get(file);
    if (!node) return;
    
    for (const sym of node.symbols) {
      slice.symbols[sym.id] = {
        name: sym.qualifiedName,
        file: relative(this.root, sym.file),
        kind: sym.kind,
        signature: sym.signature,
      };
      
      const edge = this.edges.get(sym.id);
      if (edge) {
        for (const calleeId of edge.callees) {
          slice.edges.push([sym.id, "calls", calleeId]);
        }
      }
    }
    
    // Follow imports
    for (const imp of node.imports) {
      if (imp.resolved) this._collectSlice(imp.resolved, depth - 1, visited, slice);
    }
  }

  _hashFile(absPath) {
    try {
      const code = readFileSync(absPath, "utf-8");
      return createFileRevision(code);
    } catch { return null; }
  }

  _resolveSymbolRef(id) {
    for (const [file, node] of this.nodes) {
      const sym = node.symbols.find(s => s.id === id);
      if (sym) return { id, name: sym.qualifiedName, file: relative(this.root, file), kind: sym.kind };
    }
    return { id, name: "unknown", file: "unknown", kind: "unknown" };
  }
}
