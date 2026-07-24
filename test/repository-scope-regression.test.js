import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/index.js"), "utf8");

test("watch_stop preserves repository binding", () => {
  assert.doesNotMatch(source, /indexes\.delete\(repoId\)/);
  assert.match(source, /indexes\.set\(repoId, slot\)/);
});

test("expand validates implicit target and refreshes target id", () => {
  assert.match(source, /resolveInsideRoot\(packet\._targetFile\)/);
  assert.match(source, /packet\._targetSymbolId\s*=\s*sid/);
});

test("patch proposal and validator are repository scoped", () => {
  assert.match(source, /repositoryId:\s*packet\._repositoryId/);
  assert.match(source, /repositoryRoot:\s*packet\._projectRoot/);
  assert.match(source, /requireIndex\(proposed\.repositoryId\)/);
  assert.match(source, /PATCH_REPOSITORY_BINDING_CHANGED/);
});

test("stable symbol path is NFC and slash canonical", () => {
  assert.match(source, /\.normalize\("NFC"\)/);
  assert.match(source, /\.replace\(\/\\\\\\\\\/g, "\/"\)/);
});
