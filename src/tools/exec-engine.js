// ═══ DevAutopilot: execution-engine ═══
// Песочница для запуска кода и тестов
import { execSync, spawnSync } from "child_process";

export function registerExecTools(server, ctx) {
  const { tokenBudget } = ctx;

  return [
    {
      name: "exec.run",
      description: "Запустить shell-команду в песочнице. Возвращает stdout, stderr, exit code. Вывод авто-сжимается.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Рабочая директория (по умолчанию — текущая)" },
          timeout: { type: "number", description: "Таймаут в секундах (default: 30)" },
        },
        required: ["command"],
      },
      async handler(args) {
        const timeout = (args.timeout || 30) * 1000;
        try {
          const result = spawnSync("bash", ["-lc", args.command], {
            cwd: args.cwd || process.cwd(),
            timeout,
            maxBuffer: 500 * 1024, // 500KB
            encoding: "utf-8",
          });

          const stdout = tokenBudget.truncate(result.stdout || "", 4000);
          const stderr = tokenBudget.truncate(result.stderr || "", 4000);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                exitCode: result.status,
                signal: result.signal,
                stdout: stdout.slice(0, 3000),
                stderr: stderr.slice(0, 3000),
                truncated: (result.stdout?.length > 3000 || result.stderr?.length > 3000),
              }, null, 2),
            }],
          };
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: e.message, exitCode: e.status || -1 }),
            }],
          };
        }
      },
    },
    {
      name: "exec.test",
      description: "Запустить тесты по паттерну или списку файлов. Возвращает TAP-отчёт.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Паттерн для тестов (напр. 'test/**/*.test.js')" },
          files: { type: "array", items: { type: "string" }, description: "Конкретные файлы тестов" },
          cwd: { type: "string" },
        },
        required: [],
      },
      async handler(args) {
        const cwd = args.cwd || process.cwd();
        let cmd;

        if (args.files?.length) {
          cmd = `node --test ${args.files.join(" ")}`;
        } else if (args.pattern) {
          cmd = `node --test ${args.pattern}`;
        } else {
          cmd = `node --test **/*.test.{js,mjs,ts} 2>/dev/null || echo 'no test files found'`;
        }

        try {
          const result = spawnSync("bash", ["-lc", cmd], {
            cwd,
            timeout: 60000,
            maxBuffer: 300 * 1024,
            encoding: "utf-8",
          });

          // Парсим TAP-вывод
          const output = (result.stdout || "") + (result.stderr || "");
          const passed = (output.match(/ok \d+/g) || []).length;
          const failed = (output.match(/not ok \d+/g) || []).length;
          const totalTests = passed + failed;

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                passed,
                failed,
                total: totalTests,
                exitCode: result.status,
                summary: totalTests > 0
                  ? `${passed}/${totalTests} passed${failed > 0 ? `, ${failed} FAILED` : " ✓"}`
                  : "no test results",
                output: tokenBudget.truncate(output, 3000),
              }, null, 2),
            }],
          };
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: e.message, exitCode: e.status || -1 }),
            }],
          };
        }
      },
    },
  ];
}
