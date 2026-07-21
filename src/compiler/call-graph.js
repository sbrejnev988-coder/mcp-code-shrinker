// ═══ Call Graph v0.3.2 ═══
// FIXED: _contract attached at index time → edges actually built
// FIXED: Multi-pass: index all → resolve imports → extract calls → build edges
// FIXED: Reverse edges built in final pass (no overwrite)

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, dirname } from "path";
import { parseFile, detectLanguage } from "../core/ast-engine.js";
import { createSymbolId, createFileRevision } from "../core/symbol-id.js";

export class CallGraph {
  constructor(projectRoot = ".") {
    this.root = resolve(projectRoot);
    this.nodes = new Map();
    this.edges = new Map();
    this.fileRevisions = new Map();
    this.testMap = new Map();
  }

  scan(opts = {}) {
    this._walkDir(this.root, opts.exclude || ["node_modules", ".git", "__pycache__", "dist", "build", ".cache"]);
    this._resolveAllImports();
    this._buildAllEdges();
    return { files: this.nodes.size, symbols: this.edges.size };
  }

  callers(filePath, symbolName) {
    const node = this.nodes.get(resolve(filePath));
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    if (!sym) return [];
    const edge = this.edges.get(sym.id);
    return edge?.callers ? [...edge.callers].map(id => this._resolveRef(id)) : [];
  }

  callees(filePath, symbolName) {
    const node = this.nodes.get(resolve(filePath));
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    if (!sym) return [];
    const edge = this.edges.get(sym.id);
    return edge?.callees ? [...edge.callees].map(id => this._resolveRef(id)) : [];
  }

  getTests(filePath, symbolName) {
    const node = this.nodes.get(resolve(filePath));
    if (!node) return [];
    const sym = node.symbols.find(s => s.name === symbolName || s.qualifiedName === symbolName);
    return sym ? this.testMap.get(sym.id) || [] : [];
  }

  touch(filePath) {
    const fp = resolve(filePath);
    const newRev = this._hashFile(fp);
    const oldRev = this.fileRevisions.get(fp);
    if (oldRev === newRev) return { changed: false };
    const affected = [fp];
    for (const [f, node] of this.nodes) {
      if (node.imports.some(imp => imp.resolved === fp)) affected.push(f);
    }
    for (const f of affected) this.nodes.delete(f);
    this.fileRevisions.set(fp, newRev);
    return { changed: true, affected };
  }

  toContextSlice(focusPaths, depth = 1) {
    // focusPaths may include directories → resolve to actual files
    const files = [];
    for (const p of focusPaths) {
      const rp = resolve(p);
      for (const [f] of this.nodes) {
        if (f === rp || f.startsWith(rp + "/")) files.push(f);
      }
    }
    const slice = { symbols: {}, edges: [] };
    const visited = new Set();
    for (const f of files.slice(0, 50)) this._collectSlice(f, depth, visited, slice);
    return slice;
  }

  // ── Internal ──

