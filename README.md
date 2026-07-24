# MCP Code Shrinker v0.3.11

**Semantic Context Compiler** — stratified L0-L3 context with exact-source escalation, stable symbol IDs, and repository-scoped isolation. MCP server for Hermes Agent.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    CONTEXT LAYERS                            │
│                                                              │
│  L0: Project Map         (5%)   file tree + exports          │
│  L1: Semantic Contracts  (40%)  signatures, effects, throws  │
│  L2: Exact Source        (40%)  NO renaming, NO regex mods   │
│  L3: Evidence            (15%)  tests, stack traces, logs    │
├──────────────────────────────────────────────────────────────┤
│                    SYMBOL MODEL                              │
│                                                              │
│  Stable Symbol ID = f(repository-slot.root, file_path,       │
│                       language, node_type, qualified_name,   │
│                       signature)                             │
│                                                              │
│  → Survives neighbor edits                                   │
│  → NFC-normalized, forward-slash paths                       │
│  → Scoped to repository (different repos = different IDs)    │
├──────────────────────────────────────────────────────────────┤
│                    REPOSITORY ISOLATION                      │
│                                                              │
│  requireRepositoryId(args)         P0 guard                  │
│  requireIndex(repoId)              slot verification         │
│  isInside(slot.root, filePath)     path containment          │
│  resolveInsideRoot(filePath)       canonical path            │
│  canonicalRepoPath(path)           NFC + POSIX slashes       │
│                                                              │
│  → Foreign-repo files: PATH_OUTSIDE_REPOSITORY error         │
│  → watch_stop: preserves repository slot                     │
│  → context.expand: validates implicit targetFile             │
├──────────────────────────────────────────────────────────────┤
│                    PATCH WORKFLOW                            │
│                                                              │
│  patch.propose → patch.validate → patch.apply                │
│                                     │                        │
│                                     ├─ hash re-check         │
│                                     ├─ .bak backup           │
│                                     ├─ repository slot bound │
│                                     └─ outcome → Memory Wiki  │
└──────────────────────────────────────────────────────────────┘
```

## Key Guarantees

### Symbol ID Stability
- **Survives neighbor edits**: adding/removing unrelated symbols does NOT change existing IDs
- **NFC normalization**: Unicode canonical composition for cross-platform consistency
- **Forward-slash paths**: `\` → `/` for POSIX compatibility
- **Repository-scoped**: same code in different repos → different symbol IDs

### Repository Isolation
- **Every tool requires `repository_id`**: `file.contracts`, `symbol.source`, `context.create`, `context.expand`
- **Path containment**: `isInside(slot.root, filePath)` — rejects files outside repository root
- **Slot lifecycle**: `watch_stop` stops watcher but preserves repository binding
- **Canonical paths**: NFC + POSIX slashes + resolved symlinks

### Context Packet Protocol
- **Ranking**: symbols sorted by token count (descending)
- **Quality check**: contracts must pass confidence threshold
- **Coverage manifest**: tracks what symbols are already in context
- **Loss manifest**: reports missing symbols with reasons
- **No double-relative**: prevents duplicate file paths in packets

### Exact-Source Escalation
- Layer 2 returns raw source code with ZERO modifications
- No regex replacement, no renaming, no format changes
- Contract + source separation: model can verify contract accuracy

---

## Tools (12)

### Project Tools

| Tool | Status | Description |
|---|---|---|
| `project.scan` | 🔨 Exp | Build cross-file call graph |
| `project.map` | ✅ | L0: file tree + imports/exports |
| `project.outline` | ✅ | Fingerprints of all files (compressed) |
| `project.deps` | ✅ | Dependency graph (in/out/all) |
| `project.affected` | ✅ | Transitive affected files by change |

### Symbol Tools

| Tool | Required | Status | Description |
|---|---|---|---|
| `file.contracts` | `repository_id`, `file_path` | ✅ | L1: all symbol contracts in file |
| `symbol.source` | `repository_id`, `file_path`, `symbol` | ✅ | L2: EXACT source (never modified) |
| `symbol.context` | `repository_id`, `symbol` | 🔨 Exp | Callers/callees/tests from graph |
| `file.fingerprint` | `file_path` | ✅ | Symbol signatures + hash (no body) |
| `file.symbol` | `file_path`, `symbol_id` | ✅ | Full code of specific symbol |

### Context Tools

| Tool | Description |
|---|---|
| `context.create` | Build L0-L3 packet with coverage manifest |
| `context.expand` | Request missing symbols — validates against slot.root |
| `context.inspect` | Loss manifest + quality check + coverage report |

### Patch Tools

| Tool | Description |
|---|---|
| `patch.propose` | Edit operations — bound to repository slot |
| `patch.validate` | Sandbox: parse → typecheck → lint → test |
| `patch.apply` | Apply with hash re-check + .bak backup |

### Development Tools

| Tool | Description |
|---|---|
| `exec.run` | Sandboxed shell execution (project root only) |
| `exec.test` | Run tests by pattern/file with TAP output |
| `debug.analyze` | Error analysis against file fingerprints |
| `debug.fix` | Auto-fix cycle: analyze → patch → test (3 iterations) |
| `debug.trace` | Runtime trace with temporary instrumentation |
| `task.plan` | Decompose feature into isolated subtasks |
| `task.spawn` | Launch isolated sub-agent for subtask |
| `task.status` | Check subtask status |
| `task.merge` | Merge parallel subtask results |
| `code.generate` | Generate code from spec + dependency symbols |
| `code.refactor` | Refactor specific symbol |
| `code.review` | Review diff against fingerprint |
| `context.compress` | Aggressively compress code for prompt injection |
| `test.gen` | Generate unit tests for symbol |

---

## Installation

```bash
git clone https://github.com/sbrejnev988-coder/mcp-code-shrinker.git
cd mcp-code-shrinker
npm install
npm test
```

### Hermes Integration

The Code Shrinker MCP server is registered in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  code-shrinker:
    command: node
    args: ["src/index.js"]
    cwd: "~/.hermes/workspace/mcp-code-shrinker"
```

