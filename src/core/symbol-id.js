// ═══ Stable Symbol Identity v2.1 ═══
// symbolId       = hash(language + nodeType + qualifiedName + normalizedSignature)
// symbolRevision = hash(full normalized AST subtree) ← FIXED: now tracks body changes
// fileRevision   = hash(full file content)

import { createHash } from "crypto";

const HASH_LEN = 12;

/** Normalize signature: strip whitespace, sort generic params */
function normalizeSignature(sig) {
  if (!sig) return "";
  return sig.replace(/\s+/g, " ").replace(/async\s+/g, "").trim();
}

/** Normalize AST subtree for revision hashing */
function normalizeSubtree(node) {
  if (!node) return "";
  // Recursively normalize: type + name + normalized children
  const parts = [node.kind || "unknown", node.name || "", node.qualifiedName || ""];
  if (node.signature) parts.push(normalizeSignature(node.signature));
  if (node.children) {
    for (const child of node.children) {
      parts.push(normalizeSubtree(child));
    }
  }
  return parts.join("|");
}

/**
 * Create stable symbol identity (survives neighbor edits)
 */
export function createSymbolId({ language, nodeType, qualifiedName, signature, declarationOrdinal = 0 }) {
  const key = [language, nodeType, qualifiedName, normalizeSignature(signature), declarationOrdinal > 0 ? `#${declarationOrdinal}` : ""].join("|");
  return `sym_${shaShort(key)}`;
}

/**
 * Create revision from FULL normalized AST subtree
 * Changing body → new revision. Changing signature → new symbolId.
 */
export function createSymbolRevision(normalizedAstSubtree) {
  if (!normalizedAstSubtree) return "000000000000";
  return shaShort(String(normalizedAstSubtree));
}

/**
 * Create revision from raw source body (fallback when AST unavailable)
 */
export function createSymbolRevisionFromSource(sourceBody, signature) {
  // Hash the EXACT body + signature — any change anywhere triggers new revision
  return shaShort(signature + "::" + sourceBody);
}

/** Hash of full file content */
export function createFileRevision(fileContent) {
  return shaShort(fileContent);
}

/** Hash of project-level state */
export function createProjectRevision(input) {
  return shaShort(typeof input === "string" ? input : JSON.stringify(input));
}

function shaShort(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_LEN);
}

/** Validate context freshness */
export function validateContext(expected, actual) {
  if (expected.fileRevision && expected.fileRevision !== actual.fileRevision) {
    return { valid: false, error: "STALE_FILE", expected: expected.fileRevision, actual: actual.fileRevision };
  }
  if (expected.symbolRevision && expected.symbolRevision !== actual.symbolRevision) {
    return { valid: false, error: "STALE_SYMBOL", symbolId: expected.symbolId, expected: expected.symbolRevision, actual: actual.symbolRevision };
  }
  return { valid: true };
}

/**
 * Session handle registry for metadata aliases (NEVER used in source code)
 */
export class SessionHandleRegistry {
  constructor() { this._handles = new Map(); this._reverse = new Map(); this._counter = 0; }

  register(symbolId, qualifiedName, file) {
    const existing = this._reverse.get(symbolId);
    if (existing) return existing;
    const shortName = qualifiedName.split(".").pop() || qualifiedName;
    let handle = `@${shortName}`;
    if (this._handles.has(handle)) handle = `@S${++this._counter}`;
    this._handles.set(handle, { symbolId, qualifiedName, file });
    this._reverse.set(symbolId, handle);
    return handle;
  }

  resolve(handle) { return this._handles.get(handle) || null; }

  toAliasMap() {
    const map = {};
    for (const [h, info] of this._handles) map[h] = `${info.file}#${info.qualifiedName}`;
    return map;
  }
}

export { normalizeSignature, normalizeSubtree };
