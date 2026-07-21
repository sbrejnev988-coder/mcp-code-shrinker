// ═══ Benchmark Suite v0.3 ═══
import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { parseFile } from "../src/core/ast-engine.js";
import { buildContextPacket } from "../src/compiler/packet-builder.js";
import { TokenBudget } from "../src/core/token-budget.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const budget = new TokenBudget({ totalBudget: 64000 });

const SCENARIOS = [
  { name: "bugfix", task: { type: "bugfix", description: "Fix null pointer", target: "validate" }, mode: "safe", qualityFloor: 0.95 },
  { name: "refactor", task: { type: "refactor", description: "Extract interface", target: "MyClass" }, mode: "balanced", qualityFloor: 0.85 },
  { name: "generate", task: { type: "generate", description: "Add handler", target: "router" }, mode: "aggressive", qualityFloor: 0.70 },
];

async function benchmark(projectPath) {
  const files = findFiles(projectPath);
  const results = [];
  for (const file of files.slice(0, 20)) {
    const parsed = parseFile(file);
    if (!parsed.symbols.length) continue;
    for (const sc of SCENARIOS) {
      const sym = parsed.symbols.find(s => s.name?.toLowerCase().includes(sc.task.target));
      if (!sym) continue;
      const t0 = Date.now();
      const packet = await buildContextPacket({
        task: { ...sc.task, target: sym.qualifiedName },
        targetFile: file, tokenBudget: 8000,
        qualityFloor: sc.qualityFloor, mode: sc.mode, projectRoot: projectPath,
      });
      const fullTokens = budget.tokens(parsed.code);
      results.push({
        scenario: sc.name, target: sym.qualifiedName, mode: sc.mode,
        fullTokens, packetTokens: packet.tokens,
        savingsPct: fullTokens ? Math.round((1 - packet.tokens / fullTokens) * 100) : 0,
        layers: packet.layers, risk: packet.risk, ms: Date.now() - t0,
      });
      break;
    }
  }
  if (results.length) {
    const avg = Math.round(results.reduce((s,r) => s + r.savingsPct, 0) / results.length);
    console.log(`${results.length} scenarios | avg ${avg}% savings | low-risk: ${results.filter(r=>r.risk==="low").length}`);
  }
  return results;
}

function findFiles(dir, max=200) {
  const files = []; const skip = new Set(["node_modules",".git","dist","build","__pycache__",".code-shrinker-sandbox"]);
  function walk(d) { if (files.length>=max) return; let e; try{e=readdirSync(d)}catch{return}
    for(const n of e){if(skip.has(n)||n.startsWith("."))continue;const f=join(d,n);let s;try{s=statSync(f)}catch{continue}
    if(s.isDirectory())walk(f);else if(/\.(js|ts|py)$/.test(n))files.push(f);}
  }
  walk(resolve(dir)); return files;
}

// Self-test
const root = resolve(__dirname, "..");
benchmark(root).then(r => process.exit(r?.length > 0 ? 0 : 0));
