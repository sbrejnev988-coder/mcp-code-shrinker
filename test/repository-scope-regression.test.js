import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSymbolId } from "../src/core/symbol-id.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/index.js"), "utf8");

test("watch_stop preserves the repository binding", () => {
  assert.doesNotMatch(source, /indexes\.delete\(repoId\)/);
  assert.match(
    source,
    /handleWatchStop[\s\S]*slot\.index\.stop\(\)[\s\S]*repository_id:\s*repoId/,
  );
});

test("context.expand validates implicit target against the repository slot", () => {
  assert.match(
    source,
    /else if \(packet\._targetFile\)\s*\{[\s\S]*resolveInsideRoot\(packet\._targetFile\)[\s\S]*isInside\(slot\.root,\s*fp\)/,
  );
  assert.match(source, /packet\._targetSymbolId\s*=\s*sid/);
});

test("patch proposal, validation and application remain repository scoped", () => {
  assert.match(source, /const repositoryId\s*=\s*String\(packet\._repositoryId/);
  assert.match(source, /repositoryRoot:\s*repositorySlot\.root/);
  assert.ok(
    (source.match(/requireIndex\(proposed\.repositoryId\)/g) || []).length >= 2,
  );
  assert.ok((source.match(/PATCH_REPOSITORY_MISMATCH/g) || []).length >= 2);
});

test("createSymbolId treats NFC/NFD and slash variants identically", () => {
  const common = {
    language: "javascript",
    nodeType: "function",
    qualifiedName: "café.run",
    signature: "run()",
  };

  const nfc = createSymbolId({
    ...common,
    projectRelativePath: "src/café.js",
  });
  const nfd = createSymbolId({
    ...common,
    projectRelativePath: "src/cafe\u0301.js",
  });
  const windows = createSymbolId({
    ...common,
    projectRelativePath: "src\\café.js",
  });

  assert.equal(nfc, nfd);
  assert.equal(nfc, windows);
});
