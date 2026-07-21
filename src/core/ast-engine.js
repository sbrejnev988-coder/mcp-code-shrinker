// ═══ AST Engine v0.3.2 ═══
// FIXED: Full function/class body extraction via brace counting
// FIXED: endLine now points to CLOSING brace, not opening
// string-aware, comment-aware brace matching

import { readFileSync } from "fs";
import { extname } from "path";

const EXT_MAP = {
  ".js":"javascript", ".mjs":"javascript", ".cjs":"javascript",
  ".ts":"typescript", ".mts":"typescript", ".tsx":"tsx", ".jsx":"jsx",
  ".py":"python", ".pyi":"python", ".go":"go", ".rs":"rust",
  ".sh":"bash", ".json":"json", ".yaml":"yaml", ".yml":"yaml", ".md":"markdown",
};

export function detectLanguage(filePath) {
  return EXT_MAP[extname(filePath).toLowerCase()] || "text";
}

// ═══ Full body extraction via brace/indent matching ═══

function findBlockEnd(code, openIdx, lang) {
  if (lang === "python") return findPythonBlockEnd(code, openIdx);
  return findBraceBlockEnd(code, openIdx);
}

function findBraceBlockEnd(code, openIdx) {
  let depth = 0, quote = null, escaped = false;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "/" && i+1 < code.length) {
      const nxt = code[i+1];
      if (nxt === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
      if (nxt === "*") { i += 2; while (i < code.length && !(code[i] === "*" && code[i+1] === "/")) i++; i++; continue; }
    }
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findPythonBlockEnd(code, colonIdx) {
  const lines = code.slice(colonIdx).split("\n");
  if (lines.length < 2) return colonIdx;
  const header = lines[0];
  const baseIndent = header.search(/\S|$/);
  let endPos = colonIdx + header.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { endPos += line.length + 1; continue; }
    const indent = line.search(/\S|$/);
    if (indent <= baseIndent && line.trim() !== "") break;
    endPos += line.length + 1;
  }
  return endPos;
}

// ═══ Regex-based Parser with CORRECT body ranges ═══

class RegexParser {
  constructor(language) { this.language = language; }

  parse(code) {
    const lines = code.split("\n");
    const symbols = [];
    let scopeStack = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Skip comments
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("/*")) {
        let j = i;
        while (j < lines.length && !lines[j].includes("*/")) j++;
        i = j;
        continue;
      }

      // Detect declarations
      const patterns = this._getPatterns();
      for (const pat of patterns) {
        const m = trimmed.match(pat.regex);
        if (!m) continue;

        const name = m[1];
        const qualifiedName = scopeStack.length > 0
          ? `${scopeStack[scopeStack.length-1]}.${name}`
          : name;

        // Find opening brace/colon position in original code
        let lineStartPos = 0;
        for (let k = 0; k < i; k++) lineStartPos += lines[k].length + 1;
        const lineContent = lines.slice(i).join("\n");
        const relMatch = lineContent.match(pat.regex);
        const matchPos = lineStartPos + (relMatch ? relMatch.index + relMatch[0].length : 0);

        // Find opening { or :
        let openIdx = -1;
        const rest = code.slice(matchPos);
        const braceMatch = rest.match(/[{(:]/);
        if (braceMatch) openIdx = matchPos + braceMatch.index;

        let endByte = code.length - 1;
        let endLine = lines.length;

        if (openIdx >= 0) {
          const closeIdx = findBlockEnd(code, openIdx, this.language);
          if (closeIdx >= 0) {
            endByte = closeIdx;
            // Convert byte offset to line number
            let pos = 0;
            for (let k = 0; k < lines.length; k++) {
              pos += lines[k].length + 1;
              if (pos > closeIdx) { endLine = k + 1; break; }
            }
          }
        }

        // Extract signature
        const sigOpen = code.indexOf("(", matchPos);
        let sig = "()";
        if (sigOpen >= 0 && sigOpen < endByte) {
          const sigClose = findMatchingParen(code, sigOpen);
          if (sigClose >= 0) sig = code.slice(sigOpen, sigClose + 1).replace(/\s+/g, " ").trim();
        }

        symbols.push({
          name, qualifiedName, kind: pat.kind, signature: sig,
          startLine: i + 1, endLine,
          startByte: matchPos, endByte,
          body: code.slice(matchPos, endByte + 1),
        });

        if (pat.kind === "class") scopeStack.push(qualifiedName);
        break;
      }
    }

    return { symbols, language: this.language };
  }

