# mcp-code-shrinker v0.3.4

**Semantic Context Compiler** — stratified L0-L3 context with exact-source escalation.

| Status | Feature |
|--------|---------|
| ✅ Implemented | L0 Project Map, L1 Contracts, L2 Exact Source, L3 Evidence |
| ✅ Implemented | Stable symbol IDs (survive neighbor edits) |
| ✅ Implemented | Symbol revision tracking (body changes → new revision) |
| ✅ Implemented | Context packets with ranking + quality check |
| ✅ Implemented | Patch workflow: propose → validate (sandbox) → apply |
| ✅ Implemented | Path security (MCP roots) |
| ✅ Implemented | Loss manifest + confidence scores |
| 🔨 Experimental | Cross-file call graph (relative imports; package imports planned) |
| 🔨 Experimental | Patch sandbox with project copy (node_modules skipped) |
| 🔨 Experimental | TypeScript typecheck integration (tsc must be installed) |
| 📋 Planned | tree-sitter grammars (regex parser used currently) |
| 📋 Planned | Quality benchmark suite |
| 📋 Planned | Git worktree isolation for patches |

## Architecture

```
Layer 0: Project Map         (5%)
Layer 1: Semantic Contracts  (40%)  signatures, effects, throws, confidence
Layer 2: Exact Source        (40%)  NO renaming, NO regex, NO format changes
Layer 3: Evidence            (15%)  tests, stack traces, diagnostics
```

## Tools (11)

| Tool | Status | Description |
|------|--------|-------------|
| `project.scan` | 🔨 Exp | Build cross-file call graph |
| `project.map` | ✅ | L0: file tree + exports |
| `file.contracts` | ✅ | L1: all symbol contracts |
| `symbol.source` | ✅ | L2: EXACT source (never modified) |
| `symbol.context` | 🔨 Exp | Callers/callees/tests from graph |
| `context.create` | ✅ | Build L0-L3 packet |
| `context.expand` | ✅ | Model requests missing symbols |
| `context.inspect` | ✅ | Loss manifest + quality check |
| `patch.propose` | ✅ | Edit operations |
| `patch.validate` | ✅ | Sandbox: parse→typecheck→lint→test |
| `patch.apply` | ✅ | Apply with hash re-check + .bak |

## Install

```bash
git clone https://github.com/sbrejnev988-coder/mcp-code-shrinker.git
cd mcp-code-shrinker && npm install && npm test
```

## License

MIT
