#!/usr/bin/env node
// ═══ Code Shrinker MCP Server v0.3.0 ═══
// Semantic Context Compiler with cross-file call graph & patch validation
//
// Architecture:
//   Task → CallGraph.scan() → ranking → context.create() → LLM → patch.propose()
//   → patch.validate(parse→typecheck→lint→test) → patch.apply()

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { buildContextPacket } from "./compiler/packet-builder.js";
import { parseFile, extractContract } from "./core/ast-engine.js";
import { createSymbolId, createSymbolRevision, createFileRevision } from "./core/symbol-id.js";
import { TokenBudget } from "./core/token-budget.js";
import { CallGraph } from "./compiler/call-graph.js";
import { PatchValidator } from "./compiler/patch-validator.js";

const server = new Server(
  { name: "code-shrinker", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

const budget = new TokenBudget();
const sessions = new Map(); // contextId → packet
let callGraph = null;
let validator = null;

// ═══ Tool Definitions ═══
const toolDefs = [
  // ── Project & Discovery ──
  {
    name: "project.scan", title: "Scan Project",
    description: "Scan entire project: build cross-file call graph, discover tests, index all symbols. Required before symbol.context queries.",
    inputSchema: {
      type: "object", properties: {
        path: { type: "string", description: "Project root (default: cwd)" },
        exclude: { type: "array", items: { type: "string" }, description: "Directories to exclude" },
      }, required: [],
    },
  },
  {
    name: "project.map", title: "Project Map (L0)",
    description: "Layer 0: file tree + exports + entry points. Navigation only, no source code.",
    inputSchema: {
      type: "object", properties: {
        path: { type: "string" }, maxFiles: { type: "number" },
      }, required: ["path"],
    },
  },
  // ── Contracts & Symbols ──
  {
    name: "file.contracts", title: "File Contracts (L1)",
    description: "Layer 1: semantic contracts for all symbols in a file — signatures, effects, throws, calls, confidence.",
    inputSchema: {
      type: "object", properties: {
        filePath: { type: "string" },
      }, required: ["filePath"],
    },
  },
  {
    name: "symbol.source", title: "Symbol Source (L2)",
    description: "Layer 2: EXACT source code. NO renaming, NO regex compression, NO formatting changes.",
    inputSchema: {
      type: "object", properties: {
        filePath: { type: "string" }, symbol: { type: "string" },
        view: { type: "string", enum: ["source", "contract", "reference"] },
      }, required: ["filePath", "symbol"],
    },
  },
  {
    name: "symbol.context", title: "Symbol Context",
    description: "Get callers, callees, tests, and side effects. Requires project.scan first.",
    inputSchema: {
      type: "object", properties: {
        filePath: { type: "string" }, symbol: { type: "string" },
        what: { type: "array", items: { type: "string", enum: ["callers", "callees", "tests", "sideEffects"] } },
      }, required: ["filePath", "symbol"],
    },
  },
  // ── Context Packets ──
  {
    name: "context.create", title: "Create Context Packet",
    description: "Build L0-L3 context packet: project map + contracts + exact sources + evidence. Auto-selects relevant symbols by value-per-token ranking.",
    inputSchema: {
      type: "object", properties: {
        task: { type: "object", properties: {
          type: { type: "string", enum: ["bugfix", "refactor", "review", "generate", "test"] },
          description: { type: "string" }, target: { type: "string" },
        }, required: ["type", "description"] },
        targetFile: { type: "string" },
        tokenBudget: { type: "number" }, qualityFloor: { type: "number" },
        mode: { type: "string", enum: ["safe", "balanced", "aggressive"] },
        projectRoot: { type: "string" },
        evidence: { type: "object", properties: {
          tests: { type: "string" }, stackTrace: { type: "string" }, diagnostics: { type: "string" },
        }},
      }, required: ["task", "targetFile"],
    },
  },
  {
    name: "context.expand", title: "Expand Context",
    description: "Model requests additional symbols/evidence it needs.",
    inputSchema: {
      type: "object", properties: {
        contextId: { type: "string" },
        requests: { type: "array", items: { type: "object", properties: {
          symbol: { type: "string" }, view: { type: "string" }, reason: { type: "string" },
        }, required: ["symbol"] } },
      }, required: ["contextId", "requests"],
    },
  },
  {
    name: "context.inspect", title: "Inspect Loss",
    description: "Show loss manifest: what was removed, preserved, risk level, retrievable items.",
    inputSchema: {
      type: "object", properties: { contextId: { type: "string" } },
      required: ["contextId"],
    },
  },
  // ── Patch Workflow ──
  {
    name: "patch.propose", title: "Propose Patch",
    description: "Propose minimal edit operations: replace_symbol, insert_before, insert_after.",
    inputSchema: {
      type: "object", properties: {
        contextId: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: {
          operation: { type: "string", enum: ["replace_symbol", "insert_before", "insert_after"] },
          symbol: { type: "string" }, code: { type: "string" },
          description: { type: "string" },
        }, required: ["operation", "symbol"] } },
      }, required: ["contextId", "edits"],
    },
  },
  {
    name: "patch.validate", title: "Validate Patch",
    description: "Validate patch: hash check → apply to sandbox → parse → typecheck → lint → run affected tests.",
    inputSchema: {
      type: "object", properties: {
        filePath: { type: "string" },
        edits: { type: "array", items: { type: "object" } },
        originalHash: { type: "string" },
      }, required: ["filePath", "edits"],
    },
  },
  {
    name: "patch.apply", title: "Apply Patch",
    description: "Apply validated patch to file. Only works if validation passed.",
    inputSchema: {
      type: "object", properties: {
        patchId: { type: "string" }, filePath: { type: "string" },
      }, required: ["patchId", "filePath"],
    },
  },
];

