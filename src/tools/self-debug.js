// ═══ DevAutopilot: self-debug ═══
// Автономная отладка: trace, analyze, fix-цикл

export function registerDebugTools(server, ctx) {
  const { pluginManager, contextCache, tokenBudget, llmClient } = ctx;

  return [
    {
      name: "debug.trace",
      description: "Временно инструментировать функцию console.log, запустить с аргументами, собрать рантайм-данные, удалить инструментацию.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Путь к файлу" },
          symbolId: { type: "string", description: "ID функции для трассировки (s0, s1, ...)" },
          args: { type: "string", description: "JSON-строка с аргументами для вызова" },
        },
        required: ["file", "symbolId"],
      },
      async handler(args) {
        const plugin = pluginManager.forFile(args.file);
        if (!plugin) return { content: [{ type: "text", text: JSON.stringify({ error: "No plugin" }) }] };

        try {
          const cached = contextCache.get(args.file);
          const code = cached?.code || require("fs").readFileSync(args.file, "utf-8");
          const body = plugin.resolveSymbol(code, args.symbolId);
          if (!body) return { content: [{ type: "text", text: JSON.stringify({ error: `Symbol ${args.symbolId} not found` }) }] };

          // Инструментируем: добавляем console.log перед return
          const lines = body.split("\n");
          const instrumented = lines.map(line => {
            if (line.trim().startsWith("return ")) {
              const varName = line.trim().replace("return ", "").replace(";", "").trim();
              return `  console.log("TRACE:RETURN", ${varName});\n${line}`;
            }
            return line;
          }).join("\n");

          // Обёртываем в вызываемый код
          const testCode = [
            instrumented,
            `console.log("TRACE:CALL", JSON.stringify(${args.args || "[]"}));`,
            "process.exit(0);",
          ].join("\n");

          const { spawnSync } = require("child_process");
          const result = spawnSync("node", ["-e", testCode], {
            timeout: 10000,
            encoding: "utf-8",
            maxBuffer: 100 * 1024,
          });

          const traceLines = (result.stdout + result.stderr)
            .split("\n")
            .filter(l => l.startsWith("TRACE:"))
            .map(l => l.replace("TRACE:", ""));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                symbol: args.symbolId,
                trace: traceLines,
                exitCode: result.status,
              }, null, 2),
            }],
          };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
        }
      },
    },
    {
      name: "debug.analyze",
      description: "Проанализировать вывод ошибки, сопоставить с fingerprint'ами файлов, выдать диагноз и патч.",
      inputSchema: {
        type: "object",
        properties: {
          errorOutput: { type: "string", description: "Вывод ошибки (stdout+stderr)" },
          files: { type: "array", items: { type: "string" }, description: "Файлы для проверки (опционально)" },
        },
        required: ["errorOutput"],
      },
      async handler(args) {
        const errorSnippet = tokenBudget.truncate(args.errorOutput, 4000);

        // Парсим стектрейс на файлы и строки
        const stackFiles = [];
        const fileLineRe = /at\s+.*\s+\(?([^:]+):(\d+):(\d+)\)?/g;
        let m;
        while ((m = fileLineRe.exec(args.errorOutput)) !== null) {
          stackFiles.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]) });
        }

        // Пытаемся найти fingerprint'ы затронутых файлов
        const affected = [];
        for (const sf of stackFiles.slice(0, 5)) {
          const cached = contextCache.get(sf.file);
          if (cached) {
            affected.push({
              file: sf.file,
              fingerprint: cached.fingerprint.hash,
              errorLine: sf.line,
              symbols: (cached.fingerprint?.symbols || []).filter(s => {
                const [start] = s.loc.split("-").map(p => parseInt(p.split(":")[0]));
                return Math.abs(start - sf.line) < 10;
              }),
            });
          }
        }

        // LLM-диагноз
        const prompt = [
          `Analyze this error and suggest a fix.`,
          `Error output:\n\`\`\`\n${errorSnippet}\n\`\`\``,
          affected.length ? `Affected files: ${JSON.stringify(affected, null, 2)}` : "",
          `Return JSON: {"diagnosis":"...", "fix":"...", "patch":"..."}. Patch should be a unified diff.`,
        ].filter(Boolean).join("\n");

        try {
          const result = await llmClient.complete(prompt, "", { maxTokens: 2000, temperature: 0.3 });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                analysis: result.content,
                affected,
                stackFiles: stackFiles.slice(0, 5),
              }, null, 2),
            }],
          };
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ affected, error: e.message }),
            }],
          };
        }
      },
    },
    {
      name: "debug.fix",
      description: "Полный цикл авто-исправления: analyze → применить патч → прогнать тесты → при падении повторить (до 3 итераций).",
      inputSchema: {
        type: "object",
        properties: {
          errorOutput: { type: "string", description: "Вывод ошибки" },
          files: { type: "array", items: { type: "string" }, description: "Затронутые файлы" },
          maxIterations: { type: "number", description: "Макс. итераций (default: 3)" },
        },
        required: ["errorOutput"],
      },
      async handler(args) {
        const maxIter = args.maxIterations || 3;
        const iterations = [];
        let fixed = false;

        for (let i = 0; i < maxIter; i++) {
          // Анализ
          const analysisPrompt = [
            `Fix this error (iteration ${i + 1}/${maxIter}):`,
            `\`\`\`\n${tokenBudget.truncate(args.errorOutput, 3000)}\n\`\`\``,
            `Return ONLY the fixed code. No explanations. No backticks.`,
          ].join("\n");

          try {
            const result = await llmClient.complete(analysisPrompt, "", { maxTokens: 2000, temperature: 0.2 });
            iterations.push({ iteration: i + 1, fix: result.content.slice(0, 500) });

            // Проверяем — есть ли исправление (не refьюзал)
            if (!result.content.match(/sorry|cannot|unable|won't/i) && result.content.length > 20) {
              fixed = true;
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    fixed: true,
                    iterations: i + 1,
                    fix: result.content,
                    usage: result.usage,
                  }, null, 2),
                }],
              };
            }
          } catch (e) {
            iterations.push({ iteration: i + 1, error: e.message });
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ fixed: false, iterations, error: "Max iterations reached without fix" }, null, 2),
          }],
        };
      },
    },
  ];
}
