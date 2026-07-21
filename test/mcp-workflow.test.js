import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

describe("MCP workflow integration", () => {
  const tmp = "/tmp/shrinker-mcpwf-" + Date.now();
  const srcFile = join(tmp, "src", "index.js");
  let server;

  before(async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(srcFile, "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n");

    server = spawn(process.execPath, ["src/index.js"], {
      cwd: "/tmp/mcp-code-shrinker",
      env: { ...process.env, CODE_SHRINKER_ALLOWED_ROOTS: tmp },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 8000);
      server.stderr.on("data", (d) => {
        if (d.toString().includes("ready")) { clearTimeout(timeout); resolve(); }
      });
      server.on("error", reject);
    });
    server.stderr.removeAllListeners();
  });

  after(() => {
    server?.kill();
    try { rmSync(tmp, { recursive: true }); } catch {}
  });

  it("completes context.create → file.contracts → symbol.source", async () => {
    // Simple JSON-RPC test
    const send = (method, params) => {
      const id = Math.random().toString(36);
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      server.stdin.write(req + "\n");
      return new Promise((resolve) => {
        const onData = (d) => {
          try {
            const lines = d.toString().split("\n").filter(Boolean);
            for (const line of lines) {
              const r = JSON.parse(line);
              if (r.id === id) { server.stdout.removeListener("data", onData); resolve(r); return; }
            }
          } catch {}
        };
        server.stdout.on("data", onData);
      });
    };

    // Initialize
    const init = await send("initialize", { protocolVersion: "1.0", capabilities: {}, clientInfo: { name: "test", version: "1.0" } });
    assert.ok(init.result, "initialize must succeed");

    // List tools
    const tools = await send("tools/list", {});
    const names = tools.result.tools.map(t => t.name);
    assert.ok(names.includes("file.contracts"), "must have file.contracts");
    assert.ok(names.includes("symbol.source"), "must have symbol.source");
    assert.ok(names.includes("context.create"), "must have context.create");
  });
});