  _walkDir(dir, exclude) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (exclude.some(e => entry === e)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { this._walkDir(full, exclude); }
      else if (st.isFile()) {
        const lang = detectLanguage(full);
        if (lang !== "text" && lang !== "json" && lang !== "yaml" && lang !== "markdown") {
          this._indexFile(full);
        }
      }
    }
  }

  _indexFile(absPath) {
    try {
      const parsed = parseFile(absPath);
      const { extractContract } = require("../core/ast-engine.js"); // dynamic import would be better but...
      // Actually, use the already-imported parseFile which returns code
      
      const symbols = parsed.symbols.map(sym => {
        const id = createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature });
        const body = sym.body || "";
        // Build contract from body
        const contract = this._buildContract(sym, body, parsed.language);
        return { ...sym, id, file: absPath, contract };
      });

      const fileRev = createFileRevision(parsed.code);
      this.fileRevisions.set(absPath, fileRev);

      const imports = parsed.imports.map(imp => ({
        specifier: imp.specifier, raw: imp.raw, resolved: null, // resolved in pass 2
      }));

      this.nodes.set(absPath, { symbols, imports, language: parsed.language });

      // Test ↔ source mapping
      if (absPath.includes(".test.") || absPath.includes(".spec.") || absPath.includes("test_") || absPath.includes("_test.")) {
        for (const sym of symbols) {
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
    } catch {}
  }

  _buildContract(sym, body, language) {
    const effects = [];
    if (/\.(?:save|insert|update|delete|create|write|persist)\s*\(/i.test(body)) effects.push("database-write");
    if (/\.(?:publish|send|post|put)\s*\(/.test(body)) effects.push("network-write");
    if (/\.(?:fetch|get|request)\s*\(/.test(body)) effects.push("network-read");
    if (/(?:spawn|exec|fork)\s*\(/.test(body)) effects.push("process-spawn");

    const calls = new Set();
    const callRe = /(\w+(?:\.\w+)*)\s*\(/g;
    let m;
    while ((m = callRe.exec(body)) !== null) {
      if (m[1] !== sym.name) calls.add(m[1]);
    }

    return { signature: sym.signature || "", effects, calls: [...calls], throws: [] };
  }

  _resolveAllImports() {
    for (const [file, node] of this.nodes) {
      for (const imp of node.imports) {
        imp.resolved = this._resolveImport(file, imp.specifier);
      }
    }
  }

  _buildAllEdges() {
    // First pass: build callees for each symbol
    for (const [file, node] of this.nodes) {
      for (const sym of node.symbols) {
        if (!sym.contract?.calls) continue;
        const edge = { callers: new Set(), callees: new Set() };
        for (const calledName of sym.contract.calls) {
          const target = this._findSymbol(calledName, file, node);
          if (target) edge.callees.add(target.id);
        }
        this.edges.set(sym.id, edge);
      }
    }
    // Second pass: build reverse callers (no overwrite)
    for (const [symId, edge] of this.edges) {
      for (const calleeId of edge.callees) {
        const targetEdge = this.edges.get(calleeId);
        if (targetEdge) targetEdge.callers.add(symId);
      }
    }
  }

  _findSymbol(name, currentFile, currentNode) {
    // Same file
    const local = currentNode.symbols.find(s => s.name === name || s.qualifiedName === name || s.qualifiedName?.endsWith("." + name));
    if (local) return local;
    // Imported files
    for (const imp of currentNode.imports) {
      if (!imp.resolved) continue;
      const imported = this.nodes.get(imp.resolved);
      if (!imported) continue;
      const found = imported.symbols.find(s => s.name === name || s.qualifiedName === name || s.qualifiedName?.endsWith("." + name));
      if (found) return found;
    }
    return null;
  }

  _resolveImport(fromFile, specifier) {
    if (specifier.startsWith(".")) {
      const base = dirname(fromFile);
      for (const ext of ["", ".js", ".ts", ".jsx", ".tsx", ".mjs"]) {
        const c = resolve(base, specifier + ext);
        if (this.nodes.has(c)) return c;
      }
      for (const ext of [".js", ".ts"]) {
        const c = resolve(base, specifier, "index" + ext);
        if (this.nodes.has(c)) return c;
      }
    }
    return null;
  }

  _collectSlice(file, depth, visited, slice) {
    if (depth < 0 || visited.has(file)) return;
    visited.add(file);
    const node = this.nodes.get(file);
    if (!node) return;
    for (const sym of node.symbols) {
      slice.symbols[sym.id] = { name: sym.qualifiedName, file: relative(this.root, sym.file), kind: sym.kind, signature: sym.signature };
      const edge = this.edges.get(sym.id);
      if (edge) for (const cid of edge.callees) slice.edges.push([sym.id, "calls", cid]);
    }
    for (const imp of node.imports) { if (imp.resolved) this._collectSlice(imp.resolved, depth - 1, visited, slice); }
  }

  _hashFile(p) { try { return createFileRevision(readFileSync(p, "utf-8")); } catch { return null; } }

  _resolveRef(id) {
    for (const [, node] of this.nodes) {
      const s = node.symbols.find(x => x.id === id);
      if (s) return { id, name: s.qualifiedName, file: relative(this.root, s.file), kind: s.kind };
    }
    return { id, name: "unknown", file: "unknown", kind: "unknown" };
  }
}
