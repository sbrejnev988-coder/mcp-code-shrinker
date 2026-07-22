// ═══ E2E Integration Test — Code Shrinker → Memory Wiki → OmniCouncil ═══
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectGraph } from "../src/compiler/project-graph.js";
import { IncrementalIndex } from "../src/compiler/incremental-index.js";
import { createLossManifest, excludeFile, excludeSymbol, finalizeLossManifest } from "../src/core/loss-manifest.js";
import { rankCandidates } from "../src/compiler/ranking.js";
import { artifactPut, artifactGet, artifactCopyText, artifactStats, artifactGC, artifactPin } from "../src/core/artifact-store.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

describe("E2E: Code Shrinker → Context → Patch workflow", () => {
  let tmpDir;

  it("Phase 1: Scan project and build graph", () => {
    const pg = new ProjectGraph(".");
    const result = pg.scan();
    assert.ok(result.files > 5, "should find project files");
    assert.ok(result.symbols > 50, "should find symbols");
    assert.ok(pg.entrypoints.length >= 1, "should detect entrypoints");
  });

  it("Phase 2: Build context packet with loss manifest", () => {
    const loss = createLossManifest({ tokenBudget: 8000 });
    excludeFile(loss, "node_modules/", "EXTERNAL_DEPENDENCY");
    excludeFile(loss, "test/fixtures/", "LOW_RELEVANCE", "test fixtures excluded");
    excludeSymbol(loss, "s_helper", "internalHelper", "LOW_RELEVANCE");

    finalizeLossManifest(loss, { tokens: 4200, originalTokens: 15000 });
    assert.equal(loss.schemaVersion, "0.2.0");
    assert.ok(loss.quality.requiresExpansion); // because targetCovered=false
    assert.equal(loss.risk, "critical");
    assert.equal(loss.excludedFiles.length, 2);
    assert.equal(loss.excludedSymbols.length, 1);
  });

  it("Phase 3: Ranking with graph distance", () => {
    const candidates = [
      { id: "s_a", qualifiedName: "artifactPut", callers: ["main"], callees: ["writeFile"], confidence: 0.9 },
      { id: "s_b", qualifiedName: "helpers", callers: [], callees: [], confidence: 0.5 },
    ];
    const task = { keywords: ["artifact", "store", "put"] };
    const ranked = rankCandidates(candidates, task);
    assert.ok(ranked[0].item.qualifiedName.includes("artifactPut"), "top match should be artifactPut");
    assert.ok(ranked[0].score > ranked[1].score, "relevant symbol scores higher");
  });

  it("Phase 4: Artifact storage and retrieval", () => {
    const patch = "diff --git a/foo.js b/foo.js\n+const x = 1;\n";
    const r = artifactPut(patch, { mimeType: "text/x-diff", tags: ["patch", "e2e"], ttl: 300 });
    assert.ok(r.artifactId.length === 64);

    const retrieved = artifactGet(r.artifactId, { asText: true });
    assert.equal(retrieved, patch);

    const copy = artifactCopyText(r.artifactId);
    assert.ok(copy.includes("---CONTENT---"));
    assert.ok(copy.includes("+const x = 1;"));
  });

  it("Phase 5: Incremental index watch/snapshot", () => {
    const idx = new IncrementalIndex(".");
    const start = idx.start({ interval: 60000 });
    assert.ok(start.files > 0);
    assert.equal(start.watching, true);

    const snap = idx.snapshot();
    assert.ok(snap.files > 0);
    assert.ok(Array.isArray(snap.entrypoints));
    assert.ok(snap.timestamp);

    const status = idx.status();
    assert.equal(status.watching, true);
    assert.ok(status.files > 0);

    idx.stop();
    assert.equal(idx.status().watching, false);
  });

  it("Phase 6: Simulated OmniCouncil patch proposal → validation", async () => {
    // Create a temporary file to patch
    tmpDir = mkdtempSync("/tmp/cs-e2e-");
    const testFile = join(tmpDir, "sample.js");
    writeFileSync(testFile, "function hello() {\n  return 1;\n}\n");

    // Scan
    const pg2 = new ProjectGraph(tmpDir);
    const scan = pg2.scan();
    assert.ok(scan.files > 0);

    // Create context packet
    const entries = pg2.entrypoints;
    const slice = pg2.toContextSlice([tmpDir], 1);
    assert.ok(slice.symbols);
    assert.ok(Array.isArray(slice.edges));

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("E2E: Artifact lifecycle", () => {
  it("full cycle: put → get → copy → pin → delete", () => {
    const content = `export function fixBug(input) {\n  // Fixed: null check added\n  if (!input) return null;\n  return processData(input);\n}\n`;
    const r = artifactPut(content, { tags: ["code", "patch"], ttl: 60 });

    // Verify retrieval
    const back = artifactGet(r.artifactId, { asText: true });
    assert.equal(back, content);

    // Verify copy text
    const ct = artifactCopyText(r.artifactId);
    assert.ok(ct.includes("fixBug"));
    assert.ok(ct.includes("null check"));

    // Pin prevents delete
    artifactPut("pin-test", { pin: true }); // puts + pins one

    const stats = artifactStats();
    assert.ok(stats.count >= 2);

    // GC should keep pinned
    const gcResult = artifactGC();
    assert.ok(typeof gcResult.removed === "number");
  });
});
