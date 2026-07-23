import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildContextPacket } from "../src/compiler/packet-builder.js";

describe("coverage_manifest", () => {
  it("exists in packet output", async () => {
    const packet = await buildContextPacket({
      task: { taskType: "bugfix", repositoryId: "test/repo", commitSha: "abc123" },
      tokenBudget: 8000,
      qualityFloor: 0.7,
      mode: "safe",
      evidence: {},
    });
    
    assert.ok(packet.coverage_manifest, "coverage_manifest should exist");
    assert.equal(packet.coverage_manifest.protocol_version, 1);
    assert.equal(packet.coverage_manifest.repository_id, "test/repo");
    assert.equal(packet.coverage_manifest.commit_sha, "abc123");
  });

  it("has valid coverage entries", async () => {
    const packet = await buildContextPacket({
      task: { taskType: "bugfix", repositoryId: "test/r", commitSha: "abc" },
      tokenBudget: 8000,
      qualityFloor: 0.7,
      mode: "safe",
      evidence: {},
    });
    
    const validKinds = ["exact_source","contract","diagnostic","test","project_map","call_graph"];
    for (const entry of (packet.coverage_manifest?.covered || [])) {
      assert.ok(validKinds.includes(entry.kind), `valid kind: ${entry.kind}`);
    }
  });

  it("qualityFloor produces boolean qualitySatisfied", async () => {
    const packet = await buildContextPacket({
      task: { taskType: "bugfix" },
      tokenBudget: 8000,
      qualityFloor: 0.95,
      mode: "safe",
      evidence: {},
    });
    
    assert.ok(typeof packet.qualitySatisfied === "boolean");
    assert.ok(packet.estimatedQuality !== undefined);
    assert.ok(["low","medium","high"].includes(packet.risk));
  });

  it("qualityRecovery has hints on failure", async () => {
    const packet = await buildContextPacket({
      task: { taskType: "bugfix" },
      tokenBudget: 8000,
      qualityFloor: 1.0,
      mode: "safe",
      evidence: {},
    });
    
    if (!packet.qualitySatisfied) {
      assert.ok(packet.qualityRecovery, "qualityRecovery on fail");
      assert.ok(Array.isArray(packet.qualityRecovery.hints));
    }
  });
});
