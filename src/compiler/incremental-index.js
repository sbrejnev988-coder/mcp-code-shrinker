// ═══ Incremental Index v0.1.0 — Daemon/watch mode for ProjectGraph ═══

import { statSync, readFileSync, readdirSync, lstatSync } from "fs";
import { resolve, relative } from "path";
import { ProjectGraph } from "./project-graph.js";
import { detectLanguage } from "../core/ast-engine.js";

const POLL_INTERVAL_MS = 5000;
const DEBOUNCE_MS = 2000;
const CONFIG_FILES = new Set(["package.json", "tsconfig.json", "config.yaml", "config.yml"]);

export class IncrementalIndex {
  constructor(projectRoot = ".") {
    this.root = resolve(projectRoot);
    this.graph = new ProjectGraph(this.root);
    this._watchTimer = null;
    this._watched = false;
    this._fileMTimes = new Map();
    this._pendingChanges = new Set();
    this._debounceTimer = null;
    this._changeLog = [];
    this._maxChangeLog = 200;
  }

  // ═══ Public API ═══

  /** Full initial scan + start watching */
  start(opts = {}) {
    const interval = opts.interval || POLL_INTERVAL_MS;
    const result = this.graph.scan(opts);
    this._snapshotMTimes();
    this._watched = true;
    this._watchTimer = setInterval(() => this._poll(), interval);
    return { ...result, watching: true, interval };
  }

  /** Stop watching */
  stop() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    this._watched = false;
    return { watching: false };
  }

  /** Check watch status */
  status() {
    return {
      watching: this._watched,
      files: this.graph.nodes.size,
      symbols: this.graph.edges.size,
      changeLog: this._changeLog.slice(0, 20),
      changeCount: this._changeLog.length,
    };
  }

  /** Force reindex of specific files or all */
  refresh(paths = null) {
    if (paths) {
      for (const p of paths) this._reindexFile(resolve(p));
    } else {
      this.graph = new ProjectGraph(this.root);
      this.graph.scan();
      this._snapshotMTimes();
    }
    return { changed: this._changeLog.slice(-10) };
  }

  /** Get symbols changed since last snapshot */
  changedSymbols() {
    return this._changeLog.slice(-50);
  }

  /** Take a snapshot of current state */
  snapshot() {
    return {
      root: this.root,
      files: this.graph.nodes.size,
      symbols: this.graph.edges.size,
      entrypoints: this.graph.entrypoints.map(e => e.file),
      timestamp: new Date().toISOString(),
    };
  }

  // ═══ Private ═══

  _snapshotMTimes() {
    this._fileMTimes.clear();
    for (const [filePath] of this.graph.nodes) {
      try {
        const st = statSync(filePath);
        this._fileMTimes.set(filePath, st.mtimeMs);
      } catch {}
    }
  }

  _poll() {
    if (this._pendingChanges.size > 0) return; // Debounce active

    const changed = [];

    // Check known files for modifications
    for (const [filePath, lastMtime] of this._fileMTimes) {
      try {
        const st = statSync(filePath);
        if (st.mtimeMs > lastMtime + 500) { // 500ms tolerance
          changed.push(filePath);
          this._fileMTimes.set(filePath, st.mtimeMs);
        }
      } catch {
        // File deleted
        changed.push(filePath);
        this._fileMTimes.delete(filePath);
      }
    }

    // Check for new files
    this._scanNewFiles(changed);

    if (changed.length > 0) {
      this._pendingChanges = new Set(changed);
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._applyChanges(), DEBOUNCE_MS);
    }
  }

  _scanNewFiles(changedList) {
    // Simplified: re-scan the whole directory to find new files
    // Full implementation would walk dirs tracking known paths
    const currentFiles = new Set();
    try {
      this._walkCollect(this.root, currentFiles);
    } catch {}

    for (const f of currentFiles) {
      if (!this._fileMTimes.has(f)) {
        changedList.push(f);
        try { this._fileMTimes.set(f, statSync(f).mtimeMs); } catch {}
      }
    }
  }

  _walkCollect(dir, result) {
    // fs functions imported at module level
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (["node_modules", ".git", "__pycache__", "dist", "build", "backups", ".cache"].includes(entry)) continue;
      const full = `${dir}/${entry}`;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { this._walkCollect(full, result); }
      else if (st.isFile()) {
        const lang = detectLanguage(full);
        if (lang !== "text" || CONFIG_FILES.has(entry) ||
            /\.test\.[jt]sx?$|\.spec\.[jt]sx?$|test_|_test\.py$|\/test\//.test(full)) {
          result.add(resolve(full));
        }
      }
    }
  }

  _applyChanges() {
    const changed = [...this._pendingChanges];
    this._pendingChanges.clear();
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }

    const removed = [];
    const updated = [];

    for (const filePath of changed) {
      const exists = this._fileExists(filePath);

      if (!exists) {
        // File removed
        if (this.graph.nodes.has(filePath)) {
          const node = this.graph.nodes.get(filePath);
          for (const sym of node.symbols) {
            this.graph.edges.delete(sym.id);
          }
          this.graph.nodes.delete(filePath);
          this._fileMTimes.delete(filePath);
        }
        removed.push(relative(this.root, filePath));
        continue;
      }

      // File updated or new
      try {
        const oldNode = this.graph.nodes.get(filePath);
        const oldSymbolIds = oldNode ? oldNode.symbols.map(s => s.id) : [];

        // Reindex
        this.graph._indexFile(filePath, detectLanguage(filePath));

        const newNode = this.graph.nodes.get(filePath);
        const newSymbolIds = newNode ? newNode.symbols.map(s => s.id) : [];

        const added = newSymbolIds.filter(id => !oldSymbolIds.includes(id));
        const deleted = oldSymbolIds.filter(id => !newSymbolIds.includes(id));

        updated.push({
          file: relative(this.root, filePath),
          added: added.length,
          deleted: deleted.length,
        });
      } catch (err) {
        updated.push({
          file: relative(this.root, filePath),
          error: err.message,
        });
      }
    }

    const entry = {
      timestamp: new Date().toISOString(),
      removed,
      updated,
    };

    this._changeLog.push(entry);
    if (this._changeLog.length > this._maxChangeLog) {
      this._changeLog = this._changeLog.slice(-this._maxChangeLog);
    }

    // Rebuild cross-file edges for updated files
    try { this.graph._buildAllEdges(); } catch {}
  }

  _fileExists(filePath) {
    try { statSync(filePath); return true; } catch { return false; }
  }
}

// Synchronous fs imports


export default IncrementalIndex;
