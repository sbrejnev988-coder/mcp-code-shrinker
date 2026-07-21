#!/usr/bin/env node
// ═══ Code Shrinker MCP Server v1.0 ═══
// Агрессивная токен-экономия для кодинга: -60-80% токенов
// Плагины: universal (regex), js, ts, py (pure JS, без native deps)
//"
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PluginManager } from "./core/plugin-manager.js";
import { ContextCache } from "./core/context-cache.js";
import { TokenBudget } from "./core/token-budget.js";
import { LLMClient } from "./core/llm-client.js";
import { registerTools } from "./tools/index.js";

const server = new Server(
  { name: "code-shrinker", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const pluginManager = new PluginManager();
const contextCache = new ContextCache();
const tokenBudget = new TokenBudget({ defaultLimit: 32000 });
const llmClient = new LLMClient({ endpoints: ["http://127.0.0.1:18089/v1"], tokenBudget });

await pluginManager.loadAll();

const tools = await registerTools(server, { pluginManager, contextCache, tokenBudget, llmClient });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown: ${name}`);
  try {
    return await tool.handler(args || {});
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[code-shrinker] ready — plugins:", pluginManager.list().join(", "));
