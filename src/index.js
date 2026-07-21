#!/usr/bin/env node
// ═══ Code Shrinker MCP Server v0.3.4 ═══
// Stabilization release — all P0 bugs fixed
// FIXED: Full body extraction → symbol.source/symbolRevision correct
// FIXED: require() removed, node --check for syntax
// FIXED: Hash re-check on apply actually works
// FIXED: Call graph edges built (contract attached at index)
// FIXED: ESLint exit 1 correctly detected
// FIXED: Path security uses relative() not startsWith
// FIXED: patch.propose→validate→apply linked by patchId (randomUUID)
// FIXED: context.expand path validation

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, realpathSync } from "fs";
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
import { resolve, relative, isAbsolute, delimiter } from "node:path";
import { randomUUID } from "crypto";
import { buildContextPacket } from "./compiler/packet-builder.js";
import { parseFile, extractContract } from "./core/ast-engine.js";
import { createSymbolId, createSymbolRevisionFromSource, createFileRevision } from "./core/symbol-id.js";
import { TokenBudget } from "./core/token-budget.js";
import { CallGraph } from "./compiler/call-graph.js";
import { PatchValidator } from "./compiler/patch-validator.js";

const server = new Server({ name: "code-shrinker", version: PKG.version }, { capabilities: { tools: {} } });
const budget = new TokenBudget();
const sessions = new Map();
const patches = new Map(); // patchId → { contextId, edits }
let callGraph = null;
let validator = null;
const CONFIGURED_ROOTS = (process.env.CODE_SHRINKER_ALLOWED_ROOTS || '').split(delimiter).filter(Boolean).map(p => resolve(p));

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveInsideRoot(inputPath) {
  try {
    const rp = realpathSync(inputPath);
    if (CONFIGURED_ROOTS.length === 0) throw new Error('NO_ALLOWED_ROOT_CONFIGURED. Set CODE_SHRINKER_ALLOWED_ROOTS env var.');
    if (!CONFIGURED_ROOTS.some(root => isInside(root, rp))) throw new Error(`PATH_OUTSIDE_ROOT: ${rp}`);
    return rp;
  } catch (e) { if (e.message.startsWith("PATH_OUTSIDE")) throw e; throw new Error(`PATH_RESOLVE: ${e.message}`); }
}

