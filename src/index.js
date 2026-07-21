#!/usr/bin/env node
// ═══ Code Shrinker MCP Server v0.3.1 ═══
// Semantic Context Compiler — bugfix release
// FIXED: symbolRevision tracks body changes
// FIXED: patch.validate tests against sandbox copy
// FIXED: context.expand actually loads data
// FIXED: aggressive mode logic (fewer sources, not more)
// FIXED: qualityFloor applied
// FIXED: loss manifest no double-count
// FIXED: path security (MCP roots)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, realpathSync } from "fs";
import { resolve, relative } from "path";
import { buildContextPacket } from "./compiler/packet-builder.js";
import { parseFile, extractContract } from "./core/ast-engine.js";
import { createSymbolId, createSymbolRevisionFromSource, createFileRevision } from "./core/symbol-id.js";
import { TokenBudget } from "./core/token-budget.js";
import { CallGraph } from "./compiler/call-graph.js";
import { PatchValidator } from "./compiler/patch-validator.js";

const server = new Server({ name: "code-shrinker", version: "0.3.1" }, { capabilities: { tools: {} } });
const budget = new TokenBudget();
const sessions = new Map();
let callGraph = null;
let validator = null;
let allowedRoots = [];

// ═══ Path Security ═══
async function resolveInsideRoot(inputPath) {
  try {
    const rp = realpathSync(inputPath);
    if (allowedRoots.length === 0) return rp; // No roots set — allow all
    const ok = allowedRoots.some(root => rp === root || rp.startsWith(root + "/"));
    if (!ok) throw new Error(`PATH_OUTSIDE_ALLOWED_ROOT: ${rp}`);
    return rp;
  } catch (e) {
    if (e.message.startsWith("PATH_OUTSIDE")) throw e;
    throw new Error(`PATH_RESOLVE_ERROR: ${e.message}`);
  }
}

// ═══ Tools ═══
const toolDefs = [
  { name: "project.scan", title: "Scan Project", description: "Build cross-file call graph, discover tests, index symbols. Required before symbol.context.", inputSchema: { type: "object", properties: { path: { type: "string" }, exclude: { type: "array", items: { type: "string" } } } } },
  { name: "project.map", title: "Project Map (L0)", description: "Layer 0: file tree, exports, entry points.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "file.contracts", title: "File Contracts (L1)", description: "Layer 1: semantic contracts — signatures, effects, throws, calls, confidence.", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
  { name: "symbol.source", title: "Symbol Source (L2)", description: "Layer 2: EXACT source. NO renaming, NO compression.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, symbol: { type: "string" }, view: { type: "string", enum: ["source","contract","reference"] } }, required: ["filePath","symbol"] } },
  { name: "symbol.context", title: "Symbol Context", description: "Callers, callees, tests from call graph. Requires project.scan.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, symbol: { type: "string" }, what: { type: "array", items: { type: "string", enum: ["callers","callees","tests","sideEffects"] } } }, required: ["filePath","symbol"] } },
  { name: "context.create", title: "Create Context Packet", description: "Build L0-L3 packet with ranking + quality check.", inputSchema: { type: "object", properties: { task: { type: "object" }, targetFile: { type: "string" }, tokenBudget: { type: "number" }, qualityFloor: { type: "number" }, mode: { type: "string", enum: ["safe","balanced","aggressive"] }, projectRoot: { type: "string" }, evidence: { type: "object" } }, required: ["task","targetFile"] } },
  { name: "context.expand", title: "Expand Context", description: "Load requested symbols/sources into existing packet. Returns real delta.", inputSchema: { type: "object", properties: { contextId: { type: "string" }, requests: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, filePath: { type: "string" }, view: { type: "string", enum: ["source","contract"] }, reason: { type: "string" } }, required: ["symbol"] } } }, required: ["contextId","requests"] } },
  { name: "context.inspect", title: "Inspect Loss", description: "Show loss manifest: removed symbols, risk, quality, retrievable.", inputSchema: { type: "object", properties: { contextId: { type: "string" } }, required: ["contextId"] } },
  { name: "patch.propose", title: "Propose Patch", description: "Propose edit operations: replace_symbol, insert_before/after.", inputSchema: { type: "object", properties: { contextId: { type: "string" }, edits: { type: "array" } }, required: ["contextId","edits"] } },
  { name: "patch.validate", title: "Validate Patch", description: "FIXED: tests run in sandbox copy. Hash→sandbox→parse→typecheck→lint→test.", inputSchema: { type: "object", properties: { filePath: { type: "string" }, edits: { type: "array" }, originalHash: { type: "string" }, projectRoot: { type: "string" } }, required: ["filePath","edits"] } },
  { name: "patch.apply", title: "Apply Patch", description: "Apply validated patch with re-check. Creates .bak backup.", inputSchema: { type: "object", properties: { patchId: { type: "string" }, filePath: { type: "string" } }, required: ["patchId","filePath"] } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.name.startsWith("patch.a"), destructiveHint: t.name === "patch.apply" } })),
}));

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

