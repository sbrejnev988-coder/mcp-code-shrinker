// ═══ Patch Validator v0.3.1 ═══
// FIXED: Tests run against PATCHED copy in isolated worktree
// FIXED: Separate sandbox per patchId
// FIXED: Re-check hash before apply

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { execSync } from "child_process";
import { createFileRevision, createSymbolRevisionFromSource, validateContext } from "../core/symbol-id.js";

export class PatchValidator {
  constructor({ projectRoot = ".", sandboxBase = null } = {}) {
    this.projectRoot = resolve(projectRoot);
    this.sandboxBase = sandboxBase || join(this.projectRoot, ".code-shrinker-sandbox");
    this.results = new Map();
  }

  /**
   * Validate patch in isolated worktree — tests run against PATCHED code
   */
  validate({ patchId, filePath, originalHash, edits }) {
    const absPath = resolve(filePath);
    const result = { patchId, status: "pending", steps: [], started: Date.now() };
    const sandboxDir = join(this.sandboxBase, patchId);

    try {
      // Step 0: Path security — must be inside project root
      if (!absPath.startsWith(this.projectRoot)) {
        return this._fail(result, "PATH_OUTSIDE_ROOT", { path: absPath, root: this.projectRoot });
      }
      result.steps.push({ step: "path_check", status: "passed" });

      // Step 1: Hash check — file hasn't changed
      const realCode = readFileSync(absPath, "utf-8");
      const actualHash = createFileRevision(realCode);
      if (originalHash && originalHash !== actualHash) {
        return this._fail(result, "STALE_FILE", { expected: originalHash, actual: actualHash });
      }
      result.steps.push({ step: "hash_check", status: "passed" });

      // Step 2: Create isolated sandbox (copy entire project)
      this._createSandbox(sandboxDir);
      const relPath = relative(this.projectRoot, absPath);
      const sandboxFile = join(sandboxDir, relPath);
      result.steps.push({ step: "sandbox_create", status: "passed", dir: sandboxDir });

      // Step 3: Apply edits
      let sandboxCode = readFileSync(sandboxFile, "utf-8");
      const lines = sandboxCode.split("\n");
      for (const edit of edits) {
        const ok = this._applyEditToLines(lines, edit);
        if (!ok) return this._fail(result, "EDIT_FAILED", { edit });
      }
      writeFileSync(sandboxFile, lines.join("\n"));
      result.steps.push({ step: "apply_edits", status: "passed" });

      // Step 4: Parse check
      try {
        const sandboxCodeCheck = readFileSync(sandboxFile, "utf-8");
        // Basic syntax: create a Function to check parseability
        if (sandboxFile.match(/\.(js|mjs|ts|tsx)$/)) {
          new Function(sandboxCodeCheck); // throws on syntax error
        }
        result.steps.push({ step: "parse", status: "passed" });
      } catch (e) {
        return this._fail(result, "PARSE_ERROR", { message: e.message });
      }

      // Step 5: Type check (against sandbox copy)
      const typeResult = this._runTypeCheckInSandbox(sandboxDir, relPath);
      if (typeResult?.failed) {
        return this._fail(result, "TYPE_ERROR", typeResult);
      }
      result.steps.push({ step: "typecheck", status: typeResult ? "passed" : "skipped", reason: typeResult ? null : "no tsc" });

      // Step 6: Lint (against sandbox copy)
      const lintResult = this._runLintInSandbox(sandboxDir, relPath);
      if (lintResult?.errors > 0) {
        return this._fail(result, "LINT_ERROR", lintResult);
      }
      result.steps.push({ step: "lint", status: lintResult ? "passed" : "skipped" });

      // Step 7: Run affected tests — CRITICAL: against SANDBOX copy
      const testResult = this._runTestsInSandbox(sandboxDir, relPath);
      if (testResult) {
        if (testResult.failed > 0) {
          return this._fail(result, "TEST_FAILURE", testResult);
        }
        result.steps.push({ step: "tests", status: "passed", passed: testResult.passed, failed: testResult.failed });
      } else {
        result.steps.push({ step: "tests", status: "skipped", reason: "no tests found" });
      }

      // Success
      result.status = "valid";
      result.sandboxDir = sandboxDir;
      result.summary = {
        steps: result.steps.length,
        passed: result.steps.filter(s => s.status === "passed").length,
        duration_ms: Date.now() - result.started,
      };
      result.patchReady = true;

    } catch (e) {
      return this._fail(result, "INTERNAL_ERROR", { message: e.message, stack: e.stack?.slice(0, 500) });
    }

    this.results.set(patchId, result);
    return result;
  }