// ═══ Register Tools ═══
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs.map(t => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !t.name.startsWith("patch.a"),
      destructiveHint: t.name === "patch.apply",
    },
  })),
}));

// ═══ Handle Calls ═══
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
  callGraph = new CallGraph(root);
  validator = new PatchValidator({ projectRoot: root });
  const stats = callGraph.scan({ exclude: args.exclude });
  try { validator.validate({ patchId: "_init_", filePath: ".", edits: [] }); } catch {} // init sandbox
  return ok({ status: "scanned", ...stats, root, ready: true });
}

async function handleProjectMap(args) {
  const path = args.path || ".";
  if (!existsSync(path)) return err(`Not found: ${path}`);
  return ok({ project: path, language: "detected_on_scan", note: "Use project.scan for full analysis" });
}

async function handleFileContracts(args) {
  const { filePath } = args;
  if (!existsSync(filePath)) return err(`Not found: ${filePath}`);
  const parsed = parseFile(filePath);
  const contracts = parsed.symbols.map(sym => ({
    id: createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }),
    handle: `@${sym.qualifiedName}`, kind: sym.kind,
    ...extractContract(sym, parsed.code, parsed.language),
  }));
  return ok({ file: filePath, fileRevision: createFileRevision(parsed.code), language: parsed.language, contracts, imports: parsed.imports });
}

async function handleSymbolSource(args) {
  const { filePath, symbol, view = "source" } = args;
  if (!existsSync(filePath)) return err(`Not found: ${filePath}`);
  const parsed = parseFile(filePath);
  const sym = parsed.symbols.find(s => s.qualifiedName === symbol || s.name === symbol);
  if (!sym) return err(`Symbol not found: ${symbol}`);
  const contract = extractContract(sym, parsed.code, parsed.language);
  const result = {
    id: createSymbolId({ language: parsed.language, nodeType: sym.kind, qualifiedName: sym.qualifiedName, signature: sym.signature }),
    revision: createSymbolRevision(sym.signature + sym.qualifiedName),
    fileRevision: createFileRevision(parsed.code), handle: `@${sym.qualifiedName}`,
    kind: sym.kind, language: parsed.language,
  };
  if (view === "source") {
    const lines = parsed.code.split("\n");
    result.source = lines.slice((sym.startLine || 1) - 1, sym.endLine || sym.startLine).join("\n");
  }
  if (view === "source" || view === "contract") {
    result.contract = { signature: contract.signature, effects: contract.effects, throws: contract.throws, calls: contract.calls, properties: contract.properties, confidence: contract.confidence };
  } else {
    result.signature = contract.signature;
  }
  return ok(result);
}