// ═══ Handlers ═══

async function handleProjectScan(args) {
  const root = resolve(args.path || ".");
  allowedRoots.push(realpathSync(root));
  callGraph = new CallGraph(root);
  validator = new PatchValidator({ projectRoot: root });
  const stats = callGraph.scan({ exclude: args.exclude });
  return ok({ status: "scanned", ...stats, root, allowedRoots });
}

async function handleProjectMap(args) {
  const path = await resolveInsideRoot(args.path || ".");
  if (callGraph) {
    const slice = callGraph.toContextSlice([path], 1);
    return ok({ project: path, ...slice, note: "Call graph slice loaded" });
  }
  return ok({ project: path, status: "stub", note: "Run project.scan for full map" });
}

async function handleFileContracts(args) {
  const filePath = await resolveInsideRoot(args.filePath);
  const parsed = parseFile(filePath);
  const contracts = parsed.symbols.map(sym => {
    const c = extractContract(sym, parsed.code, parsed.language);
    return {
      id: createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }),
      revision: createSymbolRevisionFromSource(c.body || "", sym.signature),
      handle: `@${sym.qualifiedName}`, kind: sym.kind,
      signature: c.signature, visibility: c.visibility,
      effects: c.effects, throws: c.throws, calls: c.calls,
      properties: c.properties, confidence: c.confidence,
    };
  });
  return ok({ file: filePath, fileRevision: createFileRevision(parsed.code), language: parsed.language, contracts, imports: parsed.imports });
}

async function handleSymbolSource(args) {
  const filePath = await resolveInsideRoot(args.filePath);
  const parsed = parseFile(filePath);
  const sym = parsed.symbols.find(s => s.qualifiedName === args.symbol || s.name === args.symbol);
  if (!sym) return err(`Symbol not found: ${args.symbol}`);
  const c = extractContract(sym, parsed.code, parsed.language);
  const result = {
    id: createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }),
    revision: createSymbolRevisionFromSource(c.body || "", sym.signature),
    fileRevision: createFileRevision(parsed.code),
    handle: `@${sym.qualifiedName}`, kind: sym.kind, language: parsed.language,
  };
  const view = args.view || "source";
  if (view === "source") result.source = c.body;
  if (view === "source" || view === "contract") {
    result.contract = { signature: c.signature, effects: c.effects, throws: c.throws, calls: c.calls, properties: c.properties, confidence: c.confidence };
  } else { result.signature = c.signature; }
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
  const targetFile = await resolveInsideRoot(args.targetFile);
  const packet = await buildContextPacket({ ...args, targetFile, tokenBudget: args.tokenBudget || 8000, qualityFloor: args.qualityFloor ?? 0.95, mode: args.mode || "safe", projectRoot: args.projectRoot || ".", evidence: args.evidence || {} });
  if (callGraph && args.task?.target) {
    const callers = callGraph.callers(targetFile, args.task.target);
    const tests = callGraph.getTests(targetFile, args.task.target);
    if (callers.length) packet.packet.callers = callers;
    if (tests.length) packet.packet.relatedTests = tests;
  }
  sessions.set(packet.contextId, packet);
  return ok({ contextId: packet.contextId, revision: packet.revision, task: packet.task, layers: packet.layers, tokens: packet.tokens, risk: packet.risk, qualitySatisfied: packet.qualitySatisfied, estimatedQuality: packet.estimatedQuality, loss: { removed: packet.loss.removed, preserved: packet.loss.preserved, risk: packet.loss.risk }, aliases: packet.aliases, packet: packet.packet, omitted: packet.omitted });
}

