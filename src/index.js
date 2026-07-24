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
import { IncrementalIndex } from "./compiler/incremental-index.js";
const indexes = new Map(); // repositoryId → { root, index }
import { artifactPut, artifactGet, artifactGetChunk, artifactCopyText, artifactPin, artifactDelete, artifactList, artifactStats, artifactGC } from "./core/artifact-store.js";
import { parseFile, extractContract } from "./core/ast-engine.js";
import { createSymbolId, createSymbolRevisionFromSource, createFileRevision } from "./core/symbol-id.js";
import { TokenBudget } from "./core/token-budget.js";
import { CallGraph } from "./compiler/call-graph.js";
import { PatchValidator } from "./compiler/patch-validator.js";

const server = new Server({ name: "code-shrinker", version: PKG.version }, { capabilities: { tools: {} } });
const budget = new TokenBudget();
const sessions = new Map();
const patches = new Map(); // patchId → { contextId, edits }


function requireRepositoryId(args) {
  const rid = String(args.repository_id || "").trim();
  if (!rid) throw new Error("repository_id is required");
  return rid;
}
function requireIndex(repositoryId) {
  const slot = indexes.get(repositoryId);
  if (!slot) throw new Error(`No index for repository_id=${repositoryId}. Start watcher first.`);
  return slot;
}

