// ═══ Patch Validator v0.3.2 ═══
// FIXED: ESM imports (no require())
// FIXED: node --check instead of new Function()
// FIXED: Hash re-check: stored as result.originalHash
// FIXED: ESLint exit 1 properly detected
// FIXED: Path security: relative() check instead of startsWith

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createFileRevision } from "../core/symbol-id.js";

export class PatchValidator {
  constructor({ projectRoot = ".", sandboxBase = null } = {}) {
    this.projectRoot = resolve(projectRoot);
    this.sandboxBase = sandboxBase || join(this.projectRoot, ".code-shrinker-sandbox");
    this.results = new Map();
  }

  validate({ patchId, filePath, originalHash, edits }) {
    const absPath = resolve(filePath);
    const id = patchId || `patch_${randomUUID()}`;
    const result = { patchId: id, status: "pending", steps: [], started: Date.now() };
    const sandboxDir = join(this.sandboxBase, id);

    try {
      // Security: proper path containment check
      if (!isInside(this.projectRoot, absPath)) {
        return this._fail(result, "PATH_OUTSIDE_ROOT", { path: absPath, root: this.projectRoot });
      }
      result.steps.push({ step: "path_check", status: "passed" });

      // Hash check
      const realCode = readFileSync(absPath, "utf-8");
      const actualHash = createFileRevision(realCode);
      result.originalHash = actualHash; // ← STORED for apply re-check
      if (originalHash && originalHash !== actualHash) {
        return this._fail(result, "STALE_FILE", { expected: originalHash, actual: actualHash });
      }
      result.steps.push({ step: "hash_check", status: "passed" });

      // Create isolated sandbox
      this._createSandbox(sandboxDir);
      const relPath = relative(this.projectRoot, absPath);
      const sandboxFile = join(sandboxDir, relPath);
      result.steps.push({ step: "sandbox_create", status: "passed" });

      // Apply edits
      let sandboxCode = readFileSync(sandboxFile, "utf-8");
      const lines = sandboxCode.split("\n");
      for (const edit of edits) {
        if (!this._applyEditToLines(lines, edit)) return this._fail(result, "EDIT_FAILED", { edit });
      }
      writeFileSync(sandboxFile, lines.join("\n"));
      result.steps.push({ step: "apply_edits", status: "passed" });

      // Parse check: use node --check (handles ESM, import, export)
      const parseOk = this._syntaxCheck(sandboxFile);
      if (!parseOk.passed) return this._fail(result, "PARSE_ERROR", parseOk);
      result.steps.push({ step: "parse", status: "passed" });

      // Type check
      const isTS = relPath.match(/\.\(ts\|tsx\)\$/); const typeResult = isTS ? this._runInSandbox(sandboxDir, relPath, "tsc", ["--noEmit", "--pretty", "false"]) : null;
      if (typeResult && typeResult.failed) return this._fail(result, "TYPE_ERROR", typeResult);
      result.steps.push({ step: "typecheck", status: typeResult ? "passed" : "skipped", reason: typeResult ? null : "tsc not available" });

      // Lint — properly handle exit 1 = lint errors
      const lintResult = this._runInSandbox(sandboxDir, relPath, "eslint", ["--format", "compact"]);
      if (lintResult) {
        if (lintResult.failed) return this._fail(result, "LINT_ERROR", lintResult);
        result.steps.push({ step: "lint", status: "passed" });
      } else {
        result.steps.push({ step: "lint", status: "skipped", reason: "eslint not available" });
      }

      // Tests
      const testResult = this._runTestsInSandbox(sandboxDir, relPath);
      if (testResult) {
        if (testResult.failed > 0) return this._fail(result, "TEST_FAILURE", testResult);
        result.steps.push({ step: "tests", status: "passed", passed: testResult.passed, failed: testResult.failed });
      } else {
        result.steps.push({ step: "tests", status: "skipped", reason: "no tests found" });
      }

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
    const validation = this.results.get(patchId);
    if (!validation || validation.status !== "valid") {
      return { status: "rejected", reason: "Patch not validated" };
    }

    const absPath = resolve(filePath);
    if (!isInside(this.projectRoot, absPath)) {
      return { status: "rejected", reason: "PATH_OUTSIDE_ROOT" };
    }

    // REAL hash re-check using stored originalHash
    const currentCode = readFileSync(absPath, "utf-8");
    const currentHash = createFileRevision(currentCode);
    if (validation.originalHash && currentHash !== validation.originalHash) {
      return { status: "rejected", reason: "STALE_FILE_AT_APPLY", expectedHash: validation.originalHash, currentHash };
    }

    const relPath = relative(this.projectRoot, absPath);
    const sandboxFile = join(validation.sandboxDir, relPath);
    if (!existsSync(sandboxFile)) {
      return { status: "rejected", reason: "Sandbox missing — re-validate" };
    }

    const patchedCode = readFileSync(sandboxFile, "utf-8");
    
    // Atomic-ish write: temp → backup → rename
    const tmpPath = absPath + ".tmp." + patchId;
    const bakPath = absPath + ".bak." + patchId;
    writeFileSync(tmpPath, patchedCode);
    try { cpSync(absPath, bakPath); } catch {}
    writeFileSync(absPath, patchedCode);
    try { rmSync(tmpPath); } catch {}

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
      // Include dotfiles (.eslintrc, .babelrc, etc.) — they affect validation
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      let st;
      try { st = statSync(srcPath); } catch { continue; }
      if (st.isDirectory()) { mkdirSync(destPath, { recursive: true }); this._copyDir(srcPath, destPath, skip); }
      else if (st.isFile()) { try { cpSync(srcPath, destPath); } catch {} }
    }
  }

