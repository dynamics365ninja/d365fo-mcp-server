# Architecture

How the server turns a private D365FO codebase into grounded AI context — and keeps generated code honest.

---

## High-level view

```mermaid
graph TB
    subgraph Clients
        VS[VS 2022/2026 + Copilot]
        CC[Claude Code CLI]
    end

    subgraph "MCP Server — Node.js 24, TypeScript"
        TRANSPORT[Transport: stdio / Express HTTP\n+ rate limiting, dedup cache]
        TOOLS[26 tool handlers]
        GATES[Quality gates\n grounding · references · BP · form patterns]
    end

    subgraph "Data sources"
        DB[(Symbols DB\nSQLite FTS5, 580K+ symbols)]
        LDB[(Labels DB\nSQLite FTS5, 20M+ rows, 70 languages)]
        BRIDGE[C# Bridge\nIMetadataProvider + DYNAMICSXREFDB]
    end

    VS & CC -->|JSON-RPC| TRANSPORT --> TOOLS
    TOOLS --> GATES
    TOOLS --> DB & LDB
    TOOLS -->|Windows VM| BRIDGE

    style BRIDGE fill:#512BD4,color:#fff
    style GATES fill:#E65100,color:#fff
```

Three complementary data sources, one rule: **bridge-first when live metadata matters, SQLite everywhere else.**

| Capability | SQLite + FTS5 | XML parser | C# bridge |
|-----------|--------------|------------|-----------|
| Available on | all platforms | all platforms | Windows VM only |
| Symbol search | ✅ < 10 ms | — | ✅ live |
| Method signatures / source | ✅ snapshot | ✅ on demand | ✅ live |
| Cross-references (callers) | ~ FTS approximation | — | ✅ exact (`DYNAMICSXREFDB`) |
| Labels (20M+ rows) | ✅ sole source | — | create/rename only |
| Create / modify objects | — | — | ✅ 18 create types, 25 modify ops |

Full tool-by-tool breakdown: [SQLITE_DEPENDENCY.md](SQLITE_DEPENDENCY.md)

---

## Request flow

```mermaid
sequenceDiagram
    participant IDE as Copilot / Claude
    participant SRV as MCP Server
    participant GATE as Gates
    participant SRC as Bridge / SQLite

    IDE->>SRV: tools/call (JSON-RPC)
    SRV->>SRV: dedup cache + loop detection
    alt read tool
        SRV->>SRC: bridge-first, SQLite fallback
        SRC-->>IDE: result (~10 ms cached)
    else write tool
        SRV->>GATE: grounding token · validate_code(mode="references") · validate_code(mode="syntax") · object_patterns (domain=form, validate)
        alt gates pass
            GATE->>SRC: bridge write (IMetadataProvider)
            SRC->>SRC: invalidate SQLite + bridge state
            SRC-->>IDE: ✅ written + registered in .rnrproj
        else gate fails
            GATE-->>IDE: ⛔ blocked with structured violations + fixes
        end
    end
```

---

## Quality gates — the grounding chain

Generated code must *prove* itself before touching disk. All gates are fail-closed and env-switchable.

| Gate | Tool / mechanism | Blocks when | Switch |
|------|------------------|-------------|--------|
| Provenance | `prepare` (mode=change/create) issues a SHA-256 grounding token (30 min TTL, object-bound) | write called without a valid token | `GROUNDING_ENFORCE` |
| References | `validate_code(mode="references")` — every type, field, method (incl. arity), enum, label checked against the index | any identifier unresolved | `GROUNDING_ENFORCE` |
| Best practices | `validate_code(mode="syntax")` — 13 static rules + data-driven XML rules mined from standard models (`property_stats`) | error-severity violations | — (advisory in output) |
| Form patterns | `object_patterns (domain=form, action=validate)` — rules FP001–FP010 against the curated pattern catalog | structural violations (FP001–FP005, FP007) | `FORM_PATTERN_ENFORCE` |

Supporting reliability mechanisms:

| Mechanism | Purpose |
|-----------|---------|
| Duplicate-call dedup cache (60 s TTL) | identical read calls served from cache, agent told to reuse data |
| Agentic-loop detection | ≥3 identical calls in a 15-call window → corrective hint injected |
| Index staleness detector | `get_workspace_info` warns when workspace files are newer than the index |
| Structured xppc diagnostics | `build_d365fo_project` parses compiler output into actionable items with fix hints |

### Form pattern engine

```mermaid
flowchart LR
    CAT["Curated catalog\n~19 patterns + ~20 sub-patterns\nsrc/knowledge/formPatterns"] --> ADV[object_patterns\ndomain=form, action=analyze]
    CAT --> SPEC[object_patterns\ndomain=form, action=spec]
    CAT --> VAL[object_patterns domain=form, action=validate\nFP001–FP010]
    MINE[("form_patterns table\nmined from real forms\nduring build-database")] --> ADV
    MINE -->|cross-check report| CAT
    ADV --> GEN["generate_smart_form\nclone reference form\n+ re-bind datasources"]
    GEN --> VAL
    VAL -->|gate| WRITE[d365fo_file action=create]
```