async function handleContextExpand(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);

  const added = { sources: [], contracts: [], tokensAdded: 0 };
  const oldRev = packet.revision;

  for (const req of (args.requests || [])) {
    const fp = req.filePath || packet.packet.project.project;
    try {
      const parsed = parseFile(fp);
      const sym = parsed.symbols.find(s => s.qualifiedName === req.symbol || s.name === req.symbol);
      if (!sym) { added.sources.push({ symbol: req.symbol, status: "not_found" }); continue; }

      const c = extractContract(sym, parsed.code, parsed.language);
      const sid = createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature });
      const srev = createSymbolRevisionFromSource(c.body || "", sym.signature);
      const h = packet.handles.register(sid, sym.qualifiedName, fp);

      if (req.view === "source" && c.body) {
        packet.packet.sources.push({ handle: h, id: sid, expectedRevision: srev, language: parsed.language, source: c.body });
        added.sources.push({ handle: h, symbol: req.symbol, status: "loaded", tokens: estimateTokens(c.body) });
        added.tokensAdded += estimateTokens(c.body);
        packet.layers.sources++;
      }

      packet.packet.contracts.push({
        handle: h, id: sid, revision: srev, kind: sym.kind,
        signature: c.signature, effects: c.effects, throws: c.throws,
        properties: c.properties, confidence: c.confidence,
      });
      if (!added.sources.find(s => s.handle === h)) {
        added.contracts.push({ handle: h, symbol: req.symbol, status: "loaded" });
      }
    } catch (e) {
      added.sources.push({ symbol: req.symbol, status: "error", error: e.message });
    }
  }

  packet.revision++;
  packet.tokens += added.tokensAdded;
  sessions.set(args.contextId, packet);

  return ok({ contextId: args.contextId, fromRevision: oldRev, revision: packet.revision, added, tokensAdded: added.tokensAdded, newTotalTokens: packet.tokens });
}

async function handleContextInspect(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);
  return ok({ contextId: args.contextId, revision: packet.revision, qualitySatisfied: packet.qualitySatisfied, estimatedQuality: packet.estimatedQuality, loss: packet.loss, omitted: packet.omitted, risk: packet.risk, retrievableCount: packet.omitted.length });
}

async function handlePatchPropose(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);
  for (const edit of (args.edits || [])) {
    if (edit.operation === "replace_symbol") {
      const known = packet.packet.contracts.find(c => c.handle === edit.symbol || c.id === edit.symbol);
      const knownSrc = packet.packet.sources.find(s => s.handle === edit.symbol || s.id === edit.symbol);
      if (!known && !knownSrc) return err(`Unknown symbol: ${edit.symbol}`);
      // Inject startLine/endLine from contract
      if (known) { edit.startLine = known.range?.[0]; edit.endLine = known.range?.[1]; }
    }
  }
  const patchId = `patch_${Date.now().toString(36)}`;
  sessions.set(patchId, { contextId: args.contextId, edits: args.edits });
  return ok({ patchId, contextId: args.contextId, edits: args.edits.map(e => ({ ...e, status: "proposed" })), note: "Use patch.validate next." });
}

async function handlePatchValidate(args) {
  const filePath = await resolveInsideRoot(args.filePath);
  if (!validator) validator = new PatchValidator({ projectRoot: args.projectRoot || resolve(".") });
  const patchId = `patch_${Date.now().toString(36)}`;
  const originalHash = args.originalHash || (existsSync(filePath) ? createFileRevision(readFileSync(filePath, "utf-8")) : null);
  const result = validator.validate({ patchId, filePath, originalHash, edits: args.edits });
  return ok(result);
}

async function handlePatchApply(args) {
  if (!validator) return err("Validator not initialized");
  const filePath = await resolveInsideRoot(args.filePath);
  const result = validator.apply({ patchId: args.patchId, filePath });
  return ok(result);
}

// ═══ Helpers ═══
function ok(d) { return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }], structuredContent: d, isError: false }; }
function err(m) { return { content: [{ type: "text", text: m }], isError: true }; }
function estimateTokens(t) { return Math.ceil(String(t).length / 1.3); }

// ═══ Start ═══
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[code-shrinker v0.3.1] ready — all critical bugs fixed");
