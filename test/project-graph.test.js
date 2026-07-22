import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { ProjectGraph, EDGE_TYPES } from "../src/compiler/project-graph.js";

describe("ProjectGraph v0.1.0", () => {
  let pg;
  before(() => {
    pg = new ProjectGraph(".");
    pg.scan();
  });

  it("scans project and finds files + symbols", () => {
    assert.ok(pg.nodes.size > 5, "should find at least 5 files");
    assert.ok(pg.edges.size > 20, "should find at least 20 symbols");
  });

  it("detects entrypoints", () => {
    assert.ok(pg.entrypoints.length >= 1, "should detect at least 1 entrypoint");
    const idx = pg.entrypoints.find(e => e.file.includes("index.js"));
    assert.ok(idx, "src/index.js should be an entrypoint");
  });

  it("exports per file", () => {
    const exp = pg.exports("src/core/ast-engine.js");
    assert.ok(Array.isArray(exp), "exports should be array");
    // ast-engine exports detectLanguage, parseFile, etc.
  });

  it("callers query returns array", () => {
    const callers = pg.callers("src/core/ast-engine.js", "parseFile");
    assert.ok(Array.isArray(callers));
    assert.ok(callers.length >= 1, "parseFile should have callers");
  });

  it("callees query returns array", () => {
    const callees = pg.callees("src/index.js", "registerTools");
    assert.ok(Array.isArray(callees));
  });

  it("getSymbol resolves by id", () => {
    const firstSym = [...pg.edges.keys()][0];
    if (firstSym) {
      const sym = pg.getSymbol(firstSym);
      assert.ok(sym);
      assert.ok(sym.qualifiedName || sym.name);
    }
  });

  it("toContextSlice builds slice", () => {
    const slice = pg.toContextSlice(["src/core"], 1);
    assert.ok(slice.symbols);
    assert.ok(Object.keys(slice.symbols).length >= 1);
    assert.ok(Array.isArray(slice.edges));
  });

  it("EDGE_TYPES has all expected types", () => {
    assert.equal(EDGE_TYPES.IMPORT, "import");
    assert.equal(EDGE_TYPES.CALLS, "calls");
    assert.equal(EDGE_TYPES.INHERITS, "inherits");
    assert.equal(EDGE_TYPES.EXPORT, "export");
    assert.equal(EDGE_TYPES.ENTRYPOINT, "entrypoint");
  });
});
