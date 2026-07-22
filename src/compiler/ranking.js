// ═══ Value-per-Token Ranking v0.4.0 — graph distance, loss-aware ═══

import { EXCLUDE_REASONS } from "../core/loss-manifest.js";

/**
 * Score = relevance × impact × uncertainty ÷ tokenCost
 * Enhanced with graph-distance penalty and loss-manifest integration.
 */
export function rankCandidates(candidates, task, opts = {}) {
  const graph = opts.graph || null;
  const focusSymbols = opts.focusSymbols || [];
  const lossManifest = opts.lossManifest || null;

  const scored = candidates.map((c, idx) => {
    const item = c.item || c;
    let relevance = 0.5;
    let impact = 0.5;
    let uncertainty = 0.3;
    let tokenCost = estimateTokens(item);

    // Lexical relevance — task keywords in symbol name/contract
    if (task.keywords?.length) {
      const name = (item.qualifiedName || item.name || "").toLowerCase();
      const sig = (item.signature || "").toLowerCase();
      const hits = task.keywords.filter(kw =>
        name.includes(kw.toLowerCase()) || sig.includes(kw.toLowerCase())
      ).length;
      relevance = 0.3 + Math.min(0.7, hits / Math.max(1, task.keywords.length));
    }

    // Graph distance penalty — prefer symbols close to focus symbols
    if (graph && focusSymbols.length > 0) {
      let minDistance = 10; // max penalty
      for (const focusId of focusSymbols) {
        const d = graphDistance(graph, item.id || item.symbolId, focusId);
        if (d < minDistance) minDistance = d;
      }
      relevance *= Math.max(0.2, 1.0 - minDistance * 0.15);
    }

    // Impact — larger symbols with more callers/callees have higher impact
    if (item.callers?.length || item.callees?.length) {
      const edges = (item.callers?.length || 0) + (item.callees?.length || 0);
      impact = 0.3 + Math.min(0.7, edges / 20);
    }

    // Confidence penalty
    const conf = item.confidence ?? 0.85;
    uncertainty = Math.max(0.1, 1.0 - conf);

    // Token cost normalization
    const normCost = Math.max(1, tokenCost / 100);

    const score = (relevance * 0.4 + impact * 0.3 + uncertainty * 0.3) / normCost;

    // Exclusion check
    let excludeReason = null;
    if (lossManifest) {
      if (tokenCost > (opts.maxSymbolTokens || 2000))
        excludeReason = EXCLUDE_REASONS.TOKEN_BUDGET;
      else if (score < (opts.relevanceFloor || 0.05))
        excludeReason = EXCLUDE_REASONS.LOW_RELEVANCE;
      else if (conf < (opts.confidenceFloor || 0.3))
        excludeReason = EXCLUDE_REASONS.LOW_CONFIDENCE;
    }

    return {
      item,
      score,
      rank: idx,
      relevance: Math.round(relevance * 100) / 100,
      impact: Math.round(impact * 100) / 100,
      uncertainty: Math.round(uncertainty * 100) / 100,
      estimatedTokens: tokenCost,
      excludeReason,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Assign final ranks
  scored.forEach((s, i) => { s.rank = i + 1; });

  return scored;
}

/**
 * Estimate tokens for a contract/symbol (rough heuristic).
 */
function estimateTokens(item) {
  let tokens = 20; // base overhead
  if (item.signature) tokens += item.signature.length / 3;
  if (item.body) tokens += item.body.length / 3;
  if (item.effects?.length) tokens += item.effects.join(" ").length / 3;
  if (item.calls?.length) tokens += item.calls.length * 5;
  if (item.throws?.length) tokens += item.throws.length * 5;
  return Math.max(10, Math.round(tokens));
}

/**
 * Approximate graph distance between two symbols (0 = same, 10 = unreachable).
 */
function graphDistance(graph, fromId, toId) {
  if (fromId === toId) return 0;
  if (!graph || !fromId || !toId) return 5;

  const edge = graph.edges?.get(fromId);
  if (!edge) return 10;

  // Direct callee?
  if (edge.callees?.has(toId)) return 1;
  // Direct caller?
  if (edge.callers?.has(toId)) return 1;
  // Inheritor?
  if (edge.inheritors?.has(toId)) return 2;

  // 2-hop search
  for (const calleeId of (edge.callees || [])) {
    const cEdge = graph.edges?.get(calleeId);
    if (cEdge?.callees?.has(toId) || cEdge?.callers?.has(toId)) return 3;
  }

  return 5; // farther or unreachable
}

export { estimateTokens, graphDistance };
