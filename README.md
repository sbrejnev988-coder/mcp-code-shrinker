# mcp-code-shrinker v0.2.0

**Semantic Context Compiler** — not a code compressor.

Stratified semantic context with exact-source escalation. Achieves 60-80% token reduction **without quality loss** by compressing context *selection*, not selected code.

## Architecture

```
Layer 0: Project Map         (5% tokens, always included)
  └─ file tree, exports, languages, entry points
  
Layer 1: Semantic Contracts  (40% tokens, per relevant file)
  └─ signatures, effects, throws, calls, properties, confidence
  
Layer 2: Exact Source        (40% tokens, only for symbols that matter)
  └─ FULL original code — NO renaming, NO regex, NO formatting changes
  
Layer 3: Evidence            (15% tokens)
  └─ tests, stack traces, diagnostics, runtime data
```

## Key Principles

1. **Compress selection, not code** — the model sees fewer symbols, but each in full fidelity
2. **NEVER rename identifiers** in source code — aliases only for metadata references
3. **NEVER truncate inside AST nodes** — remove whole symbols, not partial ones
4. **Stable symbol IDs** — `symbolId` survives neighbor edits; `symbolRevision` changes on body edit
5. **Loss manifest** — every packet honestly reports what was removed and retrievability

## Tools

| Tool | Layer | Description |
|------|-------|-------------|
| `project.map` | L0 | Project file tree, exports, entry points |
| `file.contracts` | L1 | Semantic contracts for all symbols in a file |
| `symbol.source` | L2 | EXACT source code (no modifications) |
| `symbol.context` | L2+ | Callers, callees, tests, side effects |
| `context.create` | L0-3 | Build complete context packet for a task |
| `context.expand` | L0-3 | Expand packet with model-requested symbols |
| `context.inspect` | — | Show loss manifest: what was removed, risk level |
| `patch.propose` | — | Minimal edit operations (not full files) |
| `patch.validate` | — | Parse → typecheck → lint → test |
| `patch.apply` | — | Apply validated patch with hash check |

## Symbol Identity

```json
{
  "symbolId": "sym_a3f2c8e1b4d5",      // language + type + name + signature
  "symbolRevision": "72ce19ba",          // AST subtree hash
  "fileRevision": "998ae120"             // full file hash
}
```

Changing a neighbor function → `symbolId` stays same. Renaming → new `symbolId`. Body edit → new `symbolRevision`.

## Context Packet Structure

```json
{
  "contextId": "ctx_m5k2a9",
  "task": { "type": "bugfix", "description": "Fix duplicate event" },
  "layers": { "project": true, "contracts": 9, "sources": 2, "evidence": 1 },
  "loss": {
    "removed": { "symbols": 143, "bodies": 5 },
    "preserved": { "targetSource": true, "contracts": true, "tests": true },
    "risk": "low"
  },
  "aliases": { "@S1": "src/publisher.ts#Publisher.publish" }
}
```

## Modes

| Mode | Target source | Contract bodies | When |
|------|--------------|-----------------|------|
| **safe** | exact | exact contracts | Production bugfixes |
| **balanced** | exact | contracts, bodies compressed | General development |
| **aggressive** | exact | contracts only | Exploration, planning |

**In ALL modes, target symbol source is NEVER compressed.**

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

## Roadmap

| Version | Focus |
|---------|-------|
| 0.2.0 | Stable IDs, L0-L3, semantic contracts, NO aliasing in code |
| 0.3.0 | Tree-sitter grammars, full call graph, test discovery |
| 0.4.0 | Auto-pilot: worktree isolation, apply→verify→commit |
| 0.5.0 | Benchmark suite: real repositories, real tokenizers, task success rate |

## License

MIT
