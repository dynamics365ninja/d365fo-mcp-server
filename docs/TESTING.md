# Testing

The project uses [Vitest](https://vitest.dev/). ~2,900 tests across ~220 files run without a live D365FO environment — all external dependencies (SQLite, filesystem, bridge, cache) are mocked.

## Running tests

```bash
npm run test:run                        # all tests once
npm test                                # watch mode
npm run test:coverage                   # with coverage + thresholds → coverage/
npm test tests/tools/discovery.test.ts  # single file
npm run test:integration                # tool routing end-to-end via the real dispatcher
npm run typecheck                       # tsc --noEmit (src/ only — see below)
npm run lint                            # Biome; the only automated check tests/ and scripts/ get
npx tsx tests/bridge-e2e.ts             # manual bridge E2E (Windows D365FO VM only)
```

## Test structure

| Directory | Covers |
|-----------|--------|
| `tests/tools/` | MCP tool handlers by functional area (file ops, discovery, labels, security, grounding, advisor, …) |
| `tests/utils/` | utilities: config manager, templates, cloner, dedup, provenance, staleness, tool inventory |
| `tests/golden/` | **quality-gate suites** — lock the grounding chain (`quality-gate.test.ts`) and the form-pattern write gate (`form-pattern-gate.test.ts`): correct artifacts must pass, hallucinated/violating variants must be rejected before any write |
| `tests/knowledge/` | two gates on the form-pattern catalog (unique names, resolving references, version ordering) **and three on `KNOWLEDGE_BASE`**: `entryIntegrity` (entry shape, `related:` ids resolve), `exampleValidation` (every example passes `validate_code`), `apiSymbols` (every named AOT type resolves against a VM-captured snapshot). See [KNOWLEDGE_AUTHORING.md](KNOWLEDGE_AUTHORING.md) |
| `tests/validation/` | form pattern validator rules FP001–FP010 |
| `tests/metadata/` | XML parser + pattern miner + SQLite indexing against fixture forms |
| `tests/bridge/` | bridge client behavior (debounced refresh); `bridge-e2e.ts` is manual |

Contract tests worth knowing: `tests/utils/toolInventory.test.ts` asserts the published tool count (25 on `main` at the time of writing — branches consolidating tools change it) and keeps `src/server/toolSchemas/`, the startup catalog and `LOCAL_TOOLS` in sync; it also fails when guidance text names a tool retired by a consolidation. See [NEW_TOOL_CHECKLIST.md](NEW_TOOL_CHECKLIST.md). `tests/utils/toolSchemaBudget.test.ts` pins the serialized `tools/list` payload size — that payload ships on every request.

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

Two workflows, both on push to `main` and PRs targeting `main` (Node 24.x). There is
no `develop` trigger, and neither workflow can compile the C# bridge — it references
`Microsoft.Dynamics.AX.Metadata` assemblies that exist only on a D365FO dev machine.

| Workflow | Jobs |
|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) | `typecheck` (`tsc --noEmit`), `lint` (Biome + the generated-docs check), `coverage` (full suite under v8 with enforced thresholds), `integration` (the VM-free `*.integration.test.ts` tier) |
| [`eval-gate.yml`](../.github/workflows/eval-gate.yml) | bridge-source attestation, full suite, knowledge-audit snapshot verify, eval coverage matrix |

Two gaps worth knowing about, because a green check does not mean what it looks like:

- **`tsconfig.json` `include` is `src/**/*`.** `tests/` and `scripts/` are never
  type-checked. `npm run lint` is the only automated check those ~250 files get.
- **The CodeQL `Analyze (csharp)` check compiles nothing.** It comes from GitHub's
  CodeQL *default setup* (a repository setting, not a file in this repo) and runs
  with `build-mode: none`, so it contributes a green check for C# that has analysed
  no C#. The bridge's real gate is `scripts/bridgeAttest.mjs`, which fails when
  `bridge/` changes without a re-attested build.

### Coverage

`npm run test:coverage` enforces the thresholds in `vitest.config.ts`. They are a
**ratchet**, set a couple of points under the measured value (62.12% statements /
52.92% branches / 67.59% functions / 63.77% lines) so ordinary churn stays green
while a real regression does not. Raise them when coverage rises; never lower them
to make a build green.
