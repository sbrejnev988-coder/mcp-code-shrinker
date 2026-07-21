#!/usr/bin/env node
// ═══ Code Shrinker MCP Server v0.2.0 ═══
// Semantic Context Compiler — not a code compressor!
// Stratified semantic context with exact-source escalation
//
// Principles:
//   1. Compress context SELECTION, not selected CODE
//   2. Layer 0 (project map) → Layer 1 (contracts) → Layer 2 (exact source) → Layer 3 (evidence)
//   3. NEVER rename identifiers in source code
//   4. NEVER truncate inside AST nodes
//   5. Stable symbol IDs separated from revisions
//   6. Loss manifest for every packet

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { buildContextPacket } from "./compiler/packet-builder.js";
import { parseFile, extractContract } from "./core/ast-engine.js";
import { createSymbolId, createSymbolRevision, createFileRevision, validateContext } from "./core/symbol-id.js";
import { TokenBudget } from "./core/token-budget.js";
import { finalizeLossManifest } from "./core/loss-manifest.js";

const server = new Server(
  { name: "code-shrinker", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

const budget = new TokenBudget({ totalBudget: 64000 });
const sessions = new Map(); // contextId → contextPacket

// ═══ Tool Definitions ═══
const toolDefs = [
  {
    name: "project.map",
    title: "Project Map (Layer 0)",
    description: "Build a Layer 0 project map: file tree, exports, languages, entry points. No source code loaded — navigation only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project root directory" },
        maxFiles: { type: "number", description: "Maximum files to scan (default: 100)" },
      },
      required: ["path"],
    },
  },
  {
    name: "file.contracts",
    title: "File Semantic Contracts (Layer 1)",
    description: "Extract Layer 1 semantic contracts for all symbols in a file: signatures, effects, throws, calls, properties, confidence scores. NO source code — contracts only.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to file" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "symbol.source",
    title: "Symbol Exact Source (Layer 2)",
    description: "Return EXACT, unmodified source code for a symbol. NO renaming, NO regex compression, NO formatting changes. Original identifiers preserved.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        symbol: { type: "string", description: "Qualified symbol name (e.g., 'Publisher.publish')" },
        view: { type: "string", enum: ["source", "contract", "reference"], description: "Detail level: source=full code, contract=effects+throws+calls, reference=signature only" },
      },
      required: ["filePath", "symbol"],
    },
  },
  {
    name: "symbol.context",
    title: "Symbol Context",
    description: "Get callers, callees, tests, and related symbols for a given symbol.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        symbol: { type: "string" },
        what: { type: "array", items: { type: "string", enum: ["callers", "callees", "tests", "sideEffects"] } },
      },
      required: ["filePath", "symbol"],
    },
  },
  {
    name: "context.create",
    title: "Create Context Packet",
    description: "Build a complete semantic context packet for a coding task using Layer 0-3 architecture. Automatically selects relevant context based on task type and quality floor.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "object", properties: { type: { type: "string", enum: ["bugfix", "refactor", "review", "generate", "test"] }, description: { type: "string" }, target: { type: "string" } }, required: ["type", "description"] },
        targetFile: { type: "string", description: "Primary file to analyze" },
        tokenBudget: { type: "number", description: "Max tokens for the packet (default: 8000)" },
        qualityFloor: { type: "number", description: "Minimum quality threshold 0-1 (default: 0.95)" },
        mode: { type: "string", enum: ["safe", "balanced", "aggressive"], description: "Compression mode" },
        projectRoot: { type: "string", description: "Project root directory" },
        evidence: { type: "object", properties: { tests: { type: "string" }, stackTrace: { type: "string" }, diagnostics: { type: "string" } } },
      },
      required: ["task", "targetFile"],
    },
  },
  {
    name: "context.expand",
    title: "Expand Context Packet",
    description: "Expand an existing context packet with additional requested symbols or evidence. Model requests what it needs.",
    inputSchema: {
      type: "object",
      properties: {
        contextId: { type: "string", description: "Existing context ID from context.create" },
        requests: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, view: { type: "string" }, reason: { type: "string" } }, required: ["symbol"] } },
      },
      required: ["contextId", "requests"],
    },
  },
  {
    name: "context.inspect",
    title: "Inspect Context Loss",
    description: "Show the loss manifest for a context packet: what was removed, what was preserved, risk level, retrievable items.",
    inputSchema: {
      type: "object",
      properties: {
        contextId: { type: "string" },
      },
      required: ["contextId"],
    },
  },
  {
    name: "patch.propose",
    title: "Propose Code Patch",
    description: "Propose a minimal edit operation (not full file). Returns structured edit with before/after and expected hash.",
    inputSchema: {
      type: "object",
      properties: {
        contextId: { type: "string" },
        edits: { type: "array", items: { type: "object", properties: { operation: { type: "string", enum: ["replace_symbol", "insert_before", "insert_after", "delete_symbol"] }, symbol: { type: "string" }, expectedHash: { type: "string" }, code: { type: "string" }, description: { type: "string" } }, required: ["operation", "symbol"] } },
      },
      required: ["contextId", "edits"],
    },
  },
  {
    name: "patch.validate",
    title: "Validate Patch",
    description: "Validate a proposed patch: parse, type-check, run affected tests. Returns minimal failure slice on error.",
    inputSchema: {
      type: "object",
      properties: {
        patchId: { type: "string" },
        filePath: { type: "string" },
      },
      required: ["patchId", "filePath"],
    },
  },
  {
    name: "patch.apply",
    title: "Apply Patch",
    description: "Apply a validated patch to the actual file. Only succeeds if validation passed and hash matches.",
    inputSchema: {
      type: "object",
      properties: {
        patchId: { type: "string" },
        filePath: { type: "string" },
      },
      required: ["patchId", "filePath"],
    },
  },
];