The catalog encodes Microsoft's form patterns as data (required containers, ordering, allowed sub-patterns, versions); mining grounds it in the actual environment and reports drift after every index rebuild.

---

## C# Metadata Bridge

A .NET Framework 4.8 process (`D365MetadataBridge.exe`) spawned by the server, speaking JSON-RPC over stdin/stdout. It is the **sole write path** — no XML string manipulation ever touches metadata files.

```mermaid
graph LR
    TS[bridgeClient.ts\nspawn + JSON-RPC + restarts] --> EXE[D365MetadataBridge.exe]
    EXE --> READ[MetadataReadService\nclasses, tables, forms, reports]
    EXE --> WRITE[MetadataWriteService\n18 create types · 25 modify ops]
    EXE --> XREF[CrossReferenceService\nCoC, event handlers, callers]
    READ & WRITE --> PROV[IMetadataProvider / DiskProvider]
    XREF --> SQL[(DYNAMICSXREFDB)]
```

Key implementation points:

- **DiskProvider discovery** — write methods hide behind internal interfaces; the bridge casts to reach `SaveObject()`.
- **ModelSaveInfo** — every write resolves the owning model from its descriptor, so files land in the right model.
- **Auto-invalidation** — after each write: bridge metadata cache + SQLite index are refreshed, so the next read sees the change.
- **Graceful degradation** — bridge missing (Azure/Linux) → read tools fall back to SQLite; `xrefAvailable: false` → xref tools fall back to FTS.

Protocol, error codes and troubleshooting: [BRIDGE.md](BRIDGE.md)

---

## Databases

Dual-database design — symbol searches never scan label rows (**10–30× faster**).

| Database | Content | Size | Key tables |
|----------|---------|------|-----------|
| `xpp-metadata.db` | symbols + analytics | ~2–3 GB | `symbols` (+FTS5), `form_datasources`, `form_patterns`, `table_relations`, `edt_metadata`, `security_*`, `menu_item_targets`, `property_stats` |
| `xpp-metadata-labels.db` | labels | ~0.5 GB (4 languages) – 8 GB (all 70) | `labels` (+FTS5 for en-US) |

Each `symbols` row carries enhanced metadata beyond name/type/path: description, semantic tags, source snippet, complexity, used types, extends chain, usage statistics — richer context for generation. Statistical tables (`property_stats`, `form_patterns`) power the data-driven validators and advisors.

Read concurrency: WAL mode, read-connection pool with per-connection prepared-statement caches, 256 MB mmap.

---

## Deployment

```mermaid
graph LR
    subgraph "Developer VM (Windows)"
        LOCAL["Local server\nfull or write-only mode\n+ C# bridge"]
    end
    subgraph Azure
        APP["App Service\nread-only mode"]
        BLOB[("Blob Storage\npre-built databases")]
    end
    DEVOPS[Azure DevOps pipelines\nextract → build → upload] --> BLOB
    BLOB -->|startup download| APP
    IDE[Copilot / Claude] -->|search| APP
    IDE -->|writes| LOCAL
```

| Mode | `MCP_SERVER_MODE` | Tools exposed | Typical host |
|------|-------------------|---------------|--------------|
| Full | `full` (default) | all 26 | developer VM |
| Read-only | `read-only` | search/analysis | Azure App Service |
| Write-only | `write-only` | file ops + bridge reads | hybrid local companion |

Index refresh is automated via [Azure DevOps pipelines](PIPELINES.md); the App Service downloads updated databases from Blob Storage on restart.

---

## Performance & security

| Aspect | Implementation |
|--------|----------------|
| Search latency | FTS5 < 10 ms; active invalidation on writes |
| Rate limits | `/mcp` 500 req / 15 min · `/health` 1000 req / 15 min |
| Auth (HTTP) | API key / Bearer middleware; HTTPS + TLS 1.2+; Managed Identity for Blob access |
| Path safety | every write target validated against `PackagesLocalDirectory/<Package>/<Model>/Ax<Type>/` containment (no traversal) |
| Error format | JSON-RPC errors with structured `data.detail`; network retries ×3; DB fallbacks logged |

## Technology stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 24, TypeScript 6 (strict) |
| Transport | MCP SDK — stdio + Express 5 HTTP |
| Storage | better-sqlite3 (WAL, FTS5) |
| Bridge | .NET Framework 4.8, Microsoft.Dynamics.AX.Metadata DLLs |
| Tests | Vitest — 850+ tests, golden quality-gate suites |
| CI/CD | GitHub Actions (app), Azure DevOps (metadata pipelines) |
