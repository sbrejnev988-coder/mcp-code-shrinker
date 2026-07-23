import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { buildContextPacket } from "../src/compiler/packet-builder.js";

const tmpDir = "/tmp/cs-cov-test-" + Date.now();
mkdirSync(tmpDir, { recursive: true });
const testFile = join(tmpDir, "target.js");
writeFileSync(testFile, `
function targetFunction(x) {
  if (x === null) throw new TypeError("null value");
  return x * 2;
}
function helperFunction(y) { return y + 1; }
export { targetFunction, helperFunction };
`);

describe("coverage_manifest (fixed)", () => {
  it("is non-empty and has correct structure", async () => {
    const packet = await buildContextPacket({
      task: { taskType: "bugfix", repositoryId: "test/repo", commitSha: "abc123" },
      targetFile: testFile,
      tokenBudget: 8000,
      qualityFloor: 0.7,
      mode: "safe",
      evidence: {
        tests: "targetFunction fails with null input",
        diagnostics: "TypeError at line 2",
      },
    });
    
    assert.ok(packet.coverage_manifest, "coverage_manifest exists");
    assert.ok(packet.coverage_manifest.covered.length > 0, 
      "coverage manifest must NOT be empty — has " + packet.coverage_manifest.covered.length + " entries");
    assert.ok(
      packet.coverage_manifest.covered.some(e => e.kind === "exact_source"),
      "must have at least one exact_source"
    );
    assert.ok(
      packet.coverage_manifest.covered.some(e => e.kind === "diagnostic" || e.kind === "test"),
      "must have evidence coverage"
    );
    
    // Validate all entries
    for (const entry of packet.coverage_manifest.covered) {
      assert.ok(["exact_source","contract","diagnostic","test","project_map","call_graph"].includes(entry.kind));
      assert.ok(entry.content_hash, `missing content_hash for ${entry.kind}`);
      assert.ok(entry.token_count > 0, `token_count must be > 0 for ${entry.kind}: got ${entry.token_count}`);
    }
    console.log(`  PASS: ${packet.coverage_manifest.covered.length} entries, all valid`);
  });

  it("uses contextId as packet_id", async () => {
    const packet = await buildContextPacket({
      task: { taskType: "bugfix", repositoryId: "test/r", commitSha: "abc" },
      targetFile: testFile,
      tokenBudget: 8000,
      qualityFloor: 0.7,
      mode: "safe",
      evidence: {},
    });
    
    assert.ok(packet.contextId, "contextId should exist");
    assert.equal(packet.coverage_manifest.packet_id, packet.contextId, 
      "coverage manifest packet_id must match contextId");
  });
});

// Cleanup
process.on("exit", () => { try { rmSync(tmpDir, { recursive: true }); } catch {} });
