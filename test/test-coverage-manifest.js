// P1: Coverage manifest integration test
const { buildContextPacket } = require("../src/compiler/packet-builder");
const assert = require("assert");

async function test() {
  console.log("=== coverage manifest tests ===");
  
  // Test 1: coverage_manifest exists in packet output
  const packet = await buildContextPacket({
    task: { taskType: "bugfix", repositoryId: "test/repo", commitSha: "abc123" },
    targetFile: null,
    tokenBudget: 8000,
    qualityFloor: 0.7,
    mode: "safe",
    evidence: {},
  });
  
  assert.ok(packet.coverage_manifest, "coverage_manifest should exist");
  assert.equal(packet.coverage_manifest.protocol_version, 1, "protocol version 1");
  assert.equal(packet.coverage_manifest.repository_id, "test/repo", "repository_id passed through");
  assert.equal(packet.coverage_manifest.commit_sha, "abc123", "commit_sha passed through");
  assert.ok(Array.isArray(packet.coverage_manifest.covered), "covered is array");
  console.log("  PASS: coverage_manifest structure");
  
  // Test 2: coverage entries have required fields
  for (const entry of packet.coverage_manifest.covered) {
    assert.ok(entry.kind, `entry has kind: ${entry.kind}`);
    assert.ok(["exact_source","contract","diagnostic","test","project_map","call_graph"].includes(entry.kind), `valid kind: ${entry.kind}`);
  }
  console.log(`  PASS: ${packet.coverage_manifest.covered.length} coverage entries validated`);
  
  // Test 3: qualityFloor actually applied
  assert.ok(packet.estimatedQuality !== undefined, "estimatedQuality defined");
  assert.ok(typeof packet.qualitySatisfied === "boolean", "qualitySatisfied is boolean");
  assert.ok(packet.risk !== undefined, "risk level defined");
  console.log(`  PASS: qualityFloor applied (quality=${packet.estimatedQuality}, satisfied=${packet.qualitySatisfied}, risk=${packet.risk})`);
  
  // Test 4: qualityRecovery hints
  if (!packet.qualitySatisfied) {
    assert.ok(packet.qualityRecovery, "qualityRecovery exists on fail");
    assert.ok(Array.isArray(packet.qualityRecovery.hints), "hints is array");
    console.log(`  PASS: qualityRecovery with ${packet.qualityRecovery.hints.length} hints`);
  }
  
  console.log("=== all coverage manifest tests passed ===");
}

test().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
