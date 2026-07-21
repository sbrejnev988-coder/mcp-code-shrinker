# Code Shrinker MCP Server

Aggressive token-economy MCP server for AI coding: **-60-80% token reduction** in LLM prompts.

Instead of sending full source code to the LLM, Code Shrinker provides **fingerprints** — compact structural signatures of files. The model requests only the symbols it actually needs via lazy loading.

## Features

| Tool | Description |
|------|-------------|
| `project_outline` | Full project structure as fingerprints (no code loaded) |
| `file_fingerprint` | Per-file signatures: exports, imports, top-level symbols, hash |
| `file_symbol` | Lazy-load a specific function/class by ID from fingerprint |
| `code_generate` | Generate code from spec + dependency symbol IDs |
| `code_review` | Review a diff against file fingerprint (no full code needed) |
| `code_refactor` | Refactor a specific symbol — loads ONLY that symbol's body |
| `context_compress` | Aggressively compress code/text: strip comments, create aliases |
| `debug_analyze` | Analyze error output against fingerprints, produce diagnosis + patch |
| `debug_fix` | Full auto-fix cycle: analyze → patch → test → retry (up to 3 iterations) |
| `debug_trace` | Instrument a function with console.log, run with args, collect runtime data |
| `exec_run` | Run shell command in sandbox, returns stdout/stderr/exit code |
| `exec_test` | Run test suite by pattern, returns TAP report |
| `proj_init` | Initialize project dependency graph |
| `proj_deps` | Show file dependencies (in/out/all) |
| `proj_affected` | Compute transitively affected files from changes |
| `proj_scope` | Compact subgraph for task context |
| `task_plan` | Decompose feature into isolated subtasks |
| `task_spawn` | Spawn autonomous agent for a subtask |
| `task_status` | Check subtask status |
| `task_merge` | Merge parallel subtask results |
| `test_gen` | Generate unit tests for a function by symbolId |

## Plugins (language support)

- **universal.js** — regex-based, works with any language
- **javascript.js** — AST-aware via regex patterns
- **typescript.js** — TS-specific: interfaces, generics, decorators
- **python.js** — decorators, async, type hints, dataclasses

## Architecture

```
┌─────────────┐    fingerprint     ┌──────────┐
│   LLM       │ ◄──────────────── │ MCP      │
│  (model)    │ ──── symbol req ──►│ Server   │
└─────────────┘                   └────┬─────┘
                                       │
                          ┌────────────┼────────────┐
                          │            │            │
                     Plugin Mgr   Context Cache  Token Budget
                          │
              ┌───────────┼───────────┐
              │           │           │
          universal     js/ts        python
```

## Install

```bash
git clone https://github.com/sbrejnev988-coder/mcp-code-shrinker.git
cd mcp-code-shrinker
npm install
```

## Hermes Config

```yaml
mcp_servers:
  code-shrinker:
    enabled: true
    command: node
    args:
      - /path/to/mcp-code-shrinker/src/index.js
    timeout: 120
    connect_timeout: 30
```

## Token Savings

| Scenario | Without Shrinker | With Shrinker | Savings |
|----------|-----------------|---------------|---------|
| Multi-file project (50 files) | ~120K tokens | ~25K tokens | **79%** |
| Single file review | ~8K tokens | ~1.5K tokens | **81%** |
| Error debugging (10 files) | ~45K tokens | ~12K tokens | **73%** |
| Code generation from deps | ~30K tokens | ~8K tokens | **73%** |

## License

MIT
