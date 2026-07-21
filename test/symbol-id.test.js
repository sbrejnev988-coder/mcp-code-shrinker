// ═══ symbol-id tests ═══
import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { createSymbolId, createSymbolRevisionFromSource, createFileRevision } from "../src/core/symbol-id.js";

describe("createSymbolId", () => {
  it("produces stable ID for same inputs", () => {
    const id1 = createSymbolId({ language: "javascript", nodeType: "function", qualifiedName: "Publisher.publish", signature: "async publish(event: Event): Promise<void>" });
    const id2 = createSymbolId({ language: "javascript", nodeType: "function", qualifiedName: "Publisher.publish", signature: "async publish(event: Event): Promise<void>" });
    assert.equal(id1, id2);
  });

  it("produces different ID for different signature", () => {
    const id1 = createSymbolId({ language: "javascript", nodeType: "function", qualifiedName: "X.foo", signature: "foo(a: string)" });
    const id2 = createSymbolId({ language: "javascript", nodeType: "function", qualifiedName: "X.foo", signature: "foo(a: number)" });
    assert.notEqual(id1, id2);
  });

  it("produces different ID for different qualifiedName", () => {
    const id1 = createSymbolId({ language: "javascript", nodeType: "function", qualifiedName: "A.foo", signature: "()" });
    const id2 = createSymbolId({ language: "javascript", nodeType: "function", qualifiedName: "B.foo", signature: "()" });
    assert.notEqual(id1, id2);
  });
});

describe("createSymbolRevisionFromSource", () => {
  it("changes when body changes (even if signature same)", () => {
    const sig = "function foo()";
    const rev1 = createSymbolRevisionFromSource("function foo() { return 1; }", sig);
    const rev2 = createSymbolRevisionFromSource("function foo() { return 2; }", sig);
    assert.notEqual(rev1, rev2);
  });

  it("stable for identical body", () => {
    const sig = "function bar(x)";
    const body = "function bar(x) { return x * 2; }";
    assert.equal(createSymbolRevisionFromSource(body, sig), createSymbolRevisionFromSource(body, sig));
  });
});

describe("createFileRevision", () => {
  it("changes when file content changes", () => {
    const r1 = createFileRevision("line1\nline2");
    const r2 = createFileRevision("line1\nline3");
    assert.notEqual(r1, r2);
  });

  it("stable for identical content", () => {
    const c = "const x = 1;\nconst y = 2;\n";
    assert.equal(createFileRevision(c), createFileRevision(c));
  });
});
