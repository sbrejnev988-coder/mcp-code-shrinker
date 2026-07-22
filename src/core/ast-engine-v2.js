// ═══ AST Engine v0.4.0 — Multi-backend parser with metadata ═══
// Primary: enhanced regex + heuristics (production on ARM64/proot)
// Planned: tree-sitter WASM, acorn
// 
// Every parse result includes ParserMeta:
//   { backend, version, confidence, syntaxErrors, fallback }

import { readFileSync } from "fs";
import { extname } from "path";

const VERSION = "0.4.0";

const EXT_MAP = {
  ".js":"javascript", ".mjs":"javascript", ".cjs":"javascript",
  ".ts":"typescript", ".mts":"typescript", ".tsx":"tsx", ".jsx":"jsx",
  ".py":"python", ".pyi":"python", ".go":"go", ".rs":"rust",
  ".sh":"bash", ".json":"json", ".yaml":"yaml", ".yml":"yaml", ".md":"markdown",
};

const SYMBOL_KINDS = [
  "function", "class", "method", "variable", "constant",
  "interface", "type", "enum", "module", "export",
  "arrow_function", "generator", "decorator", "unknown"
];

export function detectLanguage(filePath) {
  return EXT_MAP[extname(filePath).toLowerCase()] || "text";
}

// ═══ Parser metadata ═══
function parserMeta(backend, confidence, syntaxErrors = [], fallback = false) {
  return { backend, version: VERSION, confidence, syntaxErrors, fallback };
}

// ═══ Block end detection (brace/indent) ═══
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

// ═══ Enhanced Regex Parser (v0.4.0) ═══
export class EnhancedRegexParser {
  constructor(language) {
    this.language = language;
  }

  parse(code) {
    const lines = code.split("\n");
    const symbols = [];
    const syntaxErrors = [];
    let confidence = 0.85; // Base confidence for regex parser

    // Multi-line comment tracking
    let inBlockComment = false;
    let blockCommentStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Handle block comments
      if (trimmed.startsWith("/*") || inBlockComment) {
        if (!inBlockComment) { inBlockComment = true; blockCommentStart = i; }
        if (trimmed.includes("*/")) { inBlockComment = false; }
        continue;
      }

      // Skip single-line comments
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;

      // Triple-quoted strings in Python
      if (this.language === "python" && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
        let j = i + 1;
        const delim = trimmed.slice(0, 3);
        while (j < lines.length && !lines[j].includes(delim)) j++;
        i = j;
        continue;
      }

      // ═══ Function declarations ═══
      const fnMatch = this._matchFunction(line, trimmed, i);
      if (fnMatch) {
        const [kind, name, args, isAsync, isGenerator] = fnMatch;
        const bodyEnd = this._findBodyEnd(code, lines, i, trimmed);
        symbols.push({
          symbolId: null, // Computed later by symbol-id module
          qualifiedName: name,
          kind,
          language: this.language,
          startLine: i + 1,
          endLine: bodyEnd + 1,
          signature: `${isAsync ? "async " : ""}${isGenerator ? "generator " : ""}${name}${args}`,
          isExported: line.includes("export ") || trimmed.startsWith("export "),
          isDefault: line.includes("export default"),
          scopePath: [],
          confidence: 0.9,
        });
        continue;
      }

      // ═══ Class declarations ═══
      const clsMatch = this._matchClass(line, trimmed, i);
      if (clsMatch) {
        const [name, extends_] = clsMatch;
        const bodyEnd = this._findBodyEnd(code, lines, i, trimmed);
        symbols.push({
          symbolId: null,
          qualifiedName: name,
          kind: "class",
          language: this.language,
          startLine: i + 1,
          endLine: bodyEnd + 1,
          signature: extends_ ? `class ${name} extends ${extends_}` : `class ${name}`,
          isExported: line.includes("export "),
          isDefault: line.includes("export default"),
          scopePath: [],
          confidence: 0.9,
        });
        // Scan class body for methods
        this._scanClassBody(code, lines, i, bodyEnd, name, symbols);
        continue;
      }

      // ═══ Variable/constant declarations ═══
      const varMatch = this._matchVariable(line, trimmed);
      if (varMatch) {
        const [kind, name] = varMatch;
        symbols.push({
          symbolId: null,
          qualifiedName: name,
          kind: kind === "const" ? "constant" : "variable",
          language: this.language,
          startLine: i + 1,
          endLine: i + 1,
          signature: `${kind} ${name}`,
          isExported: line.includes("export "),
          scopePath: [],
          confidence: 0.8,
        });
        continue;
      }

      // ═══ Interface/Type/Enum (TypeScript) ═══
      const typeMatch = this._matchTypeDecl(line, trimmed);
      if (typeMatch) {
        symbols.push(typeMatch);
      }
    }

    // Adjust confidence based on parse quality
    if (syntaxErrors.length > 0) confidence = Math.max(0.3, confidence - syntaxErrors.length * 0.1);

