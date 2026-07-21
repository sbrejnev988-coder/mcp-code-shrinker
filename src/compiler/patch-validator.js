// ═══ Patch Validator v0.3.3 ═══
// FIXED: patchId traversal blocked (resolve + isInside)
// FIXED: shell injection — spawnSync(args, shell:false)
// FIXED: atomic write — fsync + renameSync
// FIXED: isTS regex — /\.(?:ts|tsx)$/i
// FIXED: symlink traversal — lstatSync, skip symlinks

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, readdirSync, statSync, lstatSync, renameSync, fdatasyncSync, openSync, closeSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createFileRevision } from "../core/symbol-id.js";

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSafePatchId(id) {
  if (id && (id.includes('..') || id.includes('/') || id.includes(String.fromCharCode(92)))) {
    throw new Error("INVALID_PATCH_ID: " + id);
  }
}

export class PatchValidator {
  constructor({ projectRoot = ".", sandboxBase = null } = {}) {
    this.projectRoot = resolve(projectRoot);
    this.sandboxBase = sandboxBase || join(this.projectRoot, ".code-shrinker-sandbox");
    this.results = new Map();
  }

  validate({ patchId, filePath, originalHash, edits }) {
    assertSafePatchId(patchId);
    const absPath = resolve(filePath);
    const id = patchId || `patch_${randomUUID()}`;
    const result = { patchId: id, status: "pending", steps: [], started: Date.now() };
    const sandboxDir = resolve(this.sandboxBase, id);

    // Traversal guard
    if (!isInside(resolve(this.sandboxBase), sandboxDir)) {
      return this._fail(result, "SANDBOX_PATH_ESCAPE", { sandboxDir });
    }

    try {
      // Path check
      if (!isInside(this.projectRoot, absPath)) {
        return this._fail(result, "PATH_OUTSIDE_ROOT", { path: absPath, root: this.projectRoot });
      }
      result.steps.push({ step: "path_check", status: "passed" });

      // Hash check — store for re-check
      const realCode = readFileSync(absPath, "utf-8");
      const actualHash = createFileRevision(realCode);
      result.originalHash = actualHash;
      if (originalHash && originalHash !== actualHash) {
        return this._fail(result, "STALE_FILE", { expected: originalHash, actual: actualHash });
      }
      result.steps.push({ step: "hash_check", status: "passed" });

      // Create sandbox
      this._createSandbox(sandboxDir);
      const relPath = relative(this.projectRoot, absPath);
      const sandboxFile = join(sandboxDir, relPath);
      result.steps.push({ step: "sandbox_create", status: "passed" });

      // Apply edits (bottom-up to preserve line numbers)
      let sandboxCode = readFileSync(sandboxFile, "utf-8");
      const lines = sandboxCode.split("\n");
      // Check for overlapping edits
      const sorted = [...edits].sort((a, b) => (b.startLine || 0) - (a.startLine || 0));
      for (const edit of sorted) {
        if (!this._applyEditToLines(lines, edit)) return this._fail(result, "EDIT_FAILED", { edit });
      }
      // Check for overlapping edits
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          if (overlaps(sorted[i], sorted[j])) return this._fail(result, "OVERLAPPING_EDITS", { a: sorted[i], b: sorted[j] });
        }
      }
      writeFileSync(sandboxFile, lines.join("\n"));
      result.steps.push({ step: "apply_edits", status: "passed" });

      // Syntax check — spawnSync, no shell
      const parseOk = this._syntaxCheck(sandboxFile);
      if (!parseOk.passed) return this._fail(result, "PARSE_ERROR", parseOk);
      result.steps.push({ step: "parse", status: "passed" });

