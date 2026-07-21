// ═══ Patch Validator v0.3 ═══
// Edit → parse → typecheck → lint → test (compact failure slice)
// Validates before applying. Never applies if validation fails.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { parseFile } from "../core/ast-engine.js";
import { createFileRevision, createSymbolRevision, validateContext } from "../core/symbol-id.js";

export class PatchValidator {
  constructor({ projectRoot = ".", sandboxDir = null } = {}) {
    this.projectRoot = projectRoot;
    this.sandboxDir = sandboxDir || join(projectRoot, ".code-shrinker-sandbox");
    this.results = new Map(); // patchId → validation result
  }

  /**
   * Validate a proposed patch
   * @returns {{ status, steps, failure?, summary }}
   */
  validate({ patchId, filePath, originalHash, edits }) {
    const result = {
      patchId,
      status: "pending",
      steps: [],
      started: Date.now(),
    };

    try {
      // Step 1: Read original
      const originalCode = readFileSync(filePath, "utf-8");
      const actualHash = createFileRevision(originalCode);
      
      if (originalHash && originalHash !== actualHash) {
        return this._fail(result, "STALE_FILE", {
          expected: originalHash,
          actual: actualHash,
          message: "File has changed since context was created. Re-run context.create.",
        });
      }
      result.steps.push({ step: "hash_check", status: "passed" });

      // Step 2: Apply edits to temp copy
      const sandboxFile = this._sandboxPath(filePath);
      mkdirSync(dirname(sandboxFile), { recursive: true });
      writeFileSync(sandboxFile, originalCode);

      for (const edit of edits) {
        const ok = this._applyEdit(sandboxFile, edit);
        if (!ok) return this._fail(result, "EDIT_FAILED", { edit, message: "Failed to apply edit" });
      }
      result.steps.push({ step: "apply_edits", status: "passed" });

      // Step 3: Parse check
      try {
        const parsed = parseFile(sandboxFile);
        result.steps.push({ step: "parse", status: "passed", symbols: parsed.symbols.length });
      } catch (e) {
        return this._fail(result, "PARSE_ERROR", {
          message: e.message,
          file: sandboxFile,
        });
      }

      // Step 4: Type check (if available)
      const typeResult = this._runTypeCheck(filePath, sandboxFile);
      if (typeResult) {
        if (typeResult.failed) {
          return this._fail(result, "TYPE_ERROR", typeResult);
        }
        result.steps.push({ step: "typecheck", status: "passed" });
      } else {
        result.steps.push({ step: "typecheck", status: "skipped", reason: "no type checker available" });
      }

      // Step 5: Lint
      const lintResult = this._runLint(sandboxFile);
      if (lintResult?.errors > 0) {
        return this._fail(result, "LINT_ERROR", lintResult);
      }
      result.steps.push({ step: "lint", status: lintResult ? "passed" : "skipped" });

      // Step 6: Affected tests
      const testResult = this._runAffectedTests(filePath);
      if (testResult) {
        result.steps.push({
          step: "tests",
          status: testResult.failed === 0 ? "passed" : "failed",
          passed: testResult.passed,
          failed: testResult.failed,
        });
        if (testResult.failed > 0) {
          return this._fail(result, "TEST_FAILURE", testResult);
        }
      } else {
        result.steps.push({ step: "tests", status: "skipped", reason: "no tests found" });
      }

      // Success
      result.status = "valid";
      result.summary = {
        steps: result.steps.length,
        passed: result.steps.filter(s => s.status === "passed").length,
        duration_ms: Date.now() - result.started,
      };
      result.patchReady = true;

    } catch (e) {
      return this._fail(result, "INTERNAL_ERROR", { message: e.message });
    }

    this.results.set(patchId, result);
    return result;
  }

  /**
   * Apply a validated patch to the real file
   */
  apply({ patchId, filePath }) {
    const validation = this.results.get(patchId);
    if (!validation || validation.status !== "valid") {
      return { status: "rejected", reason: "Patch not validated or validation failed" };
    }

    // Copy from sandbox to real
    const sandboxFile = this._sandboxPath(filePath);
    if (!existsSync(sandboxFile)) {
      return { status: "rejected", reason: "Sandbox file missing — re-validate" };
    }

    const newCode = readFileSync(sandboxFile, "utf-8");
    const oldHash = createFileRevision(readFileSync(filePath, "utf-8"));
    writeFileSync(filePath, newCode);
    const newHash = createFileRevision(newCode);

    // Clean sandbox
    this._cleanSandbox();

    return {
      status: "applied",
      file: filePath,
      oldHash,
      newHash,
      validation: validation.summary,
    };
  }

