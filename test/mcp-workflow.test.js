import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("MCP workflow integration", () => {
  const tmp = "/tmp/shrinker-mcpwf-" + Date.now();
  let server;

  before(async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.js"),
      "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n");

    server = spawn(process.execPath, [join(repoRoot, "src/index.js")], {
      cwd: repoRoot,
      env: { ...process.env, CODE_SHRINKER_ALLOWED_ROOTS: tmp },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("startup timeout")), 8000);
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

  it("connects and lists tools", async () => {
    const send = (method, params) => {
      const id = Math.random().toString(36).slice(2);
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      server.stdin.write(req);
      return new Promise((resolve) => {
        let buf = "";
        const onData = (d) => {
          buf += d.toString();
          const lines = buf.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const r = JSON.parse(line);
              if (r.id === id) { server.stdout.removeListener("data", onData); resolve(r); return; }
            } catch {}
          }
        };
        server.stdout.on("data", onData);
      });
    };

    const init = await send("initialize", { protocolVersion: "1.0", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.ok(init.result, "initialize must succeed");

    const tools = await send("tools/list", {});
    const names = tools.result.tools.map(t => t.name);
    assert.ok(names.includes("file.contracts"));
    assert.ok(names.includes("context.create"));
    assert.ok(names.includes("patch.propose"));
  });
});
