import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { buildContextPacket } from "../src/compiler/packet-builder.js";

describe("buildContextPacket", () => {
  const tmpDir = "/tmp/code-shrinker-test-" + Date.now();
  const testFile = join(tmpDir, "test.js");

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testFile, `
function validate(input) {
  if (!input) throw new Error("Invalid");
  return db.save(input);
}
class Publisher {
  async publish(event) {
    await eventRepository.save(event);
    await broker.send(event);
  }
}
function helper() { return 42; }
`);
  });
  after(() => { try { rmSync(tmpDir, { recursive: true }); } catch {} });

  it("builds packet with contracts", async () => {
    const p = await buildContextPacket({ task: { type: "bugfix", description: "Fix null check", target: "validate" }, targetFile: testFile, tokenBudget: 8000, mode: "safe" });
    assert.ok(p.contextId);
    assert.ok(p.layers.contracts > 0);
  });

  it("target source is present", async () => {
    const p = await buildContextPacket({ task: { type: "bugfix", description: "Fix", target: "validate" }, targetFile: testFile, tokenBudget: 4000, mode: "aggressive" });
    const hasTarget = p.packet.sources.some(s => s.handle?.includes("validate"));
    assert.ok(hasTarget, "target exact source must be present");
  });

  it("loss manifest no double-count", async () => {
    const p = await buildContextPacket({ task: { type: "refactor", description: "Extract", target: "Publisher" }, targetFile: testFile, tokenBudget: 8000 });
    assert.ok(p.loss.removed.symbols <= p.layers.contracts);
    assert.equal(p.loss.removed.symbols, p.loss.removedSymbolIds.length);
  });
});
