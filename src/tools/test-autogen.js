// ═══ DevAutopilot: test-autogen ═══
// Автоматическая генерация юнит-тестов из сигнатур символов

export function registerTestAutogenTools(server, ctx) {
  const { pluginManager, contextCache, tokenBudget, llmClient } = ctx;

  return [
    {
      name: "test.gen",
      description: "Сгенерировать юнит-тесты для функции/класса по symbolId. Извлекает сигнатуру, генерирует edge cases и моки.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Путь к файлу с функцией" },
          symbolId: { type: "string", description: "ID символа из fingerprint (s0, s1, ...)" },
        },
        required: ["filePath", "symbolId"],
      },
      async handler(args) {
        const plugin = pluginManager.forFile(args.filePath);
        if (!plugin) return { content: [{ type: "text", text: JSON.stringify({ error: "No plugin" }) }] };

        try {
          const cached = contextCache.get(args.filePath);
          const code = cached?.code || require("fs").readFileSync(args.filePath, "utf-8");
          const body = plugin.resolveSymbol(code, args.symbolId);
          if (!body) return { content: [{ type: "text", text: JSON.stringify({ error: `Symbol ${args.symbolId} not found` }) }] };

          const fp = plugin.fingerprint(code);
          const sym = fp.symbols.find(s => s.id === args.symbolId);
          if (!sym) return { content: [{ type: "text", text: JSON.stringify({ error: "Symbol not in fingerprint" }) }] };

          // Зависимости для моков
          const deps = fp.symbols
            .filter(s => s.id !== args.symbolId)
            .slice(0, 5)
            .map(s => `  ${s.id}: ${s.sig}`);

          const language = plugin.languageId === "typescript" ? "typescript" : plugin.languageId;

          const prompt = [
            `Generate comprehensive unit tests for this ${language} function:`,
            `Name: ${sym.name}`,
            `Signature: ${sym.sig}`,
            `Code:\n\`\`\`${language}\n${tokenBudget.truncate(body, 3000)}\n\`\`\``,
            deps.length ? `Dependencies to mock:\n${deps.join("\n")}` : "",
            `Requirements:`,
            `- Use node:test (import { describe, it } from "node:test"; import assert from "node:assert/strict";)`,
            `- Cover: happy path, edge cases (null, undefined, empty, boundary values), error cases`,
            `- Mock dependencies with simple stubs`,
            `- Return ONLY the test code. No markdown backticks. No explanations.`,
          ].filter(Boolean).join("\n");

          const result = await llmClient.complete(prompt, "", {
            maxTokens: 3000,
            temperature: 0.2,
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                symbol: sym.name,
                kind: sym.kind,
                language,
                tests: result.content,
                model: result.model,
                usage: result.usage,
              }, null, 2),
            }],
          };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
        }
      },
    },
  ];
}
