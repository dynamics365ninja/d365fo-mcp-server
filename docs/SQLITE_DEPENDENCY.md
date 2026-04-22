# SQLite Dependency Analysis

> **Why the pre-indexed SQLite databases cannot be replaced by the C# metadata bridge.**

This document maps every MCP tool to its data-source usage and explains why SQLite remains an essential component of the architecture even after the C# bridge migration.

---

## Architecture — Two Complementary Data Sources

| Data Source | What It Provides | Platform |
|-------------|-----------------|----------|
| **SQLite** — symbols DB | Hundreds of thousands of pre-indexed symbols with FTS5 full-text search, `edt_metadata`, `extension_metadata`, `menu_item_targets`, `security_*` hierarchy tables, `source_snippet` column | Cross-platform (Azure/Linux + Windows) |
| **SQLite** — labels DB | Tens of millions of label entries across 70 languages with FTS search | Cross-platform |
| **C# Bridge** — IMetadataProvider | Live reads of individual D365FO objects (class, table, form, EDT, enum, …) | Windows-only (.NET 4.8) |
| **C# Bridge** — DYNAMICSXREFDB | Compiler-resolved cross-references: `Names`, `References`, `Modules` tables | Windows-only (SQL Server) |

The bridge excels at **reading a single object with full fidelity** and **compiler-resolved caller/callee relationships**. SQLite excels at **bulk search, aggregation, pattern mining, and cross-platform availability**.

---

## Tool Inventory by Category

### A) Bridge-first, SQLite Fallback (16 tools)

These tools try the bridge first. SQLite activates only when the bridge is unavailable (Azure/Linux) or as a fast guard/enrichment layer.

| Tool | Bridge Call | SQLite Fallback Role |
|------|-----------|---------------------|
| `search` | `tryBridgeSearch` | FTS5 on `symbols_fts` — full-text symbol search |
| `classInfo` | `tryBridgeClass` | **Compact mode** (default) deliberately SQLite-only — signatures without IPC overhead |
| `tableInfo` | `tryBridgeTable` | Full fallback via `getReadDb` |
| `edtInfo` | `tryBridgeEdt` | **Hierarchy mode**: `edt_metadata` chain walk (parent → children → field usages) |
| `completion` | `tryBridgeCompletion` | Guard check ("is this a table?") + full fallback |
| `findReferences` | `tryBridgeReferences` | FTS5 `source_snippet` MATCH for code-context snippets around call sites |
| `analyzeExtensionPoints` | Bridge enrichment | `extension_metadata` + `symbols_fts` SubscribesTo for event handler discovery |
| `findCocExtensions` | `tryBridgeCocExtensions` | `extension_metadata` pre-parsed `coc_methods` JSON |
| `findEventHandlers` | `tryBridgeEventHandlers` | `symbols_fts` MATCH SubscribesTo for handler method discovery |
| `apiUsagePatterns` | `tryBridgeApiUsageCallers` | Aggregation across source snippets for frequency/pattern analysis |
| `securityArtifactInfo` | `tryBridgeSecurityArtifact` | `security_*` tables — role → duty → privilege chain walk |
| `menuItemInfo` | `tryBridgeMenuItem` | `menu_item_targets` + full security privilege chain lookup |
| `tableExtensionInfo` | `tryBridgeTableExtensions` | `extension_metadata` (fields, CoC methods, events) |
| `methodSignature` | Bridge primary | SQLite as **gate** — verify class+method exist before expensive bridge IPC |
| `getMethodSource` | Bridge primary | "Did you mean?" fuzzy suggestions on error path |
| `reportInfo` | `tryBridgeReport` | "Did you mean?" suggestions when report not found |

### B) SQLite-only: Labels (4 tools)

The bridge has **zero** label support — `IMetadataProvider` does not expose `.label.txt` file contents, and DYNAMICSXREFDB has no label data.

| Tool | SQLite APIs | Purpose |
|------|------------|---------|
| `searchLabels` | FTS on `labels` table (19M+ entries) | Full-text search across 70 languages |
| `getLabelInfo` | `getLabelFileIds`, `getLabelById` | Read label content by ID or file |
| `createLabel` | `searchLabels` (dedup check) + `bulkAddLabels` | Duplicate detection + index sync after write |
| `renameLabel` | `renameLabelInIndex` | Index update after file-level rename |

### C) SQLite-only: FTS5 / Source Analysis (5 tools)

These tools rely on FTS5 full-text search across the `source_snippet` column. The bridge reads individual objects — it has no bulk text search.

| Tool | FTS5 Query | Why Bridge Can't Replace |
|------|-----------|------------------------|
| `findReferences` (fallback) | MATCH on symbol name across all method bodies | DYNAMICSXREFDB doesn't cover all reference types (field access, type-reference in declarations) |
| `findCocExtensions` (fallback) | MATCH `SubscribesTo` | Attribute-based subscriptions require text search |
| `findEventHandlers` (fallback) | MATCH `SubscribesTo` | EventHandler attributes are not indexed in xref DB |
| `analyzeExtensionPoints` | MATCH `SubscribesTo` delegates | Discover who already subscribes to a given event |
| `extensionSearch` | FTS + non-Microsoft model filter | Bulk fuzzy search across ISV/custom code only |