const CONFIGURED_ROOTS = (process.env.CODE_SHRINKER_ALLOWED_ROOTS || '').split(delimiter).filter(Boolean).map(p => resolve(p));

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function rootForFile(filePath) {
  const root = CONFIGURED_ROOTS.find(r => isInside(r, filePath));
  if (!root) throw new Error("NO_ROOT_FOR_FILE: " + filePath);
  return root;
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
  { name: "project.watch_start", title: "Start Watch", description: "Start incremental file watcher for a specific repository.", inputSchema: { type: "object", properties: { repository_id: { type: "string", minLength: 1, description: "Repository identifer (e.g. owner/repo)" }, path: { type: "string" }, interval: { type: "number", description: "Poll interval ms (default 5000)" }, exclude: { type: "array", items: { type: "string" } } }, required: ["repository_id"] } },
  { name: "project.watch_stop", title: "Stop Watch", description: "Stop the watcher for a specific repository.", inputSchema: { type: "object", properties: { repository_id: { type: "string", minLength: 1 } }, required: ["repository_id"] } },
  { name: "project.watch_status", title: "Watch Status", description: "Current watcher state for a repository.", inputSchema: { type: "object", properties: { repository_id: { type: "string", minLength: 1 } }, required: ["repository_id"] } },
  { name: "project.snapshot", title: "Project Snapshot", description: "Take a snapshot for a repository.", inputSchema: { type: "object", properties: { repository_id: { type: "string", minLength: 1 }, path: { type: "string" } }, required: ["repository_id"] } },
  { name: "artifact.put", title: "Store Artifact", description: "Content-addressed storage with SHA-256, compression, TTL. Returns artifact ID.", inputSchema: { type: "object", properties: { content: { type: "string", description: "Content to store (text or base64)" }, contentType: { type: "string", default: "text/plain" }, compress: { type: "boolean", default: true }, ttl: { type: "number", description: "TTL in seconds (0 = forever)" }, pin: { type: "boolean" }, sensitive: { type: "boolean" }, redacted: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } },
  { name: "artifact.get", title: "Get Artifact", description: "Retrieve artifact by ID. Returns content as text.", inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] } },
  { name: "artifact.get_chunk", title: "Get Chunk", description: "Read one chunk of a large artifact.", inputSchema: { type: "object", properties: { artifactId: { type: "string" }, chunkIndex: { type: "number", default: 0 } }, required: ["artifactId"] } },
  { name: "artifact.copy_text", title: "Copy Text", description: "Self-contained copyable artifact content.", inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] } },
  { name: "artifact.pin", title: "Pin Artifact", description: "Pin/unpin (pinned survive GC).", inputSchema: { type: "object", properties: { artifactId: { type: "string" }, pin: { type: "boolean", default: true } }, required: ["artifactId"] } },
  { name: "artifact.delete", title: "Delete Artifact", description: "Delete artifact and its files.", inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] } },
  { name: "artifact.list", title: "List Artifacts", description: "List all artifacts with metadata.", inputSchema: { type: "object", properties: { pinned: { type: "boolean" }, tag: { type: "string" }, limit: { type: "number", default: 50 } } } },
  { name: "artifact.stats", title: "Artifact Stats", description: "Storage statistics (count, size, compression).", inputSchema: { type: "object", properties: {} } },
  { name: "artifact.gc", title: "Garbage Collect", description: "Remove expired unpinned artifacts.", inputSchema: { type: "object", properties: {} } },
  { name: "project.changed_symbols", title: "Changed Symbols", description: "Symbols changed since last scan/watch for a repository.", inputSchema: { type: "object", properties: { repository_id: { type: "string", minLength: 1 }, limit: { type: "number", default: 50 } }, required: ["repository_id"] } },
  { name: "context.create", title: "Create Context Packet", description: "Build L0-L3 packet with ranking + quality check.", inputSchema: { type: "object", properties: { task: { type: "object" }, targetFile: { type: "string" }, tokenBudget: { type: "number" }, qualityFloor: { type: "number" }, mode: { type: "string", enum: ["safe","balanced","aggressive"] }, projectRoot: { type: "string" }, evidence: { type: "object" } }, required: ["task","targetFile"] } },
  { name: "context.expand", title: "Expand Context", description: "FIXED: path validated, loads symbols into packet.", inputSchema: { type: "object", properties: { contextId: { type: "string" }, requests: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, filePath: { type: "string" }, view: { type: "string", enum: ["source","contract"] }, reason: { type: "string" } }, required: ["symbol"] } } }, required: ["contextId","requests"] } },
  { name: "context.inspect", title: "Inspect Loss", description: "Loss manifest + quality.", inputSchema: { type: "object", properties: { contextId: { type: "string" } }, required: ["contextId"] } },
  { name: "patch.propose", title: "Propose Patch", description: "FIXED: patchId linked to validate/apply via randomUUID.", inputSchema: { type: "object", properties: { contextId: { type: "string" }, edits: { type: "array" } }, required: ["contextId","edits"] } },
  { name: "patch.validate", title: "Validate Patch", description: "Validate proposed patch. Requires patchId from patch.propose. All state from server.", inputSchema: { type: "object", properties: { patchId: { type: "string" } }, required: ["patchId"], additionalProperties: false } },
  { name: "patch.apply", title: "Apply Patch", description: "FIXED: real hash re-check works now.", inputSchema: { type: "object", properties: { patchId: { type: "string" } }, required: ["patchId"], additionalProperties: false } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.name.startsWith("patch.a"), destructiveHint: t.name === "patch.apply" } })) }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "project.watch_start": return handleWatchStart(args);
      case "project.watch_stop": return handleWatchStop(args);
      case "project.watch_status": return handleWatchStatus(args);
      case "project.snapshot": return handleSnapshot(args);
      case "artifact.put": return handleArtifactPut(args);
      case "artifact.get": return handleArtifactGet(args);
      case "artifact.get_chunk": return handleArtifactGetChunk(args);
      case "artifact.copy_text": return handleArtifactCopyText(args);
      case "artifact.pin": return handleArtifactPin(args);
      case "artifact.delete": return handleArtifactDelete(args);
      case "artifact.list": return handleArtifactList(args);
      case "artifact.stats": return handleArtifactStats(args);
      case "artifact.gc": return handleArtifactGC(args);
      case "project.changed_symbols": return handleChangedSymbols(args);
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

