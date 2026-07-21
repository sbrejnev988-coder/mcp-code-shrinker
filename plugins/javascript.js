// ═══ JavaScript Plugin ═══
// Специализированный fingerprint/compress для JS (более точный чем universal)

import { createHash } from "crypto";

function hash(t) { return createHash("sha256").update(t).digest("hex").slice(0, 16); }

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

function extractSymbols(code) {
  const cleaned = stripComments(code);
  const symbols = [];
  let id = 0;

  // Export/function declarations
  const patterns = [
    { re: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g, kind: "function" },
    { re: /(?:export\s+)?(?:async\s+)?(\w+)\s*=\s*(?:async\s*)?\(/g, kind: "function" },
    { re: /(?:export\s+)?class\s+(\w+)/g, kind: "class" },
    { re: /(?:export\s+)?(?:const|let|var)\s+(\w+)/g, kind: "variable" },
    { re: /(?:export\s+)?(?:async\s+)?(\w+)\s*=\s*async\s+function/g, kind: "function" },
    { re: /(?:export\s+)?(?:async\s+)?(\w+)\s*=\s*function/g, kind: "function" },
    { re: /(?:export\s+)?(?:async\s+)?(?:static\s+)?(\w+)\s*\([^)]*\)\s*\{/g, kind: "method" },
  ];

  const excluded = new Set(["if","for","while","switch","catch","return","throw","new","else","import","export","from","default","typeof","instanceof","in","of","try","finally","class","function","const","let","var","async","await","yield","break","continue","case","delete","void","this","super","true","false","null","undefined","NaN","Infinity"]);

  const seen = new Set();
  for (const { re, kind } of patterns) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const name = m[1];
      if (excluded.has(name)) continue;
      if (name.length < 2) continue;
      const key = `${name}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const locStart = cleaned.slice(0, m.index).split("\n").length;
      const sigLine = cleaned.split("\n")[Math.max(0, locStart - 1)]?.trim().slice(0, 120) || "";

      symbols.push({
        id: `s${id++}`,
        kind,
        name,
        sig: sigLine || `${kind} ${name}`,
        loc: `${locStart}:1-${locStart + 1}:1`,
        exported: !!m[0].startsWith("export"),
      });
    }
  }

  // Импорты
  const imports = [];
  const importRe = /import\s+.*from\s+['"].*['"]|require\s*\(.*\)|import\s*\(.*\)/g;
  let im;
  while ((im = importRe.exec(code)) !== null) {
    imports.push(im[0].trim().slice(0, 100));
  }

  return {
    hash: hash(code),
    symbols: symbols.slice(0, 100),
    imports: imports.slice(0, 30),
    tokenEstimate: Math.ceil(code.length / 3.5),
  };
}

function resolveSymbol(code, symbolId) {
  const fp = extractSymbols(code);
  const sym = fp.symbols.find(s => s.id === symbolId);
  if (!sym) return null;
  const lines = code.split("\n");
  const [startLine] = sym.loc.split("-").map(p => parseInt(p.split(":")[0]));
  const result = [];
  let depth = 0, started = false;
  for (let i = startLine - 1; i < Math.min(lines.length, startLine + 150); i++) {
    result.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "(") depth++;
      if (ch === "}" || ch === ")") depth--;
    }
    if (depth === 0 && lines[i].includes("{")) started = true;
    if (started && depth === 0 && result.length > 1) break;
    if (!started && result.length > 10) break;
  }
  return result.join("\n");
}

function compress(code, aliasMap = { to: {}, from: {} }) {
  let out = stripComments(code)
    .replace(/[ \t]+/g, " ")
    .replace(/^ +/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  // Пропускаем алиасинг на коротких фрагментах — overhead > экономия
  if (out.length < 120) return out;
  let c = 0;
  out = out.replace(/\b([a-zA-Z_$]\w{10,})\b/g, (m, name) => {
    if (!aliasMap.to[name]) { const a = `_${(c++).toString(36)}`; aliasMap.to[name] = a; aliasMap.from[a] = name; }
    return aliasMap.to[name];
  });
  return out;
}

function decompress(code, aliasMap = { to: {}, from: {} }) {
  let out = code;
  for (const [a, o] of Object.entries(aliasMap.from)) {
    out = out.replace(new RegExp(`\\b${a}\\b`, "g"), o);
  }
  return out;
}

function diffSemantic(old, nw) {
  const ol = old.split("\n"), nl = nw.split("\n");
  const d = []; let i = 0, j = 0;
  while (i < ol.length || j < nl.length) {
    if (ol[i] === nl[j]) { d.push(` ${ol[i]}`); i++; j++; }
    else { if (i < ol.length) { d.push(`-${ol[i]}`); i++; } if (j < nl.length) { d.push(`+${nl[j]}`); j++; } }
  }
  return d.join("\n");
}

export default {
  languageId: "javascript",
  extensions: [".js", ".mjs", ".cjs"],
  fingerprint: extractSymbols,
  resolveSymbol,
  compress,
  decompress,
  stripComments,
  diffSemantic,
};
