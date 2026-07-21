import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { PatchValidator } from "../src/compiler/patch-validator.js";

describe("PatchValidator", () => {
  const tmpDir = "/tmp/shrinker-validator-test-" + Date.now();
  const testFile = join(tmpDir, "test.js");
  const validator = new PatchValidator({ projectRoot: tmpDir });

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testFile, "export function add(a, b) {\n  return a + b;\n}\n");
  });

  after(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

  it("validates a correct patch", () => {
    const r = validator.validate({
      patchId: "patch_test1",
      filePath: testFile,
      edits: [{ operation: "replace_symbol", startLine: 1, endLine: 3, code: "export function add(a, b) {\n  return a + b + 1;\n}" }],
    });
    assert.equal(r.status, "valid");
    assert.ok(r.originalHash, "hash must be stored for re-check");
  });

  it("detects path outside root", () => {
    const r = validator.validate({
      patchId: "patch_evil",
      filePath: "/etc/hosts",
      edits: [{ operation: "replace_symbol", startLine: 1, endLine: 1, code: "" }],
    });
    assert.equal(r.status, "invalid");
    assert.match(r.failure?.reason, /PATH_OUTSIDE_ROOT/);
  });

  it("detects stale file on re-apply", () => {
    const r1 = validator.validate({
      patchId: "patch_stale",
      filePath: testFile,
      edits: [{ operation: "replace_symbol", startLine: 1, endLine: 3, code: "export function add(a, b) {\n  return a * b;\n}" }],
    });
    assert.equal(r1.status, "valid");
    
    // Restore original then modify
    writeFileSync(testFile, "export function add(a, b) {\\n  return a + b;\\n}\\n");
    // Modify file between validate and apply
    writeFileSync(testFile, "export function add(a, b) {\n  return 0;\n}\n");
    
    const r2 = validator.apply({ patchId: "patch_stale", filePath: testFile });
    assert.equal(r2.status, "rejected");
    assert.match(r2.reason, /STALE_FILE/);
  });

  it("rejects root-prefix collision path", () => {
    // Create /tmp/shrinker-validator-test-XXXXX-evil alongside the root
    const evilDir = tmpDir + "-evil";
    mkdirSync(evilDir, { recursive: true });
    try {
      const r = validator.validate({
        patchId: "patch_collide",
        filePath: join(evilDir, "x.js"),
        edits: [],
      });
      assert.equal(r.status, "invalid");
    } finally { try { rmSync(evilDir, { recursive: true }); } catch {} }
  });
});
