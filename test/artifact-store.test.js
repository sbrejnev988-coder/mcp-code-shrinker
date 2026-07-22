import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { artifactPut, artifactGet, artifactCopyText, artifactList,
         artifactStats, artifactPin, artifactDelete, artifactGC, artifactGetChunk }
  from "../src/core/artifact-store.js";

describe("Artifact Store v0.1.0", () => {
  const ids = [];
  after(() => { for (const id of ids) try { artifactPin(id, false); artifactDelete(id); } catch {} });

  it("put returns hash + metadata", () => {
    const r = artifactPut("test content");
    ids.push(r.artifactId);
    assert.equal(r.artifactId.length, 64);
    assert.ok(r.size > 0);
  });

  it("get retrieves original", () => {
    assert.equal(artifactGet(ids[0], {asText:true}), "test content");
  });

  it("get returns null for unknown id", () => {
    assert.equal(artifactGet("00".repeat(32)), null);
  });

  it("deduplicates identical", () => {
    const r1 = artifactPut("abc"); ids.push(r1.artifactId);
    const r2 = artifactPut("abc");
    assert.equal(r1.artifactId, r2.artifactId);
  });

  it("copyText is self-contained", () => {
    const ct = artifactCopyText(ids[0]);
    assert.ok(ct.includes("[ARTIFACT"));
    assert.ok(ct.includes("test content"));
  });

  it("list returns array", () => {
    assert.ok(Array.isArray(artifactList({limit:100})));
  });

  it("stats returns counts", () => {
    assert.ok(artifactStats().count >= 1);
  });

  it("pin prevents delete", () => {
    artifactPin(ids[0], true);
    assert.throws(() => artifactDelete(ids[0]), /pinned/);
    artifactPin(ids[0], false);
  });

  it("gc does not crash", () => {
    const r = artifactPut("exp-"+Date.now(), {ttl:1});
    ids.push(r.artifactId);
    artifactGC();
    assert.ok(true);
  });

  it("chunk access works", () => {
    const r = artifactPut("x".repeat(100000));
    ids.push(r.artifactId);
    assert.ok(artifactGetChunk(r.artifactId, 0));
  });
});