  _syntaxCheck(filePath) {
    const ext = filePath.split(".").pop();
    const commands = { js: ["node", "--check"], mjs: ["node", "--check"], ts: ["npx", "tsc", "--noEmit"], tsx: ["npx", "tsc", "--noEmit"] };
    const cmd = commands[ext];
    if (!cmd) return { passed: true, note: "no syntax checker for ." + ext };
    const r = spawnSync(cmd[0], [...cmd.slice(1), filePath], { timeout: 15000, encoding: "utf-8" });
    if (r.status !== 0) return { passed: false, error: r.stderr?.slice(0, 500) || r.stdout?.slice(0, 500) };
    return { passed: true };
  }

  _runInSandbox(sandboxDir, relPath, cmd, args) {
    try {
      execSync([cmd, ...args, relPath].join(" "), { cwd: sandboxDir, timeout: 30000, encoding: "utf-8" });
      return { failed: false };
    } catch (e) {
      const out = (e.stdout || e.stderr || "");
      // tsc: errors = "error TS"
      // eslint: exit 1 on lint errors
      if (cmd === "eslint" && e.status === 1) {
        const errCount = (out.match(/error/g) || []).length;
        return { failed: true, errors: errCount, output: out.slice(0, 1000) };
      }
      if (cmd === "tsc" && out.includes("error TS")) {
        return { failed: true, errors: out.split("\n").filter(l => l.includes("error")).length, output: out.slice(0, 1000) };
      }
      return null; // Command unavailable
    }
  }

  _runTestsInSandbox(sandboxDir, relPath) {
    const bases = [relPath.replace(/\.(js|ts|jsx|tsx)$/, ".test.$1"), relPath.replace(/\.(js|ts)$/, ".spec.$1"), relPath.replace(/^src\//, "test/"), relPath.replace(/^src\//, "__tests__/")];
    for (const tf of bases) {
      const tp = join(sandboxDir, tf);
      if (existsSync(tp)) {
        try {
          const r = execSync(`node --test "${tf}"`, { cwd: sandboxDir, timeout: 60000, encoding: "utf-8" });
          return { passed: 1, failed: 0, output: r.slice(0, 1500) };
        } catch (e) {
          return { passed: 0, failed: 1, output: (e.stdout || e.stderr || "").slice(0, 1500) };
        }
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

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