  _getPatterns() {
    return {
      javascript: [
        { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function" },
        { regex: /^(?:export\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/, kind: "method" },
      ],
      typescript: [
        { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function" },
        { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class" },
        { regex: /^(?:export\s+)?interface\s+(\w+)/, kind: "interface" },
        { regex: /^(?:export\s+)?type\s+(\w+)\s*=/, kind: "type" },
        { regex: /^(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*:\s*\w+\s*\{/, kind: "method" },
      ],
      python: [
        { regex: /^def\s+(\w+)\s*\(/, kind: "function" },
        { regex: /^class\s+(\w+)/, kind: "class" },
        { regex: /^(?:async\s+)?def\s+(\w+)\s*\(/, kind: "async_function" },
      ],
    }[this.language] || [
      { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function" },
      { regex: /^(?:export\s+)?class\s+(\w+)/, kind: "class" },
    ];
  }
}

function findMatchingParen(code, openIdx) {
  let depth = 0, quote = null, escaped = false;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (escaped) { escaped = false; continue; }
    if (quote) { if (ch === "\\") escaped = true; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ═══ Language Adapters ═══

class BaseAdapter {
  constructor(lang) { this.language = lang || "text"; }
  extractImports(code) {
    const imports = [];
    const re = /import\s+.*?\s+from\s+['"]([^'"]+)['"]|require\s*\(['"]([^'"]+)['"]\)|from\s+(\S+)\s+import|import\s+(\S+)/g;
    let m;
    while ((m = re.exec(code)) !== null) imports.push({ specifier: m[1] || m[2] || m[3] || m[4], raw: m[0] });
    return imports;
  }
  extractCalls(code, symbolName) {
    const calls = new Set();
    const re = /(\w+(?:\.\w+)*)\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) { const c = m[1]; if (c !== symbolName) calls.add(c); }
    return [...calls];
  }
  extractThrows(code) {
    const throws = new Set();
    const re = /throw\s+(?:new\s+)?(\w+)/g;
    let m;
    while ((m = re.exec(code)) !== null) throws.add(m[1]);
    return [...throws];
  }
  extractEffects(code) {
    const e = [];
    if (/\.(?:save|insert|update|delete|create|write|persist|upsert)\s*\(/i.test(code)) e.push("database-write");
    if (/\.(?:publish|send|post|put|patch)\s*\(/.test(code)) e.push("network-write");
    if (/\.(?:fetch|get|request)\s*\(/.test(code)) e.push("network-read");
    if (/(?:writeFile|createWriteStream|open\s*\([^)]*['"]w)/.test(code)) e.push("filesystem-write");
    if (/(?:spawn|exec|fork|subprocess)/.test(code)) e.push("process-spawn");
    return e;
  }
}

class JavaScriptAdapter extends BaseAdapter { constructor() { super("javascript"); } }
class TypeScriptAdapter extends BaseAdapter { constructor() { super("typescript"); } }
class PythonAdapter extends BaseAdapter {
  constructor() { super("python"); }
  extractCalls(code, sym) {
    const calls = new Set();
    const skip = new Set(["print","len","range","str","int","list","dict","set","type","isinstance","hasattr","getattr","setattr","super","enumerate","zip","map","filter"]);
    const re = /(\w+(?:\.\w+)*)\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) { if (!skip.has(m[1])) calls.add(m[1]); }
    return [...calls];
  }
}

const adapters = { javascript: JavaScriptAdapter, typescript: TypeScriptAdapter, tsx: TypeScriptAdapter, python: PythonAdapter };

export function getAdapter(language) {
  const Adapter = adapters[language] || BaseAdapter;
  return new Adapter(language);
}

export function parseFile(filePath) {
  const code = readFileSync(filePath, "utf-8");
  const language = detectLanguage(filePath);
  const parser = new RegexParser(language);
  const adapter = getAdapter(language);
  const { symbols } = parser.parse(code);
  const imports = adapter.extractImports(code);
  return { symbols, language, imports, code };
}

export function extractContract(symbol, code, language) {
  const adapter = getAdapter(language || "javascript");
  const body = symbol.body || "";
  const effects = adapter.extractEffects(body);
  const throws = adapter.extractThrows(body);
  const calls = adapter.extractCalls(body, symbol.name);
  const props = {};
  if (/(?:new Promise|async\s|await\s)/.test(body)) props.async = true;
  if (/(?:transaction|BEGIN|COMMIT|ROLLBACK)/.test(body)) props.transactional = true;
  if (/(?:mutex|lock|semaphore|atomic)/i.test(body)) props.usesLocking = true;
  return {
    signature: symbol.signature || "", visibility: symbol.name?.startsWith("_") ? "private" : "public",
    effects, throws, calls, properties: props,
    confidence: { effects: effects.length > 0 ? 0.85 : 0.3, idempotent: props.transactional ? 0.5 : 0.5, async: props.async ? 0.95 : 0.95 },
    body, startLine: symbol.startLine, endLine: symbol.endLine,
  };
}