async function handleWatchStart(args) {
  const repoId = requireRepositoryId(args);
  const existing = indexes.get(repoId);
  const watchPath = args.path
    ? await resolveInsideRoot(args.path)
    : existing?.root ?? await resolveInsideRoot(".");
  if (existing) {
    if (existing.root !== watchPath) throw new Error(`REPOSITORY_ROOT_MISMATCH: ${repoId} bound to ${existing.root}, not ${watchPath}`);
    if (existing.index.status().watching) return ok({ ...existing.index.status(), repository_id: repoId, root: watchPath, note: "already watching" });
  }
  const slot = existing || { root: watchPath, index: new IncrementalIndex(watchPath) };
  const result = slot.index.start({ interval: args.interval || 5000, exclude: args.exclude });
  indexes.set(repoId, slot);
  return ok({ ...result, repository_id: repoId, root: watchPath });
}

async function handleWatchStop(args) {
  const repoId = requireRepositoryId(args);
  const slot = requireIndex(repoId);
  const result = slot.index.stop();
  indexes.delete(repoId);
  return ok({ status: "stopped", repository_id: repoId, root: slot.root });
}

function handleWatchStatus(args) {
  const repoId = requireRepositoryId(args);
  const slot = requireIndex(repoId);
  return ok({ ...slot.index.status(), repository_id: repoId, root: slot.root, indexes: indexes.size });
}

async function handleSnapshot(args) {
  const repoId = requireRepositoryId(args);
  const existing = indexes.get(repoId);
  const snapPath = args.path
    ? await resolveInsideRoot(args.path)
    : existing?.root ?? await resolveInsideRoot(".");
  if (existing) {
    if (existing.root !== snapPath) throw new Error(`REPOSITORY_ROOT_MISMATCH: ${repoId} bound to ${existing.root}, not ${snapPath}`);
  }
  const slot = existing || { root: snapPath, index: new IncrementalIndex(snapPath) };
  if (!slot.index.graph._scanned) slot.index.graph.scan();
  if (!existing) indexes.set(repoId, slot);
  return ok({ ...slot.index.snapshot(), repository_id: repoId, root: slot.root });
}

function handleArtifactPut(args) {
  try { const r = artifactPut(args.content, { mimeType: args.contentType || "text/plain", compress: args.compress !== false, ttl: args.ttl || 0, pin: args.pin || false, sensitive: args.sensitive || false, redacted: args.redacted || false, tags: args.tags || [] }); return ok(r); }
  catch (e) { return err(e.message); }
}
function handleArtifactGet(args) {
  const r = artifactGet(args.artifactId, { asText: true });
  return r ? ok({ content: r }) : err("Artifact not found");
}
function handleArtifactGetChunk(args) {
  const r = artifactGetChunk(args.artifactId, args.chunkIndex || 0);
  return r ? ok(r) : err("Chunk not found");
}
function handleArtifactCopyText(args) {
  const r = artifactCopyText(args.artifactId);
  return r ? ok({ copyText: r, artifactId: args.artifactId }) : err("Artifact not found");
}
function handleArtifactPin(args) {
  const r = artifactPin(args.artifactId, args.pin !== false);
  return r ? ok(r) : err("Artifact not found");
}
function handleArtifactDelete(args) {
  try { const r = artifactDelete(args.artifactId); return r ? ok(r) : err("Artifact not found"); }
  catch (e) { return err(e.message); }
}
function handleArtifactList(args) {
  return ok({ artifacts: artifactList({ pinned: args.pinned, tag: args.tag, limit: args.limit || 50 }) });
}
function handleArtifactStats(args) {
  return ok(artifactStats());
}
function handleArtifactGC(args) {
  return ok(artifactGC());
}
function handleChangedSymbols(args) {
  const repoId = requireRepositoryId(args);
  const slot = requireIndex(repoId);
  return ok(slot.index.changedSymbols().slice(0, args.limit || 50));
}

async function handleProjectScan(args) {
  if (CONFIGURED_ROOTS.length === 0) throw new Error('NO_ALLOWED_ROOT_CONFIGURED');
  const repoId = String(args.repository_id || "").trim();
  const root = args.path ? await resolveInsideRoot(args.path) : CONFIGURED_ROOTS[0];
  let slot = indexes.get(repoId);
  if (!slot) { slot = { root, index: new IncrementalIndex(root) }; indexes.set(repoId, slot); }
  slot.callGraph = new CallGraph(root);
  slot.validator = new PatchValidator({ projectRoot: root });
  const stats = slot.callGraph.scan({ exclude: args.exclude });
  return ok({ status: "scanned", ...stats, repository_id: repoId, root });
}

