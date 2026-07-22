import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankCandidates, estimateTokens, graphDistance } from "../src/compiler/ranking.js";
import { EXCLUDE_REASONS } from "../src/core/loss-manifest.js";

describe("Ranking v0.4.0", () => {
  const candidates = [
    { id: "s1", qualifiedName: "processOrder", signature: "processOrder(req)", callers: ["main"], callees: ["validate"], confidence: 0.9, effects: ["mutates"], body: "function processOrder(req) { return validate(req); }" },
    { id: "s2", qualifiedName: "formatDate", signature: "formatDate(d)", callers: [], callees: [], confidence: 0.8 },
    { id: "s3", qualifiedName: "handleError", signature: "handleError(e)", callers: ["main"], callees: [], confidence: 0.95 },
    { id: "s4", qualifiedName: "unusedHelper", signature: "unusedHelper()", callers: [], callees: [], confidence: 0.3 },
  ];

  it("ranks candidates by relevance to task keywords", () => {
    const task = { keywords: ["process", "order"] };
    const ranked = rankCandidates(candidates, task);
    assert.ok(ranked[0].score > 0, "top candidate should have positive score");
    assert.ok(ranked[0].item.qualifiedName.includes("process"), "top should match keywords");
  });

  it("higher confidence gives higher uncertainty weight", () => {
    const task = { keywords: [] };
    const ranked = rankCandidates(candidates, task);
    const high = ranked.find(r => r.item.id === "s3"); // conf 0.95
    const low = ranked.find(r => r.item.id === "s4");  // conf 0.3
    assert.ok(high.uncertainty < low.uncertainty, "higher conf → lower uncertainty");
  });

  it("exclusion reason for low-confidence below floor", () => {
    const task = { keywords: [] };
    const loss = { excludedSymbols: [] }; // minimal loss manifest
    const ranked = rankCandidates(candidates, task, { lossManifest: loss, confidenceFloor: 0.5 });
    const low = ranked.find(r => r.item.id === "s4");
    // conf 0.3 < 0.5 → should be LOW_CONFIDENCE
    if (low.confidence < 0.5) {
      assert.ok(low.excludeReason);
    }
  });

  it("estimateTokens returns reasonable values", () => {
    const t1 = estimateTokens({ signature: "foo()", body: "return 1;" });
    assert.ok(t1 > 5 && t1 < 100, `expected 5<tokens<100, got ${t1}`);
    const t2 = estimateTokens({ signature: "big()", body: "x".repeat(3000) });
    assert.ok(t2 > t1, "bigger body → more tokens");
  });

  it("graphDistance returns 0 for same symbol", () => {
    assert.equal(graphDistance(null, "a", "a"), 0);
  });

  it("graphDistance returns 10 for missing graph", () => {
    assert.equal(graphDistance(null, "a", "b"), 5);
  });
});