---

## Repository-Scope Integration with Memory Wiki

```
Code Shrinker                          Memory Wiki
──────────────                         ───────────
context.create() ──coverage────────►  _pack_context()
  manifest                             │
  ┌─ repository_id                     ├─ _classify_coverage()
  ├─ covered: [{                       │  SHA-256 normalized
  │    kind: "source"|"contract"       │  repository_id match
  │    file_path: NFC-canonical        │  hard-suppress foreign repos
  │    symbol_id: stable hash           │
  │    content_hash: sha256:...        │
  │    token_count                     ├─ suppressed_claim_ids
  │  }]                                │
  └─ loss: [...]                       └─ output → context for LLM
                                          ↓
                                       _memory_diff() — excludes suppressed
                                       _preference_layer() — excludes suppressed
```

### Cross-Plugin Hash Protocol v2
- Both plugins normalize SHA-256: lowercase, strip `sha256:` prefix
- NFC path canonization on both sides
- `repository_id` required on all code claim operations
- `content_hash` used for exact-match deduplication

---

## P0/P1 Forensic Fixes Applied

### P0 (Repository Scope)
- ✅ `file.contracts` requires `repository_id` + slot.root guard
- ✅ `symbol.source` requires `repository_id` + slot.root guard
- ✅ Foreign-repo files rejected: `PATH_OUTSIDE_REPOSITORY`
- ✅ `context.expand` validates implicit targetFile against slot.root
- ✅ `watch_stop` preserves repository slot (does not delete from indexes)
- ✅ `createSymbolId` NFC + forward-slash normalization
- ✅ `canonicalRepoPath` double-relative fix
- ✅ Symbol ID uses `slot.root` not `rootForFile(fp)`

### P1 (Forensic)
- ✅ `patch.propose` stores repository identity/root
- ✅ `patch.validate` bound to repository slot
- ✅ `patch.apply` bound to repository slot
- ✅ MCP annotations: explicit mutation/destruction sets

---

## Path Security Model

```
Allowed Roots (from Hermes config):
  ~/workspace
  ~/plugins
  ~/.hermes/proxy

Symbol resolution:
  slot.root → canonicalRepoPath(root) → isInside(root, filePath)
  
  YES: ~/workspace/project/src/index.js  → resolves
  NO:  /tmp/outside.js                    → PATH_OUTSIDE_REPOSITORY
  NO:  ~/workspace/project/../outside.js  → double-relative blocked
```

---

## Performance

| Operation | Typical Time |
|---|---|
| `file.contracts` (100 symbols) | 50-200ms |
| `symbol.source` | 10-50ms |
| `context.create` (L0-L3) | 200-500ms |
| `patch.validate` (sandbox) | 500-2000ms |
| `project.map` | 100-300ms |
| Symbol ID computation | <1ms |

## License

MIT
