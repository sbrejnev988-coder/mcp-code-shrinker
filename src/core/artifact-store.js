// ═══ Artifact Store v0.1.0 — Content-addressed, compressed, TTL-managed ═══
import { createHash } from "crypto";
import { deflateSync, inflateSync } from "zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const STORE_ROOT = process.env.CODE_SHRINKER_ARTIFACT_ROOT || resolve(process.env.HOME || "/root", ".hermes/cache/code-shrinker-artifacts");
const METADATA_FILE = join(STORE_ROOT, "_metadata.json");
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024; // 50 MB
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk

let _meta = null;

function _loadMeta() {
  if (_meta) return _meta;
  try { _meta = JSON.parse(readFileSync(METADATA_FILE, "utf-8")); }
  catch { _meta = { artifacts: {}, refs: {} }; }
  return _meta;
}

function _saveMeta() {
  mkdirSync(STORE_ROOT, { recursive: true });
  writeFileSync(METADATA_FILE, JSON.stringify(_meta, null, 2));
}

function _artifactPath(hash) {
  return join(STORE_ROOT, hash.slice(0, 2), hash);
}

/**
 * Store content and return artifact metadata.
 * Returns: { artifactId, contentHash, size, compressed, mimeType }
 */
export function artifactPut(content, opts = {}) {
  const raw = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  if (raw.length > MAX_ARTIFACT_BYTES) throw new Error(`Artifact too large: ${raw.length} > ${MAX_ARTIFACT_BYTES}`);

  const hash = createHash("sha256").update(raw).digest("hex");
  const meta = _loadMeta();

  // Dedup: return existing if same hash
  if (meta.artifacts[hash]) {
    meta.artifacts[hash].refs = (meta.artifacts[hash].refs || 0) + 1;
    _saveMeta();
    return { artifactId: hash, contentHash: hash, size: meta.artifacts[hash].size,
             compressed: meta.artifacts[hash].compressed, mimeType: meta.artifacts[hash].mimeType,
             chunkCount: meta.artifacts[hash].chunkCount || 1 };
  }

  const compressed = opts.compress !== false;
  const stored = compressed ? deflateSync(raw) : raw;
  const path = _artifactPath(hash);

  mkdirSync(join(STORE_ROOT, hash.slice(0, 2)), { recursive: true });

  // Chunk if large
  const chunkCount = Math.ceil(stored.length / CHUNK_SIZE);
  if (chunkCount > 1) {
    for (let i = 0; i < chunkCount; i++) {
      const chunk = stored.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      writeFileSync(`${path}.chunk${i}`, chunk);
    }
  } else {
    writeFileSync(path, stored);
  }

  const mimeType = opts.mimeType || (typeof content === "string" ? "text/plain" : "application/octet-stream");

  meta.artifacts[hash] = {
    hash, size: raw.length, compressedSize: stored.length, compressed,
    mimeType, chunkCount: Math.max(1, chunkCount),
    created: new Date().toISOString(),
    ttl: opts.ttl || 0, // 0 = no expiry
    pinned: opts.pin || false,
    redacted: opts.redacted || false,
    sensitive: opts.sensitive || false,
    refs: 1,
    tags: opts.tags || [],
  };
  _saveMeta();

  return { artifactId: hash, contentHash: hash, size: raw.length, compressed,
           compressedSize: stored.length, mimeType, chunkCount: Math.max(1, chunkCount) };
}

/**
 * Read artifact by ID. Returns Buffer.
 */
export function artifactGet(artifactId, opts = {}) {
  const meta = _loadMeta();
  const entry = meta.artifacts[artifactId];
  if (!entry) return null;

  const path = _artifactPath(artifactId);
  let data;

  if (entry.chunkCount > 1) {
    const chunks = [];
    for (let i = 0; i < entry.chunkCount; i++) {
      const cp = `${path}.chunk${i}`;
      if (!existsSync(cp)) return null;
      chunks.push(readFileSync(cp));
    }
    data = Buffer.concat(chunks);
  } else {
    if (!existsSync(path)) return null;
    data = readFileSync(path);
  }

  if (entry.compressed) data = inflateSync(data);

  const hash = createHash("sha256").update(data).digest("hex");
  if (hash !== artifactId) throw new Error(`Integrity check failed: ${hash.slice(0, 12)} !== ${artifactId.slice(0, 12)}`);

  return opts.asText ? data.toString("utf-8") : data;
}

/**
 * Read a single chunk. Returns Buffer.
 */
