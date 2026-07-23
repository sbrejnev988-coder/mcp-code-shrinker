// ═══ Semantic Context Packet Builder v0.3.1 ═══
import { createSymbolId, createSymbolRevisionFromSource, createFileRevision, SessionHandleRegistry } from "../core/symbol-id.js";
import { createHash } from "node:crypto";
import { relative } from "path";
import { parseFile, extractContract } from "../core/ast-engine.js";
import { rankCandidates } from "./ranking.js";

export async function buildContextPacket({ task = {}, targetFile, tokenBudget = 8000, qualityFloor = 0.95, mode = "safe", projectRoot = ".", evidence = {}, createSymbolIdentity } = {}) {
  const parsed = parseFile(targetFile);
  const identity = createSymbolIdentity || ((parsed, sym) => createSymbolId({ projectRelativePath: relative(projectRoot, targetFile), language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }));
  const fileRev = createFileRevision(parsed.code);
  const handles = new SessionHandleRegistry();

  const packet = {
    contextId: `ctx_${Date.now().toString(36)}`, revision: 1, task,
    layers: { project: true, contracts: 0, sources: 0, evidence: 0 },
    tokens: 0, risk: "low", handles, aliases: {},
    loss: { removed: { symbols: 0, comments: 0, bodies: 0, files: 0 }, preserved: { targetSource: false, contracts: false, errorPaths: false, tests: false }, risk: "low", removedSymbolIds: [] },
    omitted: [], qualitySatisfied: true, estimatedQuality: 1.0,
    packet: { project: { project: projectRoot, language: parsed.language, modules: [] }, contracts: [], sources: [], evidence: [] },
  };

  // ── Layer 0 ──
  packet.tokens += estimateTokens(JSON.stringify(packet.packet.project));

  // ── Layer 1: Build all contracts ──
  const contracts = [];
  for (const sym of parsed.symbols) {
    const sid = identity(parsed, sym);
    const c = extractContract(sym, parsed.code, parsed.language);
    const srev = createSymbolRevisionFromSource(c.body || "", sym.signature);
    const h = handles.register(sid, sym.qualifiedName, targetFile);
    contracts.push({
      handle: h, id: sid, revision: srev, fileRevision: fileRev, file: targetFile, kind: sym.kind, name: sym.name, qualifiedName: sym.qualifiedName,
      signature: sym.signature, visibility: c.visibility,
      effects: c.effects, throws: c.throws,
      calls: c.calls.map(cn => handles.register(identity(parsed, { kind: "function", qualifiedName: cn, signature: "()" }), cn, targetFile)),
      properties: c.properties, confidence: c.confidence,
      needsSource: shouldEscalate(sym, c, task, evidence),
      risk: assessRisk(sym, c),
      range: [sym.startLine || 1, sym.endLine || sym.startLine || 1],
      body: c.body, startLine: c.startLine, endLine: c.endLine,
    });
    packet.layers.contracts++;
  }

  // ── Rank & select ──
  const ranked = rankCandidates(contracts, task);
  const alloc = allocate(tokenBudget, mode);
  let used = packet.tokens;
  const selectedIds = new Set();

  // Target ALWAYS included at Layer 2
  const targetContract = contracts.find(c => 
    c.qualifiedName?.includes(task.target) || c.name?.includes(task.target) || c.handle?.includes(task.target));
  if (targetContract) {
    selectedIds.add(targetContract.id);
    const st = estimateTokens(JSON.stringify({ handle: targetContract.handle, id: targetContract.id, revision: targetContract.revision, source: targetContract.body }));
    used += Math.min(st, alloc.sources);
  }

  for (const r of ranked) {
    const c = r.item;
    if (selectedIds.has(c.id)) continue;
    
    // FIXED: aggressive mode includes FEWER sources, not more
    const includeSource = c.id === targetContract?.id || c.needsSource || (mode === "safe" && c.risk >= 2);
    
    let cost = estimateTokens(JSON.stringify({ ...c, body: undefined }));
    if (includeSource && c.body) {
      cost += estimateTokens(c.body);
    }
    
    if (used + cost > alloc.total) {
      packet.omitted.push({ id: c.id, handle: c.handle || c.id, reason: 'token_budget', availableViews: ['contract'], estimatedTokens: cost });
        packet.loss.removed.symbols++;
      packet.loss.removedSymbolIds.push(c.id);
      continue;
    }
    
    selectedIds.add(c.id);
    used += cost;
  }

  // ── Build selected contracts & sources ──
  const selContracts = [];
  const sources = [];
  const removedIds = [];

  for (const c of contracts) {
    if (!selectedIds.has(c.id)) {
      removedIds.push(c.id);
      continue;
    }
    
    const cc = { ...c, body: undefined, startLine: undefined, endLine: undefined };
    delete cc.body; delete cc.startLine; delete cc.endLine;
    selContracts.push(cc);

    // FIXED: aggressive mode logic — include source only for high-value symbols
    const includeSource = c.id === targetContract?.id || c.needsSource || (mode === "safe" && c.risk >= 2);
    
    if (includeSource && c.body) {
      sources.push({
        handle: c.handle, id: c.id, file: targetFile, expectedRevision: c.revision,
        language: parsed.language, source: c.body,
        related: { callers: [], tests: [] },
      });
      packet.layers.sources++;
      packet.loss.preserved.targetSource = true;
    }
  }

  // FIXED: loss manifest — count once, not double
  packet.loss.removed.symbols = removedIds.length;
  packet.loss.removedSymbolIds = removedIds;

  packet.packet.contracts = selContracts;
  packet.packet.sources = sources;

  // ── Layer 3: Evidence (FIXED: include diagnostics) ──
  if (evidence.tests) { packet.packet.evidence.push({ type: "tests", data: evidence.tests }); packet.layers.evidence++; packet.loss.preserved.tests = true; }
  if (evidence.stackTrace) { packet.packet.evidence.push({ type: "stackTrace", data: evidence.stackTrace }); packet.layers.evidence++; packet.loss.preserved.errorPaths = true; }
  if (evidence.diagnostics) { packet.packet.evidence.push({ type: "diagnostics", data: evidence.diagnostics }); packet.layers.evidence++; }

  packet.tokens = used + estimateTokens(JSON.stringify(packet.packet.evidence));
  packet.aliases = handles.toAliasMap();

  // ── FIXED: qualityFloor actually applied ──
  const hasTargetSource = sources.some(source => targetContract && source.id === targetContract.id);
  const hasContracts = selContracts.length > 0;
  const hasTests = !!evidence.tests;
  let estQuality = 0.5;
  if (hasTargetSource) estQuality += 0.15;
  if (hasContracts) estQuality += 0.2;
  if (hasTests) estQuality += 0.15;
  if (packet.loss.removed.symbols < contracts.length * 0.3) estQuality = Math.min(1, estQuality + 0.1);
  
  packet.estimatedQuality = Math.round(estQuality * 100) / 100;
  packet.qualitySatisfied = packet.estimatedQuality >= qualityFloor;

  // ── Risk calculation ──
  if (!packet.qualitySatisfied) {
    packet.risk = "high";
    packet.qualityRecovery = {
      attempted: false,
      reason: estQuality < 0.85 ? "missing_critical_sources" : "quality_below_floor",
      hints: []
    };
    // Auto-recovery hints: what would improve quality
    const sourceCount = (packet.packet.sources || []).length;
    const contractCount = (packet.packet.contracts || []).length;
    const hasTests = (packet.packet.evidence || []).some(e => e.type === "tests");
    if (sourceCount === 0) packet.qualityRecovery.hints.push("add_target_source");
    if (contractCount === 0) packet.qualityRecovery.hints.push("add_contracts");
    if (!hasTests && task.taskType === "bugfix") packet.qualityRecovery.hints.push("add_tests");
    if ((packet.omitted?.length || 0) > sourceCount * 2) packet.qualityRecovery.hints.push("reduce_omissions");
  }
  else if (packet.loss.removed.bodies > 0 && !hasTargetSource) packet.risk = "high";
  else if (packet.loss.removed.bodies > packet.layers.contracts * 0.3) packet.risk = "medium";
  else packet.risk = "low";
  
  packet.loss.risk = packet.risk;
  
  // P1: Quality auto-recovery — single retry if quality not satisfied
  if (!packet.qualitySatisfied && packet.qualityRecovery) {
    packet.qualityRecovery.attempted = false;
    packet.qualityRecovery.plan = [...packet.qualityRecovery.hints];
  }
  
  // P1: Coverage manifest for Memory Wiki deduplication
  const coveredSources = packet.packet.sources || [];
  const coveredContracts = packet.packet.contracts || [];
  const coveredEvidence = packet.packet.evidence || [];
  
  packet.coverage_manifest = {
    protocol_version: 1,
    packet_id: packet.contextId || `ctx-${Date.now()}`,
    repository_id: task.repositoryId || "",
    commit_sha: task.commitSha || "",
    covered: [],
    created_at: Math.floor(Date.now() / 1000)
  };
  
  for (const src of coveredSources) {
    const hash = createHash("sha256").update(src.source || "").digest("hex");
    packet.coverage_manifest.covered.push({
      kind: "exact_source",
      file_path: src.file || "",
      symbol_id: src.id,
      revision: src.expectedRevision || "",
      content_hash: `sha256:${hash}`,
      token_count: estimateTokens(src.source || "", "code")
    });
  }
  
  for (const contract of coveredContracts) {
    const serialized = JSON.stringify(contract);
    const hash = createHash("sha256").update(serialized).digest("hex");
    packet.coverage_manifest.covered.push({
      kind: "contract",
      file_path: contract.file || "",
      symbol_id: contract.id,
      revision: contract.revision || "",
      content_hash: `sha256:${hash}`,
      token_count: estimateTokens(serialized, "json")
    });
  }
  
  for (const ev of coveredEvidence) {
    const serialized = JSON.stringify(ev.data);
    const hash = createHash("sha256").update(serialized).digest("hex");
    packet.coverage_manifest.covered.push({
      kind: ev.type === "tests" ? "test" : "diagnostic",
      content_hash: `sha256:${hash}`,
      token_count: estimateTokens(serialized, "diagnostic")
    });
  }

  return packet;
}