// ═══ Tool Registry ═══
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs.map(t => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !t.name.startsWith("patch."),
      destructiveHint: t.name === "patch.apply",
    },
  })),
}));

// ═══ Tool Handlers ═══
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  
  try {
    switch (name) {
      case "project.map":
        return handleProjectMap(args);
      case "file.contracts":
        return handleFileContracts(args);
      case "symbol.source":
        return handleSymbolSource(args);
      case "symbol.context":
        return handleSymbolContext(args);
      case "context.create":
        return handleContextCreate(args);
      case "context.expand":
        return handleContextExpand(args);
      case "context.inspect":
        return handleContextInspect(args);
      case "patch.propose":
        return handlePatchPropose(args);
      case "patch.validate":
        return handlePatchValidate(args);
      case "patch.apply":
        return handlePatchApply(args);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(`${name} failed: ${e.message}`);
  }
});

// ═══ Handlers ═══

async function handleProjectMap(args) {
  const path = args.path || ".";
  if (!existsSync(path)) return errorResult(`Path not found: ${path}`);
  
  // Basic project scan
  const map = { project: path, language: "unknown", modules: [] };
  // ... simplified for now
  
  return okResult(map);
}

async function handleFileContracts(args) {
  const { filePath } = args;
  if (!existsSync(filePath)) return errorResult(`File not found: ${filePath}`);
  
  const parsed = parseFile(filePath);
  const contracts = [];
  
  for (const sym of parsed.symbols) {
    const contract = extractContract(sym, parsed.code, parsed.language);
    const symbolId = createSymbolId({
      language: parsed.language,
      nodeType: sym.kind,
      qualifiedName: sym.qualifiedName,
      signature: sym.signature,
    });
    
    contracts.push({
      id: symbolId,
      handle: `@${sym.qualifiedName}`,
      kind: sym.kind,
      signature: contract.signature,
      visibility: contract.visibility,
      effects: contract.effects,
      throws: contract.throws,
      calls: contract.calls,
      properties: contract.properties,
      confidence: contract.confidence,
    });
  }
  
  return okResult({
    file: filePath,
    fileRevision: createFileRevision(parsed.code),
    language: parsed.language,
    contracts,
    imports: parsed.imports,
  });
}