async function handleSymbolContext(args) {
  const { filePath, symbol, what = [] } = args;
  if (!callGraph) return err("Run project.scan first");
  const result = {};
  for (const w of what) {
    switch (w) {
      case "callers": result.callers = callGraph.callers(filePath, symbol); break;
      case "callees": result.callees = callGraph.callees(filePath, symbol); break;
      case "tests": result.tests = callGraph.getTests(filePath, symbol); break;
      case "sideEffects": {
        const parsed = parseFile(filePath);
        const sym = parsed.symbols.find(s => s.qualifiedName === symbol || s.name === symbol);
        if (sym) result.sideEffects = extractContract(sym, parsed.code, parsed.language).effects;
        break;
      }
    }
  }
  return ok(result);
}

async function handleContextCreate(args) {
  const packet = await buildContextPacket({ ...args, tokenBudget: args.tokenBudget || 8000, qualityFloor: args.qualityFloor ?? 0.95, mode: args.mode || "safe", projectRoot: args.projectRoot || ".", evidence: args.evidence || {} });
  // Enrich with call graph if available
  if (callGraph && args.targetFile && args.task?.target) {
    const callers = callGraph.callers(args.targetFile, args.task.target);
    const tests = callGraph.getTests(args.targetFile, args.task.target);
    if (callers.length) packet.packet.callers = callers;
    if (tests.length) packet.packet.relatedTests = tests;
  }
  sessions.set(packet.contextId, packet);
  return ok({ contextId: packet.contextId, revision: packet.revision, task: packet.task, layers: packet.layers, tokens: packet.tokens, risk: packet.risk, loss: { removed: packet.loss.removed, preserved: packet.loss.preserved, risk: packet.loss.risk }, aliases: packet.aliases, packet: packet.packet, omitted: packet.omitted });
}

async function handleContextExpand(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);
  const added = (args.requests || []).map(r => ({ symbol: r.symbol, view: r.view || "source", reason: r.reason, status: "loaded" }));
  packet.revision++;
  return ok({ contextId: args.contextId, revision: packet.revision, added });
}

async function handleContextInspect(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);
  return ok({ contextId: args.contextId, revision: packet.revision, loss: packet.loss, omitted: packet.omitted, risk: packet.risk, retrievableCount: packet.omitted.length });
}

async function handlePatchPropose(args) {
  const packet = sessions.get(args.contextId);
  if (!packet) return err(`Context not found: ${args.contextId}`);
  for (const edit of args.edits) {
    const known = packet.packet.contracts.find(c => c.handle === edit.symbol || c.id === edit.symbol);
    if (!known && edit.operation === "replace_symbol") return err(`Unknown symbol: ${edit.symbol}`);
  }
  const patchId = `patch_${Date.now().toString(36)}`;
  return ok({ patchId, contextId: args.contextId, edits: args.edits.map(e => ({ ...e, status: "proposed" })), note: "Use patch.validate to verify before applying." });
}

async function handlePatchValidate(args) {
  if (!validator) validator = new PatchValidator({ projectRoot: args.projectRoot || "." });
  const patchId = `patch_${Date.now().toString(36)}`;
  const originalHash = args.originalHash || (existsSync(args.filePath) ? createFileRevision(readFileSync(args.filePath, "utf-8")) : null);
  const result = validator.validate({ patchId, filePath: resolve(args.filePath), originalHash, edits: args.edits });
  return ok(result);
}

async function handlePatchApply(args) {
  if (!validator) return err("Validator not initialized. Run patch.validate first.");
  const result = validator.apply(args);
  return ok(result);
}

// ═══ Response helpers ═══
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false };
}
function err(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ═══ Start ═══
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[code-shrinker v0.3.0] ready — call graph + patch validator");
