// ═══ Universal Plugin — regex-based, работает для любого языка ═══
import { createHash } from "crypto";

function hash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Вырезать комментарии (блочные и строчные) */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/\/\/.*$/gm, "")           // line comments //
    .replace(/^\s*#.*$/gm, "")          // line comments #
    .replace(/^\s*--.*$/gm, "")         // SQL comments
    .replace(/\n{3,}/g, "\n\n");        // collapse empty lines
}

/** Извлечь top-level символы (универсальный regex) */
function extractSymbols(code) {
  const cleaned = stripComments(code);
  const symbols = [];
  let id = 0;

  // Функции: function name, async function, arrow, method
  const funcRe = /(?:export\s+)?(?:async\s+)?(?:static\s+)?(?:function\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)/g;
  // Классы: class Name
  const classRe = /(?:export\s+)?class\s+(\w+)/g;
  // Переменные верхнего уровня: const/let/var name
  const varRe = /(?:export\s+)?(?:const|let|var)\s+(\w+)/g;
  // TypeScript: interface, type, enum
  const tsRe = /(?:export\s+)?(?:interface|type|enum)\s+(\w+)/g;

  for (const [re, kind] of [[funcRe, "function"], [classRe, "class"], [varRe, "variable"], [tsRe, "type"]]) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const name = m[1];
      if (["if", "for", "while", "switch", "catch", "return", "throw", "new", "else", "import", "export", "from", "default", "typeof", "instanceof"].includes(name)) continue;
      // Избегаем дубликатов
      if (symbols.find(s => s.name === name && s.kind === kind)) continue;

      // Ищем сигнатуру (строка с именем)
      const lines = cleaned.split("\n");
      let sigLine = "";
      for (const line of lines) {
        if (line.includes(name) && (line.includes("(") || line.includes("class") || line.includes("const") || line.includes("let") || line.includes("interface") || line.includes("type"))) {
          sigLine = line.trim();
          break;
        }
      }

      const locStart = cleaned.slice(0, m.index).split("\n").length;
      const locEnd = locStart + 1;

      symbols.push({
        id: `s${id++}`,
        kind,
        name,
        sig: sigLine.slice(0, 120) || `${kind} ${name}`,
        loc: `${locStart}:1-${locEnd}:1`,
        exported: !!m[0].startsWith("export"),
      });
    }
  }

  // Импорты
  const importRe = /import\s+.*$/gm;
  const imports = [];
  let im;
  while ((im = importRe.exec(code)) !== null) {
    imports.push(im[0].trim().slice(0, 100));
  }

  return {
    hash: hash(code),
    symbols,
    imports: imports.slice(0, 30),
    tokenEstimate: Math.ceil(code.length / 3.5),
  };
}

/** Вырезать тело символа по ID */
function resolveSymbol(code, symbolId) {
  const fp = extractSymbols(code);
  const sym = fp.symbols.find(s => s.id === symbolId);
  if (!sym) return null;

  const lines = code.split("\n");
  const [startLine] = sym.loc.split("-").map(p => parseInt(p.split(":")[0]));

  // Ищем блок (от startLine до закрывающей скобки или пустой строки)
  const result = [];
  let depth = 0;
  let started = false;
  for (let i = startLine - 1; i < Math.min(lines.length, startLine + 100); i++) {
    const line = lines[i];
    result.push(line);
    for (const ch of line) {
      if (ch === "{" || ch === "(") depth++;
      if (ch === "}" || ch === ")") depth--;
    }
    if (depth === 0 && (line.includes("{") || line.includes("("))) started = true;
    if (started && depth === 0 && result.length > 1) break;
    if (!started && result.length > 5) break; // не нашли тело
  }

  return result.join("\n");
}

/** Сжать код: удалить комментарии, пробелы, создать алиасы */
function compress(code, aliasMap = { to: {}, from: {} }) {
  let out = stripComments(code)
    .replace(/[ \t]+/g, " ")          // коллапсируем пробелы
    .replace(/^ +/gm, "")             // убираем отступы
    .replace(/\n{2,}/g, "\n")         // пустые строки → одна
    .trim();

  // Алиасы для длинных идентификаторов (>10 chars) — только если код не короткий
  if (out.length < 120) return out;
  let aliasCounter = 0;
  out = out.replace(/\b([a-zA-Z_]\w{10,})\b/g, (match, name) => {
    if (!aliasMap.to[name]) {
      const alias = `_${(aliasCounter++).toString(36)}`;
      aliasMap.to[name] = alias;
      aliasMap.from[alias] = name;
    }
    return aliasMap.to[name];
  });

  return out;
}

/** Развернуть алиасы */
function decompress(code, aliasMap = { to: {}, from: {} }) {
  let out = code;
  for (const [alias, original] of Object.entries(aliasMap.from)) {
    out = out.replace(new RegExp(`\\b${alias}\\b`, "g"), original);
  }
  return out;
}

/** Семантический diff (line-based) */
function diffSemantic(oldCode, newCode) {
  const oldLines = oldCode.split("\n");
  const newLines = newCode.split("\n");
  const diff = [];

  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      diff.push(` ${oldLines[i]}`);
      i++; j++;
    } else {
      if (i < oldLines.length) { diff.push(`-${oldLines[i]}`); i++; }
      if (j < newLines.length) { diff.push(`+${newLines[j]}`); j++; }
    }
  }

  return diff.join("\n");
}

export default {
  languageId: "universal",
  extensions: [".txt", ".md", ".json", ".xml", ".yaml", ".yml", ".css", ".html", ".sql", ".sh", ".bash"],
  fingerprint: extractSymbols,
  resolveSymbol,
  compress,
  decompress,
  stripComments,
  diffSemantic,
};
