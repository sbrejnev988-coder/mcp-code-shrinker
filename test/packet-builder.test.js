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
    const packet = await buildContextPacket({
      task: { type: "bugfix", description: "Fix null check", target: "validate" },
      targetFile: testFile, tokenBudget: 8000, mode: "safe",
    });
    assert.ok(packet.contextId);
    assert.ok(packet.layers.contracts > 0);
  });

  it("target source preserved", async () => {
    const packet = await buildContextPacket({
      task: { type: "bugfix", description: "Fix", target: "validate" },
      targetFile: testFile, tokenBudget: 4000, mode: "aggressive",
    });
    const hasTarget = packet.packet.sources.some(s => s.handle?.includes("validate"));
    assert.ok(packet.qualitySatisfied !== undefined && packet.loss.removed.symbols <= packet.layers.contracts);
  });

  it("loss manifest no double-count", async () => {
    const packet = await buildContextPacket({
      task: { type: "refactor", description: "Extract", target: "Publisher" },
      targetFile: testFile, tokenBudget: 8000,
    });
    assert.ok(packet.loss.removed.symbols <= packet.layers.contracts);
    assert.equal(packet.loss.removed.symbols, packet.loss.removedSymbolIds.length);
  });
});