const toolDefs = [
  { name: "project.scan", title: "Scan Project", description: "Build cross-file call graph. Required before symbol.context.", inputSchema: { type: "object", properties: { path: { type: "string" }, exclude: { type: "array", items: { type: "string" } } } } },
  { name: "project.map", title: "Project Map (L0)", description: "Layer 0: file tree + exports.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "file.contracts", title: "File Contracts (L1)", description: "Layer 1: contracts for all symbols. FIXED: includes full body ranges.", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
  { name: "symbol.source", title: "Symbol Source (L2)", description: "EXACT source — FIXED: full function body now extracted.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, symbol: { type: "string" }, view: { type: "string", enum: ["source","contract","reference"] } }, required: ["filePath","symbol"] } },
  { name: "symbol.context", title: "Symbol Context", description: "Callers/callees/tests. FIXED: edges now built.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, symbol: { type: "string" }, what: { type: "array", items: { type: "string", enum: ["callers","callees","tests","sideEffects"] } } }, required: ["filePath","symbol"] } },
  { name: "context.create", title: "Create Context Packet", description: "Build L0-L3 packet with ranking + quality check.", inputSchema: { type: "object", properties: { task: { type: "object" }, targetFile: { type: "string" }, tokenBudget: { type: "number" }, qualityFloor: { type: "number" }, mode: { type: "string", enum: ["safe","balanced","aggressive"] }, projectRoot: { type: "string" }, evidence: { type: "object" } }, required: ["task","targetFile"] } },
  { name: "context.expand", title: "Expand Context", description: "FIXED: path validated, loads symbols into packet.", inputSchema: { type: "object", properties: { contextId: { type: "string" }, requests: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, filePath: { type: "string" }, view: { type: "string", enum: ["source","contract"] }, reason: { type: "string" } }, required: ["symbol"] } } }, required: ["contextId","requests"] } },
  { name: "context.inspect", title: "Inspect Loss", description: "Loss manifest + quality.", inputSchema: { type: "object", properties: { contextId: { type: "string" } }, required: ["contextId"] } },
  { name: "patch.propose", title: "Propose Patch", description: "FIXED: patchId linked to validate/apply via randomUUID.", inputSchema: { type: "object", properties: { contextId: { type: "string" }, edits: { type: "array" } }, required: ["contextId","edits"] } },
  { name: "patch.validate", title: "Validate Patch", description: "Validate proposed patch. Requires patchId from patch.propose. All state from server.", inputSchema: { type: "object", properties: { patchId: { type: "string" } }, required: ["patchId"], additionalProperties: false } },
  { name: "patch.apply", title: "Apply Patch", description: "FIXED: real hash re-check works now.", inputSchema: { type: "object", properties: { patchId: { type: "string" }, filePath: { type: "string" } }, required: ["patchId","filePath"] } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.name.startsWith("patch.a"), destructiveHint: t.name === "patch.apply" } })) }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "project.scan": return handleProjectScan(args);
      case "project.map": return handleProjectMap(args);
      case "file.contracts": return handleFileContracts(args);
      case "symbol.source": return handleSymbolSource(args);
      case "symbol.context": return handleSymbolContext(args);
      case "context.create": return handleContextCreate(args);
      case "context.expand": return handleContextExpand(args);
      case "context.inspect": return handleContextInspect(args);
      case "patch.propose": return handlePatchPropose(args);
      case "patch.validate": return handlePatchValidate(args);
      case "patch.apply": return handlePatchApply(args);
      default: return err(`Unknown: ${name}`);
    }
  } catch (e) { return err(`${name}: ${e.message}`); }
});

async function handleProjectScan(args) {
  if (CONFIGURED_ROOTS.length === 0) throw new Error('NO_ALLOWED_ROOT_CONFIGURED');
  const root = args.path ? await resolveInsideRoot(args.path) : CONFIGURED_ROOTS[0];
  callGraph = new CallGraph(root);
  validator = new PatchValidator({ projectRoot: root });
  const stats = callGraph.scan({ exclude: args.exclude });
  return ok({ status: "scanned", ...stats, root });
}

async function handleProjectMap(args) {
  const path = await resolveInsideRoot(args.path || ".");
  if (callGraph) {
    const slice = callGraph.toContextSlice([path], 1);
    return ok({ project: path, entrypoints: Object.keys(slice.symbols || {}).slice(0, 20), ...slice });
  }
  return ok({ project: path, status: "stub", note: "Run project.scan for full map" });
}

async function handleFileContracts(args) {
  const fp = await resolveInsideRoot(args.filePath);
  const parsed = parseFile(fp);
  const rev = createFileRevision(parsed.code);
  const contracts = parsed.symbols.map(sym => {
    const c = extractContract(sym, parsed.code, parsed.language);
    return {
      id: createSymbolId({ projectRelativePath: relative(".", fp), language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }),
      revision: createSymbolRevisionFromSource(c.body || "", sym.signature),
      handle: `@${sym.qualifiedName}`, kind: sym.kind, signature: c.signature, visibility: c.visibility,
      effects: c.effects, throws: c.throws, calls: c.calls, properties: c.properties, confidence: c.confidence,
      range: [sym.startLine, sym.endLine], // FIXED: correct ranges
    };
  });
  return ok({ file: fp, fileRevision: rev, language: parsed.language, contracts, imports: parsed.imports });
}