    return {
      symbols,
      parser: parserMeta("enhanced-regex", confidence, syntaxErrors, false),
    };
  }

  _matchFunction(line, trimmed, lineNum) {
    // Python: def name(args):
    if (this.language === "python") {
      const m = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*\S+)?\s*:/);
      if (m) return ["function", m[1], `(${m[2]})`, trimmed.startsWith("async"), false];
      return null;
    }

    // JavaScript/TypeScript: function, async function, arrow functions, methods
    const patterns = [
      // function name(args)
      /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)/,
      // const name = (args) => { or const name = async (args) => {
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\s*\(([^)]*)\)\s*=>/,
      // name(args) { (object method shorthand)
      /^(\w+)\s*\(([^)]*)\)\s*\{/,
    ];

    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        // Filter control-flow keywords
        const CONTROL = new Set(["if","for","while","switch","catch","with","do","else","try","finally","return","throw","await","yield","import","export","from","new","delete","typeof","instanceof","void","in","of","case","default","break","continue","debugger","class","extends","super","static","get","set","public","private","protected","readonly","abstract","implements","interface","type","enum","namespace","declare","module","require"]);
        if (CONTROL.has(m[1])) return null;
        const kind = trimmed.includes("=>") ? "arrow_function" : "function";
        const isAsync = trimmed.includes("async ");
        const isGen = trimmed.includes("function*") || trimmed.includes("* ");
        return [kind, m[1], `(${m[2]})`, isAsync, isGen];
      }
    }
    return null;
  }

  _matchClass(line, trimmed, lineNum) {
    if (this.language === "python") {
      const m = trimmed.match(/^class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/);
      if (m) return [m[1], m[2] || null];
      return null;
    }

    const m = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+(?:\.\w+)*))?(?:\s+implements\s+[^{]+)?\s*\{/);
    if (m) return [m[1], m[2] || null];

    // exported class without immediate brace
    const m2 = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (m2 && !CONTROL.has(m2[1])) return [m2[1], null];

    return null;
  }

  _matchVariable(line, trimmed) {
    const m = trimmed.match(/^(?:export\s+)?(const|let|var)\s+(\w+)\s*=/);
    if (m) return [m[1], m[2]];
    return null;
  }

  _matchTypeDecl(line, trimmed) {
    // TypeScript: interface Foo {, type Foo =, enum Foo {
    const intf = trimmed.match(/^(?:export\s+)?interface\s+(\w+)\s*(?:extends\s[^{]+)?\s*\{/);
    if (intf) return { qualifiedName: intf[1], kind: "interface", startLine: 0, confidence: 0.85, /* filled by caller */ };

    const type = trimmed.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
    if (type) return { qualifiedName: type[1], kind: "type", startLine: 0, confidence: 0.85 };

    const enm = trimmed.match(/^(?:export\s+)?enum\s+(\w+)\s*\{/);
    if (enm) return { qualifiedName: enm[1], kind: "enum", startLine: 0, confidence: 0.85 };

    return null;
  }

  _findBodyEnd(code, lines, startLine, trimmed) {
    if (this.language === "python") {
      const colonIdx = code.indexOf("\n", code.split("\n").slice(0, startLine).join("\n").length + startLine);
      if (colonIdx < 0) return startLine;
      return findPythonBlockEnd(code, code.indexOf(":", colonIdx - 50));
    }
    const openBrace = code.indexOf("{", code.split("\n").slice(0, startLine).join("\n").length);
    if (openBrace < 0) return startLine;
    const endIdx = findBraceBlockEnd(code, openBrace);
    if (endIdx < 0) return startLine;
    return code.slice(0, endIdx + 1).split("\n").length - 1;
  }

  _scanClassBody(code, lines, classStart, classEnd, className, symbols) {
    // Scan for class methods
    for (let i = classStart + 1; i <= classEnd && i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

      const methodRe = this.language === "python"
        ? /^\s+def\s+(\w+)\s*\(([^)]*)\)/
        : /^\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/;

      const m = trimmed.match(methodRe);
      if (m && !CONTROL.has(m[1])) {
        symbols.push({
          symbolId: null,
          qualifiedName: `${className}.${m[1]}`,
          kind: "method",
          language: this.language,
          startLine: i + 1,
          endLine: i + 1,
          signature: `${className}.${m[1]}(${m[2]})`,
          isExported: false,
          isStatic: trimmed.includes("static "),
          scopePath: [className],
          confidence: 0.85,
        });
      }
    }
  }
}

const CONTROL = new Set(["if","for","while","switch","catch","with","do","else","try","finally","return","throw","await","yield","import","export","from","new","delete","typeof","instanceof","void","in","of","case","default","break","continue","debugger","class","extends","super","static","get","set","public","private","protected","readonly","abstract","implements","interface","type","enum","namespace","declare","module","require"]);

// ═══ Factory ═══
export function createParser(language) {
  // Try enhanced regex (always works, no native deps)
  return new EnhancedRegexParser(language);
}

export { VERSION };
