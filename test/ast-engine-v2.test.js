import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFile, detectLanguage, PARSER_VERSION, parserMeta } from "../src/core/ast-engine.js";

describe("parser metadata (v0.4.0)", () => {
  it("PARSER_VERSION is semver", () => assert.match(PARSER_VERSION, /^\d+\.\d+\.\d+$/));

  it("parserMeta shape", () => {
    const m = parserMeta("enhanced-regex", 0.85, ["e"], true);
    assert.equal(m.backend, "enhanced-regex");
    assert.equal(m.version, PARSER_VERSION);
    assert.equal(m.confidence, 0.85);
    assert.equal(m.fallback, true);
  });

  it("parseFile includes parser metadata", () => {
    const r = parseFile("test/fixtures/sample.js");
    assert.ok(r.parser);
    assert.equal(r.parser.backend, "enhanced-regex");
    assert.ok(r.parser.confidence > 0);
  });

  it("parseFile returns symbols array", () => {
    const r = parseFile("test/fixtures/sample.js");
    assert.ok(Array.isArray(r.symbols));
    assert.ok(r.symbols.length >= 5);
  });

  it("symbols have required fields", () => {
    const s = parseFile("test/fixtures/sample.js").symbols[0];
    assert.ok(s.qualifiedName);
    assert.ok(s.kind);
    assert.ok(s.startLine > 0);
    assert.ok(s.signature);
  });
});

describe("symbol detection", () => {
  it("hello function", () => {
    const s = parseFile("test/fixtures/sample.js").symbols;
    assert.ok(s.find(x => x.qualifiedName === "hello"));
  });
  it("Greeter class + 3 methods", () => {
    const s = parseFile("test/fixtures/sample.js").symbols;
    assert.ok(s.find(x => x.qualifiedName === "Greeter" && x.kind === "class"));
    assert.equal(s.filter(x => x.kind === "method").length, 3);
  });
});

describe("detectLanguage", () => {
  it("js/ts/py/sh/json/yml", () => {
    assert.equal(detectLanguage("a.js"), "javascript");
    assert.equal(detectLanguage("a.ts"), "typescript");
    assert.equal(detectLanguage("a.py"), "python");
    assert.equal(detectLanguage("a.sh"), "bash");
    assert.equal(detectLanguage("a.json"), "json");
    assert.equal(detectLanguage("a.yml"), "yaml");
    assert.equal(detectLanguage("a.xyz"), "text");
  });
});