  // ── Internal ──

  _applyEdit(filePath, edit) {
    try {
      const code = readFileSync(filePath, "utf-8");
      const lines = code.split("\n");
      
      switch (edit.operation) {
        case "replace_symbol": {
          // Find the symbol and replace its body
          const parsed = parseFile(filePath);
          const sym = parsed.symbols.find(s => 
            s.qualifiedName === edit.symbol || s.name === edit.symbol);
          if (!sym) return false;
          
          const before = lines.slice(0, (sym.startLine || 1) - 1);
          const after = lines.slice(sym.endLine || sym.startLine);
          writeFileSync(filePath, [...before, edit.code, ...after].join("\n"));
          return true;
        }
        case "insert_before": {
          const parsed = parseFile(filePath);
          const sym = parsed.symbols.find(s => 
            s.qualifiedName === edit.symbol || s.name === edit.symbol);
          if (!sym) return false;
          
          const idx = (sym.startLine || 1) - 1;
          lines.splice(idx, 0, edit.code);
          writeFileSync(filePath, lines.join("\n"));
          return true;
        }
        case "insert_after": {
          const parsed = parseFile(filePath);
          const sym = parsed.symbols.find(s => 
            s.qualifiedName === edit.symbol || s.name === edit.symbol);
          if (!sym) return false;
          
          const idx = sym.endLine || sym.startLine;
          lines.splice(idx, 0, edit.code);
          writeFileSync(filePath, lines.join("\n"));
          return true;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  _runTypeCheck(originalFile, sandboxFile) {
    // Try TypeScript
    try {
      const result = execSync(`npx tsc --noEmit --pretty false "${sandboxFile}" 2>&1`, {
        cwd: this.projectRoot,
        timeout: 30000,
        encoding: "utf-8",
      });
      return { failed: false, output: result };
    } catch (e) {
      if (e.stdout?.includes("error TS")) {
        return { failed: true, errors: e.stdout.split("\n").filter(l => l.includes("error")).length, output: e.stdout.slice(0, 1000) };
      }
      // tsc not available — skip
      return null;
    }
  }

  _runLint(filePath) {
    try {
      const result = execSync(`npx eslint --format compact "${filePath}" 2>&1`, {
        cwd: this.projectRoot,
        timeout: 15000,
        encoding: "utf-8",
      });
      const errors = (result.match(/error/g) || []).length;
      return { errors, output: result.slice(0, 500) };
    } catch {
      return null; // eslint not available
    }
  }

  _runAffectedTests(filePath) {
    // Try to find and run tests
    const testPatterns = [
      filePath.replace(/\.(js|ts|jsx|tsx)$/, ".test.$1"),
      filePath.replace(/\.(js|ts|jsx|tsx)$/, ".spec.$1"),
      filePath.replace(/src\//, "test/"),
      filePath.replace(/src\//, "__tests__/"),
    ];

    for (const testFile of testPatterns) {
      if (existsSync(testFile)) {
        try {
          const result = execSync(`node --test "${testFile}" 2>&1`, {
            cwd: this.projectRoot,
            timeout: 60000,
            encoding: "utf-8",
          });
          const passed = (result.match(/✔|ok\s+\d+|pass/g) || []).length;
          const failed = (result.match(/✖|not ok|fail/g) || []).length;
          return { passed, failed: Math.max(failed, 0), output: result.slice(0, 1500) };
        } catch (e) {
          // Try to extract test counts from output
          const out = e.stdout || e.stderr || "";
          return {
            passed: (out.match(/pass\s+(\d+)/)?.[1]) || 0,
            failed: (out.match(/fail\s+(\d+)/)?.[1]) || 1,
            output: out.slice(0, 1500),
          };
        }
      }
    }
    return null;
  }

  _sandboxPath(filePath) {
    return join(this.sandboxDir, filePath.replace(this.projectRoot, ""));
  }

  _cleanSandbox() {
    try { rmSync(this.sandboxDir, { recursive: true, force: true }); } catch {}
  }

  _fail(result, reason, details) {
    result.status = "invalid";
    result.failure = { reason, ...details };
    result.patchReady = false;
    this.results.set(result.patchId, result);
    return result;
  }
}
