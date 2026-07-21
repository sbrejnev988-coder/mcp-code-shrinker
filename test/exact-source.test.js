import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { parseFile } from "../src/core/ast-engine.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

describe("exact source extraction", () => {
  const tmp = "/tmp/exact-source-test-" + Date.now();
  before(() => { mkdirSync(tmp, { recursive: true }); });
  after(() => { try { rmSync(tmp, { recursive: true }); } catch {} });

  it("returns byte-exact declaration for function", () => {
    const code = "export async function publish(event) {\n  await broker.send(event);\n}\n";
    writeFileSync(join(tmp, "test.js"), code);
    const parsed = parseFile(join(tmp, "test.js"));
    assert.ok(parsed.symbols.length > 0);
    const sym = parsed.symbols.find(s => s.name === "publish");
    assert.ok(sym, "must find publish");
    assert.ok(sym.body.startsWith("export"), "body must start with 'export': " + sym.body?.slice(0, 40));
    assert.ok(sym.body.includes("broker.send"), "body must contain function logic");
    assert.ok(sym.body.endsWith("}\n") || sym.body.endsWith("}"), "body must end with closing brace");
  });

  it("returns declaration for class", () => {
    const code = "export class Publisher {\n  async publish(e) {}\n}\n";
    writeFileSync(join(tmp, "test2.js"), code);
    const parsed = parseFile(join(tmp, "test2.js"));
    const sym = parsed.symbols.find(s => s.name === "Publisher");
    assert.ok(sym, "must find Publisher");
    assert.ok(sym.body.startsWith("export"), "body must include 'export'");
    assert.ok(sym.body.includes("async publish"), "body must include method");
  });

  it("control flow keywords not matched as methods", () => {
    const code = "function foo() { if (x) return; while (y) doThing(); for (;;) break; }\n";
    writeFileSync(join(tmp, "test3.js"), code);
    const parsed = parseFile(join(tmp, "test3.js"));
    const methods = parsed.symbols.filter(s => s.kind === "method");
    assert.equal(methods.length, 0, "if/while/for must not be methods");
    assert.equal(parsed.symbols.length, 1, "only foo should be detected");
  });
});
