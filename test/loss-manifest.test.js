import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLossManifest, excludeFile, excludeSymbol, addUnresolvedCall,
         addParserFallback, addLowConfidence, finalizeLossManifest, EXCLUDE_REASONS }
  from "../src/core/loss-manifest.js";

describe("Loss Manifest v0.2.0", () => {
  it("creates manifest with schema version and token budget", () => {
    const m = createLossManifest({tokenBudget: 8000});
    assert.equal(m.schemaVersion, "0.2.0");
    assert.equal(m.tokenBudget, 8000);
    assert.equal(m.risk, "low");
  });

  it("excludeFile adds entry with machine-readable reason code", () => {
    const m = createLossManifest();
    excludeFile(m, "node_modules/big-lib.js", "EXTERNAL_DEPENDENCY");
    assert.equal(m.excludedFiles.length, 1);
    assert.equal(m.excludedFiles[0].reason, "EXTERNAL_DEPENDENCY");
    assert.ok(m.excludedFiles[0].retrievalId);
  });

  it("excludeSymbol adds retrieval ID", () => {
    const m = createLossManifest();
    excludeSymbol(m, "sym_abc123", "processData", "LOW_RELEVANCE");
    assert.equal(m.excludedSymbols[0].reason, "LOW_RELEVANCE");
    assert.ok(m.retrievableIds.length > 0);
  });

  it("addUnresolvedCall tracks edge type", () => {
    const m = createLossManifest();
    addUnresolvedCall(m, "main", "missingHelper", "import");
    assert.equal(m.unresolvedCalls[0].edgeType, "import");
  });

  it("addParserFallback records backend and lowers confidence", () => {
    const m = createLossManifest();
    addParserFallback(m, "foo.js", "javascript", "regex", ["unexpected token"]);
    assert.ok(m.parserFallbacks[0].confidence < 0.85);
  });

  it("addLowConfidence only records items below threshold", () => {
    const m = createLossManifest();
    addLowConfidence(m, "s1", "signature", 0.4, 0.7);
    addLowConfidence(m, "s2", "kind", 0.9, 0.7);
    assert.equal(m.lowConfidenceItems.length, 1);
  });

  it("finalizeLossManifest sets risk and requiresExpansion", () => {
    const m = createLossManifest();
    m.quality.targetCovered = false;
    finalizeLossManifest(m, {tokens: 500, originalTokens: 12000});
    assert.equal(m.risk, "critical");
    assert.equal(m.quality.requiresExpansion, true);
    assert.ok(m.expansionHint.includes("requires_expansion"));
  });

  it("EXCLUDE_REASONS has all 14 machine-readable codes", () => {
    assert.equal(Object.keys(EXCLUDE_REASONS).length, 14);
    assert.equal(EXCLUDE_REASONS.SECRET, "SECRET");
    assert.equal(EXCLUDE_REASONS.TOKEN_BUDGET, "TOKEN_BUDGET");
    assert.equal(EXCLUDE_REASONS.PARSE_FAILURE, "PARSE_FAILURE");
    assert.equal(EXCLUDE_REASONS.DUPLICATE, "DUPLICATE");
  });
});
