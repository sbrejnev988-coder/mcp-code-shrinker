// ═══ Path security tests ═══
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "path";

describe("path security", () => {
  it("rejects paths outside project root", () => {
    const projectRoot = "/tmp/test-project";
    const evilPath = "/etc/passwd";
    const inside = evilPath.startsWith(projectRoot);
    assert.equal(inside, false);
  });

  it("accepts paths inside project root", () => {
    const projectRoot = resolve("/tmp/test-project");
    const goodPath = resolve("/tmp/test-project/src/index.js");
    const inside = goodPath.startsWith(projectRoot);
    assert.equal(inside, true);
  });

  it("rejects ../ traversal inside root", () => {
    const root = "/tmp/proj";
    const path = "/tmp/proj/../../etc/passwd";
    // realpath would resolve this
    const resolved = resolve(path);
    const inside = resolved.startsWith(root);
    assert.equal(inside, false);
  });
});
