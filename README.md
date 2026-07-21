# mcp-code-shrinker v0.3.0

**Semantic Context Compiler** — stratifies context into L0-L3 layers with exact-source escalation. Achieves 60-80% token reduction by compressing context **selection**, not selected code.

## What's New in v0.3

- **Cross-file call graph** — `project.scan` builds full dependency graph with import resolution
- **Real patch validation** — hash check → sandbox → parse → typecheck → lint → affected tests
- **Callers/callees/tests** — `symbol.context` returns actual call-graph data
- **Benchmark suite** — measures token savings against real codebases
- **AST-atomic removal** — removes whole symbols, never truncates mid-node

## Architecture

```
Layer 0: Project Map         (5%)
Layer 1: Semantic Contracts  (40%)  signatures, effects, throws, calls, confidence
Layer 2: Exact Source        (40%)  NO renaming, NO regex, NO format changes
Layer 3: Evidence            (15%)  tests, stack traces, diagnostics
```

## Tools (12)

| Tool | Description |
|------|-------------|
| `project.scan` | Build cross-file call graph + test index |
| `project.map` | L0: file tree, exports, entry points |
| `file.contracts` | L1: all symbol contracts in a file |
| `symbol.source` | L2: EXACT source — never modified |
| `symbol.context` | Callers, callees, tests (needs scan) |
| `context.create` | Build L0-L3 packet for a task |
| `context.expand` | Model requests missing context |
| `context.inspect` | Loss manifest: removed, risk, retrievable |
| `patch.propose` | Minimal edit operations |
| `patch.validate` | Parse → typecheck → lint → test |
| `patch.apply` | Apply validated patch with hash check |

## Quick Start

```bash
git clone https://github.com/sbrejnev988-coder/mcp-code-shrinker.git
cd mcp-code-shrinker && npm install
```

### Hermes config
```yaml
mcp_servers:
  code-shrinker:
    enabled: true
    command: node
    args: [path/to/src/index.js]
    timeout: 120
```

### Typical workflow
```
1. project.scan          → build call graph
2. context.create        → build packet for task
3. [LLM analyzes packet]
4. context.expand        → model requests more
5. [LLM proposes edits]
6. patch.validate        → verify in sandbox
7. patch.apply           → commit to file
```

## License

MIT
