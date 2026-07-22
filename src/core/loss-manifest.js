// ═══ Loss Manifest v0.2.0 — Machine-verifiable exclusion reasons ═══

export const EXCLUDE_REASONS = {
  TOKEN_BUDGET: "TOKEN_BUDGET", LOW_RELEVANCE: "LOW_RELEVANCE",
  GENERATED_FILE: "GENERATED_FILE", BINARY: "BINARY", SECRET: "SECRET",
  DYNAMIC_EDGE: "DYNAMIC_EDGE", PARSE_FAILURE: "PARSE_FAILURE",
  DUPLICATE: "DUPLICATE", EXTERNAL_DEPENDENCY: "EXTERNAL_DEPENDENCY",
  USER_EXCLUDED: "USER_EXCLUDED", PARSER_FALLBACK: "PARSER_FALLBACK",
  LOW_CONFIDENCE: "LOW_CONFIDENCE", TRUNCATED: "TRUNCATED", REDACTED: "REDACTED",
};

export function createLossManifest(opts = {}) {
  return {
    schemaVersion: "0.2.0", originalTokens: 0, packetTokens: 0,
    tokenBudget: opts.tokenBudget || 0, budgetExceeded: false, targetCovered: false,
    excludedFiles: [], excludedSymbols: [], unresolvedCalls: [],
    dynamicImports: [], parserFallbacks: [], lowConfidenceItems: [],
    truncatedItems: [], redactedItems: [],
    quality: { targetCovered: false, entrypointsCovered: false, unresolvedRefs: 0,
      testsIncluded: false, exactSourceSufficient: false, versionConflicts: 0,
      snapshotStale: false, budgetExceeded: false, aggressiveCompression: false,
      requiresExpansion: false },
    retrievableIds: [], risk: "low", expansionHint: "",
  };
}

export function excludeFile(manifest, path, reason, detail = "") {
  manifest.excludedFiles.push({ path, reason: EXCLUDE_REASONS[reason] || reason,
    detail: detail || _desc(reason),
    retrievalId: `file:${Buffer.from(path).toString("hex").slice(0,12)}` });
}

export function excludeSymbol(manifest, symbolId, qualifiedName, reason, detail = "") {
  manifest.excludedSymbols.push({ symbolId, qualifiedName,
    reason: EXCLUDE_REASONS[reason] || reason, detail: detail || _desc(reason),
    retrievalId: `sym:${symbolId}` });
  manifest.retrievableIds.push(`sym:${symbolId}`);
}

export function addUnresolvedCall(manifest, caller, target, edgeType = "calls") {
  manifest.unresolvedCalls.push({
    caller: typeof caller === "string" ? caller : caller.qualifiedName,
    target, reason: "UNRESOLVED", edgeType });
}

export function addParserFallback(manifest, file, language, backend, syntaxErrors = []) {
  manifest.parserFallbacks.push({ file, language, backend, syntaxErrors,
    confidence: 0.5 + Math.max(0, 0.3 - syntaxErrors.length * 0.1) });
}

export function addLowConfidence(manifest, symbolId, field, confidence, threshold = 0.7) {
  if (confidence < threshold)
    manifest.lowConfidenceItems.push({ symbolId, field, confidence, threshold });
}

export function finalizeLossManifest(manifest, packet = {}) {
  const q = manifest.quality;
  if (!q.targetCovered && !q.entrypointsCovered) manifest.risk = "critical";
  else if (!q.targetCovered) manifest.risk = "high";
  else if (q.unresolvedRefs > 10) manifest.risk = "medium";
  else manifest.risk = "low";
  q.requiresExpansion = !q.targetCovered || q.unresolvedRefs > 0 || manifest.parserFallbacks.length > 0;
  manifest.packetTokens = packet.tokens || packet.estimatedTokens || 0;
  if (packet.originalTokens) manifest.originalTokens = packet.originalTokens;
  manifest.budgetExceeded = manifest.packetTokens > manifest.tokenBudget && manifest.tokenBudget > 0;
  if (q.requiresExpansion) {
    const reasons = [];
    if (!q.targetCovered) reasons.push("target symbols not covered");
    if (q.unresolvedRefs > 0) reasons.push(`${q.unresolvedRefs} unresolved`);
    if (manifest.parserFallbacks.length) reasons.push(`${manifest.parserFallbacks.length} fallbacks`);
    manifest.expansionHint = `requires_expansion: ${reasons.join(", ")}. Use context.expand.`;
  }
  return manifest;
}

function _desc(reason) {
  const m = { TOKEN_BUDGET: "Excluded to stay within token budget",
    LOW_RELEVANCE: "Ranked below relevance threshold", GENERATED_FILE: "Generated artifact",
    BINARY: "Binary file", SECRET: "Contains credentials", DYNAMIC_EDGE: "Dynamic import/call",
    PARSE_FAILURE: "Parse failed", DUPLICATE: "Duplicate symbol",
    EXTERNAL_DEPENDENCY: "External dependency", USER_EXCLUDED: "User configuration",
    PARSER_FALLBACK: "Lower-confidence parser", LOW_CONFIDENCE: "Below confidence threshold",
    TRUNCATED: "Content truncated", REDACTED: "Security redaction" };
  return m[reason] || reason;
}