async function handleSymbolSource(args) {
  const fp = await resolveInsideRoot(args.filePath);
  const parsed = parseFile(fp);
  const sym = parsed.symbols.find(s => s.qualifiedName === args.symbol || s.name === args.symbol);
  if (!sym) return err(`Symbol not found: ${args.symbol}`);
  const c = extractContract(sym, parsed.code, parsed.language);
  const result = {
    id: createSymbolId({ projectRelativePath: relative(".", fp), language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }),
    revision: createSymbolRevisionFromSource(c.body || "", sym.signature),
    fileRevision: createFileRevision(parsed.code), handle: `@${sym.qualifiedName}`, kind: sym.kind, language: parsed.language,
    range: [sym.startLine, sym.endLine],
  };
  const view = args.view || "source";
  if (view === "source") result.source = c.body;
  if (view === "source" || view === "contract") result.contract = { signature: c.signature, effects: c.effects, throws: c.throws, calls: c.calls, properties: c.properties, confidence: c.confidence };
  else result.signature = c.signature;
  return ok(result);
}

async function handleSymbolContext(args) {
  if (!callGraph) return err("Run project.scan first");
  const result = {};
  for (const w of (args.what || [])) {
    switch (w) { case "callers": result.callers = callGraph.callers(args.filePath, args.symbol); break; case "callees": result.callees = callGraph.callees(args.filePath, args.symbol); break; case "tests": result.tests = callGraph.getTests(args.filePath, args.symbol); break; }
  }
  return ok(result);
}

async function handleContextCreate(args) {
  const tf = await resolveInsideRoot(args.targetFile);
  const packet = await buildContextPacket({ ...args, targetFile: tf, tokenBudget: args.tokenBudget || 8000, qualityFloor: args.qualityFloor ?? 0.95, mode: args.mode || "safe", evidence: args.evidence || {} });
  if (callGraph && args.task?.target) {
    const callers = callGraph.callers(tf, args.task.target);
    const tests = callGraph.getTests(tf, args.task.target);
    if (callers.length) packet.packet.callers = callers;
    if (tests.length) packet.packet.relatedTests = tests;
  }
  packet._targetFile = tf;
  sessions.set(packet.contextId, packet);
  return ok({ contextId: packet.contextId, revision: packet.revision, task: packet.task, layers: packet.layers, tokens: packet.tokens, risk: packet.risk, qualitySatisfied: packet.qualitySatisfied, estimatedQuality: packet.estimatedQuality, loss: { removed: packet.loss.removed, preserved: packet.loss.preserved, risk: packet.loss.risk }, aliases: packet.aliases, packet: packet.packet, omitted: packet.omitted });
}

async function handleContextExpand(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);
  const added = { sources: [], contracts: [], tokensAdded: 0 };
  const oldRev = packet.revision;
  for (const req of (args.requests || [])) {
    // FIXED: path validation on expand requests
    let fp = req.filePath;
    if (fp) fp = await resolveInsideRoot(fp);
    else if (packet._targetFile) fp = packet._targetFile; else continue;
    try {
      const parsed = parseFile(fp);
      const sym = parsed.symbols.find(s => s.qualifiedName === req.symbol || s.name === req.symbol);
      if (!sym) { added.sources.push({ symbol: req.symbol, status: "not_found" }); continue; }
      const c = extractContract(sym, parsed.code, parsed.language);
      const sid = createSymbolId({ projectRelativePath: relative(".", fp), language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature });
      const srev = createSymbolRevisionFromSource(c.body || "", sym.signature);
      const h = packet.handles.register(sid, sym.qualifiedName, fp);
      if (!packet.packet.contracts.find(x => x.id === sid)) {
        packet.packet.contracts.push({ handle: h, id: sid, revision: srev, kind: sym.kind, signature: c.signature, effects: c.effects, throws: c.throws, properties: c.properties, confidence: c.confidence, range: [sym.startLine, sym.endLine] });
        added.contracts.push({ handle: h, symbol: req.symbol, status: "loaded" });
        packet.layers.contracts++;
      }
      if (req.view === "source" && c.body && !packet.packet.sources.find(x => x.id === sid)) {
        packet.packet.sources.push({ handle: h, id: sid, expectedRevision: srev, language: parsed.language, source: c.body });
        added.sources.push({ handle: h, symbol: req.symbol, status: "loaded", tokens: estimateTokens(c.body) });
        added.tokensAdded += estimateTokens(c.body);
        packet.layers.sources++;
      }
      // Remove from omitted if present
      packet.omitted = packet.omitted.filter(o => o.id !== sid);
    } catch (e) { added.sources.push({ symbol: req.symbol, status: "error", error: e.message }); }
  }
  packet.revision++;
  packet.tokens += added.tokensAdded;
  sessions.set(args.contextId, packet);
  return ok({ contextId: args.contextId, fromRevision: oldRev, revision: packet.revision, added, tokensAdded: added.tokensAdded });
}

