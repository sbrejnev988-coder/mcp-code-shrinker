import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { CallGraph } from "../src/compiler/call-graph.js";

describe("CallGraph", () => {
  const tmp = "/tmp/callgraph-test-" + Date.now();
  before(() => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.js"), "export function main() { return helper(); }\nfunction helper() { return 42; }\n");
    writeFileSync(join(tmp, "src", "utils.js"), "export function helper() { return 42; }\n");
  });
  after(() => { try { rmSync(tmp, { recursive: true }); } catch {} });

  it("indexes files in ESM project without crashing", () => {
    const graph = new CallGraph(tmp);
    const stats = graph.scan();
    assert.ok(stats.files > 0, "must index files");
    assert.ok(stats.symbols >= 0, "symbols count must be defined");
    console.log("Diagnostics:", JSON.stringify(stats.diagnostics));
  });
});