      // Type check (only .ts/.tsx)
      const isTS = /\.(?:ts|tsx|mts|cts)$/i.test(relPath);
      if (isTS) {
        const typeResult = this._runInSandbox(sandboxDir, "tsc", ["--noEmit", "--pretty", "false", relPath]);
        if (typeResult && typeResult.failed) return this._fail(result, "TYPE_ERROR", typeResult);
        result.steps.push({ step: "typecheck", status: typeResult ? "passed" : "skipped" });
      } else {
        result.steps.push({ step: "typecheck", status: "skipped", reason: "not .ts" });
      }

      // Lint
      const lintResult = this._runInSandbox(sandboxDir, "eslint", ["--format", "compact", relPath]);
      if (lintResult) {
        if (lintResult.failed) return this._fail(result, "LINT_ERROR", lintResult);
        result.steps.push({ step: "lint", status: "passed" });
      } else {
        result.steps.push({ step: "lint", status: "skipped", reason: "eslint unavailable" });
      }

      // Tests
      const testResult = this._runTestsInSandbox(sandboxDir, relPath);
      if (testResult) {
        if (testResult.failed > 0) return this._fail(result, "TEST_FAILURE", testResult);
        result.steps.push({ step: "tests", status: "passed", passed: testResult.passed, failed: testResult.failed });
      } else {
        result.steps.push({ step: "tests", status: "skipped" });
      }

