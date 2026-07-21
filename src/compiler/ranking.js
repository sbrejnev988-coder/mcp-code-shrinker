// ═══ Value-per-Token Ranking ═══
// contextValue = relevance × impact × uncertainty × evidenceStrength ÷ tokenCost

export function rankCandidates(candidates, task) {
  const scored = candidates.map(c => ({
    item: c,
    score: computeScore(c, task),
  }));
  
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function computeScore(candidate, task) {
  const taskDesc = (task.description || task.type || "").toLowerCase();
  
  // Relevance: is this symbol related to the task?
  const nameMatch = candidate.name && taskDesc.includes(candidate.name.toLowerCase()) ? 1.5 : 0.3;
  const qualifiedMatch = candidate.qualifiedName && taskDesc.includes(candidate.qualifiedName.toLowerCase()) ? 2.0 : 0.3;
  const relevance = Math.max(0.2, nameMatch, qualifiedMatch);
  
  // Impact: could this symbol change correctness?
  let impact = 1.0;
  if (candidate.properties?.transactional) impact *= 2.0;
  if (candidate.properties?.usesLocking) impact *= 1.8;
  if (candidate.kind === "class") impact *= 1.3;
  if (candidate.visibility === "public") impact *= 1.2;
  
  // Uncertainty: how little we know?
  let uncertainty = 1.0;
  if (candidate.confidence?.effects < 0.5) uncertainty *= 1.5;
  if (candidate.confidence?.idempotent < 0.4) uncertainty *= 1.3;
  if (!candidate.signature) uncertainty *= 1.8;
  
  // Evidence strength: linked to failure?
  let evidenceStrength = 1.0;
  if (candidate.needsSource) evidenceStrength *= 2.5;
  if (candidate.effects?.length > 0) evidenceStrength *= 1.4;
  if (candidate.throws?.length > 0) evidenceStrength *= 1.2;
  
  // Token cost
  const tokenCost = Math.max(estimateTokens(JSON.stringify(candidate)), 1);
  
  return (relevance * impact * uncertainty * evidenceStrength) / Math.log2(tokenCost + 1);
}

function estimateTokens(text) {
  return Math.ceil(text.length / 1.3);
}