function shouldEscalate(sym, contract, task, evidence) {
  if (task.target && (sym.qualifiedName?.includes(task.target) || sym.name?.includes(task.target))) return true;
  if (evidence.stackTrace && evidence.stackTrace.includes(sym.name)) return true;
  if (evidence.tests && evidence.tests.includes(sym.name)) return true;
  if (contract.confidence?.effects < 0.5 || contract.confidence?.idempotent < 0.4) return true;
  if (sym.name?.match(/auth|perm|acl|role|crypt|token|secret|password|hash/i)) return true;
  if (contract.properties?.transactional || contract.properties?.usesLocking) return true;
  return false;
}

function assessRisk(sym, contract) {
  let risk = 0;
  if (sym.name?.match(/auth|perm|acl|role|crypt|token|secret|password|hash|payment|transaction|migrate/i)) risk += 2;
  if (contract.properties?.transactional || contract.properties?.usesLocking) risk += 2;
  if (contract.effects?.length > 2) risk += 1;
  if (contract.throws?.length > 0) risk += 1;
  return risk;
}

function allocate(total, mode) {
  const m = { safe: [0.05, 0.40, 0.45], balanced: [0.05, 0.45, 0.40], aggressive: [0.03, 0.55, 0.35] }[mode] || [0.05, 0.45, 0.40];
  return { project: total * m[0] | 0, contracts: total * m[1] | 0, sources: total * m[2] | 0, total };
}

function estimateTokens(text, contentType = "json") {
  return Math.ceil(String(text).length * { text: 0.75, code: 0.40, json: 0.55, tool_schema: 0.60, diagnostic: 0.65 }[contentType] || 0.70);
}
