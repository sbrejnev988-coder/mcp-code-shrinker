import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { CallGraph } from "../src/compiler/call-graph.js";

describe("CallGraph", () => {
  const tmp = "/tmp/callgraph-test-" + Date.now();
  const indexFile = join(tmp, "src", "index.js");
  const utilsFile = join(tmp, "src", "utils.js");

  before(() => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(indexFile, "export function main() { return helper(); }\nfunction helper() { return 42; }\n");
    writeFileSync(utilsFile, "export function helper() { return 42; }\n");
  });
  after(() => { try { rmSync(tmp, { recursive: true }); } catch {} });

  it("indexes files and symbols", () => {
    const graph = new CallGraph(tmp);
    const stats = graph.scan();
    assert.ok(stats.files > 0, "must index files");
    assert.ok(stats.symbols > 0, "must have symbols");
  });

  it("finds callers for leaf function", () => {
    const graph = new CallGraph(tmp);
    graph.scan();
    const callers = graph.callers(indexFile, "helper");
    const names = callers.map(c => c.name);
    assert.ok(names.includes("main"), "main should call helper, got: " + JSON.stringify(names));
  });

  it("finds callees for caller", () => {
    const graph = new CallGraph(tmp);
    graph.scan();
    const callees = graph.callees(indexFile, "main");
    const names = callees.map(c => c.name);
    assert.ok(names.includes("helper"), "main should call helper, got: " + JSON.stringify(names));
  });
});
