import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync, spawn } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

describe("Server startup", () => {
  const tmp = "/tmp/shrinker-startup-" + Date.now();

  before(() => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.js"), "export function foo() { return 1; }\n");
  });
  after(() => { try { rmSync(tmp, { recursive: true }); } catch {} });

  it("starts without ReferenceError", () => {
    const r = spawnSync(process.execPath, ["src/index.js"], {
      env: { ...process.env, CODE_SHRINKER_ALLOWED_ROOTS: tmp },
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = (r.stderr || "");
    // Should mention "ready" in stderr within 5s, NOT "ReferenceError" or "not defined"
    assert.ok(!stderr.includes("ReferenceError"), "no ReferenceError: " + stderr.slice(0, 200));
    assert.ok(!stderr.includes("is not defined"), "no undefined var: " + stderr.slice(0, 200));
    assert.ok(stderr.includes("ready"), "must show ready: " + stderr.slice(0, 200));
  });
});