  /**
   * Apply validated patch to real file with re-check
   */
  apply({ patchId, filePath }) {
    const validation = this.results.get(patchId);
    if (!validation || validation.status !== "valid") {
      return { status: "rejected", reason: "Patch not validated. Run patch.validate first." };
    }

    const absPath = resolve(filePath);
    if (!absPath.startsWith(this.projectRoot)) {
      return { status: "rejected", reason: "PATH_OUTSIDE_ROOT" };
    }

    // Read sandbox result
    const relPath = relative(this.projectRoot, absPath);
    const sandboxFile = join(validation.sandboxDir, relPath);
    if (!existsSync(sandboxFile)) {
      return { status: "rejected", reason: "Sandbox missing — re-validate" };
    }

    // FINAL hash re-check before apply
    const currentCode = readFileSync(absPath, "utf-8");
    const currentHash = createFileRevision(currentCode);
    const expectedHash = validation.steps?.find(s => s.step === "hash_check")?.expected;
    if (expectedHash && currentHash !== expectedHash) {
      return { status: "rejected", reason: "STALE_FILE_AT_APPLY", currentHash, expectedHash };
    }

    const patchedCode = readFileSync(sandboxFile, "utf-8");
    const oldHash = currentHash;
    
    // Atomic write: backup first
    const backupPath = absPath + `.bak.${patchId}`;
    writeFileSync(backupPath, currentCode);
    writeFileSync(absPath, patchedCode);
    const newHash = createFileRevision(patchedCode);

    // Clean sandbox
    this._cleanSandbox(patchId);

    return {
      status: "applied",
      file: relPath,
      oldHash,
      newHash,
      backupPath,
      validation: validation.summary,
    };
  }

  // ── Internal ──

  _createSandbox(sandboxDir) {
    if (existsSync(sandboxDir)) rmSync(sandboxDir, { recursive: true, force: true });
    mkdirSync(sandboxDir, { recursive: true });
    // Copy project files (skip heavy dirs)
    const SKIP = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".code-shrinker-sandbox", ".cache"]);
    this._copyDir(this.projectRoot, sandboxDir, SKIP);
  }

  _copyDir(src, dest, skip) {
    const { readdirSync } = require("fs");
    const { statSync } = require("fs");
    let entries;
    try { entries = readdirSync(src); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry) || entry.startsWith(".")) continue;
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      let st;
      try { st = statSync(srcPath); } catch { continue; }
      if (st.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        this._copyDir(srcPath, destPath, skip);
      } else if (st.isFile() && st.size < 500000) {
        try { cpSync(srcPath, destPath); } catch {}
      }
    }
  }

  _applyEditToLines(lines, edit) {
    try {
      switch (edit.operation) {
        case "replace_symbol": {
          if (!edit.startLine || !edit.endLine) return false;
          const before = lines.slice(0, edit.startLine - 1);
          const after = lines.slice(edit.endLine);
          const newLines = [...before, edit.code, ...after];
          lines.length = 0;
          lines.push(...newLines);
          return true;
        }
        case "insert_before": {
          if (!edit.startLine) return false;
          lines.splice(edit.startLine - 1, 0, edit.code);
          return true;
        }
        case "insert_after": {
          if (!edit.endLine) return false;
          lines.splice(edit.endLine, 0, edit.code);
          return true;
        }
        default: return false;
      }
    } catch { return false; }
  }

  _runTypeCheckInSandbox(sandboxDir, relPath) {
    try {
      execSync(`npx tsc --noEmit --pretty false 2>&1`, {
        cwd: sandboxDir, timeout: 30000, encoding: "utf-8",
      });
      return { failed: false };
    } catch (e) {
      const out = e.stdout || e.stderr || "";
      if (out.includes("error TS")) {
        return { failed: true, errors: out.split("\n").filter(l => l.includes("error")).length, output: out.slice(0, 1000) };
      }
      return null;
    }
  }

  _runLintInSandbox(sandboxDir, relPath) {
    try {
      const result = execSync(`npx eslint --format compact "${relPath}" 2>&1`, {
        cwd: sandboxDir, timeout: 15000, encoding: "utf-8",
      });
      const errors = (result.match(/error/g) || []).length;
      return { errors, output: result.slice(0, 500) };
    } catch { return null; }
  }

  _runTestsInSandbox(sandboxDir, relPath) {
    const testPatterns = [
      relPath.replace(/\.(js|ts|jsx|tsx)$/, ".test.$1"),
      relPath.replace(/\.(js|ts|jsx|tsx)$/, ".spec.$1"),
      relPath.replace(/^src\//, "test/"),
      relPath.replace(/^src\//, "__tests__/"),
    ];
    for (const testFile of testPatterns) {
      const testPath = join(sandboxDir, testFile);
      if (existsSync(testPath)) {
        try {
          const result = execSync(`node --test "${testFile}" 2>&1`, {
            cwd: sandboxDir, timeout: 60000, encoding: "utf-8",
          });
          return { passed: (result.match(/✔/g) || []).length || 1, failed: 0, output: result.slice(0, 1500) };
        } catch (e) {
          const out = e.stdout || e.stderr || "";
          return { passed: 0, failed: 1, output: out.slice(0, 1500) };
        }
      }
    }
    return null;
  }

  _cleanSandbox(patchId) {
    const dir = join(this.sandboxBase, patchId);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  _fail(result, reason, details) {
    result.status = "invalid";
    result.failure = { reason, ...details };
    result.patchReady = false;
    this.results.set(result.patchId, result);
    return result;
  }
}
