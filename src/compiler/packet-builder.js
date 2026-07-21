// ═══ Semantic Context Packet Builder v2.0 ═══
import { createSymbolId, createSymbolRevision, createFileRevision, SessionHandleRegistry } from "../core/symbol-id.js";
import { parseFile, extractContract } from "../core/ast-engine.js";
import { rankCandidates } from "./ranking.js";

export async function buildContextPacket({ task = {}, targetFile, tokenBudget = 8000, qualityFloor = 0.95, mode = "safe", projectRoot = ".", evidence = {} }) {
  const parsed = parseFile(targetFile);
  const fileRev = createFileRevision(parsed.code);
  const handles = new SessionHandleRegistry();

  const packet = {
    contextId: `ctx_${Date.now().toString(36)}`,
    revision: 1, task,
    layers: { project: true, contracts: 0, sources: 0, evidence: 0 },
    tokens: 0, risk: "low", handles, aliases: {},
    loss: { removed: { symbols: 0, comments: 0, bodies: 0, files: 0 }, preserved: { targetSource: false, contracts: false, errorPaths: false, tests: false }, risk: "low" },
    omitted: [],
    packet: { project: { project: projectRoot, language: parsed.language, modules: [] }, contracts: [], sources: [], evidence: [] },
  };

  // ── Layer 0: Project Map ──
  packet.tokens += estimateJsons(JSON.stringify(packet.packet.project));

  // ── Layer 1: Semantic Contracts ──
  const contracts = [];
  for (const sym of parsed.symbols) {
    const sid = createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature });
    const srev = createSymbolRevision(sym.signature + sym.qualifiedName);
    const h = handles.register(sid, sym.qualifiedName, targetFile);
    const c = extractContract(sym, parsed.code, parsed.language);
    const needsSrc = shouldEscalate(sym, c, task, evidence);

    contracts.push({ handle: h, id: sid, revision: srev, fileRevision: fileRev, kind: sym.kind, signature: sym.signature, visibility: c.visibility, effects: c.effects, throws: c.throws, calls: c.calls.map(cn => handles.register(createSymbolId({ language: parsed.language, nodeType: "function", qualifiedName: cn, signature: "()" }), cn, targetFile)), properties: c.properties, confidence: c.confidence, needsSource: needsSrc, range: [sym.startLine || 1, sym.endLine || sym.startLine || 1] });
    packet.layers.contracts++;
  }

  const ranked = rankCandidates(contracts, task);
  const alloc = allocate(tokenBudget, mode);
  let used = packet.tokens;

  const selContracts = [];
  for (const r of ranked) {
    const ct = estimateJsons(JSON.stringify(r.item));
    if (used + ct > alloc.contracts) { packet.loss.removed.symbols++; continue; }
    selContracts.push(r.item); used += ct;
  }
  packet.packet.contracts = selContracts;
  packet.loss.removed.symbols += contracts.length - selContracts.length;

  // ── Layer 2: Exact Source (NO ALIASING!) ──
  const sources = [];
  for (const c of selContracts) {
    if (!c.needsSource && mode !== "aggressive") continue;
    const lines = parsed.code.split("\n");
    const body = lines.slice(c.range[0] - 1, c.range[1]).join("\n");
    const st = estimateJsons(body);
    if (used + st > alloc.sources + alloc.contracts) { packet.omitted.push({ handle: c.handle, reason: "budget", retrievable: true }); packet.loss.removed.bodies++; continue; }
    sources.push({ handle: c.handle, id: c.id, expectedRevision: c.revision, language: parsed.language, source: body, related: { callers: [], tests: [] } });
    used += st; packet.layers.sources++; packet.loss.preserved.targetSource = true;
  }
  packet.packet.sources = sources;

  // ── Layer 3: Evidence ──
  if (evidence.tests) { packet.packet.evidence.push({ type: "tests", data: evidence.tests }); packet.layers.evidence++; packet.loss.preserved.tests = true; }
  if (evidence.stackTrace) { packet.packet.evidence.push({ type: "stackTrace", data: evidence.stackTrace }); packet.layers.evidence++; packet.loss.preserved.errorPaths = true; }
  packet.tokens = used + estimateJsons(JSON.stringify(packet.packet.evidence));

  packet.loss.preserved.contracts = selContracts.length > 0;
  packet.aliases = handles.toAliasMap();
  if (packet.loss.removed.bodies > packet.layers.contracts * 0.3) packet.loss.risk = "medium";
  if (!packet.loss.preserved.targetSource && task.type === "bugfix") packet.loss.risk = "high";
  packet.risk = packet.loss.risk;

  return packet;
}

function shouldEscalate(sym, contract, task, evidence) {
  if (task.target && sym.qualifiedName?.includes(task.target)) return true;
  if (evidence.stackTrace && evidence.stackTrace.includes(sym.name)) return true;
  if (evidence.tests && evidence.tests.includes(sym.name)) return true;
  if (contract.confidence?.effects < 0.5 || contract.confidence?.idempotent < 0.4) return true;
  if (sym.name?.match(/auth|perm|acl|role|crypt|token|secret|password|hash/i)) return true;
  if (contract.properties?.transactional || contract.properties?.usesLocking) return true;
  return false;
}

function allocate(total, mode) {
  const m = { safe: [0.05, 0.40, 0.40], balanced: [0.05, 0.45, 0.35], aggressive: [0.03, 0.55, 0.30] }[mode] || [0.05, 0.45, 0.35];
  return { project: total * m[0] | 0, contracts: total * m[1] | 0, sources: total * m[2] | 0, total };
}

function estimateJsons(text) { return Math.ceil(String(text).length / 1.3); }
