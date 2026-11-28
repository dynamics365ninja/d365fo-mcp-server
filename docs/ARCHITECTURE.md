<sub>[README](../README.md) › [Docs](README.md) › Architecture</sub>

# 🏛️ Architecture

How the server turns a private D365FO codebase into grounded AI context — and keeps generated code
honest.

**On this page:** [High-level view](#high-level-view) · [Request flow](#request-flow) ·
[Quality gates](#quality-gates--the-grounding-chain) · [C# bridge](#c-metadata-bridge) ·
[Databases](#databases) · [Eval loop](#self-improving-eval-loop) · [Deployment](#deployment) ·
[Performance & security](#performance--security) · [Stack](#technology-stack)

---

## High-level view

<p align="center">
  <img src="img/architecture.svg" alt="Architecture: the AI agent calls the d365fo-mcp server over MCP; reads are served from SQLite symbol and label indexes, writes pass four grounding gates and go through the C# metadata bridge into the D365FO development VM, whose metadata is indexed at build time." width="100%"/>
</p>

The same picture as a component graph:

```mermaid
flowchart TB
    subgraph clients["Clients"]
        direction LR
        VSC["VS Code<br/>Copilot · Claude Code"]
        VS["Visual Studio 2026<br/>Copilot"]
        CC["Claude Code<br/>CLI · desktop"]
    end

    subgraph server["MCP server — Node.js 24 · TypeScript"]
        TRANSPORT["Transport<br/>stdio · Express HTTP<br/>rate limiting · dedup cache"]
        TOOLS["22 tool handlers"]
        GATES["Quality gates<br/>grounding · references · BP · form patterns"]
    end

    subgraph data["Data sources"]
        DB[("Symbols DB<br/>SQLite FTS5 · 580K+ symbols")]
        LDB[("Labels DB<br/>SQLite FTS5 · 20M+ rows · 70 languages")]
        BRIDGE["C# bridge<br/>IMetadataProvider + DYNAMICSXREFDB"]
    end

    clients -- "JSON-RPC" --> TRANSPORT --> TOOLS
    TOOLS --> GATES
    TOOLS --> DB & LDB
    TOOLS -- "Windows VM" --> BRIDGE

    classDef bridge fill:#6639ba,stroke:#6639ba,color:#ffffff
    classDef gate fill:#bc4c00,stroke:#bc4c00,color:#ffffff
    class BRIDGE bridge
    class GATES gate
```

Three complementary data sources, one rule: **bridge-first when live metadata matters, SQLite
everywhere else.**

| Capability | SQLite + FTS5 | XML parser | C# bridge |
|---|---|---|---|
| Available on | all platforms | all platforms | Windows VM only |
| Symbol search | ✅ < 10 ms | — | ✅ live |
| Method signatures / source | ✅ snapshot | ✅ on demand | ✅ live |
| Cross-references (callers) | ~ FTS approximation, or exact from a SQLite export of `DYNAMICSXREFDB` (`D365FO_XREF_SQLITE_PATH`) | — | ✅ exact (`DYNAMICSXREFDB`) |
| Labels (20M+ rows) | ✅ sole source | — | create/rename only |
| Create / modify objects | validated XML writers for types the provider cannot express | — | ✅ 13 create types, 27 modify ops |

> [!NOTE]
> SQLite stays essential even with the bridge: it is the **only** data source on Azure/Linux (no
> bridge), the sole store for 20M+ labels (`IMetadataProvider` has no label API), and the engine for
> all bulk search, aggregation and pattern mining (the bridge reads one object at a time).

---

## Request flow

```mermaid
sequenceDiagram
    autonumber
    participant IDE as Copilot / Claude
    participant SRV as MCP server
    participant GATE as Gates
    participant SRC as Bridge / SQLite

    IDE->>SRV: tools/call (JSON-RPC)
    SRV->>SRV: dedup cache + loop detection
    alt read tool
        SRV->>SRC: bridge-first, SQLite fallback
        SRC-->>IDE: result (~10 ms cached)
    else write tool
        SRV->>GATE: grounding token · references · BP rules · form patterns
        alt gates pass
            GATE->>SRC: bridge write (IMetadataProvider) or validated XML writer
            SRC->>SRC: invalidate SQLite + bridge state
            SRC-->>IDE: ✅ written + registered in .rnrproj
        else gate fails
            GATE-->>IDE: ⛔ blocked with structured violations + fixes
        end
    end
```

---

## Quality gates — the grounding chain

Generated code must *prove* itself before touching disk. All gates are fail-closed and
env-switchable.

```mermaid
flowchart LR
    gen["Generated code"] --> g1{"<b>Provenance</b><br/>grounding token"}
    g1 -- ok --> g2{"<b>References</b><br/>every identifier proven"}
    g2 -- ok --> g3{"<b>Best practices</b><br/>error-severity rules"}
    g3 -- ok --> g4{"<b>Form patterns</b><br/>forms only"}
    g4 -- ok --> w["✅ write"]
    g1 & g2 & g3 & g4 -- fail --> x["⛔ blocked<br/>structured fixes"]

    classDef gate fill:#bc4c00,stroke:#bc4c00,color:#ffffff
    classDef ok fill:#1a7f37,stroke:#1a7f37,color:#ffffff
    classDef bad fill:#cf222e,stroke:#cf222e,color:#ffffff
    class g1,g2,g3,g4 gate
    class w ok
    class x bad
```

| Gate | Tool / mechanism | Blocks when | Switch |
|---|---|---|---|
| Provenance | `prepare` (mode=change/create) issues a grounding token (30 min TTL, object-bound). In-memory by default; with `GROUNDING_SECRET` set on both instances the token is HMAC-signed and portable, so the hybrid write-only companion (and scaled-out App Service) can validate it — without the secret, write-only mode bypasses enforcement | write called without a valid token | `GROUNDING_ENFORCE` + `GROUNDING_SECRET` |
| References | `validate_code(mode="references")` — every type, field, method (incl. arity), enum, label checked against the index | any identifier unresolved | `GROUNDING_ENFORCE` |
| Best practices | `validate_code(mode="syntax")` — **57 rules**: 53 static (ATTR001–003, BP001–006, COC001–006, CS001, DOC001, EXT001, FN001/002, INT001, KW001, MAC001, OP001, RPT001/002/101–103, SEL001–011, SET001, TST001–003, TTS001–003, XML001/006–010) + 4 data-driven (XML002–005) mined from standard models (`property_stats`). FN001/FN002/KW001/ATTR001/SEL010 read the captured compiler tables (`src/knowledge/compilerFacts.ts`) rather than a hand-kept list; the `reserved-words` knowledge topic is generated from the same table | error-severity violations | — (advisory in output) |
| Form patterns | `object_patterns (domain=form, action=validate)` — rules FP000–FP011 against the platform pattern definitions (generated from the Patterns DLL) | what the compiler rejects (FP001–FP005, FP007, FP011) | `FORM_PATTERN_ENFORCE` |

> [!IMPORTANT]
> `GROUNDING_ENFORCE` is **off** by default — the provenance and reference gates advise until you
> turn it on. `FORM_PATTERN_ENFORCE` is on by default. See [CONFIGURATION.md](CONFIGURATION.md).

Supporting reliability mechanisms:

| Mechanism | Purpose |
|---|---|
| Duplicate-call dedup cache (60 s TTL) | identical read calls served from cache, agent told to reuse data |
| Agentic-loop detection | ≥3 identical calls in a 15-call window → corrective hint injected |
| Index staleness detector | `get_workspace_info` warns when workspace files are newer than the index |
| Structured xppc diagnostics | `build_d365fo_project` parses compiler output into actionable items with fix hints |
| Extension name formats | optional `EXTENSION_*_NAME_FORMAT*` settings: one resolver (`resolveFormattedExtensionName`, `src/utils/objectNaming.ts`) names extensions for create, the modify lookup, `prepare`, `generate_object` and the cross-model suggestion, and `validate_object_naming` checks against the same formats. The base type comes from the call (`[ExtensionOf(<kind>Str)]`, a stated type), never from the index, so the write-only companion and the read-only server name alike |

### Form pattern engine

```mermaid
flowchart LR
    CAT["<b>Curated catalog</b><br/>patterns + sub-patterns<br/><code>src/knowledge/formPatterns</code>"]
    MINE[("<b>form_patterns</b> table<br/>mined from real forms<br/>during build-database")]
    ADV["<b>object_patterns</b><br/>analyze"]
    SPEC["<b>object_patterns</b><br/>spec"]
    GEN["<b>generate_object</b><br/>clone reference form<br/>+ re-bind datasources"]
    VAL{"<b>object_patterns</b><br/>validate · FP000–FP011"}
    WRITE["<b>d365fo_file</b><br/>create"]

    CAT --> ADV & SPEC & VAL
    MINE --> ADV
    MINE -. "cross-check report" .-> CAT
    ADV --> GEN --> VAL
    VAL -- "gate" --> WRITE

    classDef gate fill:#bc4c00,stroke:#bc4c00,color:#ffffff
    class VAL gate
```

The catalog encodes Microsoft's form patterns as data (required containers, ordering, allowed
sub-patterns, versions); mining grounds it in the actual environment and reports drift after every
index rebuild.

---

## C# Metadata Bridge

A .NET Framework 4.8 process (`D365MetadataBridge.exe`) spawned by the server, speaking JSON-RPC
over stdin/stdout. It is the **primary write path**: whenever `IMetadataProvider` can express the
object, the bridge writes it and no string manipulation touches the XML.

It is not the *only* write path. Two cases fall through to purpose-built XML writers, and both are
deliberate:

- **Object types outside `BRIDGE_CREATE_TYPES`** (13 of the 39 create types route to the bridge).
  `security-privilege`/`duty`/`role` and `query`/`view` are excluded on purpose — the bridge's
  generic `properties: Dictionary<string,string>` channel cannot carry the structured collections
  they need (EntryPoints, Privileges, Duties, query data sources), so a bridge create would
  "succeed" and produce a functionally broken object. `securityPrivilegeXml.ts`, `queryViewXml.ts`
  and friends build these correctly instead.
- **Modify operations with no backing C# op** — `add-delete-action`, `remove-delete-action`,
  `modify-property` on some types, `add-menu-item-to-menu`, `add-control`, `add-index`,
  `add-query-range`/`remove-query-range` and the data-entity-extension field writer fall back to the
  `directXml*` helpers in `src/tools/write/directXmlWriters.ts` (see also
  `dataEntityViewExtensionXml.ts`; `add-menu-item-to-menu` on a `menu-extension`, or into a submenu
  of a `menu`, and `add-submenu` go there directly, through `src/tools/xml/menuExtensionXml.ts` and
  `menuXml.ts`; `move-control` and `wrap-controls` on a `form` through
  `src/tools/xml/formRestructure.ts`).

> [!NOTE]
> The distinction matters for correctness, not for safety: **every write goes through the same
> grounding gates and the same path-containment check**, whichever writer commits it. The XML
> writers are structured builders with ambiguity guards (they refuse to guess when a target tag
> matches more than once), not blind string replacement.

```mermaid
flowchart LR
    TS["<b>bridgeClient.ts</b><br/>spawn · JSON-RPC · restarts"] --> EXE["<b>D365MetadataBridge.exe</b>"]
    TS -. "types the provider<br/>cannot express" .-> XMLW["<b>XML writers</b><br/>securityPrivilegeXml · queryViewXml<br/>directXml fallbacks"]
    EXE --> READ["<b>MetadataReadService</b><br/>classes · tables · forms · reports"]
    EXE --> WRITE["<b>MetadataWriteService</b><br/>13 create types · 27 modify ops"]
    EXE --> XREF["<b>CrossReferenceService</b><br/>CoC · event handlers · callers"]
    READ & WRITE --> PROV["IMetadataProvider<br/>DiskProvider"]
    XREF --> SQL[("DYNAMICSXREFDB")]

    classDef bridge fill:#6639ba,stroke:#6639ba,color:#ffffff
    class EXE bridge
```

Key implementation points:

- **DiskProvider discovery** — write methods hide behind internal interfaces; the bridge casts to
  reach `SaveObject()`.
- **ModelSaveInfo** — every write resolves the owning model from its descriptor, so files land in
  the right model.
- **Auto-invalidation** — after each write: bridge metadata cache + SQLite index are refreshed, so
  the next read sees the change.
- **Graceful degradation** — bridge missing (Azure/Linux) → read tools fall back to SQLite;
  `xrefAvailable: false` → xref tools read the SQLite export of `DYNAMICSXREFDB` named by
  `D365FO_XREF_SQLITE_PATH` when one is configured and valid (`src/xref/`: the bridge's four queries
  ported, bounded, opened read-only and immutable), else fall back to FTS. Not in `write-only` mode:
  the companion has no index to search, so `find_references` there answers from the
  cross-reference database only and points to the shared server's `find_references` otherwise.

### Bridge protocol & resilience

Newline-delimited JSON-RPC over stdin/stdout. Read calls that time out or hit a dead pipe are
retried after a health-checked respawn (`BRIDGE_MAX_RETRIES`, `BRIDGE_MAX_RESTARTS`).

> [!WARNING]
> **Write calls are never retried** — a timed-out write may already have applied.

On startup the child sends `{"id":"ready", result:{ metadataAvailable, xrefAvailable }}`.

| Error code | Meaning |
|---|---|
| `-32601` / `-32602` | unknown method / invalid params |
| `-32000` / `-32001` | service not available / object not found |
| `-32603` | internal error |

**Troubleshooting:**

| Symptom | Cause and fix |
|---|---|
| `metadataAvailable: false` | D365FO not deployed to the package path, or a DLL version mismatch (check bridge stderr) |
| `xrefAvailable: false` | non-critical, xref falls back to FTS — SQL Server / `DYNAMICSXREFDB` unreachable; on UDE the server reads `CrossReferencesDbServerName`/`CrossReferencesDatabaseName` from the XPP config automatically |
| Build fails on UDE | the DLL path is needed: `dotnet build -c Release -p:D365BinPath="<FrameworkDirectory>\bin"` |
| You edited bridge sources | build with `npm run bridge:build` instead, so `bridge/build-attestation.json` is refreshed — see [SETUP.md § Changing bridge sources](SETUP.md#changing-bridge-sources--use-npm-run-bridgebuild) |

---

## Databases

Dual-database design — symbol searches never scan label rows (**10–30× faster**).

| Database | Content | Size | Key tables |
|---|---|---|---|
| `xpp-metadata.db` | symbols + analytics | ~2–3 GB | `symbols` (+FTS5), `form_datasources`, `form_patterns`, `object_source`, `table_relations`, `edt_metadata`, `security_*`, `menu_item_targets`, `property_stats` |
| `xpp-metadata-labels.db` | labels | ~0.5 GB (4 languages) – 8 GB (all 70) | `labels` (+FTS5 for en-US) |

Each `symbols` row carries enhanced metadata beyond name/type/path: description, semantic tags,
source snippet, complexity, used types, extends chain, usage statistics — richer context for
generation. Statistical tables (`property_stats`, `form_patterns`) power the data-driven validators
and advisors.

`property_stats` is a corpus of **Microsoft-authored models only** — it answers "what does the
standard platform do", so mining our own or a third-party ISV's objects would feed our own habits
back to us as platform convention. The gate is `XppSymbolIndex.isMineableModel()`, fed by the
extract manifest (the only source of truth on UDE, where `CUSTOM_MODELS` is empty by design) plus
the name-based `isStandardModel()`. Counts are cumulative, so `build-database` also purges rows that
fail today's gate; `npm run purge-property-stats [-- --dry-run]` does the same to an existing
database without a rebuild.

Reads: WAL mode, one read-only connection beside the writer (it reads the last committed snapshot
while the writer has a transaction open) with a 128 MB page cache and its own prepared-statement
cache, 1 GiB mmap. `READ_POOL_SIZE` opens more connections and splits the cache between them.

---

## Self-improving eval loop

The gates above say whether a *single* write is grounded. The eval loop answers the larger question
— is the server getting better at producing X++ that compiles, is BP-clean, and matches the
intended metadata shape? Full spec: [AGENT_EVAL_LOOP.md](AGENT_EVAL_LOOP.md).

```mermaid
flowchart LR
    IMPL["<b>Implementer agent</b><br/>on the VM — full mode + bridge<br/>grounded MCP tools only"] -- "run records" --> CORP[("<b>Corpus</b><br/>one NDJSON record per run<br/>held-out split")]
    CORP -- "clustered failures" --> IMPV["<b>Improver agent</b><br/>in the repo — reproduce as a<br/>minimal test → fix → validate"]
    IMPV -- "pull request,<br/>humans merge" --> SRV["<b>mcp-server</b><br/>tools · knowledge · validators"]
    SRV -. "next run tests the fix" .-> IMPL
```

Two agents, one shared store, **no shared in-memory state** — either can run on its own cadence.
The split is deliberate: the VM has the platform and the compiler, the repo is where TypeScript
edits, golden tests and CI belong. Mixing them couples slow platform builds to fast unit-test
iteration.

| Element | What it is |
|---|---|
| Case catalog | ~130 cases in `eval/cases/`, tiered L0–L4, each with a JSON spec validated against `schema.json` |
| Primary oracle | **golden metadata** — a diff of produced XML against the case's captured golden, not merely "it compiled" |
| Runtime oracle | `run_systest_class` against `eval/systests/<id>.xml` — a SysTest references only standard objects, so it fails when a CoC wrapper is missing or wrong, which a golden cannot detect |
| Fixtures | shared INPUT objects (e.g. `ConDemoNoteHeader`) live in `eval/fixtures/`, re-provisioned per run and excluded from rollback — case OUTPUTS are never pre-provisioned |
| Isolation | every run works in a throwaway sandbox model and rolls back, so runs never pollute each other or the index |
| Coverage | a taxonomy leaf counts as covered only when **K**nowledge teaches it, an **E**val case with a captured golden proves it, and the **T**ool path can build it — current numbers in [eval/COVERAGE.md](../eval/COVERAGE.md) |

> [!NOTE]
> The loop is an eval and self-improvement harness, **not** a production code generator and **not**
> auto-merge — the improver opens PRs that humans review.

---

## Deployment

```mermaid
flowchart LR
    subgraph vm["🖥️ Developer VM (Windows)"]
        LOCAL["Local server<br/>full or write-only mode<br/>+ C# bridge"]
    end
    subgraph azure["☁️ Azure"]
        APP["App Service<br/>read-only mode"]
        BLOB[("Blob Storage<br/>pre-built databases")]
    end
    DEVOPS["Azure DevOps pipelines<br/>extract → build → upload"] --> BLOB
    BLOB -- "startup download" --> APP
    IDE(["🤖 Copilot / Claude"]) -- "search" --> APP
    IDE -- "writes" --> LOCAL
```

| Mode | `MCP_SERVER_MODE` | Tools exposed | Typical host |
|---|---|---|---|
| Full | `full` (default) | all 22 | developer VM |
| Read-only | `read-only` | 14 — everything except the eight `LOCAL_TOOLS` (build, BP, tests, SQL, trace, reindex, workspace, verify) | Azure App Service |
| Write-only | `write-only` | up to 12 — the eight `LOCAL_TOOLS` + the four `ALWAYS_TOOLS` (`get_object_info`, `labels`, `d365fo_file`, `find_references`) | hybrid local companion |

In the hybrid deployment only the write-only companion runs the C# bridge, so only it reaches the
developer's cross-reference database (`DYNAMICSXREFDB`); the read-only server answers
`find_references` from its symbol index by name. The companion therefore publishes
`find_references` too, answered from the bridge alone: it has no index, so wherever the shared
server would search by name it says so and points there. Its cross-references are as current as
the developer's last Visual Studio build with cross-references.

A second, independent axis controls how many of those tools are worth advertising.
`MCP_TOOL_PROFILE=core` publishes only the create-and-build loop (17 tools) instead of all 22, with
`MCP_EXTRA_TOOLS` adding individual ones back; `isToolEnabled()` in `serverMode.ts` combines both
axes and is the single predicate used by the ListTools filter, the runtime call gate and the
startup banner. It exists because hosts stop sending the tool catalogue inline past a limit (VS
Code: ~100 tools across all servers) and fall back to a search-based tool surface, which costs a
discovery round trip per tool the model needs.

`axdb_sql` counts toward those totals but is published only once a SQL server is configured and
SQL is enabled. It uses a separate, lazily opened, Windows-authenticated connection to AxDB from
the bridge. See [AXDB_SQL.md](AXDB_SQL.md). `trace_d365fo` likewise counts but is published only
once `trace.enabled` is true; see [TRACE.md](TRACE.md).

Index refresh is automated via [Azure DevOps pipelines](SETUP_AZURE.md#azure-devops-pipelines); the
App Service downloads updated databases from Blob Storage on restart.

---

## Performance & security

| Aspect | Implementation |
|---|---|
| Search latency | FTS5 < 10 ms; active invalidation on writes |
| Rate limits | `/mcp` 500 req / 15 min (`RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS`); `/health` exempt so Azure probes never throttle |
| Auth (HTTP) | API key / Bearer middleware; HTTPS + TLS 1.2+; Blob access via connection string (`AZURE_STORAGE_CONNECTION_STRING`) |
| Path safety | every write target validated against `PackagesLocalDirectory/<Package>/<Model>/Ax<Type>/` containment (no traversal) |
| Error format | JSON-RPC errors with structured `data.detail`; network retries ×3; DB fallbacks logged |

## Technology stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 24, TypeScript 7 (strict) |
| Transport | MCP SDK — stdio + Express 5 HTTP |
| Storage | node:sqlite (WAL, FTS5) — core module, no native addon |
| Bridge | .NET Framework 4.8, Microsoft.Dynamics.AX.Metadata DLLs |
| Tests | Vitest — ~5,450 tests, golden quality-gate suites |
| CI/CD | GitHub Actions — app CI + `eval-gate` (bridge attestation, golden regression, knowledge audit, coverage matrix); Azure DevOps (metadata pipelines) |
