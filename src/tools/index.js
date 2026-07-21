// ═══ MCP Tools Registry ═══
// 7 инструментов: outline, fingerprint, symbol, generate, review, refactor, compress
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** @param {{ pluginManager: import("../core/plugin-manager.js").PluginManager, contextCache: import("../core/context-cache.js").ContextCache, tokenBudget: import("../core/token-budget.js").TokenBudget, llmClient: import("../core/llm-client.js").LLMClient }} ctx */
export async function registerTools(server, ctx) {
  const { pluginManager, contextCache, tokenBudget, llmClient } = ctx;

  const tools = [
    // ═══ 1. project.outline — карта всего проекта (только fingerprint'ы) ═══
    {
      name: "project.outline",
      description: "Получить структуру проекта: fingerprint'ы всех файлов. Модель видит весь проект как сжатые отпечатки, не загружая код.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Путь к корню проекта" },
          maxFiles: { type: "number", description: "Макс. число файлов (default: 100)" },
        },
        required: ["path"],
      },
      async handler(args) {
        const root = args.path || ".";
        const maxFiles = args.maxFiles || 100;

        function scanDir(dir, files = []) {
          try {
            for (const entry of readdirSync(dir)) {
              const full = join(dir, entry);
              if (files.length >= maxFiles) break;
              try {
                const st = statSync(full);
                if (st.isDirectory() && !entry.startsWith(".") && entry !== "node_modules") scanDir(full, files);
                else if (st.isFile()) {
                  const rel = relative(root, full);
                  const ext = "." + (entry.split(".").pop() || "");
                  const plugin = pluginManager.forFile(entry);
                  if (plugin && st.size < 500000) { // Пропускаем бинарники и огромные файлы
                    const code = readFileSync(full, "utf-8");
                    const fp = plugin.fingerprint(code);
                    fp.hash = contextCache.hash(code);
                    contextCache.track(rel, code, fp, { to: {}, from: {} });
                    files.push({ file: rel, size: st.size, fingerprint: fp });
                  }
                }
              } catch (e) { /* skip */ }
            }
          } catch (e) { /* skip */ }
          return files;
        }

        const outline = scanDir(root);
        // Считаем экономию
        const totalTokens = outline.reduce((s, f) => s + (f.fingerprint.tokenEstimate || 0), 0);
        const fpTokens = outline.length * 15; // fingerprint ≈ 15 токенов

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              project: root,
              files: outline.length,
              savings: {
                fullTokens: totalTokens,
                outlineTokens: fpTokens,
                saved: `${Math.round((1 - fpTokens / totalTokens) * 100)}%`,
              },
              outline: outline.map(f => ({
                file: f.file,
                hash: f.fingerprint.hash.slice(0, 12),
                symbols: f.fingerprint.symbols.length,
                imports: f.fingerprint.imports?.length || 0,
                tokens: f.fingerprint.tokenEstimate,
              })),
            }, null, 2),
          }],
        };
      },
    },

    // ═══ 2. file.fingerprint — отпечаток конкретного файла ═══
    {
      name: "file.fingerprint",
      description: "Получить fingerprint файла: сигнатуры всех top-level символов, импорты, хеш. Без тела кода.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Путь к файлу" },
        },
        required: ["filePath"],
      },
      async handler(args) {
        const code = readFileSync(args.filePath, "utf-8");
        const plugin = pluginManager.forFile(args.filePath);
        if (!plugin) return { content: [{ type: "text", text: JSON.stringify({ error: "No plugin for this file type" }) }] };

        const fp = plugin.fingerprint(code);
        const aliasMap = { to: {}, from: {} };
        const compressed = plugin.compress(code, aliasMap);
        contextCache.track(args.filePath, code, fp, aliasMap);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              file: args.filePath,
              hash: fp.hash,
              symbols: fp.symbols,
              imports: fp.imports,
              stats: {
                fullTokens: fp.tokenEstimate,
                fingerprints: fp.symbols.length * 10,
                saved: fp.symbols.length > 0 ? `${Math.round((1 - (fp.symbols.length * 10) / fp.tokenEstimate) * 100)}%` : "N/A",
              },
            }, null, 2),
          }],
        };
      },
    },

    // ═══ 3. file.symbol — ленивая загрузка тела символа ═══
    {
      name: "file.symbol",
      description: "Получить ПОЛНЫЙ код конкретного символа (функции/класса) по его ID из fingerprint. Ленивая загрузка — модель запрашивает только нужное.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          symbolId: { type: "string", description: "ID символа из fingerprint (s0, s1, ...)" },
        },
        required: ["filePath", "symbolId"],
      },
      async handler(args) {
        const cached = contextCache.get(args.filePath);
        const code = cached?.code || readFileSync(args.filePath, "utf-8");
        const plugin = pluginManager.forFile(args.filePath);
        if (!plugin) return { content: [{ type: "text", text: JSON.stringify({ error: "No plugin" }) }] };

        const body = plugin.resolveSymbol(code, args.symbolId);
        if (!body) return { content: [{ type: "text", text: JSON.stringify({ error: `Symbol ${args.symbolId} not found` }) }] };

        const aliasMap = cached?.aliasMap || { to: {}, from: {} };
        const compressed = plugin.compress(body, aliasMap);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              symbolId: args.symbolId,
              compressed: compressed,
              tokenEstimate: Math.ceil(compressed.length / 3.5),
              aliases: Object.keys(aliasMap.from).length,
            }, null, 2),
          }],
        };
      },
    },

    // ═══ 4. code.generate — генерация нового кода ═══
    {
      name: "code.generate",
      description: "Сгенерировать код по спецификации. Принимает ТОЛЬКО спецификацию + ID зависимых символов — не требует полного контекста.",
      inputSchema: {
        type: "object",
        properties: {
          spec: { type: "string", description: "Спецификация: что нужно сгенерировать" },
          language: { type: "string", description: "Язык (javascript, typescript, python, ...)" },
          deps: { type: "array", items: { type: "string" }, description: "ID зависимых символов из других файлов" },
        },
        required: ["spec", "language"],
      },
      async handler(args) {
        const plugin = pluginManager.get(args.language) || pluginManager.get("universal");
        const systemPrompt = `You are a ${args.language} code generator. Output ONLY valid code. No explanations. No markdown. Return pure ${args.language}.`;

        const prompt = [
          `Generate ${args.language} code for: ${args.spec}`,
          args.deps?.length ? `Dependencies (IDs): ${args.deps.join(", ")}` : "",
          `Return ONLY the code. No backticks, no explanations.`,
        ].filter(Boolean).join("\n");

        try {
          const result = await llmClient.complete(prompt, systemPrompt, { maxTokens: 4000, temperature: 0.3 });
          const compressed = plugin.compress(result.content, { to: {}, from: {} });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                code: result.content,
                compressed: compressed,
                model: result.model,
                usage: result.usage,
                saving: Math.round((1 - compressed.length / result.content.length) * 100) + "%",
              }, null, 2),
            }],
          };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
        }
      },
    },

    // ═══ 5. code.review — ревью кода (только diff) ═══
    {
      name: "code.review",
      description: "Отревьюить изменения. Принимает diff + fingerprint файла — не требует полного кода.",
      inputSchema: {
        type: "object",
        properties: {
          diff: { type: "string", description: "Unified diff изменений" },
          filePath: { type: "string", description: "Путь к файлу (для fingerprint)" },
          context: { type: "string", description: "Дополнительный контекст (опционально)" },
        },
        required: ["diff", "filePath"],
      },
      async handler(args) {
        const plugin = pluginManager.forFile(args.filePath) || pluginManager.get("universal");
        const fp = plugin.fingerprint(args.diff);

        const prompt = [
          `Review this diff:`,
          `File: ${args.filePath}`,
          `\`\`\`diff\n${tokenBudget.truncate(args.diff, 8000)}\n\`\`\``,
          `File symbols: ${JSON.stringify(fp.symbols.slice(0, 20))}`,
          args.context ? `Context: ${args.context}` : "",
          `Return: [{severity:"error"|"warning"|"info", line:N, message:"..."}] as JSON array. No explanations.`,
        ].filter(Boolean).join("\n");

        try {
          const result = await llmClient.complete(prompt, "", { maxTokens: 2000, temperature: 0.3 });
          return { content: [{ type: "text", text: result.content }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
        }
      },
    },

    // ═══ 6. code.refactor — рефакторинг scope (только целевой блок) ═══
    {
      name: "code.refactor",
      description: "Отрефакторить конкретный символ. Принимает scope (ID символа) + инструкцию. Загружает ТОЛЬКО тело этого символа.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          scope: { type: "string", description: "ID символа для рефакторинга (s0, s1, ...)" },
          instruction: { type: "string", description: "Что сделать (разбить, оптимизировать, переименовать, ...)" },
        },
        required: ["filePath", "scope", "instruction"],
      },
      async handler(args) {
        const plugin = pluginManager.forFile(args.filePath);
        if (!plugin) return { content: [{ type: "text", text: JSON.stringify({ error: "No plugin" }) }] };

        const cached = contextCache.get(args.filePath);
        const code = cached?.code || readFileSync(args.filePath, "utf-8");
        const aliasMap = cached?.aliasMap || { to: {}, from: {} };

        // Извлекаем ТОЛЬКО целевой символ
        const body = plugin.resolveSymbol(code, args.scope);
        if (!body) return { content: [{ type: "text", text: JSON.stringify({ error: `Symbol ${args.scope} not found` }) }] };

        const compressed = plugin.compress(body, aliasMap);
        const deps = cached?.fingerprint?.symbols
          ?.filter(s => s.id !== args.scope)
          ?.slice(0, 10)
          ?.map(s => `${s.id}: ${s.sig}`) || [];

        const prompt = [
          `Refactor this ${plugin.languageId} code:`,
          `Instruction: ${args.instruction}`,
          `\`\`\`${plugin.languageId}\n${tokenBudget.truncate(compressed, 8000)}\n\`\`\``,
          deps.length ? `Related symbols:\n${deps.join("\n")}` : "",
          `Return ONLY the refactored code. No backticks, no explanations.`,
        ].filter(Boolean).join("\n");

        try {
          const result = await llmClient.complete(prompt, "", { maxTokens: 4000, temperature: 0.3 });
          const decompressed = plugin.decompress(result.content, aliasMap);
          const diff = plugin.diffSemantic(body, decompressed);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                refactored: decompressed,
                diff: diff.slice(0, 5000),
                model: result.model,
                usage: result.usage,
                savings: {
                  inputTokens: tokenBudget.estimate(prompt),
                  fullFileTokens: tokenBudget.estimate(code),
                  saved: `${Math.round((1 - tokenBudget.estimate(prompt) / tokenBudget.estimate(code)) * 100)}%`,
                },
              }, null, 2),
            }],
          };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
        }
      },
    },

    // ═══ 7. context.compress — сжать произвольный код/текст ═══
    {
      name: "context.compress",
      description: "Агрессивно сжать код/текст: удалить комментарии, создать алиасы, выдать fingerprint. Для вставки в промпт.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Код или текст для сжатия" },
          language: { type: "string", description: "Язык (опционально, автоопределение по содержимому)" },
          mode: { type: "string", enum: ["fingerprint", "compress", "full"], description: "fingerprint=только отпечаток, compress=сжатый код, full=и то и другое" },
        },
        required: ["code"],
      },
      async handler(args) {
        const plugin = args.language ? pluginManager.get(args.language) : pluginManager.get("universal");
        if (!plugin) return { content: [{ type: "text", text: JSON.stringify({ error: "No plugin" }) }] };

        const mode = args.mode || "full";
        const code = args.code;
        const fp = plugin.fingerprint(code);
        const aliasMap = { to: {}, from: {} };
        const compressed = plugin.compress(code, aliasMap);

        const fullTokens = Math.ceil(code.length / 3.5);
        const fpTokens = fp.symbols.length * 15 + (fp.imports?.length || 0) * 5;
        const compTokens = Math.ceil(compressed.length / 3.5);

        const result = {};
        if (mode === "fingerprint" || mode === "full") result.fingerprint = fp;
        if (mode === "compress" || mode === "full") result.compressed = compressed;
        result.stats = {
          originalTokens: fullTokens,
          fingerprintTokens: fpTokens,
          compressedTokens: compTokens,
          fingerprintSaving: `${Math.round((1 - fpTokens / fullTokens) * 100)}%`,
          compressedSaving: `${Math.round((1 - compTokens / fullTokens) * 100)}%`,
          aliases: Object.keys(aliasMap.from).length,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    },
  ];

  // ═══ DevAutopilot: дополнительные 12 инструментов ═══
  const { registerProjectGraphTools } = await import("./project-graph.js");
  const { registerExecTools } = await import("./exec-engine.js");
  const { registerDebugTools } = await import("./self-debug.js");
  const { registerParallelTools } = await import("./parallel-planner.js");
  const { registerTestAutogenTools } = await import("./test-autogen.js");

  const devTools = [
    ...registerProjectGraphTools(server, ctx),
    ...registerExecTools(server, ctx),
    ...registerTestAutogenTools(server, ctx),
    ...registerDebugTools(server, ctx),
    ...registerParallelTools(server, ctx),
  ];

  console.error(`[tools] ${tools.length} code-shrinker + ${devTools.length} dev-autopilot = ${tools.length + devTools.length} total`);
  return [...tools, ...devTools];
}