export function artifactGetChunk(artifactId, chunkIndex) {
  const meta = _loadMeta();
  const entry = meta.artifacts[artifactId];
  if (!entry || chunkIndex >= (entry.chunkCount || 1)) return null;

  const path = _artifactPath(artifactId);
  const cp = entry.chunkCount > 1 ? `${path}.chunk${chunkIndex}` : path;
  if (!existsSync(cp)) return null;

  let data = readFileSync(cp);
  if (entry.chunkCount === 1 && entry.compressed) {
    // Single chunk compressed — decompress for text preview
    try { data = inflateSync(data); } catch {}
  }
  return { chunkIndex, data: data.toString("utf-8").slice(0, 5000), totalChunks: entry.chunkCount };
}

/**
 * Copy text from artifact (self-contained, ready for paste).
 */
export function artifactCopyText(artifactId) {
  const meta = _loadMeta();
  const entry = meta.artifacts[artifactId];
  if (!entry) return null;

  const buf = artifactGet(artifactId);
  if (!buf) return null;

  const text = typeof buf === "string" ? buf : buf.toString("utf-8");
  const hash = createHash("sha256").update(text).digest("hex");

  return `[ARTIFACT ${artifactId.slice(0, 12)}]
Hash: ${hash}
Size: ${entry.size} bytes
MIME: ${entry.mimeType}
Created: ${entry.created}
---CONTENT---
${text.length > 100000 ? text.slice(0, 100000) + `\n... [truncated, ${text.length - 100000} more bytes]` : text}
---END ARTIFACT---`;
}

/**
 * Pin/unpin artifact (pinned artifacts survive GC).
 */
export function artifactPin(artifactId, pin = true) {
  const meta = _loadMeta();
  if (!meta.artifacts[artifactId]) return null;
  meta.artifacts[artifactId].pinned = pin;
  _saveMeta();
  return { artifactId, pinned: pin };
}

/**
 * Delete artifact and its files.
 */
export function artifactDelete(artifactId) {
  const meta = _loadMeta();
  const entry = meta.artifacts[artifactId];
  if (!entry) return null;
  if (entry.pinned) throw new Error("Cannot delete pinned artifact — unpin first");

  const path = _artifactPath(artifactId);
  try { unlinkSync(path); } catch {}
  for (let i = 0; i < (entry.chunkCount || 1); i++) {
    try { unlinkSync(`${path}.chunk${i}`); } catch {}
  }
  delete meta.artifacts[artifactId];
  _saveMeta();
  return { deleted: artifactId };
}

/**
 * Garbage collect: remove expired and unpinned artifacts.
 */
export function artifactGC() {
  const meta = _loadMeta();
  const now = Date.now();
  const removed = [];

  for (const [id, entry] of Object.entries(meta.artifacts)) {
    if (entry.pinned) continue;
    if (entry.ttl > 0 && new Date(entry.created).getTime() + entry.ttl * 1000 < now) {
      artifactDelete(id);
      removed.push(id);
    }
  }

  _saveMeta();
  return { removed: removed.length, ids: removed.map(id => id.slice(0, 12)) };
}

/**
 * List all artifacts with metadata.
 */
export function artifactList(opts = {}) {
  const meta = _loadMeta();
  let entries = Object.values(meta.artifacts);
  if (opts.pinned) entries = entries.filter(e => e.pinned);
  if (opts.tag) entries = entries.filter(e => e.tags?.includes(opts.tag));
  entries.sort((a, b) => new Date(b.created) - new Date(a.created));
  if (opts.limit) entries = entries.slice(0, opts.limit);
  return entries.map(e => ({
    artifactId: e.hash.slice(0, 12),
    size: e.size,
    compressed: e.compressed,
    mimeType: e.mimeType,
    pinned: e.pinned,
    created: e.created,
    tags: e.tags,
    chunkCount: e.chunkCount || 1,
  }));
}

/**
 * Store stats.
 */
export function artifactStats() {
  const meta = _loadMeta();
  const entries = Object.values(meta.artifacts);
  const totalSize = entries.reduce((s, e) => s + e.size, 0);
  const totalCompressed = entries.reduce((s, e) => s + (e.compressedSize || e.size), 0);
  return {
    count: entries.length,
    pinned: entries.filter(e => e.pinned).length,
    totalBytes: totalSize,
    compressedBytes: totalCompressed,
    compressionRatio: totalSize > 0 ? Math.round((1 - totalCompressed / totalSize) * 100) : 0,
    storePath: STORE_ROOT,
  };
}

export { STORE_ROOT, MAX_ARTIFACT_BYTES, CHUNK_SIZE };
