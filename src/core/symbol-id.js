// ═══ Stable Symbol Identity v2.0 ═══
// symbolId    = hash(language + nodeType + qualifiedName + normalizedSignature)
// symbolRevision = hash(normalizedAstSubtree)
// fileRevision   = hash(fileContent)
//
// Changing a NEIGHBOR symbol → symbolId stays same, symbolRevision unchanged
// Changing a symbol body  → symbolId stays same, symbolRevision changes
// Renaming/change sig     → new symbolId
// Any file change         → fileRevision changes

import { createHash } from "crypto";

const HASH_LEN = 12;

/** Normalize signature: strip whitespace, sort generic params */
function normalizeSignature(sig) {
  if (!sig) return "";
  return sig
    .replace(/\s+/g, " ")
    .replace(/async\s+/g, "")
    .trim();
}

/**
 * @param {object} opts
 * @param {string} opts.language - js, ts, python, etc.
 * @param {string} opts.nodeType - FunctionDeclaration, ClassDef, MethodDefinition, etc.
 * @param {string} opts.qualifiedName - module.Class.method or module.function
 * @param {string} opts.signature - normalized function signature
 * @param {number} [opts.declarationOrdinal] - for overloaded functions
 */
export function createSymbolId({ language, nodeType, qualifiedName, signature, declarationOrdinal = 0 }) {
  const normalizedSig = normalizeSignature(signature);
  const key = [
    language,
    nodeType,
    qualifiedName,
    normalizedSig,
    declarationOrdinal > 0 ? `#${declarationOrdinal}` : "",
  ].join("|");
  return `sym_${shaShort(key)}`;
}

/** Hash of normalized AST subtree */
export function createSymbolRevision(normalizedAstSubtree) {
  return shaShort(normalizedAstSubtree);
}

/** Hash of full file content */
export function createFileRevision(fileContent) {
  return shaShort(fileContent);
}

/** Hash of project-level state (git rev, file tree) */
export function createProjectRevision(input) {
  return shaShort(typeof input === "string" ? input : JSON.stringify(input));
}

function shaShort(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_LEN);
}

/**
 * Parse a session handle like "@Publisher.publish" or "@S3"
 * Session handles are ephemeral, mapped to stable symbolIds
 */
export class SessionHandleRegistry {
  constructor() {
    this._handles = new Map(); // handle → { symbolId, qualifiedName, file }
    this._reverse = new Map(); // symbolId → handle
    this._counter = 0;
  }

  /** Register or retrieve a handle */
  register(symbolId, qualifiedName, file) {
    const existing = this._reverse.get(symbolId);
    if (existing) return existing;

    // Try to create a readable handle
    const shortName = qualifiedName.split(".").pop() || qualifiedName;
    let handle = `@${shortName}`;
    
    // If taken, add suffix
    if (this._handles.has(handle)) {
      handle = `@S${++this._counter}`;
    }

    this._handles.set(handle, { symbolId, qualifiedName, file });
    this._reverse.set(symbolId, handle);
    return handle;
  }

  resolve(handle) {
    return this._handles.get(handle) || null;
  }

  /** Export for context packet */
  toAliasMap() {
    const map = {};
    for (const [handle, info] of this._handles) {
      map[handle] = `${info.file}#${info.qualifiedName}`;
    }
    return map;
  }
}

/**
 * Validate context freshness
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateContext(expected, actual) {
  if (expected.fileRevision && expected.fileRevision !== actual.fileRevision) {
    return {
      valid: false,
      error: "STALE_FILE",
      expected: expected.fileRevision,
      actual: actual.fileRevision,
    };
  }
  if (expected.symbolRevision && expected.symbolRevision !== actual.symbolRevision) {
    return {
      valid: false,
      error: "STALE_SYMBOL",
      symbolId: expected.symbolId,
      expected: expected.symbolRevision,
      actual: actual.symbolRevision,
    };
  }
  return { valid: true };
}