async function handleSymbolSource(args) {
  const { filePath, symbol, view = "source" } = args;
  if (!existsSync(filePath)) return errorResult(`File not found: ${filePath}`);
  
  const parsed = parseFile(filePath);
  const fileRev = createFileRevision(parsed.code);
  
  const sym = parsed.symbols.find(s => s.qualifiedName === symbol || s.name === symbol);
  if (!sym) return errorResult(`Symbol not found: ${symbol}`);
  
  const contract = extractContract(sym, parsed.code, parsed.language);
  const symbolId = createSymbolId({
    language: parsed.language,
    nodeType: sym.kind,
    qualifiedName: sym.qualifiedName,
    signature: sym.signature,
  });
  const symbolRev = createSymbolRevision(sym.signature + sym.qualifiedName);
  
  const result = {
    id: symbolId,
    revision: symbolRev,
    fileRevision: fileRev,
    handle: `@${sym.qualifiedName}`,
    kind: sym.kind,
    language: parsed.language,
  };
  
  if (view === "source" || view === "contract") {
    const lines = parsed.code.split("\n");
    const body = lines.slice((sym.startLine || 1) - 1, sym.endLine || sym.startLine).join("\n");
    
    if (view === "source") {
      // EXACT source — no renaming, no regex, no formatting changes
      result.source = body;
    }
    
    result.contract = {
      signature: contract.signature,
      effects: contract.effects,
      throws: contract.throws,
      calls: contract.calls,
      properties: contract.properties,
      confidence: contract.confidence,
    };
  } else {
    result.signature = contract.signature;
  }
  
  return okResult(result);
}

async function handleSymbolContext(args) {
  const { filePath, symbol, what = [] } = args;
  // Stub — full implementation needs project-wide call graph
  return okResult({
    symbol,
    callers: [],
    callees: [],
    tests: [],
    sideEffects: [],
    note: "Full call-graph analysis requires project-wide scan. Use context.create for complete context.",
  });
}

async function handleContextCreate(args) {
  const { task, targetFile, tokenBudget = 8000, qualityFloor = 0.95, mode = "safe", projectRoot = ".", evidence } = args;
  
  const packet = await buildContextPacket({
    task,
    targetFile,
    tokenBudget,
    qualityFloor,
    mode,
    projectRoot,
    evidence,
  });
  
  // Store session
  sessions.set(packet.contextId, packet);
  
  return okResult({
    contextId: packet.contextId,
    revision: packet.revision,
    task: packet.task,
    layers: packet.layers,
    tokens: packet.tokens,
    risk: packet.risk,
    loss: {
      removed: packet.loss.removed,
      preserved: packet.loss.preserved,
      risk: packet.loss.risk,
    },
    aliases: packet.aliases,
    packet: packet.packet,
    omitted: packet.omitted,
  });
}

async function handleContextExpand(args) {
  const { contextId, requests = [] } = args;
  const packet = sessions.get(contextId);
  if (!packet) return errorResult(`Context not found: ${contextId}`);
  
  const added = [];
  for (const req of requests) {
    // Load requested symbol and add to packet
    added.push({ symbol: req.symbol, view: req.view || "source", reason: req.reason });
  }
  
  packet.revision++;
  
  return okResult({
    contextId,
    revision: packet.revision,
    added,
    newTokens: packet.tokens + estimateTokens(JSON.stringify(added)),
  });
}

async function handleContextInspect(args) {
  const { contextId } = args;
  const packet = sessions.get(contextId);
  if (!packet) return errorResult(`Context not found: ${contextId}`);
  
  return okResult({
    contextId,
    revision: packet.revision,
    loss: packet.loss,
    omitted: packet.omitted,
    risk: packet.risk,
    retrievableCount: packet.omitted.length,
  });
}

async function handlePatchPropose(args) {
  const { contextId, edits } = args;
  const packet = sessions.get(contextId);
  if (!packet) return errorResult(`Context not found: ${contextId}`);
  
  // Validate that edits reference known symbols
  for (const edit of edits) {
    const known = packet.packet.contracts.find(c => c.handle === edit.symbol || c.id === edit.symbol);
    if (!known && edit.operation !== "insert_before" && edit.operation !== "insert_after") {
      return errorResult(`Unknown symbol: ${edit.symbol}. Use context.create first.`);
    }
  }
  
  const patchId = `patch_${Date.now().toString(36)}`;
  
  return okResult({
    patchId,
    contextId,
    edits: edits.map(e => ({
      ...e,
      status: "proposed",
    })),
    note: "Patch proposed but NOT applied. Use patch.validate to verify, then patch.apply to commit.",
  });
}

async function handlePatchValidate(args) {
  // Stub — real implementation would: parse → typecheck → lint → test
  return okResult({
    status: "validation_stub",
    note: "Full validation (parse→typecheck→lint→test) not implemented yet. See v0.3 roadmap.",
  });
}

async function handlePatchApply(args) {
  return okResult({
    status: "applied_stub",
    note: "Patch application not implemented yet. See v0.3 roadmap.",
  });
}

// ═══ Helpers ═══

function okResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: false,
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 1.3);
}

// ═══ Start ═══
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[code-shrinker v0.2.0] ready — semantic context compiler");
