import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { IncrementalIndex } from "../src/compiler/incremental-index.js";

describe("IncrementalIndex v0.1.0", () => {
  let idx;
  after(() => { try { idx?.stop(); } catch {} });

  it("start scans and begins watching", () => {
    idx = new IncrementalIndex(".");
    const result = idx.start({ interval: 300000 }); // 5 min for test
    assert.ok(result.files > 5, "should find >5 files");
    assert.ok(result.symbols > 10, "should find >10 symbols");
    assert.equal(result.watching, true);
  });

  it("status returns watching + counts", () => {
    const s = idx.status();
    assert.equal(s.watching, true);
    assert.ok(s.files > 0);
    assert.ok(s.symbols > 0);
    assert.ok(Array.isArray(s.changeLog));
  });

  it("snapshot captures current state", () => {
    const snap = idx.snapshot();
    assert.equal(snap.root, idx.root);
    assert.ok(snap.files > 0);
    assert.ok(snap.symbols > 0);
    assert.ok(Array.isArray(snap.entrypoints));
    assert.ok(snap.timestamp);
  });

  it("changedSymbols returns array", () => {
    const changed = idx.changedSymbols();
    assert.ok(Array.isArray(changed));
  });

  it("refresh without paths reindexes", () => {
    idx.refresh();
    const s = idx.status();
    assert.ok(s.files > 0);
  });

  it("stop sets watching to false", () => {
    idx.stop();
    assert.equal(idx.status().watching, false);
  });
});
