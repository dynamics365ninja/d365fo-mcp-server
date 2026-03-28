# Test Documentation

This project uses [Vitest](https://vitest.dev/) as the testing framework.

## Running Tests

```bash
# Run all tests in watch mode
npm test

# Run tests with coverage
npm test -- --coverage

# Run a specific test file
npm test tests/tools/discovery.test.ts
```

## Test Structure

Tests are organized into the following directories:

- `tests/tools/` - Unit tests for MCP tools, grouped by functional area
- `tests/utils/` - Unit tests for utility functions and configuration

All tests run without a live D365FO environment. External dependencies (SQLite DB,
file system, cache, configManager) are mocked with Vitest's `vi.fn()` / `vi.mock()`.

## Test Suite Overview

**Vitest unit test suites covering tools and utilities**

```
tests/
├── tools/
│   ├── code-generation.test.ts   (30 tests)
│   ├── discovery.test.ts         (17 tests)
│   ├── extensions-security.test.ts (26 tests)
│   ├── file-ops.test.ts          (20 tests)
│   ├── labels.test.ts            (15 tests)
│   ├── local-ops.test.ts
│   ├── object-info.test.ts       (28 tests)
│   └── xpp-knowledge.test.ts
├── utils/
│   ├── configManager.test.ts     (21 tests)
│   ├── forceProject.test.ts
│   ├── operationLocks.test.ts
│   └── toolInventory.test.ts
└── bridge-e2e.ts                 (manual E2E — npx tsx tests/bridge-e2e.ts)
```

> **Bridge E2E test:** `tests/bridge-e2e.ts` is a manual end-to-end test that exercises the
> C# bridge child process. It requires a Windows D365FO VM with `IMetadataProvider` DLLs
> available and is NOT included in `npm test`. Run it with `npx tsx tests/bridge-e2e.ts`.

---

## Test File Reference

### `tests/tools/code-generation.test.ts`

Covers all AI-driven and template-based code generation tools.

| Tool | What is tested |
|------|---------------|
| `generate_code` | Class, runnable, SysOperation, table-extension, event-handler, security-privilege templates; missing-name error; invalid-pattern error |
| `code_completion` | Completions with correct `kind`/`label` shape; empty-result when class has no members; missing-className error |
| `generate_d365fo_xml` | Class, table, enum XML generation; missing-objectType error |
| `generate_smart_table` | Field hint parsing; primary key index from `primaryKeyFields` |
| `generate_smart_form` | Form XML from a table datasource |
| `suggest_edt` | EDT suggestion for a known field name; obscure field name (always returns JSON) |
| `analyze_code_patterns` | Pattern analysis result with exampleClasses; missing-scenario error |
| `suggest_method_implementation` | Implementation suggestions; missing required fields error |
| `analyze_class_completeness` | Completeness report; missing-className error |
| `get_api_usage_patterns` | API usage patterns; missing-apiName error |
| `get_table_patterns` | Table group analysis using `tableGroup: 'Main'` (mock DB returns empty, output still contains "Patterns" heading) |
| `get_form_patterns` | Form patterns from `tableName` parameter |

**Key mock requirements:**
- `symbolIndex.getCompletions` must return `{ kind: 'Method'|'Field', label: string, detail?: string }` objects (not `name`/`type`)
- `symbolIndex.getSymbolByName` must return `null` (not `undefined`) when a symbol is not found, to avoid `undefined !== null` being `true` in existence checks
- `generate_smart_table` requires `fieldsHint` to be non-empty; omitting it triggers the BLOCKED guard and returns `isError: true`

---

### `tests/tools/discovery.test.ts`

Covers symbol search and reference lookup tools.

| Tool | What is tested |
|------|---------------|
| `search` | Formatted results; empty result message; objectType filter; missing-query error; limit parameter; cache hit (uses `cache.getFuzzy`) |
| `batch_search` | Multiple queries with combined results; >10 queries rejected; empty queries rejected; `globalTypeFilter` applied |
| `search_extensions` | Extension matches from custom models; no-results message; missing-query error; prefix filter |
| `find_references` | References found in DB; no-references message; missing-symbolName error |

**Key note:** The `search` tool uses `cache.getFuzzy()`, not `cache.get()`. The context mock must include `getFuzzy`.

---

### `tests/tools/extensions-security.test.ts`

Covers Chain-of-Command extensions, event handlers, and security tooling.

| Tool | What is tested |
|------|---------------|
| `find_coc_extensions` | CoC class found; no extension found; missing-className error |
| `find_event_handlers` | Handlers returned; no handlers found; missing-targetName error |
| `get_table_extension_info` | Extension fields/methods; not found; missing-extensionName error |
| `get_security_artifact_info` | Security privilege/duty/role info; not found; missing-name error |
| `get_security_coverage_for_object` | Objects with security coverage; objects without coverage; missing-objectName error |
| `analyze_extension_points` | Extension points for a class; missing-className error |
| `get_menu_item_info` | Display/action/output menu item info; not found; type filter |
| `get_data_entity_info` | Data entity fields/methods; not found; missing-entityName error |

---

### `tests/tools/file-ops.test.ts`

Covers file creation, modification, naming validation, and project verification.

**Module mocks:**
- `fs/promises` — `readFile`, `writeFile`, `mkdir`, `access`, `stat`, `readdir` are all mocked (no actual disk I/O)
- `../../src/utils/configManager` — returns fixed paths for `packagePath`, `modelName`, `projectPath`, etc.
- `../../src/utils/packageResolver` — resolves any model name to a fixed `K:\PackagesLocalDirectory` root
- `../../src/utils/modelClassifier` — `resolveObjectPrefix` returns `''`, `applyObjectPrefix` is a no-op

| Tool | What is tested |
|------|---------------|
| `validate_object_naming` | Valid class name passes; 82-char name fails; 75-char name warns; table-extension name; name collision detected; missing objectType/proposedName errors; all supported objectType values |
| `verify_d365fo_project` | Object found on disk and in `.rnrproj`; missing object reported; multiple objects at once; missing-objects array error |
| `create_d365fo_file` | Class file creation; table-extension; custom `xmlContent` (hybrid); missing objectType/objectName errors (throws) |
| `modify_d365fo_file` | Method added to existing class XML; missing required args error; file-not-found error |

**Key note:** `modifyD365File.ts` must import fs as `import * as fs from 'fs/promises'` (namespace import). The `import { promises as fs } from 'fs'` style is **not** intercepted by `vi.mock('fs/promises', ...)`.

---

### `tests/tools/labels.test.ts`

Covers label search, retrieval, creation, and renaming.

**Module mock:** `fs` is mocked with `{ promises: { readFile, writeFile, readdir, ... } }`.

| Tool | What is tested |
|------|---------------|
| `search_labels` | Results from symbolIndex; no-results message; missing-query error |
| `get_label_info` | Label details from `.label.txt`; not found; missing-labelId error |
| `create_label` | Label created with `createLabelFileIfMissing: true, updateIndex: false` (readdir mock returns `[]`); missing-labelId error |
| `rename_label` | Dry-run rename (mocks `readdir → ['en-US']` and `readFile → BOM+label text`); missing-labelId error |

**Key note for `create_label`:** Because `readdir` returns `[]`, `existingLanguages` is empty. Without `createLabelFileIfMissing: true`, the tool returns an early error. Tests must set this flag explicitly.

**Key note for `rename_label`:** The test must override the `readdir` and `readFile` mocks before calling the tool so that the rename logic finds the label.

---

### `tests/tools/object-info.test.ts`

Covers all "get info" lookup tools for D365FO object types.

| Tool | What is tested |
|------|---------------|
| `get_class_info` | Class found with methods; not found; missing-className error |
| `get_table_info` | Table found with fields; not found; missing-tableName error |
| `get_method_signature` | Signature extracted; method not found; missing parameter errors |
| `get_form_info` | Form with datasources and controls; not found; missing-formName error |
| `get_query_info` | Query with datasources; not found; missing-queryName error |
| `get_view_info` | View with fields; not found; missing-viewName error |
| `get_enum_info` | Enum with values; not found; missing-enumName error |
| `get_edt_info` | EDT with base type; not found; missing-edtName error |
| `get_report_info` | Report not on disk (not-found message); unknown report; missing-reportName error |

---

### `tests/utils/configManager.test.ts`

Covers configuration manager path parsing, model resolution, and runtime context updates.

| Scenario | What is tested |
|----------|---------------|
| One-level workspacePath | `PackagesLocalDirectory\ModelName` → `modelName` = last segment; `packagePath` extracted correctly |
| Two-level workspacePath | `PackagesLocalDirectory\PackageName\ModelName` → second-to-last as package, last as model; forward-slash paths; case-insensitive `PackagesLocalDirectory` match |
| Explicit `packagePath` | Overrides any workspacePath-extracted value |
| Explicit `modelName` | Overrides workspacePath last-segment extraction |
| No `workspacePath` | Returns `null` for both model and package |
| `setRuntimeContext` | Runtime workspacePath takes priority over file context; merges runtime and file contexts |
| UDE context | `customPackagesPath` / `microsoftPackagesPath` returned correctly |
| Kebab-case path rejection | Kebab-format paths are rejected with a clear error |

**Key fix:** `getModelNameFromWorkspacePath()` uses `replace(/\\/g, '/').split('/').pop()` instead of `path.basename(path.normalize())` to correctly handle Windows-style backslash paths on macOS/Linux hosts.

---

## Writing New Tests

When adding new functionality:

1. Create unit tests for individual functions/tools in the appropriate `tests/tools/*.test.ts` file
2. Mock all external dependencies — no live DB, disk, or network access
3. Test both success and error scenarios
4. Test edge cases (empty inputs, null values, missing required args)
5. Ensure each `describe` block has an independent `buildContext()` call in `beforeEach`

### Mock Shape Guidelines

```typescript
// Correct completion shape (formatCompletions filters by .kind, renders .label)
{ kind: 'Method', label: 'CustTable_find', detail: 'CustTable find()' }

// Correct "not found" return (undefined !== null is true — causes false positives)
symbolIndex.getSymbolByName = vi.fn(() => null);  // ✅ null, NOT undefined

// Correct fs mock for file-ops tests
vi.mock('fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), ... }));
// Combined with import in source:
import * as fs from 'fs/promises';  // ✅ namespace import
```

---

## CI/CD Integration

Tests run automatically in GitHub Actions on:
- Every push to `main` and `develop` branches
- Pull requests to `main` and `develop` branches
- Matrix testing on Node.js 24.x

---

## Mock Strategy

| Dependency | Mock approach |
|------------|--------------|
| `XppSymbolIndex` | `vi.fn()` on individual methods (`searchSymbols`, `getSymbolByName`, `getCompletions`, `analyzeCodePatterns`, etc.) |
| `fs/promises` | `vi.mock('fs/promises', ...)` module mock at top of file |
| `configManager` | `vi.mock('../../src/utils/configManager', ...)` returning fixed paths |
| `packageResolver` | `vi.mock('../../src/utils/packageResolver', ...)` returning fixed `K:\PackagesLocalDirectory` |
| `modelClassifier` | `vi.mock('../../src/utils/modelClassifier', ...)` with no-op prefix application |
| `BridgeClient` | `context.bridge` set to `undefined` in `buildContext()` — bridge is absent, all `tryBridge*()` calls return `null` instantly. For tools that import bridge functions directly, tests use `vi.hoisted()` to create bridge mocks that are hoisted above `vi.mock()` calls, ensuring consistent behavior. |
| Cache | `{ get, getFuzzy, set, generateSearchKey, generateExtensionSearchKey }` as `vi.fn()` |
| Parser / WorkspaceScanner | Empty object `{} as any` when not exercised by the test |

Mocks reset automatically between test files. Use `beforeEach` with a fresh `buildContext()` call to reset per-test state.

### Index Lifecycle Testing

The stale-index fix (update_symbol_index + undo_last_modification) is verified via the
existing mock infrastructure:

- **update_symbol_index** — tests confirm that when a file does not exist on disk, stale
  symbol and label entries are removed from SQLite and Redis cache is invalidated
- **undo_last_modification** — tests verify that after reverting a tracked file or deleting
  an untracked file, the `cleanupIndexAfterUndo()` helper removes stale entries and
  triggers re-indexing for reverts
- **Bridge refresh** — `bridgeRefreshProvider()` is called after every index cleanup to
  ensure the C# bridge reflects the current state

---

## Coverage Requirements

Aim for:
- **80%+ line coverage** for critical paths
- **100% coverage** for error handling
- **All exported tool handler functions** should have at least one passing and one error test

```bash
npm test -- --coverage
```

Coverage reports are generated in `coverage/` directory.
