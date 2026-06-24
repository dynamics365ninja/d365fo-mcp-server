# Testing

The project uses [Vitest](https://vitest.dev/). 1100+ tests run without a live D365FO environment — all external dependencies (SQLite, filesystem, bridge, cache) are mocked.

## Running tests

```bash
npm test -- --run                       # all tests once
npm test                                # watch mode
npm test -- --coverage                  # with coverage → coverage/
npm test tests/tools/discovery.test.ts  # single file
npm run test:integration                # tool routing end-to-end via the real dispatcher
npx tsx tests/bridge-e2e.ts             # manual bridge E2E (Windows D365FO VM only)
```

## Test structure

| Directory | Covers |
|-----------|--------|
| `tests/tools/` | MCP tool handlers by functional area (file ops, discovery, labels, security, grounding, advisor, …) |
| `tests/utils/` | utilities: config manager, templates, cloner, dedup, provenance, staleness, tool inventory |
| `tests/golden/` | **quality-gate suites** — lock the grounding chain (`quality-gate.test.ts`) and the form-pattern write gate (`form-pattern-gate.test.ts`): correct artifacts must pass, hallucinated/violating variants must be rejected before any write |
| `tests/knowledge/` | form pattern catalog integrity (unique names, resolving references, version ordering) |
| `tests/validation/` | form pattern validator rules FP001–FP010 |
| `tests/metadata/` | XML parser + pattern miner + SQLite indexing against fixture forms |
| `tests/bridge/` | bridge client behavior (debounced refresh); `bridge-e2e.ts` is manual |

Contract tests worth knowing: `tests/utils/toolInventory.test.ts` asserts the published tool count (26) and keeps `mcpServer.ts`, the startup catalog and `LOCAL_TOOLS` in sync — it fails when a new tool is registered incompletely (see [NEW_TOOL_CHECKLIST.md](NEW_TOOL_CHECKLIST.md)).

## Mock strategy

| Dependency | Approach |
|------------|----------|
| `XppSymbolIndex` | `vi.fn()` per method; in-memory `new XppSymbolIndex(':memory:', ':memory:')` where real SQL matters |
| `fs/promises` | module mock at the top of the file — source must use `import * as fs from 'fs/promises'` (namespace import, or the mock is bypassed) |
| `configManager` / `packageResolver` / `modelClassifier` | module mocks returning fixed paths and no-op prefixing |
| Bridge | `context.bridge = undefined` → all `tryBridge*()` return `null`; direct imports mocked via `vi.hoisted()` |
| Cache | `{ get, getFuzzy, set, … }` as `vi.fn()` — note `search` uses `getFuzzy`, not `get` |

Common pitfalls:

```typescript
symbolIndex.getSymbolByName = vi.fn(() => null);   // ✅ null — undefined breaks existence checks
{ kind: 'Method', label: 'find', detail: '...' }   // ✅ completion shape (kind/label, not name/type)
```

## Writing new tests

1. Success **and** error scenarios for every exported tool handler.
2. Mock everything external — no live DB, disk, or network.
3. Fresh `buildContext()` in `beforeEach`.
4. When the behavior guards a write path, add a **golden** case: valid input passes, the broken variant is rejected with the specific rule named.

## CI/CD

GitHub Actions runs the suite on every push and PR to `main`/`develop` (Node 24.x). Targets: 80%+ line coverage on critical paths, 100% on error handling.