async function handleProjectMap(args) {
  const repoId = String(args.repository_id || "").trim();
  const path = await resolveInsideRoot(args.path || ".");
  const slot = repoId ? indexes.get(repoId) : null;
  if (slot?.callGraph) {
    const slice = slot.callGraph.toContextSlice([path], 1);
    return ok({ project: path, repository_id: repoId, entrypoints: Object.keys(slice.symbols || {}).slice(0, 20), ...slice });
  }
  return ok({ project: path, status: "stub", note: "Run project.scan for full map", repository_id: repoId });
}

async function handleFileContracts(args) {
  const fp = await resolveInsideRoot(args.filePath);
  const parsed = parseFile(fp);
  const rev = createFileRevision(parsed.code);
  const contracts = parsed.symbols.map(sym => {
    const c = extractContract(sym, parsed.code, parsed.language);
    return {
      id: symId(rootForFile(fp), fp, parsed, sym),
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
    id: symId(rootForFile(fp), fp, parsed, sym),
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
  const repoId = String(args.repository_id || "").trim();
  const slot = repoId ? indexes.get(repoId) : null;
  if (!slot?.callGraph) return err("Run project.scan first for this repository");
  const result = {};
  for (const w of (args.what || [])) {
    switch (w) { case "callers": result.callers = slot.callGraph.callers(args.filePath, args.symbol); break; case "callees": result.callees = slot.callGraph.callees(args.filePath, args.symbol); break; case "tests": result.tests = slot.callGraph.getTests(args.filePath, args.symbol); break; }
  }
  return ok(result);
}

async function handleContextCreate(args) {
  const tf = await resolveInsideRoot(args.targetFile);
  const packet = await buildContextPacket({ ...args, targetFile: tf, tokenBudget: args.tokenBudget || 8000, qualityFloor: args.qualityFloor ?? 0.95, mode: args.mode || "safe", evidence: args.evidence || {}, projectRoot: rootForFile(tf) });
  const cgSlot = (args.task?.repositoryId) ? indexes.get(args.task.repositoryId) : null;
  if (cgSlot?.callGraph && args.task?.target) {
    const callers = cgSlot.callGraph.callers(tf, args.task.target);
    const tests = cgSlot.callGraph.getTests(tf, args.task.target);
    if (callers.length) packet.packet.callers = callers;
    if (tests.length) packet.packet.relatedTests = tests;
  }
  packet._targetFile = tf;
  packet._qualityFloor = args.qualityFloor ?? 0.95;
  packet._projectRoot = rootForFile(tf);
  packet._repositoryId = args.task?.repositoryId || "";
  packet._commitSha = args.task?.commitSha || "";
  // Resolve target to stable ID for expand comparisons
  const targetContract = packet.packet.contracts?.find(c => c.handle === args.task?.target || c.signature?.includes(args.task?.target));
  const targetSource = packet.packet.sources?.find(s => s.handle === args.task?.target);
  packet._targetSymbolId = targetSource?.id || targetContract?.id || args.task?.target || "";
  packet._targetSymbolName = args.task?.target || "";
  packet._targetFileRevision = createFileRevision(readFileSync(tf, 'utf-8'));
  
  // P2: Quality auto-recovery — single retry with expanded budget
  if (!packet.qualitySatisfied && args.allowRecovery !== false) {
    const recoveryPlan = [...(packet.qualityRecovery?.hints || [])];
    if (recoveryPlan.length > 0) {
      try {
        const recovered = await buildContextPacket({
          ...args,
          targetFile: tf,
          tokenBudget: (args.tokenBudget || 8000) * 1.5,  // Expand budget by 50%
          qualityFloor: args.qualityFloor ?? 0.95,
          mode: args.mode || "safe",
          evidence: args.evidence || {},
          projectRoot: rootForFile(tf),
        });
        if (recovered.qualitySatisfied && recovered.estimatedQuality > packet.estimatedQuality) {
          recovered._targetFile = tf;
          recovered._targetFileRevision = packet._targetFileRevision;
          recovered._qualityFloor = args.qualityFloor ?? 0.95;
          recovered._projectRoot = rootForFile(tf);
          recovered._repositoryId = args.task?.repositoryId || "";
          recovered._commitSha = args.task?.commitSha || "";
          const recTargetContract = recovered.packet.contracts?.find(c => c.handle === args.task?.target || c.signature?.includes(args.task?.target));
          const recTargetSource = recovered.packet.sources?.find(s => s.handle === args.task?.target);
          recovered._targetSymbolId = recTargetSource?.id || recTargetContract?.id || args.task?.target || "";
          recovered._targetSymbolName = args.task?.target || "";
          recovered.qualityRecovery = {
            attempted: true,
            succeeded: true,
            actions: recoveryPlan,
            qualityBefore: packet.estimatedQuality,
            qualityAfter: recovered.estimatedQuality,
            budgetBefore: args.tokenBudget || 8000,
            budgetAfter: (args.tokenBudget || 8000) * 1.5
          };
          packet = recovered;
        } else {
          packet.qualityRecovery = {
            attempted: true,
            succeeded: false,
            actions: recoveryPlan,
            qualityBefore: packet.estimatedQuality,
            qualityAfter: recovered.estimatedQuality
          };
        }
      } catch (e) {
        packet.qualityRecovery = {
          attempted: true,
          succeeded: false,
          error: { type: e.name || 'Error', message: e.message || String(e) }
        };
      }
    }
  }
  
  sessions.set(packet.contextId, packet);
  return ok({
    contextId: packet.contextId, revision: packet.revision,
    task: packet.task, layers: packet.layers, tokens: packet.tokens,
    risk: packet.risk, qualitySatisfied: packet.qualitySatisfied,
    estimatedQuality: packet.estimatedQuality,
    loss: { removed: packet.loss.removed, preserved: packet.loss.preserved, risk: packet.loss.risk },
    aliases: packet.aliases, packet: packet.packet, omitted: packet.omitted,
    coverage_manifest: packet.coverage_manifest || null,
    qualityRecovery: packet.qualityRecovery || null
  });
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
      const sid = symId(rootForFile(fp), fp, parsed, sym);
      const srev = createSymbolRevisionFromSource(c.body || "", sym.signature);
      const h = packet.handles.register(sid, sym.qualifiedName, fp);
      if (!packet.packet.contracts.find(x => x.id === sid)) {
        packet.packet.contracts.push({ handle: h, id: sid, revision: srev, file: fp, kind: sym.kind, signature: c.signature, effects: c.effects, throws: c.throws, properties: c.properties, confidence: c.confidence, range: [sym.startLine, sym.endLine] });
        added.contracts.push({ id: sid, handle: h, symbol: req.symbol, status: "loaded" });
        packet.layers.contracts++;
      }
      if (req.view === "source" && c.body && !packet.packet.sources.find(x => x.id === sid)) {
        packet.packet.sources.push({ handle: h, id: sid, expectedRevision: srev, file: fp, language: parsed.language, source: c.body });
        added.sources.push({ id: sid, handle: h, symbol: req.symbol, status: "loaded", tokens: estimateTokens(c.body) });
        added.tokensAdded += estimateTokens(c.body);
        packet.layers.sources++;
      }
      // Remove from omitted if present
      packet.omitted = packet.omitted.filter(o => o.id !== sid);
    } catch (e) { added.sources.push({ symbol: req.symbol, status: "error", error: e.message }); }
  }
  packet.revision++;
  packet.tokens += added.tokensAdded;
  
  // Build coverage manifest for expanded packet
  const sources = packet.packet.sources || [];
  const contracts = packet.packet.contracts || [];
  const evidence = packet.packet.evidence || [];
  const hasTarget = sources.length > 0 && (packet._targetSymbolId ? sources.some(s => s.id === packet._targetSymbolId) : true);
  const hasContracts = contracts.length > 0;
  const hasEvidence = evidence.length > 0;
  const omittedCount = (packet.omitted || []).length;
  
  // Recalculate estimated quality
  let estQ = 0.5;
  if (hasTarget) estQ += 0.25;
  if (hasContracts) estQ += 0.15;
  if (hasEvidence) estQ += 0.10;
  if (omittedCount === 0) estQ = Math.min(estQ + 0.05, 1.0);
  packet.estimatedQuality = Math.round(estQ * 100) / 100;
  packet.qualitySatisfied = packet.estimatedQuality >= (packet._qualityFloor || 0.95);
  
  // Update loss manifest — subtract only successfully loaded IDs
  if (packet.loss) {
    const newlyRestoredIds = new Set(
      (added.sources || [])
        .filter(s => s.status === "loaded" && s.id)
        .map(s => s.id)
    );
    packet.loss.removedSymbolIds = (packet.loss.removedSymbolIds || []).filter(id => !newlyRestoredIds.has(id));
    packet.loss.removed.symbols = packet.loss.removedSymbolIds.length;
    packet.loss.removed.bodies = packet.loss.removedSymbolIds.length;
    packet.loss.preserved.targetSource = hasTarget;
  }
  
  // Recalculate risk
  if (!hasTarget) packet.risk = "high";
  else if (packet.loss?.removed?.bodies > packet.layers?.contracts * 0.3) packet.risk = "medium";
  else packet.risk = "low";
  if (packet.loss) packet.loss.risk = packet.risk;
  
  // Rebuild coverage manifest
  const projectRoot = packet._projectRoot || ".";
  const { createHash } = await import("node:crypto");
  packet.coverage_manifest = {
    protocol_version: 1,
    packet_id: packet.contextId,
    repository_id: packet._repositoryId || "", commit_sha: packet._commitSha || "",
    covered: [],
    created_at: Math.floor(Date.now() / 1000)
  };
  for (const src of sources) {
    const hash = createHash("sha256").update(src.source || "").digest("hex");
    packet.coverage_manifest.covered.push({
      kind: "exact_source", file_path: src.file ? relative(packet._projectRoot || ".", src.file).replace(/\\/g, "/") : "",
      symbol_id: src.id, revision: src.expectedRevision || "",
      content_hash: hash,
      token_count: estimateTokens(src.source || "", "code")
    });
  }
  for (const contract of contracts) {
    const hash = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
    packet.coverage_manifest.covered.push({
      kind: "contract", file_path: contract.file ? (packet._projectRoot !== "." ? relative(packet._projectRoot, contract.file).replace(/\\/g, "/") : contract.file) : "",
      symbol_id: contract.id, revision: contract.revision || "",
      content_hash: hash,
      token_count: estimateTokens(JSON.stringify(contract), "json")
    });
  }
  for (const ev of evidence) {
    const hash = createHash("sha256").update(JSON.stringify(ev.data)).digest("hex");
    packet.coverage_manifest.covered.push({
      kind: ev.type === "tests" ? "test" : "diagnostic",
      content_hash: hash,
      token_count: estimateTokens(JSON.stringify(ev.data), "diagnostic")
    });
  }
  
  sessions.set(args.contextId, packet);
  return ok({
    contextId: args.contextId, fromRevision: oldRev, revision: packet.revision,
    added, tokensAdded: added.tokensAdded,
    coverage_manifest: packet.coverage_manifest,
    estimatedQuality: packet.estimatedQuality,
    qualitySatisfied: packet.qualitySatisfied,
    loss: packet.loss ? { removed: packet.loss.removed, preserved: packet.loss.preserved, risk: packet.loss.risk } : null,
    risk: packet.risk
  });
}

async function handleContextInspect(args) {
  const p = sessions.get(args.contextId);
  if (!p) return err(`Context: ${args.contextId}`);
  return ok({ contextId: args.contextId, revision: p.revision, qualitySatisfied: p.qualitySatisfied, estimatedQuality: p.estimatedQuality, loss: p.loss, omitted: p.omitted, risk: p.risk });
}

async function handlePatchPropose(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err("Context: " + args.contextId);
  for (const edit of (args.edits || [])) {
    if (edit.operation === "replace_symbol") {
      const ctr = (packet.packet.contracts || []).find(c => c.handle === edit.symbol || c.id === edit.symbol);
      const src = (packet.packet.sources || []).find(s => s.handle === edit.symbol || s.id === edit.symbol);
      const known = src || ctr;
      if (!known) return err("UNKNOWN_SYMBOL: " + edit.symbol);
      if (ctr && ctr.range) { edit.startLine = ctr.range[0]; edit.endLine = ctr.range[1]; }
      if (known.file && known.file !== packet._targetFile) return err("CROSS_FILE_EDIT: " + edit.symbol + " in " + known.file);
    }
  }
  const patchId = "patch_" + randomUUID().slice(0, 12);
  const ref = { contextId: args.contextId, contextRevision: packet.revision, filePath: packet._targetFile, expectedFileRevision: packet._targetFileRevision, edits: args.edits.map(e => ({...e})), editsHash: createFileRevision(JSON.stringify(args.edits)) };
  patches.set(patchId, ref);
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
  // Check file hasn\'t changed since context.create
  const currentFileRev = createFileRevision(readFileSync(filePath, 'utf-8'));
  if (proposed.expectedFileRevision && currentFileRev !== proposed.expectedFileRevision) return err('STALE_FILE_SINCE_CONTEXT');
  // Init validator from configured root that contains this file
  const projectRoot = rootForFile(filePath);
  let vtor; for (const s of indexes.values()) { if (s.validator && s.root === projectRoot) { vtor = s.validator; break; } } if (!vtor) { vtor = new PatchValidator({ projectRoot }); }
  const fileHash = existsSync(filePath) ? createFileRevision(readFileSync(filePath, "utf-8")) : null;
  const result = vtor.validate({ patchId: args.patchId, filePath, originalHash: fileHash, edits: proposed.edits });
  return ok(result);
}

async function handlePatchApply(args) {
  if (!args.patchId) return err('patchId required');
  const proposed = patches.get(args.patchId);
  if (!proposed) return err('UNKNOWN_PATCH_ID');
  const fp = await resolveInsideRoot(proposed.filePath);
  const vRoot = CONFIGURED_ROOTS.find(r => isInside(r, fp)) || CONFIGURED_ROOTS[0] || resolve('.');
  let vtor; for (const s of indexes.values()) { if (s.validator && s.root === vRoot) { vtor = s.validator; break; } } if (!vtor) { vtor = new PatchValidator({ projectRoot: vRoot }); }
  const validation = vtor.results.get(args.patchId);
  if (!validation) return err('Validation not found — run patch.validate first');
  const result = vtor.apply({ patchId: args.patchId, filePath: fp });
  return ok(result);
}

function ok(d) { return { content: [{ type: "text", text: JSON.stringify(d) }], isError: false }; }
function err(m) { return { content: [{ type: "text", text: m }], isError: true }; }
function symId(root, filePath, parsed, sym) { return createSymbolId({ projectRelativePath: relative(root || '.', filePath), language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }); }
function estimateTokens(t, contentType = "text") {
  // Uses model-aware TokenBudget when available, falls back to estimated ratio
  if (typeof TokenBudget !== "undefined" && TokenBudget.countText) {
    return TokenBudget.countText(String(t), contentType);
  }
  // Fallback coefficients by content type
  const ratios = { text: 0.75, code: 0.40, json: 0.55, tool_schema: 0.60, diagnostic: 0.65 };
  const ratio = ratios[contentType] || 0.70;
  return Math.ceil(String(t).length * ratio);
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[code-shrinker v${PKG.version}] ready`);