### D) SQLite-only: Pattern / Statistical Queries (11 tools)

These tools query across hundreds to thousands of objects with GROUP BY, COUNT, and pattern matching. The bridge reads one object at a time — aggregation would require O(N) IPC calls.

| Tool | Aggregation Type | Typical Scale |
|------|-----------------|---------------|
| `analyzePatterns` | Scan `source_snippet` for pattern types, method frequencies | Thousands of classes |
| `analyzeCompleteness` | Compare class methods vs. similar classes | Hundreds of same-type classes |
| `suggestImplementation` | Fuzzy method name matching across all classes | Full symbol index |
| `suggestEdt` | Exact → prefix → keyword → context on `edt_metadata` | Thousands of EDTs |
| `getTablePatterns` | GROUP BY / COUNT on tables of same TableGroup | Hundreds of tables |
| `getFormPatterns` | GROUP BY on forms of same pattern | Hundreds of forms |
| `generateSmartTable` | EDT resolution + auto-FK relations via `edt_metadata` chain walk | `edt_metadata` + symbols |
| `generateSmartForm` | copyFrom structure + auto-grid from table fields | Symbols + form patterns |
| `generateSmartReport` | copyFrom TmpTable + EDT → .NET type resolution | `edt_metadata` chain walk |
| `securityCoverageInfo` | 4-table JOIN (role → duty → privilege → entry point) | `security_*` hierarchy |
| `validateObjectNaming` | Collision check LIKE/exact across all symbols | Full symbol index |

### E) SQLite for File Resolution in Write Operations (1 tool)

| Tool | SQLite Usage | Why Bridge Can't Replace |
|------|-------------|------------------------|
| `modifyD365File` | `file_path` column maps object name → absolute disk path | Bridge resolves objects by name internally but does not expose file paths. File path is needed to locate the XML before editing it. |

### F) Tools with No SQLite Dependency

These tools are fully bridge-based, template-based, or standalone:

`enumInfo` · `queryInfo` · `viewInfo` · `formInfo` · `dataEntityInfo` · `generateCode` · `generateD365foXml` · `createD365foFile` · `getD365foErrorHelp` · `recommendExtensionStrategy` · `getXppKnowledge` · `batchSearch` (delegates to `search`) · `buildD365foProject` · `triggerDbSync` · `runBpCheck` · `runSystestClass` · `verifyD365foProject` · `reviewWorkspaceChanges`

---

## Summary — Three Irreplaceable Roles of SQLite

### 1. Cross-Platform Fallback (Azure / Linux)

The C# bridge requires Windows + .NET Framework 4.8 + D365FO runtime binaries installed locally. On Azure/Linux deployments the bridge is physically unavailable. SQLite is the **only** data source in that environment — without it, all 16 bridge-first tools and all pattern/analysis tools would return nothing.

### 2. Bulk Analytical Engine

DYNAMICSXREFDB contains three tables: `Names`, `References`, `Modules`. It stores compiler-resolved caller/callee pairs — nothing else. It has:

- **No source code** — cannot show code context around a call site
- **No labels** — labels are flat `.label.txt` files, not metadata objects
- **No EDT inheritance trees** — cannot walk base type → children → field usages
- **No security hierarchy** — no role → duty → privilege → entry point chain
- **No form/table pattern statistics** — no "what do Main tables typically look like?"

SQLite fills all of these gaps with pre-indexed, pre-aggregated data optimized for analytical queries.

### 3. Sole Source for 19M+ Labels

The labels database contains tens of millions of entries across 70 languages. `IMetadataProvider` has no API for reading or searching label files. Every label operation — search, read, create, rename — goes exclusively through SQLite. There is no alternative data path.

---

## Could SQLite Be Eliminated in Theory?

| Approach | Feasibility | Cost |
|----------|-------------|------|
| Add FTS to DYNAMICSXREFDB | ❌ Microsoft-owned DB, read-only schema | Would require custom SQL Server full-text index + schema changes to a production database |
| Add label API to bridge | ⚠️ Possible but laborious | Requires parsing all `.label.txt` files (19M entries) in C#, plus building search/CRUD — essentially reimplementing `labelsDb.ts` |
| Add aggregation endpoints to bridge | ⚠️ Possible for individual queries | Each analytical query (pattern mining, EDT chain walk, security hierarchy) would need a dedicated C# endpoint — dozens of new endpoints, each doing what one SQL query does today |
| Enumerate all objects via bridge for aggregation | ❌ Prohibitively slow | Reading the full symbol set one-by-one via IPC to compute a GROUP BY would take minutes vs. milliseconds in SQLite |
| Drop Azure/Linux support | ❌ Violates product requirements | The MCP server must work in read-only Azure deployments where no D365FO runtime exists |

**Conclusion:** SQLite and the C# bridge are complementary by design. The bridge provides **live, authoritative, single-object reads** and **compiler-resolved cross-references**. SQLite provides **bulk search, aggregation, cross-platform availability, and label management**. Neither can fully replace the other.
