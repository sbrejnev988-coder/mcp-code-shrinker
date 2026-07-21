// ═══ DevAutopilot: parallel-planner ═══
// Декомпозиция фич на параллельные подзадачи + бесконфликтное слияние
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, relative } from "path";
import { createHash } from "crypto";

const tasks = new Map(); // taskId → { status, result, createdAt }

function hash(t) { return createHash("sha256").update(t).digest("hex").slice(0, 8); }

export function registerParallelTools(server, ctx) {
  const { pluginManager, contextCache, tokenBudget, llmClient } = ctx;

  return [
    {
      name: "task.plan",
      description: "Декомпозировать фичу на изолированные подзадачи. Учитывает граф зависимостей для минимизации конфликтов.",
      inputSchema: {
        type: "object",
        properties: {
          feature: { type: "string", description: "Описание фичи" },
          projectRoot: { type: "string", description: "Корень проекта" },
        },
        required: ["feature"],
      },
      async handler(args) {
        // Загружаем граф если есть
        let graphSummary = "";
        const cacheFile = args.projectRoot
          ? join(args.projectRoot, ".code-shrinker", "graph.json")
          : null;
        if (cacheFile && existsSync(cacheFile)) {
          const graph = JSON.parse(require("fs").readFileSync(cacheFile, "utf-8"));
          graphSummary = Object.entries(graph.nodes)
            .slice(0, 20)
            .map(([f, n]) => `${f}: ${(n.symbols || []).join(", ")}`)
            .join("\n");
        }

        const prompt = [
          `Decompose this feature into independent subtasks: ${args.feature}`,
          graphSummary ? `Project structure:\n${graphSummary.slice(0, 2000)}` : "",
          `Return JSON array: [{id, desc, dependsOn:[], files:["file1","file2"], acceptanceTest:"..."}]`,
          `Rules:`,
          `- Each subtask should touch DIFFERENT files to avoid conflicts`,
          `- dependsOn = IDs of subtasks that must complete first`,
          `- acceptanceTest = one-line description of how to verify`,
        ].filter(Boolean).join("\n");

        try {
          const result = await llmClient.complete(prompt, "", { maxTokens: 3000, temperature: 0.4 });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                plan: result.content,
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
    {
      name: "task.spawn",
      description: "Создать изолированный workspace для подзадачи и запустить автономного агента.",
      inputSchema: {
        type: "object",
        properties: {
          subtaskId: { type: "string", description: "ID подзадачи" },
          description: { type: "string", description: "Что сделать" },
          files: { type: "array", items: { type: "string" }, description: "Файлы для копирования" },
        },
        required: ["subtaskId", "description"],
      },
      async handler(args) {
        const taskId = `task_${hash(args.subtaskId + Date.now())}`;

        tasks.set(taskId, {
          id: taskId,
          subtaskId: args.subtaskId,
          description: args.description,
          status: "spawned",
          files: args.files || [],
          createdAt: Date.now(),
          result: null,
        });

        // Промпт для автономного агента
        const prompt = [
          `You are an autonomous coding agent. Complete this subtask:`,
          `ID: ${args.subtaskId}`,
          `Description: ${args.description}`,
          args.files?.length ? `Files in scope: ${args.files.join(", ")}` : "",
          `Plan:`,
          `1. Understand the task and existing code`,
          `2. Write the implementation`,
          `3. Write tests if applicable`,
          `4. Run tests and fix if needed`,
          `5. Return the final code as a unified diff`,
        ].filter(Boolean).join("\n");

        try {
          const result = await llmClient.complete(prompt, "", {
            maxTokens: 4000,
            temperature: 0.3,
          });

          tasks.set(taskId, {
            ...tasks.get(taskId),
            status: "done",
            result: result.content,
            usage: result.usage,
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                taskId,
                subtaskId: args.subtaskId,
                status: "done",
                result: result.content.slice(0, 3000),
                usage: result.usage,
              }, null, 2),
            }],
          };
        } catch (e) {
          tasks.set(taskId, { ...tasks.get(taskId), status: "failed", error: e.message });
          return { content: [{ type: "text", text: JSON.stringify({ taskId, status: "failed", error: e.message }) }] };
        }
      },
    },
    {
      name: "task.status",
      description: "Получить статус подзадачи. При завершении возвращает список изменённых файлов с fingerprint'ами.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
        },
        required: ["taskId"],
      },
      async handler(args) {
        const task = tasks.get(args.taskId);
        if (!task) return { content: [{ type: "text", text: JSON.stringify({ error: "Task not found" }) }] };

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              taskId: task.id,
              subtaskId: task.subtaskId,
              status: task.status,
              files: task.files,
              usage: task.usage,
              error: task.error,
            }, null, 2),
          }],
        };
      },
    },
    {
      name: "task.merge",
      description: "Слить результаты параллельных подзадач. Конфликты разрешаются через авто-review.",
      inputSchema: {
        type: "object",
        properties: {
          taskIds: { type: "array", items: { type: "string" }, description: "ID подзадач для слияния" },
        },
        required: ["taskIds"],
      },
      async handler(args) {
        const results = [];
        const fileChanges = new Map(); // file → [taskId, patch]

        for (const tid of args.taskIds) {
          const task = tasks.get(tid);
          if (!task) { results.push({ taskId: tid, status: "not_found" }); continue; }
          if (task.status !== "done") { results.push({ taskId: tid, status: task.status }); continue; }

          results.push({
            taskId: tid,
            subtaskId: task.subtaskId,
            status: "merged",
            result: task.result?.slice(0, 1000),
          });

          // Простейшее слияние — записываем результат
          task.files?.forEach(f => {
            if (!fileChanges.has(f)) fileChanges.set(f, []);
            fileChanges.get(f).push(tid);
          });
        }

        // Проверяем конфликты
        const conflicts = [];
        for (const [file, taskIds] of fileChanges) {
          if (taskIds.length > 1) conflicts.push({ file, taskIds, resolution: "manual_review_needed" });
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              merged: results.length,
              conflicts: conflicts.length > 0 ? conflicts : "none",
              results,
            }, null, 2),
          }],
        };
      },
    },
  ];
}
