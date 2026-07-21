// ═══ DevAutopilot: project-graph ═══
// Граф зависимостей проекта на основе fingerprint'ов code-shrinker
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, relative, dirname } from "path";
import { createHash } from "crypto";

function hash(t) { return createHash("sha256").update(t).digest("hex").slice(0, 16); }

/** Построить граф зависимостей */
export function buildGraph(projectRoot, pluginManager, contextCache) {
  const nodes = {}; // file → { fingerprint, imports[], exports[], dependents[] }
  const maxFiles = 200;

  function scan(dir, files = []) {
    try {
      for (const entry of readdirSync(dir)) {
        if (files.length >= maxFiles) break;
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            if (!entry.startsWith(".") && entry !== "node_modules" && entry !== "__pycache__" && entry !== ".git")
              scan(full, files);
          } else if (st.isFile() && st.size < 500000) {
            files.push(full);
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }
    return files;
  }

  const files = scan(projectRoot);

  // Фаза 1: fingerprint'ы всех файлов
  for (const file of files) {
    const rel = relative(projectRoot, file);
    const plugin = pluginManager.forFile(file);
    if (!plugin) continue;

    try {
      const code = readFileSync(file, "utf-8");
      const fp = plugin.fingerprint(code);
      contextCache.track(rel, code, fp, { to: {}, from: {} });

      nodes[rel] = {
        fingerprint: fp.hash,
        symbols: fp.symbols.map(s => s.name),
        imports: [],
        exports: fp.symbols.filter(s => s.exported).map(s => s.name),
        dependents: [],
        tokenEstimate: fp.tokenEstimate,
      };

      // Извлекаем импорты
      for (const imp of fp.imports || []) {
        // "import X from './foo'" → './foo'
        const fromMatch = imp.match(/from\s+['"]([^'"]+)['"]/) || imp.match(/require\s*\(['"]([^'"]+)['"]/);
        if (fromMatch) {
          const importPath = fromMatch[1];
          if (importPath.startsWith(".")) {
            nodes[rel].imports.push(importPath);
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  // Фаза 2: резолвим импорты в файлы
  for (const [file, node] of Object.entries(nodes)) {
    for (const imp of node.imports) {
      const resolved = resolveImport(file, imp, projectRoot, nodes);
      if (resolved && nodes[resolved]) {
        nodes[resolved].dependents.push(file);
      }
    }
  }

  return { root: projectRoot, nodes, fileCount: Object.keys(nodes).length, builtAt: Date.now() };
}

/** Резолвить импорт в относительный путь */
function resolveImport(fromFile, importPath, root, nodes) {
  const base = dirname(join(root, fromFile));
  const candidates = [
    join(base, importPath),
    join(base, importPath + ".js"),
    join(base, importPath + ".ts"),
    join(base, importPath + ".mjs"),
    join(base, importPath, "index.js"),
    join(base, importPath, "index.ts"),
    join(base, importPath + ".jsx"),
    join(base, importPath + ".tsx"),
  ];
  for (const c of candidates) {
    const rel = relative(root, c);
    if (nodes[rel]) return rel;
  }
  return null;
}

/** Инициализировать граф, сохранить в кеш */
export function initGraph(projectRoot, pluginManager, contextCache) {
  const graph = buildGraph(projectRoot, pluginManager, contextCache);
  const cacheDir = join(projectRoot, ".code-shrinker");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "graph.json"), JSON.stringify(graph, null, 2));
  return graph;
}

/** Загрузить граф из кеша или перестроить */
function loadGraph(projectRoot, pluginManager, contextCache) {
  const cacheFile = join(projectRoot, ".code-shrinker", "graph.json");
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
    if (Date.now() - cached.builtAt < 300000) return cached; // 5 min TTL
  }
  return initGraph(projectRoot, pluginManager, contextCache);
}

/** Получить зависимости файла */
function getDeps(graph, file, direction = "all") {
  const node = graph.nodes[file];
  if (!node) return { error: `File not in graph: ${file}` };

  const result = {};
  if (direction === "out" || direction === "all") {
    result.dependsOn = node.imports.filter(i => graph.nodes[i]).map(i => ({
      file: i,
      fingerprint: graph.nodes[i].fingerprint,
      symbols: (graph.nodes[i].symbols || []).slice(0, 15),
    }));
  }
  if (direction === "in" || direction === "all") {
    result.dependedBy = (node.dependents || []).map(f => ({
      file: f,
      fingerprint: graph.nodes[f].fingerprint,
    }));
  }
  return result;
}

/** Транзитивно затронутые файлы */
function getAffected(graph, files) {
  const affected = new Set(files);
  const queue = [...files];

  while (queue.length > 0) {
    const f = queue.shift();
    const node = graph.nodes[f];
    if (!node) continue;
    for (const dep of node.dependents || []) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  return [...affected].map(f => ({
    file: f,
    fingerprint: graph.nodes[f]?.fingerprint,
    symbols: (graph.nodes[f]?.symbols || []).slice(0, 20),
  }));
}

/** Подграф для подзадачи */
function getScope(graph, files) {
  const scopeFiles = new Set(files);
  // Добавляем прямые зависимости
  for (const f of files) {
    const node = graph.nodes[f];
    if (!node) continue;
    for (const imp of node.imports) {
      if (graph.nodes[imp]) scopeFiles.add(imp);
    }
  }

  return [...scopeFiles].map(f => ({
    file: f,
    fingerprint: graph.nodes[f]?.fingerprint,
    symbols: (graph.nodes[f]?.symbols || []).slice(0, 15),
  }));
}

export function registerProjectGraphTools(server, ctx) {
  const { pluginManager, contextCache, tokenBudget } = ctx;
  let currentGraph = null;

  return [
    {
      name: "proj.init",
      description: "Инициализировать граф зависимостей проекта. Сканирует все файлы, строит карту импортов/экспортов. Возвращает сжатый граф.",
      inputSchema: {
        type: "object",
        properties: {
          projectRoot: { type: "string", description: "Корень проекта" },
        },
        required: ["projectRoot"],
      },
      async handler(args) {
        currentGraph = initGraph(args.projectRoot, pluginManager, contextCache);
        const summary = {
          root: currentGraph.root,
          files: currentGraph.fileCount,
          savings: {
            fullTokens: Object.values(currentGraph.nodes).reduce((s, n) => s + (n.tokenEstimate || 0), 0),
            graphTokens: currentGraph.fileCount * 20,
            saved: "~95%",
          },
          topFiles: Object.entries(currentGraph.nodes)
            .sort((a, b) => (b[1].dependents?.length || 0) - (a[1].dependents?.length || 0))
            .slice(0, 10)
            .map(([f, n]) => ({ file: f, dependents: (n.dependents?.length || 0), symbols: (n.symbols?.length || 0) })),
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      },
    },
    {
      name: "proj.deps",
      description: "Показать зависимости файла: от кого зависит и кто зависит от него.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
          direction: { type: "string", enum: ["in", "out", "all"], description: "in=кто зависит от файла, out=от кого зависит файл, all=оба" },
        },
        required: ["file"],
      },
      async handler(args) {
        if (!currentGraph) return { content: [{ type: "text", text: JSON.stringify({ error: "Граф не построен. Вызови proj.init." }) }] };
        const result = getDeps(currentGraph, args.file, args.direction || "all");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    },
    {
      name: "proj.affected",
      description: "Вычислить все файлы, транзитивно затронутые изменениями. Нужно для инкрементального тестирования.",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Изменённые файлы" },
        },
        required: ["files"],
      },
      async handler(args) {
        if (!currentGraph) return { content: [{ type: "text", text: JSON.stringify({ error: "Граф не построен." }) }] };
        const affected = getAffected(currentGraph, args.files);
        return { content: [{ type: "text", text: JSON.stringify({ affected, count: affected.length }, null, 2) }] };
      },
    },
    {
      name: "proj.scope",
      description: "Получить компактный подграф для понимания задачи — только нужные файлы + их зависимости.",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
        },
        required: ["files"],
      },
      async handler(args) {
        if (!currentGraph) return { content: [{ type: "text", text: JSON.stringify({ error: "Граф не построен." }) }] };
        const scope = getScope(currentGraph, args.files);
        return { content: [{ type: "text", text: JSON.stringify({ scope, files: scope.length }, null, 2) }] };
      },
    },
  ];
}