async function handleContextInspect(args) {
  const p = sessions.get(args.contextId);
  if (!p) return err(`Context: ${args.contextId}`);
  return ok({ contextId: args.contextId, revision: p.revision, qualitySatisfied: p.qualitySatisfied, estimatedQuality: p.estimatedQuality, loss: p.loss, omitted: p.omitted, risk: p.risk });
}

async function handlePatchPropose(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context: ${args.contextId}`);
  for (const edit of (args.edits || [])) {
    if (edit.operation === "replace_symbol") {
      const known = (packet.packet.contracts || []).find(c => c.handle === edit.symbol || c.id === edit.symbol);
      const knownSrc = (packet.packet.sources || []).find(s => s.handle === edit.symbol || s.id === edit.symbol);
      if (!known && !knownSrc) return err(`Unknown: ${edit.symbol}`);
      if (known && known.range) { edit.startLine = known.range[0]; edit.endLine = known.range[1]; }
    }
  }
  const patchId = `patch_${randomUUID().slice(0, 12)}`;
  const ref = { contextId: args.contextId, contextRevision: packet.revision, filePath: packet._targetFile, edits: args.edits.map(e => ({...e})), editsHash: createFileRevision(JSON.stringify(args.edits)) }; patches.set(patchId, ref);
  return ok({ patchId, contextId: args.contextId, edits: args.edits.map(e => ({ ...e, status: "proposed" })), note: "Use patch.validate with this patchId next." });
}

async function handlePatchValidate(args) {
  if (!args.patchId) return err('patchId required');
  const proposed = patches.get(args.patchId);
  if (!proposed) return err('UNKNOWN_PATCH_ID');
  const ctx = sessions.get(proposed.contextId);
  if (!ctx) return err('CONTEXT_EXPIRED');
  if (ctx.revision !== proposed.contextRevision) return err('STALE_CONTEXT');
  if (createFileRevision(JSON.stringify(proposed.edits)) !== proposed.editsHash) return err('PATCH_TAMPERED');
  const filePath = await resolveInsideRoot(proposed.filePath);
  if (!validator) validator = new PatchValidator({ projectRoot: resolve(".") });
  const fileHash = existsSync(filePath) ? createFileRevision(readFileSync(filePath, "utf-8")) : null;
  const result = validator.validate({ patchId: args.patchId, filePath, originalHash: fileHash, edits: proposed.edits });
  return ok(result);
}

async function handlePatchApply(args) {
  if (!validator) return err("Validator not initialized");
  const fp = await resolveInsideRoot(args.filePath);
  const result = validator.apply({ patchId: args.patchId, filePath: fp });
  return ok(result);
}

function ok(d) { return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }], structuredContent: d, isError: false }; }
function err(m) { return { content: [{ type: "text", text: m }], isError: true }; }
function symId(root, filePath, parsed, sym) { return createSymbolId({ projectRelativePath: relative(root || '.', filePath), language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }); }
function estimateTokens(t) { return Math.ceil(String(t).length / 1.3); }

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[code-shrinker v${PKG.version}] ready`);
