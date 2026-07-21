// ═══ Python Plugin ═══

import { createHash } from "crypto";
function hash(t) { return createHash("sha256").update(t).digest("hex").slice(0, 16); }
function stripComments(code) {
  return code
    .replace(/\"\"\"[\s\S]*?\"\"\"/g, "")  // docstrings
    .replace(/'''[\s\S]*?'''/g, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

function extractSymbols(code) {
  const cleaned = stripComments(code);
  const symbols = [];
  let id = 0;
  const excluded = new Set(["if","for","while","with","try","except","finally","return","yield","raise","break","continue","import","from","as","in","is","not","and","or","True","False","None","class","def","lambda","global","nonlocal","del","pass","assert","elif","else","print"]);

  // Функции
  const funcRe = /(?:async\s+)?def\s+(\w+)\s*\(/g;
  let m;
  while ((m = funcRe.exec(cleaned)) !== null) {
    const name = m[1];
    if (excluded.has(name) || name.startsWith("_")) continue;
    const locStart = cleaned.slice(0, m.index).split("\n").length;
    const sigLine = cleaned.split("\n")[Math.max(0, locStart - 1)]?.trim().slice(0, 120) || "";
    symbols.push({
      id: `s${id++}`, kind: "function", name,
      sig: sigLine || `def ${name}(...)`,
      loc: `${locStart}:1-${locStart + 1}:1`,
      exported: !name.startsWith("_"),
    });
  }

  // Классы
  const classRe = /class\s+(\w+)/g;
  while ((m = classRe.exec(cleaned)) !== null) {
    const name = m[1];
    if (excluded.has(name)) continue;
    const locStart = cleaned.slice(0, m.index).split("\n").length;
    const sigLine = cleaned.split("\n")[Math.max(0, locStart - 1)]?.trim().slice(0, 120) || "";
    symbols.push({
      id: `s${id++}`, kind: "class", name,
      sig: sigLine || `class ${name}`,
      loc: `${locStart}:1-${locStart + 1}:1`,
      exported: !name.startsWith("_"),
    });
  }

  // Импорты
  const imports = [];
  const importRe = /(?:from\s+\S+\s+)?import\s+.*$/gm;
  let im;
  while ((im = importRe.exec(code)) !== null) imports.push(im[0].trim().slice(0, 100));

  return { hash: hash(code), symbols: symbols.slice(0, 100), imports: imports.slice(0, 30), tokenEstimate: Math.ceil(code.length / 3.5) };
}

function resolveSymbol(code, symbolId) {
  const fp = extractSymbols(code);
  const sym = fp.symbols.find(s => s.id === symbolId);
  if (!sym) return null;
  const lines = code.split("\n");
  const [startLine] = sym.loc.split("-").map(p => parseInt(p.split(":")[0]));
  const result = [];
  let baseIndent = null, started = false;
  for (let i = startLine - 1; i < Math.min(lines.length, startLine + 150); i++) {
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (baseIndent === null && indent > 0) baseIndent = indent;
    result.push(lines[i]);
    if (i > startLine - 1) {
      if (lines[i].trim() && indent <= (baseIndent || 0) && started) break;
      started = true;
    }
    if (result.length > 100) break;
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
  out = out.replace(/\b([a-zA-Z_]\w{10,})\b/g, (m, name) => {
    if (!aliasMap.to[name]) { const a = `_${(c++).toString(36)}`; aliasMap.to[name] = a; aliasMap.from[a] = name; }
    return aliasMap.to[name];
  });
  return out;
}

function decompress(code, aliasMap = { to: {}, from: {} }) {
  let out = code;
  for (const [a, o] of Object.entries(aliasMap.from)) out = out.replace(new RegExp(`\\b${a}\\b`, "g"), o);
  return out;
}

function diffSemantic(old, nw) {
  const ol = old.split("\n"), nl = nw.split("\n"), d = []; let i = 0, j = 0;
  while (i < ol.length || j < nl.length) {
    if (ol[i] === nl[j]) { d.push(` ${ol[i]}`); i++; j++; }
    else { if (i < ol.length) { d.push(`-${ol[i]}`); i++; } if (j < nl.length) { d.push(`+${nl[j]}`); j++; } }
  }
  return d.join("\n");
}

export default {
  languageId: "python", extensions: [".py", ".pyw", ".pyx"],
  fingerprint: extractSymbols, resolveSymbol, compress, decompress, stripComments, diffSemantic,
};