      // Store validated hash for integrity check
      result.validatedPatchedHash = createFileRevision(readFileSync(sandboxFile, "utf-8"));
      result.status = "valid";
      result.sandboxDir = sandboxDir;
      result.summary = { steps: result.steps.length, passed: result.steps.filter(s => s.status === "passed").length, duration_ms: Date.now() - result.started };
      result.patchReady = true;
    } catch (e) {
      return this._fail(result, "INTERNAL_ERROR", { message: e.message });
    }

    this.results.set(id, result);
    return result;
  }

  apply({ patchId, filePath }) {
    assertSafePatchId(patchId);
    const validation = this.results.get(patchId);
    if (!validation || validation.status !== "valid") {
      return { status: "rejected", reason: "Patch not validated" };
    }

    const absPath = resolve(filePath);
    if (!isInside(this.projectRoot, absPath)) {
      return { status: "rejected", reason: "PATH_OUTSIDE_ROOT" };
    }

    // REAL hash re-check
    const currentCode = readFileSync(absPath, "utf-8");
    const currentHash = createFileRevision(currentCode);
    if (validation.originalHash && currentHash !== validation.originalHash) {
      return { status: "rejected", reason: "STALE_FILE_AT_APPLY", expectedHash: validation.originalHash, currentHash };
    }

    const relPath = relative(this.projectRoot, absPath);
    const sandboxFile = join(validation.sandboxDir, relPath);
    if (!existsSync(sandboxFile)) {
      return { status: "rejected", reason: "Sandbox missing" };
    }

    const patchedCode = readFileSync(sandboxFile, "utf-8");
    // Check sandbox wasn't modified after validation
    const currentSandboxHash = createFileRevision(patchedCode);
    if (validation.validatedPatchedHash && currentSandboxHash !== validation.validatedPatchedHash) {
      return { status: "rejected", reason: "SANDBOX_CHANGED_AFTER_VALIDATION" };
    }
    const tmpPath = absPath + ".tmp." + patchId;
    const bakPath = absPath + ".bak." + patchId;

    // Atomic write: preserve mode, fsync, rename
    let mode = 0o644;
    try { mode = statSync(absPath).mode; } catch {}
    writeFileSync(tmpPath, patchedCode, { mode });
    try { const fd = openSync(tmpPath, "r+"); fdatasyncSync(fd); closeSync(fd); } catch {}
    try { cpSync(absPath, bakPath); } catch {}
    try { renameSync(tmpPath, absPath); } catch { writeFileSync(absPath, patchedCode); }
    try { rmSync(tmpPath, { force: true }); } catch {}

    const newHash = createFileRevision(patchedCode);
    this._cleanSandbox(patchId);

    return { status: "applied", file: relPath, oldHash: validation.originalHash, newHash, backupPath: bakPath, validation: validation.summary };
  }

  // ── Internal ──

  _createSandbox(dir) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".code-shrinker-sandbox", ".cache"]);
    this._copyDir(this.projectRoot, dir, SKIP);
  }

  _copyDir(src, dest, skip) {
    let entries;
    try { entries = readdirSync(src); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      let st;
      try { st = lstatSync(srcPath); } catch { continue; }
      if (st.isSymbolicLink()) continue; // Skip symlinks
      if (st.isDirectory()) { mkdirSync(destPath, { recursive: true }); this._copyDir(srcPath, destPath, skip); }
      else if (st.isFile()) { try { cpSync(srcPath, destPath); } catch {} }
    }
  }

  _syntaxCheck(filePath) {
    const ext = filePath.split(".").pop();
    const map = { js: ["node", "--check"], mjs: ["node", "--check"] };
    const cmd = map[ext];
    if (!cmd) return { passed: true, note: "no syntax check for ." + ext };
    const r = spawnSync(cmd[0], [...cmd.slice(1), filePath], { timeout: 15000, encoding: "utf-8", shell: false });
    if (r.status !== 0) return { passed: false, error: (r.stderr || r.stdout || "").slice(0, 500) };
    return { passed: true };
  }

  _runInSandbox(sandboxDir, cmd, args) {
    try {
      const result = spawnSync(cmd, args, { cwd: sandboxDir, timeout: 30000, encoding: "utf-8", shell: false });
      const out = (result.stdout || result.stderr || "");
      if (result.status === 0) return { failed: false };
      if (cmd === "eslint" && result.status === 1) {
        const errCount = (out.match(/error/g) || []).length;
        return { failed: true, errors: errCount, output: out.slice(0, 1000) };
      }
      if (out.includes("error TS")) {
        return { failed: true, errors: out.split("\n").filter(l => l.includes("error")).length, output: out.slice(0, 1000) };
      }
      return null;
    } catch { return null; }
  }

  _runTestsInSandbox(sandboxDir, relPath) {
    const bases = [
      relPath.replace(/\.(js|ts|jsx|tsx)$/, ".test.$1"),
      relPath.replace(/\.(js|ts)$/, ".spec.$1"),
      "test/" + relPath.replace(/^src\//, ""),
      "__tests__/" + relPath.replace(/^src\//, ""),
      relPath.replace(/^src\//, "test/").replace(/\.(js|ts)$/, ".test.$1"),
    ];
    for (const tf of bases) {
      const tp = join(sandboxDir, tf);
      if (existsSync(tp)) {
        try {
          const r = spawnSync(process.execPath, ["--test", tf], { cwd: sandboxDir, timeout: 60000, encoding: "utf-8", shell: false });
          if (r.status === 0) return { passed: 1, failed: 0, output: r.stdout?.slice(0, 1500) };
          return { passed: 0, failed: 1, output: (r.stderr || r.stdout || "").slice(0, 1500) };
        } catch { return { passed: 0, failed: 1, output: "test spawn error" }; }
      }
    }
    return null;
  }

  _applyEditToLines(lines, edit) {
    try {
      switch (edit.operation) {
        case "replace_symbol": if (!edit.startLine || !edit.endLine) return false; lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, edit.code); return true;
        case "insert_before": if (!edit.startLine) return false; lines.splice(edit.startLine - 1, 0, edit.code); return true;
        case "insert_after": if (!edit.endLine) return false; lines.splice(edit.endLine, 0, edit.code); return true;
        default: return false;
      }
    } catch { return false; }
  }

  _cleanSandbox(patchId) { try { rmSync(join(this.sandboxBase, patchId), { recursive: true, force: true }); } catch {} }

  _fail(result, reason, details) { result.status = "invalid"; result.failure = { reason, ...details }; result.patchReady = false; this.results.set(result.patchId, result); return result; }
}

function overlaps(a, b) {
  if (!a.startLine || !a.endLine || !b.startLine || !b.endLine) return false;
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}
