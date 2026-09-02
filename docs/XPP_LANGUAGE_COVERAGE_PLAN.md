# X++ language coverage plan — v4 (PLAN ONLY, 2026-09-02)

**Status:** plan, not started. Nothing in this document has been implemented.
**Execution:** on the D365FO VM (xppc 7.0.7996.33, sandbox model `fm-mcp`, prefix `Con`), because every
new claim below is gated by an oracle that only exists there (`oracle:members`, `oracle:census`,
`oracle:probe`, `oracle:sweep`, `SysTestConsole.exe`). Repo-only work is marked **[repo]**, VM-bound
work **[VM]**.
**Lifecycle:** same rule as v1–v3 — when the last phase ships, delete this file; move every non-goal to
`docs/BACKLOG.md`; the durable record is `CHANGELOG.md`, `eval/COVERAGE.md` and the goldens' READMEs.
Do not keep an executed plan.

---

## 0a. Execution log (this plan is being worked, not just written)

| Phase | State | Commit |
|---|---|---|
| H0 infra & truth | **shipped** | `045f1fa` |
| H1a discoverability + G-25 | **shipped** | `f805775` |
| H1b target kinds + red-phase signal | **shipped** | `168cb9c` |
| H1c ATTR003 + the language fact behind it | **shipped** | `19b4a0f`, `98e23a6` |
| H1 live verification of the loop | **shipped** | `cea4aa5` |
| H1 remainder (G-06, G-13, cases §5.5) | not started | — |
| H2-H6 | not started | — |

**What execution has already corrected in this plan** — recorded here because a plan
that quietly absorbs its own errors teaches nothing:

1. **`XDSServiceBase` does not exist** (H0). §3.L named it; the real class is
   `SysSecXDSServices`. A name written from memory, caught by the members oracle
   before it reached a knowledge entry.
2. **`FormRun` is an AOT class, not kernel** (H0) — 209 methods, readable with
   `oracle:members`. But `executeQuery` is not on it, because `FormDataSource` IS
   kernel, so G-14 is two jobs with two oracles and the plan drew the line in the
   wrong place.
3. **The sweep already covers the test and ATL packages** (H0). §7.3 claimed it did
   not; `walkAot` filters by AOT type, never by package. Measured baseline: 4,319
   files, zero error-severity findings.
4. **`testTargetType` was invisible** (H1b). It shipped in 1.16.0 as the selector for
   the table shape and was missing from the `pattern` mode's op-spec `optional`
   list — and since these parameters are deliberately off the wire schema, the
   op-spec is the only place they are documented.
5. **`expectRed` could not ship as designed** (H1b). §5.4 proposed it as an
   op-spec-level parameter at "zero schema bytes", but `run_systest_class` has no
   `params` wrapper, so a strict MCP client would drop it — an instruction the
   caller cannot follow. The runner derives the signal instead, from the session
   ledger and the scaffold's own failure text.
6. **A new validator rule the gap list did not contain** (H1c): ATTR003. See §7.3.
7. **The red-phase warning was specified wrong** (live run). §5.4 asked for "all green on a class
   created this session" to be a warning. Driving the real loop on the VM showed that is exactly what
   the GREEN half of red→green looks like, so it fired on the developer who had just done the right
   thing. The runner now remembers which classes it has seen fail. **The unit tests could not find
   this** — they asserted the behaviour the plan specified, and the plan was wrong.

**The live verification, because H1 is not provable from unit tests.** Driven end to end against the
real `SysTestConsole` on 2026-09-02, three phases, sandbox restored afterwards:

| phase | outcome | note |
|---|---|---|
| scaffold verbatim | FAIL ×2, "is not implemented yet" | 🔴 Red phase confirmed. 2 of 2 |
| assertion written, behaviour wrong | FAIL, "Expected: 30; Actual: 0" | (silent) |
| behaviour implemented | PASS | (silent — it follows a red) |

The middle phase is the one that earns its place: a note firing on every red run would be useless, so
it has to tell "you have not written the assertion" from "the assertion is telling you something".

## 0. TL;DR

v3 closed the artifact taxonomy at 100 % (109/109 leaves, 120 cases, 0 pending). That number is honest at
the granularity it measures — one leaf per artifact kind or framework — and blind one level below it.
This round measured the level below: a **construct-level map** of X++ and the reporting stack
(15 axes, ~1,800 terms), probed against every knowledge entry, validator rule, op-spec, generator
template and eval golden in the repo, then cross-checked against real demand (1,603 MCP calls in 47
Copilot sessions) and against the AOT on this VM.

What it found, in order of weight:

| Finding | Evidence | Consequence |
|---|---|---|
| **The TDD loop exists and nobody uses it.** `prepare(mode="test")` 0 calls, `run_systest_class` 0 calls, `generate_object` 5 calls in 1,603. `prepare(change|create)` never mention a test. | demand mining §2.3; `prepareChange.ts`/`prepareCreate.ts` grep | The loop must become **proactive** (offered inside the calls people already make) and must cover the targets people actually write — today it resolves only classes and tables. §5 |
| **Testing knowledge is the thinnest axis**: 120 of 178 test/TDD terms have no knowledge hit; the framework ships 150+ `SysTest*` classes, 4,545 ATL classes in 9 packages and 6,492 form adaptors, and the base names ~25 of them. Two entries (`testing`, `unit-testing`) overlap and disagree on the naming convention wording. | §2.2 axis N; AOT listing §2.4 | Consolidate + write the test-data (ATL), attribute/dependency, and per-target test-shape knowledge. §5.6 |
| **Reporting is the second-thinnest**: 147 of 266 terms unmatched. No knowledge of the AxReport metadata anatomy, parameter properties (`AllowBlank` appears 172× in goldens, 0× in knowledge), TempDB `setConnection`, `SrsReportRunUtil`/permissions/validators/drill-through, RDL layout & formatting functions; and still **no `d365fo_file` operation can touch an AxReport**. | §2.2 axis M; `d365foFileOpSpecs.ts`; BACKLOG "AxReport write operations" | §6 |
| **Runtime API catalogs are missing** for the three objects every developer writes against: the table buffer (`xRecord`/`Common` — 36 of 121 terms unmatched, `tableDataMethods.ts` lists 8 methods), the form runtime (75 of 164 — no control-class catalog, no FormRun/FormDataSource method table), the data entity lifecycle (44 of 114 — `persistEntity`, `initializeEntityDataSource`, `PrimaryCompanyContext`, OData attributes). | §2.2 axes I, J, K | Three catalog entries, each fed by `oracle:members` and reused by `prepare(mode="test")` target resolution. §7 |
| Language core is **fine at the rule level and thin at the reference level**: escapes/hex/`[n,m]` arrays/static fields/bitwise table/13 macro directives have no line anywhere. All low-demand; all one-table additions to existing entries. | axes A–F | §7.1, extend — do not add entries |

Guard rails inherited from v1–v3 and kept: **no new tools** (20 pinned), **no ListTools bytes** unless paid
for by a measured trim in the same change (headroom today: 45,000 − 44,951 = **49 chars**), **no AST**
(lexer-only rules, zero error-severity findings on the full-install sweep), **every API name verified by
an oracle before it enters knowledge**, **every scaffold compiled with a negative control before it
ships**, and every rejection in `docs/BACKLOG.md` stays rejected unless a probe contradicts the probe
that dropped it.

---

## 1. Why v4, and what "fully covered" means now

`eval/COVERAGE.md` answers "is there at least one knowledge entry, one captured golden and one write path
for *SSRS report*?" — yes. It cannot answer "does the server know that a TempDB temp table in a
non-pre-processed DP must be bound to the report's user connection, and would it catch the omission?" —
no, and that is the kind of question a developer asks a copilot.

**Definition for v4.** A construct is covered when, for the flags that apply to it:

- **K** — a knowledge entry names it *and states its failure mode* (not merely lists it);
- **V** — where the omission is decidable from text, a validator rule catches it (advisory or error,
  error only if the sweep bar holds);
- **T** — the tool path can produce or modify the artifact that carries it (scaffold, op, or op-spec param);
- **E** — an eval case with a captured golden exercises it;
- **R** — where correctness is a run-time property, a SysTest asserts it (the runtime oracle).

Not every construct needs every flag. A macro directive needs K only; a report parameter needs K+V+T+E;
a `validateWrite` CoC needs all five. The map in §3 states which flags apply per row.

**The taxonomy is not replaced.** §8 adds leaves under it so the headline number keeps meaning what it
meant, and falls honestly while the new cases are `golden_pending`.

---

## 2. Method — what was measured (2026-09-02)

### 2.1 Inventories (all read from the current tree, `main` @ `caf9d8b`)

| Source | Count | Where |
|---|---|---|
| Knowledge entries | **90** (63 name an auditable AOT reference; 27 name none) | `src/tools/knowledge/xppKnowledge.ts` |
| Validator rules | **50** (27 error, 23 warning; no `info` severity exists) | `src/tools/analysis/validateXpp.ts` |
| Form-pattern rules | FP000–FP010 | `src/validation/formPatternValidator.ts` |
| Naming rules | 22 checks | `src/utils/objectNamingRules.ts` |
| `generate_object` patterns | 32 buildable / 26 published | `src/tools/smart/codeGen.ts`, `patternEnumParity.test.ts` |
| `d365fo_file` create types / modify ops | 40 / 38 | `src/tools/specs/d365foFileOpSpecs.ts` |
| Report recipes / form patterns / mobile recipes | 10 / 36 + 30 sub / 7 | `src/knowledge/*Patterns` |
| Compiler facts | 115 keywords, 80 intrinsics, 170 predefined functions with arity | `eval/compiler-facts.snapshot.json` (2026-08-30) |
| Kernel enums / table data methods / BP monikers | 19 / 8 / 577 | `src/knowledge/*` |
| Eval cases / goldens / corpus runs | 120 / 120 / 182 | `eval/` |
| Taxonomy leaves | 109 (65 core) | `src/eval/coverage/taxonomy.ts` |

Two stale statements found on the way, fix in H0: `docs/ARCHITECTURE.md:89` says "40 static rules + 4
data-driven" (it is 50); five v3 taxonomy `note` fields still say "no case yet" for leaves whose case was
captured 2026-08-31 (`lookups`, `global-statics`, `system-objects`, `rdl-expressions`, `report-destinations`).

### 2.2 The construct probe

A term list of the X++ language reference structure plus the reporting and testing stacks (15 axes,
**1,165 constructs** — including generic words on purpose, so that a zero is unambiguous) is matched,
whole-word and case-insensitively, against four source groups: **K** = knowledge + op-specs + prepare +
prompts (63 files), **V** = validators + lexer (20 files), **T** = generators + writers + XML + metadata
(64 files), **E** = case specs + goldens + systests (457 files).

**Shipped in H0** as `scripts/oracles/termMap.ts` (the vocabulary) + `scripts/oracles/termProbe.ts` (the
matcher), run with `npm run oracle:terms` — `--axis M`, `--core`, `--json`. It needs no D365FO install;
the sources are this repo. The v3 harness was lost by living only in a scratchpad, which is the mistake
this commit exists to not repeat.

| Axis | Terms | K=0 | K≤2 | K>0, E=0 | Reading |
| --- | ---: | ---: | ---: | ---: | --- |
| A. Lexical & literals | 17 | 7 | 4 | 4 | reference-level holes (escapes, hex, `@` strings, guid/int64 literals) |
| B. Types & declarations | 27 | 5 | 3 | 4 | static fields, `[n,m]` arrays, `anytype` params, `byref` |
| C. Operators | 25 | 2 | 3 | 8 | bitwise table, container destructuring |
| D. Statements & flow | 33 | 2 | 8 | 6 | `ttsLevel`, `Uncheck::`, `Exception::Deadlock`, `flush` thin |
| E. Select & data statements | 79 | 11 | 24 | 29 | xRecord buffer API (`data()`, `setTmp`, `setConnection`, `wasCached`, `fieldState`), `avg`, `QueryFetchMode`, multi-select |
| F. Macros | 21 | 13 | 5 | 2 | 13 directives never named; census says most are unused |
| G. Functions | 145 | **0** | 73 | 82 | fully covered by the captured compiler tables + FN001/FN002 — see the note below |
| H. Classes & OOP | 75 | 19 | 16 | 20 | CoC target-kind table, `ExportMetadata`, `Dict*` completeness |
| I. Tables & data model | 92 | 31 | 17 | 18 | **table method catalog** (`exist`, `checkExist`, `aosValidate*`, `postLoad`, `defaultField`, `renamePrimaryKey`, …), relation/index property semantics |
| J. Forms & UI | 111 | **56** | 16 | 12 | **form runtime catalog** (FormRun/FormDataSource/FormControl methods, 25 control classes, menu-item properties, Dialog API) |
| K. Data entities & integration | 85 | 33 | 16 | 18 | **entity lifecycle catalog**, OData attributes, the three deferred packs (mail, file write, HTTP/JSON) |
| L. Frameworks | 145 | 45 | 31 | 32 | workflow event-handler interfaces, `NumberSeqScope`, dimension storage, notifications; the rest is domain breadth (§10 non-goals) |
| M. Reporting | 136 | **63** | 36 | 16 | see §6 |
| N. Testing & TDD | 119 | **48** | 41 | 52 | see §5 — and note the 52: more testing constructs are *named but unproven* than in any other axis |
| O. BP & lifecycle | 55 | 20 | 7 | 13 | label runtime API, CAS permissions, index design; most of the rest is ALM (non-goal) |

**Axis G is the calibration row, and it is why a zero is a candidate and not a verdict.** The first,
scratchpad version of this probe reported ten predefined functions as untaught. All ten were false: the
terms carried a call paren (`abs(`) while `compilerFacts.generated.ts` stores them as `abs: { min: 1,
max: 1 }`. The committed map uses bare names, axis G now reads 0, and the header of `termMap.ts` records
the three ways a zero lies so the next reader does not re-learn it. The committed map is also smaller
than the scratchpad one (1,165 terms, not ~1,800) because duplicates and near-synonyms were merged — a
term counted twice inflates both the total and the gap count.

### 2.3 Demand (47 Copilot sessions, 1,603 MCP calls — same population as v3 + 10 calls)

`get_object_info` 352 · `labels` 308 · `get_knowledge` 250 (≈200 op-spec; **≈35 of the ≈50 real knowledge
asks are the table `validateWrite` CoC contract** in different words) · `d365fo_file` 195 · `search` 92 ·
`prepare` 88 (54 change, 34 create, **0 test**) · `build` 51 · `verify` 43 · `run_bp_check` 43 · …
`generate_object` **5** · `run_systest_class` **0** · `find_references` 5.

Writes: `create enum` 33 · `create class-extension` 25 · `modify table-extension add-field+add-field-to-field-group` 24 ·
`create form-extension` 21 · `modify form-extension add-control` 17 · `replace-code` 19.

Reading: the daily loop is extension work on tables/forms/enums/classes; the one X++ *rule* people keep
asking for is the table-method CoC contract; nobody has discovered the test path. This is why §5 puts the
TDD offer inside `prepare(change)` for a table/class-extension target and does not wait for
`prepare(test)` to be found.

### 2.4 AOT existence checks made for this plan (read-only, this VM)

So that the map does not repeat the v3 mistake of naming things that do not exist, every unfamiliar name
in §3–§7 was checked against `K:\AosService\PackagesLocalDirectory` by file name (and the plan marks
`<Name>`-verification as an H0 step, since the file name is not authoritative — see
`aot-file-name-casing-vs-name-element`). Legend used below: ✓ found as an AxClass/package today;
⊙ not checked or not found in the packages searched — **must go through `oracle:members` before it is
written into a knowledge entry**; ⊘ known kernel object (no AOT XML by construction — audit allow-list).

- Test packages ✓: `TestEssentials`, `ATLApplicationSuite`, `ATLTestCaseCommon`, `AtlFoundation`, `AtlCoreFinancial`,
  `AtlCostAccounting`, `AtlMaterialhandling`, `AtlPersonnel`, `AtlWarehouseOrders`, `AtlSampleTests`,
  `ATLGlobalizationLTM`, `WHSTests`, `FleetManagementUnitTests`, `CommunityDrivenEngineeringTests`; form adaptors:
  `ApplicationPlatformFormAdaptor`, `ApplicationFoundationFormAdaptor`, `ApplicationSuiteFormAdaptor`,
  `ApplicationWorkspacesFormAdaptor`, `GeneralLedgerFormAdaptor`, `RetailFormAdaptor`, `PublicSectorFormAdaptor`,
  `FiscalBooksFormAdaptor` (6,492 `*FormAdaptor` classes; `CustTableFormAdaptor` confirmed).
- SysTest ✓ (selection): `SysTestCase`, `SysTestAssert`, `SysTestSuite`, `SysTestSuiteCompanyIsolateClass`,
  `SysTestSuiteCompanyIsolateMethod`, `SysTestSuiteCompIsolateClassWithTts`, `SysTestSuiteTTS`, `SysTestSuiteNoCleanup`,
  `SysTestMethodAttribute`, `SysTestCheckInTestAttribute`, `SysTestNonCheckInTestAttribute`, `SysTestInactiveTestAttribute`,
  `SysTestTargetAttribute`, `SysTestGranularityAttribute`, `SysTestCategoryAttribute`, `SysTestOwnerAttribute`,
  `SysTestPriorityAttribute`, `SysTestAreaPathAttribute`, `SysTestRowAttribute`, `SysTestRowInactiveAttribute`,
  `SysTestCaseDataDependencyAttribute`, `SysTestCaseDemoDataDependencyAttribute`, `SysTestCaseCompanyData`,
  `SysTestCaseCountryRegionDependencyAttribute`, `SysTestCaseAutomaticNumberSequencesAttribute`,
  `SysTestCaseNumSeqModuleDependencyAttribute`, `SysTestCaseNumSeqTypeDependencyAttribute`,
  `SysTestCaseConfigurationKeyDependencyAttribute`, `SysTestCaseDependsOnReportAttribute`, `SysTestCaseDependsOnBatchAttribute`,
  `SysTestFeatureDependencyAttribute`, `SysTestFeatureConfigurationAttribute`, `SysTestCaseFlightDependencyAttribute`,
  `SysTestCaseUseSingleInstanceAttribute`, `SysTestSecurityAttribute`, `SysTestSecurityContext`, `SysTestTransactionAttribute`,
  `SysTestFixtureAttribute`, `SysTestKeyAttribute`, `SysTestExtendedInfologEntryCaptureAttribute`,
  `SysTestableExceptionExpected`, `SysTestableExceptionAndInfologExpected`, `SysTestListenerXML`, `SysTestListenerConsoleOutput`,
  `SysTestBatchScheduler`/`SysTestBatchTask` (batch execution of tests), `SysTestStatisticsFormAdaptor`.
- ATL ✓: `AtlDataRootNode` (already in knowledge), `AtlCommand`, `AtlCreatorRecordBased`, `AtlCreatorJournalTable`,
  `AtlData*` module nodes (`AtlDataInvent`, `AtlDataCust`, `AtlDataCustomers`, `AtlDataHcm`, `AtlDataDimensions`, …),
  4,545 `Atl*` classes in total.
- Reporting ✓: `SrsReportNameAttribute`, `SrsReportRunUtil`, `SrsReportRunMailer`, `SrsReportRunPrinter`,
  `SrsReportRunPermission`/`SRSReportRunPermission`, `SrsReportHelper`, `SrsReportRdlDataContract`,
  `SrsReportParameterValidator`/`Base`, `SrsReportEMailDataContract`, `SRSPrintArchiveContract`, `SrsReportRunCache`,
  `SrsReportDrillThruUtil`, `SrsReportDrillThroughFeature`, `SrsReportPdfViewerControl` (+ 8 `SrsReportPdfViewer*` feature
  classes), `SrsReportRunRdpPreProcessStrategyTempDB`/`Regular`, `SrsReportProviderQueryBuilder`, `SRSReportParameterSchema`,
  `SrsReportDataContractUIBuilder`, `SrsPrintDestinationUIBuilder`; print management: `PrintMgmtReportFormatPublisher`,
  `PrintMgmtReportFormatSubscriber`, `PrintMgmtDelegatesHandler`, `PrintMgmtDocumentTypeFactoryAttribute`,
  `PrintMgmtNode_*` (Sales/Purch/Cust/Vend/Invent/Ledger/Project …), `PrintMgmtHierarchy_*`, `PrintMgmtPrintSettingDetail`,
  `PrintMgmtSetup*`; `FormLetterReport`, `Barcode`, `BarcodeCode128`, `BarcodeCode39`, `BarcodeEAN128`, `BarcodeEAN13`,
  `BarcodeUPCA`, `BarcodeITF`, `BarcodeTypeFactoryAttribute`.
- Frameworks ✓: `SysMailerMessageBuilder`, `SysMailerFactory`, `SysMailerGraph`/`SMTP`/`Exchange`/`EML`, `SysOperationValidatable`,
  `SysOperationInitializable`, `SysPackable`, `NumberSeqScope`, `NumberSeqScopeFactory`, `SystemNotificationsManager`,
  `SysDaQueryObject`, the workflow handler interfaces `WorkflowStartedEventHandler`, `WorkflowCompletedEventHandler`,
  `WorkflowCanceledEventHandler`, `WorkflowElementStartedEventHandler`, `WorkflowElementCompletedEventHandler`,
  `WorkflowElementCanceledEventHandler`, `WorkflowElementReturnedEventHandler`, `WorkflowElementDeniedEventHandler`,
  `WorkflowElemChangeRequestedEventHandler`, `WorkflowWorkItemsCreatedEventHandler`, `WorkflowQueueCreatedEventHandler`.
**H0 ran the members oracle over this list and corrected it — three findings, one of them a class that
does not exist.** The committed list is `scripts/oracles/apiSurface.txt` (142 names) and the snapshot is
`eval/api-members.snapshot.json` (128 resolved, names-only):

1. **`XDSServiceBase` DOES NOT EXIST.** No AOT element of any type carries that name. The real one is
   **`SysSecXDSServices`** (ApplicationFoundation). This is the exact defect class the whole round exists
   to prevent — a name that sounds right, written from memory — caught before it reached a knowledge
   entry rather than after an eval run paid two build cycles for it. Every G-18 XDS sentence must be
   re-derived from `SysSecXDSServices`, and §3.L's row is wrong as written.
2. **`FormRun` is an ordinary AOT class**, not kernel: `ApplicationPlatform/AxClass`, **209 methods**,
   `public class FormRun extends xFormRun implements SysFormRun_doRe, IUsageDataPersister`. G-14's cost
   drops accordingly — the FormRun half can be read with `oracle:members` instead of probed. `xUserInfo`
   is likewise AOT (18 methods).
3. **The split inside G-14 is real, and it is not where the plan drew it.** `executeQuery` is *not* on
   `FormRun` (0 of 209 match), because it belongs to `FormDataSource` — and `FormDataSource`,
   `FormDataObject`, `FormStringControl` and `FormReferenceControl` *are* kernel (no AOT XML). So G-14 is
   two jobs with two different oracles: FormRun from metadata, the datasource/control API from
   `oracle:probe`. Writing it as one probe job would have been slower and writing it as one metadata job
   would have produced an entry that silently omits the datasource half.

Everything else the plan marked ⊘ was confirmed kernel by the same run: `xRecord`, `Common`, `xSession`,
`xInfo`, `Query`, `QueryRun`, `DataEntityRuntimeContext`, `DataEntityDataSourceRuntimeContext`.
`SysTestAssert` resolved to exactly the 14 asserts the knowledge base claims, and **`assertExpectedException`
is absent from it** — the entry that says so is right.

- ⊙ to verify with `oracle:members` before use: `MultiSelectionHelper`, `SysExtensionSingletonAttribute`,
  `ERExpressionCustomFunction*` (ElectronicReporting package not searched), `SysComputedColumn` members,
  `SysLabel::labelId2String`, `Label`, `DimensionStorage`, `DimensionDefaultFacade`, `SysDictWorkflowType`.
- ⊘ kernel: `DataEntityRuntimeContext`, `DataEntityDataSourceRuntimeContext`, `xRecord`/`Common` members,
  `FormRun`/`FormDataSource`/`FormControl` members, `xSession`, `xInfo` — these are exactly the objects the symbol
  index cannot answer about, which is why §7 builds their catalogs from the compiler (`oracle:probe`) and from
  shipped usage (`oracle:census --examples`), never from the index.

---

## 3. The map — X++ and the D365FO stack at construct level

Legend per row: **K** knowledge · **V** validator · **T** tool path · **E** eval golden · **R** runtime
(SysTest). ✅ covered · ◐ partial (named but no failure mode, or one of the applicable flags missing) ·
✗ gap · — flag does not apply. "Where" names the existing entry/rule/pattern the row lives in or should
be merged into. Gap ids (G-nn) are expanded in §4–§7.

### 3.A Lexical structure & literals

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| Comments `//`, `/* */`, doc comments `///` (XML: bare `&`/`<` illegal) | ✅ | ✅ DOC001, BP003 | — | ✅ | `xpp-class-rules`, `bp-rules` |
| String literals `"…"` and `'…'` (both are strings), `\` escapes | ◐ | ✅ lexer | — | ✅ | escapes never listed → **G-01** extend `xpp-data-types` |
| Verbatim `@"…"` / `@'…'` (backslash ordinary, may span lines) | ◐ | ✅ lexer | — | ✅ | 2 mentions; census `verbatim-string` exists → G-01 |
| Integer / int64 / real / hex (`0x…`) / date (`1\1\2026`) / utcdatetime / guid / timeOfDay literals | ◐ | — | — | ◐ | hex, int64 suffix-less rule, guid literal absent → G-01 |
| Label literals `"@SYS12345"`, `"@File:Id"`, `literalStr("@…")` | ✅ | ✅ BP001 + reference resolver | ✅ labels tool | ✅ | `labels` |
| Reserved words (115) incl. reserved-unimplemented `having`/`foreach`/`async`/`await`/`namespace`; `client` is reserved | ✅ | ✅ KW001 | — | ✅ | `compilerFacts` |
| Removed statements `pause`, `window`, `tableLock`, `changeSite`; dev artifacts `print`, `breakpoint` | ✅ | ✅ BP004, BP006 | — | ✅ | `switch-loops` |

### 3.B Types & declarations

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| Primitives `anytype boolean date enum guid int int64 real str timeOfDay utcdatetime container`; null-equivalents | ✅ | — | ✅ | ✅ | `xpp-data-types` |
| `str n` (declared length truncates silently) | ◐ | — | — | ✅ | G-01 |
| Fixed arrays `int a[10]`, dynamic `int a[]`, memory-windowed `int a[100, 10]` | ◐ | — | — | ◐ | `[n,m]` form absent → G-01 (census `array-decl` exists) |
| `var`, `const`, `readonly`, `static` **fields**, declare-anywhere, shadowing rejected | ◐ | — (DECL001 rejected) | ✅ | ✅ | static fields absent → G-01 |
| Optional parameters with defaults; `anytype` parameters; by-value semantics, `byref` for containers? (probe) | ◐ | ✅ COC001 | ✅ | ✅ | `xpp-class-rules`; `byref` keyword exists in the parser — semantics **⊙ probe** → G-01 |
| Implicit conversions (compile-time refusals) and converter functions | ✅ | — (CONV001 rejected) | — | ✅ | `xpp-data-types`, FN001 |
| `typeOf()` / `Types` enum; `anytype` re-typing at run time | ◐ | — | — | ✗ | BACKLOG "anytype probe (P2)" — now writable as a SysTest → **G-02** (R flag) |
| EDT / enum as types; `IsExtensible` + `UseEnumValue`; `<Value>` semantics | ✅ | ✅ (create-path warnings) | ✅ | ✅ | `extensible-enums` |
| `using System.X;` namespace alias vs `using (…) { }` statement | ✅ | ✅ CS001 alias exemption | — | ✅ | `xpp-declarations` |

### 3.C Operators

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| Arithmetic incl. `div`, `mod`; compound `+= -= *= /=` (all compile — rule rejected) | ✅ | — | — | ✅ | `operators-precedence` |
| `&&`/`\|\|` equal precedence, left-to-right | ✅ | ✅ OP001 | — | ✅ | |
| Bitwise `& \| ^ ~ << >>` with a precedence chart | ◐ | — | — | ✗ | 2 mentions, no table → **G-03** extend `operators-precedence` |
| `like` with `*`/`?`, `is`/`as` for classes **and tables**, `?:` | ✅ | — | — | ✅ | |
| `++`/`--` are statements, not expressions | ✅ | — | — | ✅ | |
| Container operators: `+=` append, `[a, b] = con` destructuring, `conIns/conPeek/conDel/conLen/conFind/conNull` | ◐ | ✅ FN001 | — | ✅ | destructuring absent → G-03 |
| String concatenation and `strFmt` placeholders `%1` | ✅ | — | — | ✅ | |

### 3.D Statements & flow

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| `if/else`, `switch` (fallthrough, comma cases, non-const cases, `default` last), `for` (multi-init), `while`, `do…while`, `break`, `continue` | ✅ | — | — | ✅ | `switch-loops` |
| `try/catch/finally`, typed CLR catch needs a declared variable, `retry`, `throw`, `Exception::` members (verified list) | ✅ | ✅ TTS002, TTS003 | — | ✅ | `error-handling`, `transactions` |
| `ttsbegin/ttscommit/ttsabort`, nesting, `appl.ttsLevel()`, catch inside tts is dead unless UpdateConflict/DuplicateKey | ✅ | ✅ TTS001, TTS002 | — | ✅ | `transactions` — `ttsLevel` named once → **G-04** state the check idiom |
| `Exception::UpdateConflict`, `::Deadlock`, `::DuplicateKeyException` retry idiom with `xSession::currentRetryCount()` | ◐ | ✅ TTS003 | — | ✅ | `Deadlock` absent → G-04 |
| `unchecked(Uncheck::TableSecurityPermission / XDS)` | ◐ | — | — | ✗ | one mention → G-04 |
| `changecompany(x) { }`, `crossCompany` | ✅ | ✅ SEL003 | — | ✅ | `multi-company` |
| `flush`, `using (…)`, `breakpoint` | ◐ | ✅ BP004 | — | — | G-04 |
| infolog: `info/warning/error/checkFailed`, `setPrefix`, `SysInfoAction`, `Box::`, `infologLine()` | ✅ | ✅ BP001, BP005, COC005 | — | ✅ | `system-objects` |

### 3.E Data statements (select, set-based, query object model)

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| `select` grammar: find options between `select` and buffer; clause order; per-join `where` | ✅ | ✅ SEL008, lintXppSelect | ✅ | ✅ | `select-statement` |
| Find options: `firstOnly[1/10/100/1000]`, `firstFast`, `forUpdate`, `noFetch`, `reverse`, `optimisticLock`, `pessimisticLock`, `repeatableRead`, `generateOnly`, `forceLiterals`, `forcePlaceholders`, `forceNestedLoop`, `forceSelectOrder`, `crossCompany`, `validTimeState`, `index hint` | ✅ | ✅ SEL001–SEL010 | — | ✅ | |
| Aggregates `sum avg minof maxof count` with `group by`; `order by asc/desc` | ◐ | — | — | ✅ | `avg` absent → **G-05** table in `select-statement` |
| Joins `join`, `outer join`, `exists join`, `notexists join`; `join … on` is not X++ | ✅ | ✅ SEL007 | ✅ relation-xpp | ✅ | |
| Select expressions `(select firstonly T).Field` need the TABLE name | ✅ | ✅ SEL010 | — | ✅ | |
| `while select`, `select count(RecId)`, `in` needs an enum field | ✅ | ✅ SEL009 | — | ✅ | |
| `insert_recordset`, `update_recordset … setting`, `delete_from`; `skipDataMethods/skipDeleteActions/skipDatabaseLog/skipEvents/skipAosValidation`; `RecordInsertList`, `RecordSortedList` | ◐ | ✅ SET001 | — | ✅ | skip* named once each; no "which skip disables which handler" table → G-05 |
| `getSQLStatements()` after `generateOnly` | ✗ | — | — | ✗ | G-05 |
| **xRecord/Common buffer API**: `orig()`, `RecVersion`, `data()`, `buf2Buf()`, `merge()`, `setTmp()`, `setTmpData()`, `setConnection()`, `wasCached()`, `isFieldDataRetrieved()`, `fieldState()`, `selectForUpdate()`, `reread()`, `clear()`, `initValue()`, `checkRecord()`, dynamic field access `buf.(fieldId)`, `fieldName2Id/fieldId2Name` | ◐ | ✅ COC006 (re-read) | — | ◐ | **G-06 new entry `xrecord-buffer-api`** — half of the kernel API has no line; TempDB `setConnection` is also the §6 report gotcha |
| Query object model: `Query/QueryRun/QueryBuildDataSource/QueryBuildRange/QueryFilter`, `SysQuery::value/range/findOrCreateRange`, `addLink`, `JoinMode`, `QueryFetchMode` ⊙, `SysQueryRangeUtil`, `[QueryRangeFunction]` | ✅ | — | — | ✅ | `query-object-model` — `QueryFetchMode` absent → G-05 |
| SysDa fluent API | ✅ | — | — | ✅ | `sysda` |
| Multi-select from a grid: `MultiSelectionHelper` ⊙ / `getFirst()`/`getNext()` | ✗ | — | — | ✗ | **G-07** (form catalog §3.J) |
| Direct SQL `Connection/Statement/ResultSet` + permission assert | ✅ | — | — | ✅ | `direct-sql` |

### 3.F Macros & preprocessor

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| `#define.X(v)`, `#localmacro … #endmacro`, `#macrolib`/`#<Library>`, `%1` params, `#if/#ifnot/#endif`, `#undef` | ◐ | ✅ MAC001 | ✅ macro create | ✅ | `macros` — `#macrolib`, `#ifnot`, `#undef` unnamed → **G-08** directive table with census counts |
| `#globaldefine`, `#globalmacro`, `#linenumber`, `#defInc`, `#defDec` (all compile, census: 0–rare) | ✗ | — | — | — | G-08 (state "exists, unused, do not teach first") |
| Platform includes `#AOT`, `#Properties`, `#Task`, `#resAppl`, `#File`; `#CurrentVersion`/`#CurrentList` pack/unpack | ◐ | — | — | ✅ | `deprecated` (RunBase); the include list → G-08 |
| A `#define` value is a legal attribute argument | ✅ | ✅ ATTR001 | — | ✅ | |

### 3.G Functions (intrinsic & predefined)

Covered by the captured compiler facts (80 intrinsics, 170 predefined with arity, 5 unknown, 4 obsolete)
and FN001/FN002/ATTR001; the probe's ten zeros are false (`abs(` vs the table's `abs:`). One real item:
the intrinsic list contains **`dimensionHierarchyStr`, `dimensionHierarchyLevelStr`, `dimensionReferenceStr`,
`measureStr`, `measurementStr`, `webActionItemStr` … `webWebPartStr`, `staticDelegateStr`, `queryMethodStr`,
`tablePName`, `maxDate`, `maxInt`, `minInt`, `enumCnt`** — none of which the `intrinsic-functions` entry names.
**G-09**: regenerate the entry's catalog line from `compilerFacts.generated.ts` (a test should pin that the
entry and the table agree, the way `compilerFacts.test.ts` pins FN001).

### 3.H Classes, OOP, extension model

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| Class declaration, modifiers (`public/protected/private/internal/final/abstract/static`, `protected internal` ok, `private protected` not), `extends`/`implements`, `new`/`finalize`, `this`/`super`, `construct`/`newFrom*`/`parm*` | ✅ | ✅ CS001 | ✅ class, runnable | ✅ | `xpp-class-rules`, `class-inheritance` |
| `static main(Args)`, static fields/ctor semantics ⊙ | ◐ | — | ✅ runnable | ✅ | G-01 |
| Interfaces, abstract, virtual dispatch, `is`/`as` | ✅ | — | ✅ | ✅ | |
| `delegate` + `eventhandler` subscription, `[SubscribesTo]`, `[PreHandlerFor]`/`[PostHandlerFor]` + `XppPrePostArgs` | ✅ | — | ✅ event-handler | ✅ | `event-handlers` |
| CoC: `[ExtensionOf(classStr/tableStr/formStr/formDataSourceStr/formControlStr/formDataFieldStr/queryStr/dataEntityViewStr)] final class X_Extension`, `next` once & unconditional, no default params, `[Hookable]`/`[Wrappable]`/`[Replaceable]`, static/protected wrapping | ✅ | ✅ COC001–006, EXT001 | ✅ 6 extension patterns | ✅ | `coc`, `coc-authoring` — **G-10**: one table "target kind → intrinsic → wrapper name shape → what `this` is" (the eight kinds are spread over four entries) |
| Extension methods (`static class X_Extension`, first param the type) | ✅ | ✅ EXT001 | — | ✅ | |
| Attributes: authoring (`SysAttribute`), literal-only args, `[SysObsolete]` 1–3 args, reading via reflection | ✅ | ✅ ATTR001/002 | — | ✅ | `attributes-authoring` |
| SysExtension plug-ins: `SysExtensionIAttribute`, `SysExtensionAppClassFactory`, `[ExportMetadata]`, singleton/cache ⊙ | ◐ | — | ✅ (unpublished feature-class) | ✅ | `sysextension` — `ExportMetadata`/singleton absent → **G-11** |
| Reflection `Dict*`/`SysDict*` (Table/Field/Class/Method/Enum/Index ⊙/Relation ⊙/View ⊙/Type ⊙), `TreeNode` obsolete | ◐ | — | — | ✅ | `reflection-dict` → G-11 |
| Kernel objects `xSession`, `xInfo`, `xUserInfo`, `xGlobal`, `xArgs`, `ClassFactory`, `Box`, `Debug` | ✅ | — | — | ✅ | `system-objects` |
| Generics `List<str>` (resolution, not syntax — rule rejected), CLR interop, `using` alias, `CLRError` | ✅ | — | — | ✅ | `dotnet-interop` |
| `Args`: `record()`, `caller()`, `parmEnum/parmObject/parmEnumType`, `menuItemName()`, `OpenMode`, `lookupField/Value` | ✅ | — | — | ✅ | `args-object` |

### 3.I Tables & data model

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| AxTable anatomy, canonical element order, non-existent properties | ✅ | ✅ XML001–007 | ✅ | ✅ | `metadata-element-order` (memory) |
| Fields, EDT/enum typing, `StringSize`/`Memo`, `Mandatory`, `AllowEdit`/`AllowEditOnCreate`, `Visible`, `IgnoreEDTRelation`, `CountryRegionCodes`, `ConfigurationKey` | ◐ | ✅ XML004, references | ✅ add/modify-field | ✅ | property semantics scattered → **G-12** merge into `xpp-class-rules`? No — new entry `table-properties-reference` is too generic; put the *semantics with failure mode* rows into `bp-rules` and the create op-spec |
| Indexes: unique, `AlternateKey`, `ClusteredIndex`, `ReplacementKey`, `PrimaryIndex`, `IncludedColumns` ⊙, `ValidTimeStateKey`/`Mode` | ◐ | ✅ XML001/005 | ✅ add-index | ✅ | included columns absent → G-12 |
| Relations: `Normal`/`ForeignKey`/`EntityRelationshipType` (Association/Composition/…), cardinality, `Validate`, `RelatedTableRole`, `UseDefaultRoleNames` | ◐ | ✅ references | ✅ add-relation | ✅ | relation-type semantics → G-12 |
| Delete actions `None/Restricted/Cascade/CascadeRestricted` (+ the bridge-overwrite hazard) | ✅ | — | ✅ | ✅ | `d365fo_file` op-spec |
| Field groups incl. `AutoReport/AutoLookup/AutoIdentification/AutoSummary/AutoBrowse` semantics | ◐ | ✅ XML009 | ✅ | ✅ | auto-groups never explained → G-12 |
| `TableGroup`, `TableType` (Regular/InMemory/TempDB), `CacheLookup`, `SaveDataPerCompany/Partition`, `OccEnabled`, `CreateRecIdIndex`, `SupportInheritance`/`Extends` | ✅ | ✅ XML002/003 | ✅ | ✅ | `temp-tables`, `caching`, `table-inheritance` |
| **Table methods (overridable)**: `insert/update/delete`, `validateWrite/validateField/validateDelete`, `modifiedField/modifiedFieldValue`, `initValue`, `postLoad`, `aosValidateInsert/Update/Delete/Read`, `caption`, `toolTipField`, `helpField`, `defaultField/defaultRow` ⊙, `initFrom*` convention, `renamePrimaryKey`, `canSubmitToWorkflow`, `merge`, `clear`; static conventions `find`, `findRecId`, `exist`, `checkExist` | ◐ (8 of ~25) | ✅ COC004–006 | ✅ find-methods, add-table-method | ✅ | **G-13 extend `src/knowledge/tableDataMethods.ts` to the full set** — it is the source `prepare(test)` uses to shape a table test |
| Data events `[DataEventHandler(tableStr, DataEventType::…)]`, `DataEventArgs`/`ValidateEventArgs`/`ValidateFieldEventArgs` ⊙/`ModifiedFieldEventArgs` ⊙ | ◐ | — | ✅ event-handler | ✅ | args classes → G-13 |
| Views (`SysComputedColumn` ⊙ members, view methods), maps (field mapping), date-effective (`ValidTimeStateFieldType`, auto query) | ◐ | ✅ SEL010 | ✅ | ✅ | `date-effective`, `data-entities` — computed column API → G-15 |
| Extensions: table/field/enum/EDT extension, `<Methods>` illegal on AxTableExtension, field modifications, field-group extensions | ✅ | ✅ XML008, EDT validator | ✅ | ✅ | |

### 3.J Forms & UI

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| Form patterns (36 + 30 sub), pattern validator, element order census | ✅ | ✅ FP000–010, XML010 | ✅ scaffold:form | ✅ | `form-patterns` |
| FormRun lifecycle `init → run → executeQuery → active → … → close`; `canClose`, `closeOk/closeCancel`, `wait`, `args()`, `design()`, `dataSource()` | ◐ | — | ✅ methodStubs | ✅ | `formrun-lifecycle` names 5 of ~20 → **G-14 new entry `form-runtime-api`** |
| FormDataSource: `initValue`, `create`, `write`, `validateWrite`, `delete`, `validateDelete`, `refresh/reread/research(true)/refreshEx`, `linkActive`, `leave/leaveRecord`, `positionToRecord`, `markAsDirty`, `cursor()`, `displayOption`/`FormRowDisplayOption`, `queryBuildDataSource()`, `addRange`, `filter()`, `object(fieldNum)`, `queryRun()` | ◐ | — | ◐ | ✅ | G-14 |
| FormDataObject `allowEdit/visible/mandatory/lookup/modified/validate` | ◐ | — | — | ✅ | G-14 |
| **Control classes** (25): String/Int/Int64/Real/Date/DateTime/Time/CheckBox/ComboBox/Image/Html/StaticText/Button/CommandButton/MenuButton/DropDialogButton/ButtonGroup/Group/TabPage/Tab/Grid/ActionPane/FilterPane/QuickFilter/ReferenceGroup/SegmentedEntry/Tree/List/Window ↔ data type ↔ `AxForm…Control` XML name | ✗ | ✅ FP004 | ✅ `getFieldControlMap` (generator knows it) | ✅ | **G-14**: publish the generator's mapping as knowledge, one table |
| Control methods `enabled/visible/allowEdit/text/valueStr/selection/lookup/modified/validate/clicked/jumpRef/context/displayOption`; `registerOverrideMethod` (concrete control only) | ◐ | — | — | ✅ | `lookups`, G-14 |
| Form event handlers (4 attributes, 4 enums, sender types) | ✅ | — | ✅ | ✅ | `form-event-handlers` |
| Lookups (table / reference / multi-select / override) | ✅ | — | ✅ lookup-form | ✅ | `lookups` |
| Dialog API (`Dialog`, `DialogField`, `addField`, `dialogSelectCtrl`, `DialogRunbase`) vs SysOperation dialogs | ◐ | — | ✅ dialog-box | ✅ | `sysoperation-ui-attributes` — legacy Dialog API → G-14 (state as legacy) |
| Menu items: types, `EnumTypeParameter/EnumParameter`, `NeedsRecord`, `LinkedPermissionType/Object`, `OpenMode`, `Parameters`, security `NormalImage`… | ◐ | — | ✅ menu-item | ✅ | `menu-navigation` → G-14 property table |
| Multi-select in grids (`MultiSelectionHelper` ⊙, `getFirstSelected` ⊙) | ✗ | — | — | ✗ | G-07 |
| Form extension: add control (DataGroup refusal), remove control (XML-only), property modification, datasource add, method CoC | ✅ | ✅ shape validator | ✅ | ✅ | |
| Tiles/KPIs/workspaces, saved views/personalization (state: metadata-only, no X++) | ◐ | — | ✅ | ✅ | `tiles-kpis` |
| Extensible controls, embedded Power Apps, HTML controls | ✗ | — | — | — | **non-goal** (§10) |

### 3.K Data entities & integration

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| Entity anatomy (data sources, keys, `PublicEntityName/CollectionName`, `IsPublic`, `DataManagementEnabled`, staging, `EntityCategory`, `PrimaryCompanyContext` ⊘) | ◐ | ✅ references | ✅ create data-entity | ✅ | `data-entities` — `PrimaryCompanyContext` absent → **G-15 new entry `data-entity-methods`** |
| **Entity lifecycle methods**: `postLoad`, `initializeEntityDataSource`, `mapEntityToDataSource`, `mapDataSourceToEntity`, `insertEntityDataSource/updateEntityDataSource/deleteEntityDataSource`, `persistEntity`, `validateWrite/validateDelete/initValue`, `defaultCTQuery`, `DataEntityRuntimeContext`/`DataEntityDataSourceRuntimeContext` ⊘ | ✗ (1 mention each at most) | — | ✅ add-method | ◐ | G-15 |
| Unmapped / virtual / computed fields (`SysComputedColumn` ⊙), `EnableSetBased`/set-based insert | ✗ | — | ◐ | ✗ | G-15 |
| OData: `[SysODataActionAttribute]`, `[SysODataCollectionAttribute]` ⊙, `[SysODataFirstOnly]` ⊙, `[AifCollectionTypeAttribute]`, `$filter` semantics, cross-company | ◐ | — | ✅ custom-service | ✅ | `custom-services` → G-15 |
| DMF: `DMFEntityBase`, definition groups, composite, change tracking, recurring integrations | ◐ | — | — | ✅ | `data-management-framework` (adequate at the K level) |
| Business events (`BusinessEventsBase/Contract`), dual-write, virtual entities | ✅ | — | ✅ business-event (unpublished) | ✅ | |
| File I/O: read CSV/XLSX (stream-based) ✅; **write** CSV/XLSX, `File::SendFileToUser` | ◐ | — | — | ◐ | BACKLOG `file-io` → **G-16 promote** |
| HTTP/JSON/XML/Regex: `HttpClient`, `FormJsonSerializer`, `Newtonsoft.Json`, `System.Xml`, `Regex`, Base64/streams | ✗ | — | — | ✗ | BACKLOG `http-json-xml` → G-16 |
| E-mail: `SysMailerMessageBuilder` + `SysMailerFactory::sendNonInteractive` ✓ | ✗ | — | — | ✗ | BACKLOG `email-sending` → G-16 |
| Attachments `DocuRef/DocuValue/DocumentManagement::attachFile` (9 args) | ✅ | — | — | ✅ | `document-attachments` |
| Azure Blob / Key Vault SDKs, Power BI embedded | ✗ | — | — | — | **non-goal** |

### 3.L Frameworks

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| SysOperation: contract/service/controller, execution modes, UI attributes, query param, `SysOperationValidatable` ✓ / `SysOperationInitializable` ✓ interfaces, `SysOperationProgress`, `SysOperationSandbox`, batch info (`batchInfo()`), `BatchRetryable`, `runAsync` | ◐ | — | ✅ sysoperation, batch-job | ✅ | `sysoperation` — the two interfaces + `parmBatchInfo`/`BatchHeader` names absent → **G-17** extend |
| RunBase lifecycle (legacy), pack/unpack `#CurrentVersion`, `SysPackable` ✓ | ✅ | — | — | ✅ | `deprecated` |
| Parallel batch (`BatchHeader`, `addRuntimeTask`, dependencies) | ✅ | — | — | ✅ | `parallel-batch` |
| Number sequences: module/reference, `NumberSeq::newGetNum`, `NumberSeqFormHandler`, **scopes** (`NumberSeqScopeFactory` ✓), `used()/abort()` | ◐ | — | ✅ number-seq-handler | ✅ | scopes absent → G-17 |
| Financial dimensions: `DimensionDefault`, `DimensionAttributeValueSetStorage`, `LedgerDimensionFacade`, `DimensionStorage` ⊙, `DimensionDefaultFacade` ⊙ | ✅ | — | ✅ dimension-controller | ✅ | |
| Posting (`LedgerVoucher`, `SubledgerJournalizer`), currency, GAB, inventory, WHS, ProcessGuide, trade agreements | ✅ | — | ✅ | ✅ | adequate at K |
| Workflow: document/type/approval/task, `canSubmitToWorkflow`, **event-handler interfaces** (11 ✓ — all K = 0), submit/resubmit managers, providers (participant/hierarchy/due-date) ⊙ | ◐ | — | — (no AxWorkflow* objectType) | ✅ | **G-18** extend `workflow` with the interface table; objectType for AxWorkflowType stays out (T-flag non-goal, noted in taxonomy) |
| Feature management, flights, configuration keys, license codes | ✅ | — | ✅ | ✅ | |
| Security: roles/duties/privileges/entry points, XDS (`SysSecXDSServices` ✓ — **not** `XDSServiceBase`, which does not exist; `PolicyContext`, `ContextString` all K = 0), `SecurityRights` ⊘ | ◐ | — | ✅ | ✅ | XDS API → G-18 |
| Alerts, business events, **action-center notifications** (`SystemNotificationsManager` ✓, `SystemNotificationDataContract` ⊙) | ◐ | — | — | ✅ | G-18 |
| Caching: `CacheLookup`, `SysGlobalObjectCache`, `RecordViewCache`, `SysGlobalCache`/`SysDataAreaCache` ⊙ (session-scoped) | ✅ | — | — | ✅ | `caching` |
| ER: run a format from X++, model-mapping data source; **custom functions** (`ERExpressionCustomFunction*` ⊙, generator has `er-custom-function` unpublished) | ◐ | — | ✅ (unpublished) | ✅ | G-18 |
| Tax framework, fixed assets, projects, HRM, retail/commerce, production/BOM, master planning, TMS | ✗ | — | — | — | domain breadth — tax pack only on owner ask (BACKLOG); others **non-goal** |

### 3.M Reporting (SSRS + print management + ER) — expanded in §6

| Construct | K | V | T | E | R | Where / gap |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Pipeline TmpTable → Contract → DP → Controller → AxReport; `[SRSReportParameterAttribute]`, `[SRSReportQueryAttribute]`, `[SRSReportDataSetAttribute]`, `processReport`, `getTmp*`, `ssrsReportStr`, design named `Report` | ✅ | ✅ RPT001/002/101/102 | ✅ scaffold:report (7 objects) | ✅ | ✗ | `ssrs-reports` |
| `SrsReportNameAttribute` ✓ on the contract; `SrsReportRdlDataContract` for RDL-declared params; `SrsReportParameterValidator` ✓ | ◐ | — | ◐ | ◐ | ✗ | **G-19** |
| **TempDB temp table binding**: `tmp.setConnection(this.parmUserConnection())` in a non-pre-processed DP ⊙ (census first) | ✗ | ✗ | ◐ (scaffold uses RecId key; connection not verified) | ✗ | ✗ | **G-20** K + V (RPT003, after census) + scaffold audit |
| Pre-processed DP (`…PreProcess`, `…PreProcessTempDB`, `createdTransactionId`, `AX_RdpPreProcessedId`) | ✅ | ✅ RPT001 exempt | ✅ | ✅ | ✗ | `ssrs-rdp-preprocess` |
| Controller: `main`, `parmReportName`, `parmDialogCaption`, `parmShowDialog`, `parmArgs`, `prePromptModifyContract`, `preRunModifyContract`, `startOperation`, `runReport` ⊙, `parmLoadFromSysLastValue` ⊙, `getReportContract` | ◐ | — | ✅ | ✅ | ✗ | `ssrs-contracts` → G-19 |
| Contracts taxonomy (RDP / RDL / print / composite), `SrsReportEMailDataContract` ✓, `SRSPrintArchiveContract` ✓ | ✅ | — | ✅ | ✅ | — | |
| Print destinations (file/PDF/e-mail/archive/printer/batch), `SRSPrintDestinationSettings` props | ✅ | — | ✅ | ✅ | ✗ | `report-print-destinations` |
| Print management: `PrintMgmtDocType` enum ext, `PrintMgmtDelegatesHandler` ✓, `getDefaultReportFormatDelegate`, `PrintMgmtReportFormatPublisher` ✓ (`publishReportFormats`), `PrintMgmtNode_*` ✓, `PrintMgmtDocumentTypeFactoryAttribute` ✓, `SrsPrintMgmtFormLetterController` ✓ | ◐ | — | ✅ report-custom-design, printMgmt controller | ✅ | ✗ | `print-management`, `report-extension-patterns` → G-19 (publisher/subscriber, node hierarchy) |
| UI builder (`SrsReportDataContractUIBuilder`), automatic UI, dialog attributes | ✅ | — | ✅ uiBuilder | ✅ | — | `ssrs-ui-builder` |
| **AxReport metadata anatomy**: `AxReportDataSet`/`Field`, `AxReportParameter` (`AllowBlank`, `Nullable`, `MultiValue`, `Hidden`, `DefaultValue`, `DataType`), `AxReportDesign` (`i:type` precision/auto), `DefaultParameterGroup`, platform params (6), `DataMethods` (obsolete), `EmbeddedImages` | ✗ (E 172 / K 0 for `AllowBlank`) | ✅ RPT101/102 only | ✅ writer | ✅ | — | **G-21 new entry `axreport-anatomy`** + V: RPT103 parameter/dataset ↔ contract consistency |
| Report **write ops** (`report-design` op: refresh dataset from tmp table, add parameter, add column) | — | — | ✗ | ✗ | — | BACKLOG deferral → **G-22** (needs a measured schema trim) |
| Design: precision vs auto (416:56), tablix/textbox, page header/footer, page breaks, grouping, `Fields!/Parameters!/Labels!/Globals!/ReportItems!/User!`, functions `Sum/First/Format/IIF/Switch/RowNumber/RunningValue/Previous/CountDistinct`, `PageNumber/TotalPages`, formatting by culture (`AX_RenderingCulture`), visibility/toggle, interactive sort, drill-through (`SrsReportDrillThruUtil` ✓) | ◐ | — | ✅ RDL skeleton (2 styles) | ✅ | — | `rdl-design-expressions` → **G-23** extend with a function table + layout rules |
| Images/logo (`FormLetterReport` ✓, `CompanyImage` table), barcodes (`BarcodeCode128` ✓ → font string) | ◐ | — | — | ✗ | — | `barcode-scanning` names the hierarchy; the report-side recipe → G-23 |
| Report security (`SrsReportRunPermission` ✓), `SysLastValue` caching, report in batch, cross-company DP, localisation | ✗ | — | — | ✗ | — | G-19 |
| **Report DP unit test** (call `processReport()` with a contract, read the tmp table) | ✗ | — | ✗ | ✗ | ✗ | **G-24** (TDD target kind, §5.2) |
| ER: run format from X++, data-source class, custom function ⊙ | ◐ | — | ◐ | ✅ | — | G-18 |
| Sub-reports, Power BI embedded, Financial Reporting, Document Routing Agent internals | ✗ | — | — | — | — | **non-goal** |

### 3.N Testing & TDD — expanded in §5

| Construct | K | V | T | E | R | Where / gap |
|---|:-:|:-:|:-:|:-:|:-:|---|
| `SysTestCase`/`SysTestAssert` (13 asserts + `fail`), `parmExceptionExpected`, `setUp/tearDown[TestCase]`, `[SysTestMethod]`, `[SysTestTarget]`, `[SysTestCheckInTest]` | ✅ | — | ✅ systest (class, table) | ✅ | ✅ | `testing` + `unit-testing` (**overlap — G-25 consolidate**) |
| `assertExpectedInfoLogMessage` ✓, `SysTestableExceptionAndInfologExpected` ✓, `SysTestExtendedInfologEntryCaptureAttribute` ✓ | ◐ | — | ✅ | ✅ | ✅ | |
| **Attributes & dependencies**: category/owner/priority/area path (TestEssentials), `SysTestCaseDataDependency`, `SysTestCaseDemoDataDependency`, `SysTestCaseCompanyData`, `SysTestCaseCountryRegionDependency`, `SysTestCaseAutomaticNumberSequences`, `SysTestCaseNumSeqModule/TypeDependency`, `SysTestCaseConfigurationKeyDependency`, `SysTestCaseDependsOnReport/Batch`, `SysTestFeatureDependency`/`FeatureConfiguration`/`FlightDependency`, `SysTestSecurity`, `SysTestTransaction`, `SysTestRow` (data-driven), `SysTestFixture`, `SysTestKey`, `SysTestInactiveTest`, `SysTestCaseUseSingleInstance` (all ✓) | ◐ (listed in one rule line, no semantics) | ✗ | ✗ | ✗ | ✗ | **G-26 new entry `systest-attributes`** + scaffold params |
| Suites & isolation: `SysTestSuite`, `…CompanyIsolateClass/Method`, `…CompIsolateClassWithTts`, `…TTS`, `…NoCleanup`; `createSuite()` override; rollback default; partition `UT01`/company `DAT` | ◐ | — | ✗ | ✗ | ◐ | G-26 |
| **Test data**: raw buffer + `initValue()` ✅; **ATL** (`AtlDataRootNode`, module `AtlData*` nodes, creators `AtlCreator*`, queries, specs, commands `AtlCommand*`; 9 packages, model must reference them) | ◐ (4 lines) | — | ✗ | ✗ | ✗ | **G-27 new entry `test-data-atl`** + `prepare(test)` detection of ATL references + scaffold variant |
| **Form tests via form adaptors** (`*FormAdaptor` packages ✓, 6,492 classes; `CustTableFormAdaptor`) | ✗ | — | ✗ | ✗ | ✗ | **G-28** (P2 — K first, scaffold only after a probe) |
| Test doubles: no mocking framework; seams = CoC in the test model, abstract factory, `SysExtension`, protected virtuals | ◐ | — | ✗ | ✗ | ✗ | G-25 (rules with a compiled example) |
| Runner: `SysTestConsole.exe /test: /xml: /unattended` (no per-method filter), VS Test Explorer, `SysTestListenerXML`, batch execution (`SysTestBatch*` ✓) | ✅ | — | ✅ run_systest_class | ✅ | ✅ | |
| **TDD loop** red → green → refactor; red must COMPILE; empty-assert guard; BP after green | ✅ | ✗ | ◐ (class, table only) | ◐ (`L2-systest-authoring-basic` proves authoring, not the loop) | ◐ | **G-29** `L2-tdd-red-green-cycle` (BACKLOG) + proactivity (§5.1) + target kinds (§5.2) |
| Test shapes per target: class ✅ · table method ✅ · **table-extension CoC · class-extension CoC · event handler · SysOperation service · report DP · data entity · number sequence · business event · form (adaptor)** | ✗ | — | ✗ | ✗ | ✗ | **G-30** |
| Validator help for tests: `assertExpectedException` (does not exist) → error; `[SysTestMethod]` on a non-`SysTestCase` class → error; test method with no assert and no `parmExceptionExpected` → warning; `SysTestCategory` without TestEssentials reference → warning (needs Descriptor read — prepare does it) | ✗ | ✗ | — | — | — | **G-31** TST001–TST003 (sweep bar applies: the AOT ships tens of thousands of tests) |
| RSAT / Task recorder / performance & load tests | ✗ | — | — | — | — | **non-goal** |

### 3.O Best practice & lifecycle

| Construct | K | V | T | E | Where / gap |
|---|:-:|:-:|:-:|:-:|---|
| BP rules, monikers (577), suppression lifecycle, `SuppressBPWarning` | ✅ | ✅ | ✅ | ✅ | `bp-rules`, bp-moniker |
| Labels: files, `@File:Id`, `literalStr`, `strFmt`, runtime `SysLabel::labelId2String` ⊙ / `Label` class ⊙ | ◐ | ✅ BP001 | ✅ labels | ✅ | runtime label API absent → **G-32** extend `labels` |
| Naming conventions (22 checks), prefix/infix, extension name shapes | ✅ | ✅ | ✅ | ✅ | |
| Deprecated APIs & the explicit NOT-DEPRECATED block | ✅ | ✅ FN002, BP006 | — | ✅ | `deprecated` |
| Code-access security asserts (`FileIOPermission`, `InteropPermission`, `SqlStatementExecutePermission`, `RunAsPermission` ⊙, `assert()/revertAssert()`) | ◐ | — | — | ✅ | one line per topic → G-32 (one table in `xpp-class-rules`) |
| Build/DB sync/BP/verify/systest tooling | ✅ | — | ✅ | ✅ | `MCP_TOOLS.md` |
| Performance: set-based, indexes (covering/`IncludedColumns` ⊙), caching, tts length, trace | ◐ | ✅ SEL004/005/006 | — | ✅ | `performance` → G-12 (index) |
| Code-quality heuristics (method length, complexity, dead code) | ✗ | ✗ | — | — | **non-goal** — needs an AST; the compiler/BP do not report them either |
| ALM: LCS, pipelines, deployable packages, TFVC/git, version updates | ✗ | — | — | — | **non-goal** for the server (out of the copilot's tool reach) |

---

## 4. Gap register

Priority: **P1** = named by demand or on the TDD/report critical path · **P2** = completeness the user asked
for ("fully covered") with a verified API · **P3** = reference-level. Every K item obeys
`docs/KNOWLEDGE_AUTHORING.md` (extend before add; placeholder names `My*`; audit snapshot re-capture).

| Id | Area | What | Merge target | Oracle | Pri |
|---|---|---|---|---|---|
| G-01 | B/A | literal forms (escapes, hex, `@`), `str n`, `[n,m]` arrays, static fields, `byref` | extend `xpp-data-types`, `xpp-declarations` | `oracle:census --patterns language --examples`; `oracle:probe` for `byref`, static field, `[n,m]` | P3 |
| G-02 | B | `anytype` run-time re-typing | new R-only case `L2-anytype-retyping-runtime` (SysTest) | SysTest | P3 |
| G-03 | C | bitwise table, container destructuring | extend `operators-precedence`, `xpp-collections` | probe (precedence of `&` vs `==`) | P3 |
| G-04 | D | `ttsLevel` idiom, `Exception::Deadlock` retry, `Uncheck::`, `flush`, `using` statement | extend `transactions`, `error-handling` | census | P3 |
| G-05 | E | aggregate table (`avg`), skip* ↔ handler matrix, `getSQLStatements`, `QueryFetchMode` | extend `select-statement`, `set-based`, `query-object-model` | probe (`skipEvents` vs DataEventHandler), census | P2 |
| G-06 | E | **`xrecord-buffer-api`** — every kernel buffer member with its failure mode | new entry; `related` from `coc-authoring`, `occ-unitofwork`, `temp-tables` | `oracle:probe` (kernel — no AOT XML), census `--examples` | **P1** (feeds §5 table/entity tests and §6 G-20) |
| G-07 | E/J | multi-select (`MultiSelectionHelper`) | extend `form-runtime-api` (G-14) | `oracle:members` | P2 |
| G-08 | F | directive table with census counts | extend `macros` | census `--patterns macros` | P3 |
| G-09 | G | intrinsic catalog line generated from `compilerFacts`; pin by test | `intrinsic-functions` + `tests/knowledge/compilerFacts.test.ts` | — [repo] | P2 |
| G-10 | H | CoC target-kind table (8 intrinsics × wrapper shape × `this`) | extend `coc-authoring` | probe (already largely compiled in v2/v3 goldens) | **P1** (35 demand asks) |
| G-11 | H | `[ExportMetadata]`, singleton/cache, `DictIndex/Relation/View/Type` | extend `sysextension`, `reflection-dict` | `oracle:members` | P3 |
| G-12 | I | property semantics: auto field groups, relation kinds, `IncludedColumns`, `AllowEditOnCreate` | extend `bp-rules` + create op-spec text | census over `AxTable` (property_stats already mined) | P2 |
| G-13 | I | **full table-method catalog** (~25 methods + event-args classes) | `src/knowledge/tableDataMethods.ts` (typed, tested) + `coc-authoring` | probe per signature (kernel) | **P1** |
| G-14 | J | **`form-runtime-api`**: FormRun/FormDataSource/FormDataObject/FormControl method tables, 25 control classes ↔ types ↔ XML names (export the generator's map), menu-item properties, legacy Dialog API marked legacy | new entry; `formrun-lifecycle` keeps lifecycle, links here | generator map [repo]; probe for method signatures | **P1** (forms are 38 of 195 writes) |
| G-15 | K | **`data-entity-methods`**: lifecycle methods, runtime context, `PrimaryCompanyContext`, unmapped/virtual/computed, set-based, OData attributes | new entry; `data-entities` keeps the model | census over `AxDataEntityView` methods; probe | **P1** |
| G-16 | K | the three deferred packs `email-sending`, `file-io` (write), `http-json-xml` | new entries from probe JSON (BACKLOG says the shapes compiled) | already probed; re-run `oracle:probe -- --file coverage-v3.ts` | P2 |
| G-17 | L | SysOperation interfaces (`SysOperationValidatable`/`Initializable`), `batchInfo()`, number-sequence scopes | extend `sysoperation`, `number-sequences` | `oracle:members` | P2 |
| G-18 | L | workflow event-handler interfaces (11), XDS API, action-center notifications, ER custom function | extend `workflow`, `security`, `alerts-business-events`, `electronic-reporting` | `oracle:members`; ER needs the `ElectronicReporting` package scan | P2 |
| G-19 | M | controller/runtime API (`runReport`, `parmLoadFromSysLastValue`, `SrsReportRunUtil`, permissions, validators, `SysLastValue`, batch, cross-company, localisation), print-mgmt publisher/subscriber/node hierarchy | extend `ssrs-contracts`, `print-management`, `report-extension-patterns` | `oracle:members` on the ✓ classes | **P1** |
| G-20 | M | **TempDB `setConnection(parmUserConnection())`** | K in `ssrs-reports` + `xrecord-buffer-api`; V RPT003; scaffold audit | census (how many shipped DPs call it; on which base) → probe → sweep | **P1** |
| G-21 | M | **`axreport-anatomy`** + RPT103 (params ↔ contract DataMembers; dataset fields ↔ tmp table) | new entry; validator on `codeType="xml-report"` (in-document + on-disk table read like XML009) | census over 400 shipped reports (already partly done in v3) | **P1** |
| G-22 | M | `report-design` modify op (`action` = refresh-dataset \| add-parameter \| add-column), refusing foreign designs | `modifyD365File.ts` + op-spec; needs ~25 chars → find a ≥25-char trim first | writer tests + VM build of the result | P2 |
| G-23 | M | RDL function/layout table, logo & barcode recipe, formatting by culture | extend `rdl-design-expressions`, `barcode-scanning` | census `--patterns reporting --examples` | P2 |
| G-24 | M/N | report DP unit-test shape (`processReport()` → tmp table) | §5.2 target kind `report-dp` | probe + SysTest | **P1** |
| G-25 | N | consolidate `testing` + `unit-testing` (one authoritative entry, one naming rule, test-double seams with a compiled example) | `unit-testing` absorbs; `testing` becomes a 3-line redirect or is removed (taxonomy `knowledgeIds` updated) | — [repo] + probe for the seam example | **P1** |
| G-26 | N | **`systest-attributes`** (dependencies, isolation, data-driven rows, security, feature flags) + scaffold params | new entry; `pattern="systest"` gains op-spec params `attributes`, `companyIsolation`, `dataDependency` | `oracle:members` on each attribute class (arg lists!) + probe | **P1** |
| G-27 | N | **`test-data-atl`** + scaffold variant | new entry; `prepare(test)` detects ATL refs in Descriptor (same mechanism as TestEssentials) and offers the ATL arrange block | census over `AtlSampleTests` (Microsoft's own examples) + probe | **P1** |
| G-28 | N | form tests via adaptors | new entry `form-adaptor-tests`; scaffold later | census over `*FormAdaptor` + `SysTestCaseFormRunTracker`; probe | P2 |
| G-29 | N | `L2-tdd-red-green-cycle` case (records the red run, then green) | eval case + corpus schema field `systest_red` | SysTest | **P1** |
| G-30 | N | test shapes for 9 more target kinds | `prepareTest.ts` + `codeGen.ts` templates | probe each shape with a negative control | **P1** |
| G-31 | N | TST001–TST003 | `validateXpp.ts` | full sweep incl. the test packages (add `*Tests`, `ATL*`, `TestEssentials` to the sweep types — today's sweep may never have scanned a test class) | P2 |
| G-32 | O | runtime label API, CAS permission table | extend `labels`, `xpp-class-rules` | `oracle:members` | P3 |

---

## 5. The TDD copilot — design

### 5.1 Proactivity (zero schema bytes)

The loop must be *offered*, not *found*. All of the following are response-text changes to calls people
already make; none touches the ListTools payload.

1. **`prepare(mode="change"|"create")` gains a `### Test first?` section** when any of: `objectType` ∈
   {class, class-extension, table, table-extension, data-entity}; `methodName` matches
   `validate*|modified*|init*|calc*|post*|process*|check*`; or `goal` contains a rule-like verb
   (validate, reject, prevent, calculate, default, must, should). The section is two lines: the exact
   `prepare(mode="test", objectName="<Target>.<method>")` call, and the one-sentence reason ("a
   validateWrite rule is a boolean plus an infolog line — the scaffold asserts both"). It is emitted
   *above* the ranked-context block and below the write contract, so a cap cut never removes it.
   Gate: `tests/tools/prepare*.test.ts` pins that it appears for a table-extension `validateWrite`
   change and does NOT appear for `add-field` on an enum.
2. **`d365fo_file` post-write note**: after a create/modify that wrote X++ into a class/table-extension
   whose method set intersects the rule-like list, append one line: "No SysTest references `<Target>`
   in `<model>` — `prepare(mode="test", …)` scaffolds one." The lookup is the same
   `existingTests()` query `prepareTest.ts` already runs (index-only, ~1 ms).
3. **`build_d365fo_project` and `run_systest_class` hand-off**: a green build whose model contains a
   `*Test` class touched this session ends with "run it: `run_systest_class(className=…)`"; a
   `run_systest_class` where *every* method passed on a class created this session says "all green on
   first run — check the asserts are not empty" (the red-first rule, restated where it is violated).
4. **`get_workspace_info(changes:true)`** lists, per changed X++ object, whether a test class referencing
   it exists (`Tested: yes/no`). Session-level TDD visibility without a new tool.
5. **Knowledge**: the consolidated `unit-testing` entry (G-25) and a new `tdd-workflow` entry that is
   *process*, not API: what to test per artifact kind (table rule, CoC wrapper, service, DP, entity),
   the AAA shape, naming, the red-must-compile rule, the empty-assert trap, when a SysTest is the wrong
   tool (layout, metadata-only objects — the golden oracle covers those).

### 5.2 Target kinds for `prepare(mode="test")` + `pattern="systest"`

Today: `class`, `table`. Each new kind needs (a) resolution in `targetKind()`, (b) a template in
`codeGen.ts`, (c) a probe in `scripts/oracles/probes/coverage-v4.ts` compiled **with a negative control
in the same build**, (d) an eval case with a golden and a SysTest, (e) a taxonomy leaf. Order by demand:

| Kind | Resolution | Arrange | Act | Assert | Notes |
|---|---|---|---|---|---|
| **table-extension CoC** (`CustTable.validateWrite` when the wrapper lives in the caller's model) | `objectName` dotted → find `[ExtensionOf(tableStr(X))]` classes in the model (index: `class-extension` rows whose declaration names X) | buffer + `initValue()` + the field the rule reads | `buf.validateWrite()` | `assertFalse` + `assertExpectedInfoLogMessage(<label text>)` **and** the accepting case | CoC is transparent to the test — this is the v3 table template pointed at the extension's own model; add the "which model must the test live in" rule |
| **class-extension CoC** (`Base.method` wrapped) | same discovery on `classStr` | construct the base (needs its `construct`/`new` signature from the index) | call the wrapped method | `assertEquals` on the wrapped result; a second input proving base behaviour survives (the `L2-coc-extension` SysTest shape) | already proven by `EvalL2CocCarFactsTest` — promote its shape into the template |
| **event handler** (`[DataEventHandler]`/`[PostHandlerFor]`) | class whose methods carry the attributes → derive the table/method | buffer with the triggering field blank | `buf.insert()` inside `ttsbegin/ttscommit` | re-read by RecId, assert the defaulted value (the `L2-event-handler-basic` shape) | |
| **SysOperation service** | class extends `SysOperationServiceBase` (index `extends`) or has a `[DataContract]` sibling | `new Contract()` + `parm*` | `service.process(contract)` directly (no controller, no batch) | result/side effect; `SysOperationValidatable.validate()` returns false for a bad contract | |
| **report DP** (G-24) | class extends `SrsReportDataProviderBase`/`PreProcessTempDB` | contract via `parmDataContract()`; for query DPs `parmQuery(new Query(queryStr(…)))` | `dp.processReport()` | `select count(RecId) from dp.getTmp…()` ⊙ — **probe**: is `getTmp*` callable without a report run, and does TempDB need `setConnection` here (G-20)? | the negative control: a DP that throws in `processReport` |
| **data entity** | `AxDataEntityView` | entity buffer + mapped fields | `entity.insert()` | mapped table row exists; `validateWrite` false on a bad row | probe whether direct entity `insert()` runs the lifecycle methods outside DMF |
| **number sequence** | class extends `NumberSeqApplicationModule` | `[SysTestCaseAutomaticNumberSequences]` | `NumberSeq::newGetNum(<Ref>::numRefX()).num()` | non-empty, format matches | the attribute is exactly why G-26 must precede this |
| **business event** | class extends `BusinessEventsBase` | buffer | `X::newFromY(buf).buildContract()` | contract parm values | no send |
| **form (adaptor)** (G-28) | form has a `*FormAdaptor` class in a referenced package | `CustTableFormAdaptor::construct()`/`open()` ⊙ | drive controls | assert datasource state | P2, after K |

`generate_object(pattern="systest")` gains op-spec params (no schema bytes): `testTargetType` extends its
enum to the kinds above; `attributes[]` (G-26); `arrange: "buffer"|"atl"` (G-27). `prepare(test)` writes
the recommended call with them already filled.

### 5.3 Test data

- **ATL** is the platform's own answer to "arrange"; the base mentions it in four lines. G-27 writes the
  entry from Microsoft's `AtlSampleTests` (census: which root/creator/query/spec calls appear most) and
  adds the `arrange: "atl"` variant that emits `AtlDataRootNode data = AtlDataRootNode::construct();`
  plus the module node for the target's table when one exists (index: which `AtlData*` node names the
  table — an `oracle:members` sweep over `AtlData*` classes, cached into `src/knowledge/atlNodes.generated.ts`).
  `prepare(test)` reports whether the model references the ATL packages (Descriptor scan, same code as
  TestEssentials) and says which line to add if not.
- **Isolation**: `SysTestSuiteCompanyIsolateClass/Method`, `[SysTestCaseDataDependency]`,
  `[SysTestCaseDemoDataDependency]`, `[SysTestTransaction]` — semantics from `oracle:members` + a probe
  that shows the rollback (a test writes a row; the next test asserts it is gone).
- **Number sequences, feature flags, security**: the attribute per case, with the compiled example.

### 5.4 Runner and loop mechanics

- `run_systest_class`: add op-spec-level `expectRed: true` (op-spec topic `sdlc-overrides` already
  exists — zero schema bytes) that turns "all passed" into a ❌ with the empty-assert explanation. Add
  `build: true` to chain the model build first (same lock), so the loop is two calls, not three.
- Corpus record: `systest.red_run` (`{ran, failed_as_expected}`) so `L2-tdd-red-green-cycle` can be
  scored: `score.systest` = 1 only if red failed AND green passed.
- `scripts/capture-golden.ts` (**does not exist** — every implementer re-implements the gate from memory,
  per `eval-wave-2026-08-31-remaining-cases`) — H0 item, shared by every case below.

### 5.5 Eval cases (all authored `golden_pending`, captured serially on the VM)

First, a re-run, not a new case: `L2-systest-authoring-basic` is the only case behind today's
`tdd-workflow` leaf and its last corpus record (2026-08-30) predates the runner config fix, so it still
scores `systest: null` — the leaf is green on the weaker proof. Re-run it under `SysTestConsole.exe`
before authoring anything below, so the baseline is a recorded run. Then:
`L2-tdd-red-green-cycle` (G-29, core; confirmed absent — only two prose mentions exist) · `L2-tdd-table-extension-coc` · `L2-tdd-class-extension-coc` ·
`L2-tdd-event-handler` · `L3-tdd-sysoperation-service` · `L4-tdd-report-dp` · `L3-tdd-data-entity` ·
`L2-systest-attributes-isolation` (G-26, R) · `L3-test-data-atl` (G-27, R; needs the ATL packages in the
sandbox descriptor — **owner decision D2**) · `L2-anytype-retyping-runtime` (G-02).

### 5.6 Knowledge (N axis)

`unit-testing` (consolidated, G-25) · `tdd-workflow` (process) · `systest-attributes` (G-26) ·
`test-data-atl` (G-27) · `form-adaptor-tests` (G-28, P2). `testing` retired → its id kept as a 3-line
redirect for one release so `related:` links and the taxonomy do not dangle, then removed.

### 5.7 Validator (G-31)

TST001 error `assertExpectedException` (no such method; the base already says so in prose) · TST002
error `[SysTestMethod]` in a class that does not `extends SysTestCase` (regex on the declaration; the
sweep over `*Tests`/`ATL*`/`TestEssentials` packages decides whether it holds) · TST003 warning: a
`test*` method whose body contains no `assert`/`fail(`/`parmExceptionExpected` — advisory only.

---

## 6. Reports — design

Demand for reports is low in the mined logs (0 report writes in 195), but the user's brief names report
development explicitly and the probe shows it is the second-thinnest axis. The order below is
"cheapest verified truth first".

1. **G-20 TempDB connection** [VM]: `oracle:census --grep "setConnection(" --types AxClass --examples 10`
   restricted to classes extending `SrsReportDataProviderBase` (not PreProcess). Expected: shipped DPs
   with a TempDB tmp table call `tmp.setConnection(this.parmUserConnection())` before insert. If the
   census confirms, write the rule into `ssrs-reports` + G-06, add RPT003 (warning first; error only
   if the sweep holds), and **audit the scaffold** — `generateSmartReport.ts` emits a TempDB table
   (`REPORT_TMP_KEY_FIELD` note) — does its DP call `setConnection`? If not, every scaffolded report
   renders empty at run time and no build catches it. This is exactly the "compiles ≠ correct" shape.
2. **G-21 `axreport-anatomy`** [repo + VM census]: the element tree the writer emits, with the
   semantics of each `AxReportParameter` property (`AllowBlank`, `Nullable`, `MultiValue`, `Hidden`,
   `DefaultValue`, `DataType`, `Label`), the six platform parameters, dataset ↔ tmp-table field binding,
   `DefaultParameterGroup`, `i:type` design kinds, `DataMethods` (obsolete — say so). RPT103: a
   contract `[DataMember]` with no `AxReportParameter` and a dataset field absent from the tmp table
   (on-disk read, like XML009). Census the 400 shipped reports for property distributions so the
   entry states defaults from data, not memory.
3. **G-19 runtime API** [VM `oracle:members`]: `SrsReportRunController` (`runReport`,
   `parmLoadFromSysLastValue`, `parmShowDialog`, `parmPrintDestination`?), `SrsReportRunUtil`,
   `SrsReportRunPermission`, `SrsReportParameterValidator`, `SrsReportRunCache`, `SrsReportDrillThruUtil`,
   `PrintMgmtReportFormatPublisher::publishReportFormats`, `PrintMgmtDelegatesHandler`,
   `PrintMgmtNode_*`/`PrintMgmtHierarchy_*` (which node for which document), report in batch
   (`SysOperationExecutionMode::ScheduledBatch` on the controller), cross-company DP (`crossCompany` in
   `processReport` vs `allowCrossCompany` on the query), user language (`AX_RenderingCulture`, labels).
   Write into `ssrs-contracts`, `print-management`, `report-extension-patterns`; nothing new unless a
   topic exceeds ~12 KB (the `object_patterns` cap lesson).
4. **G-23 design** [census]: function table (`Sum/First/Last/Format/IIF/Switch/RowNumber/RunningValue/
   Previous/CountDistinct/PageNumber/TotalPages`) with the census count of each in shipped RDL; layout
   rules (page header before body — the writer already enforces; page breaks; grouping; landscape/
   `PageSize`; multi-column labels); logo (`FormLetterReport`/`CompanyImage`) and barcode
   (`BarcodeCode128` → `barcodeStr()` ⊙ → font) recipes with the exact class/method names verified.
5. **G-24 DP test** — §5.2.
6. **G-22 write op** [repo, then VM]: only after a measured trim ≥ 25 chars in another schema
   (candidates: restated enum values in `d365fo_file`'s description — the v3 method). Shape per BACKLOG:
   one `report-design` operation, `action` in the op-spec. Refuses any design whose RDL was not written
   by this server (fingerprint comment in the RDL skeleton — add it now so future scaffolds are
   recognisable). Every result built on the VM; malformed RDL fails only in the renderer, so the case
   must include a render (`run_systest_class` cannot; the print-destination case can render to file —
   check whether `SrsReportRunController` in a SysTest can render to a file under `/unattended`; ⊙).
7. Cases: `L4-ssrs-report-tempdb-connection` (R if 6 works, else E) · `L4-ssrs-report-parameters`
   (hidden/default/multi-value; E + RPT103) · `L4-tdd-report-dp` (R) · `L3-print-mgmt-publish-format`
   (publisher delegate; E) · `L4-ssrs-report-logo-barcode` (E). Taxonomy leaves: `report-parameters`
   (core), `report-runtime-api` (core), `report-tempdb-binding` (core), `report-dp-tests` (core),
   `report-design-layout` (total).

---

## 7. Language core, tables, forms, entities, frameworks — design

### 7.1 Extend, do not add (G-01, 03, 04, 05, 08, 09, 11, 12, 17, 18, 32)

Each is a table appended to an existing entry, written from a census/`oracle:members` run, with the
failure mode in the same row. Budget rule from `KNOWLEDGE_AUTHORING.md` §1 applies: a row that restates
what the model already knows is deleted in review. G-09 is repo-only and comes with a test.

### 7.2 Three new catalogs (G-06, G-13, G-14, G-15)

| Entry | Built from | Reused by |
|---|---|---|
| `xrecord-buffer-api` | `oracle:probe` (kernel members — signature + one-line semantics per member; the probe class calls each member so the compiler confirms it exists and its arity) + census examples | `prepare(test)` table/entity arrange blocks; G-20; COC006's explanation text |
| `tableDataMethods.ts` full set (typed; drives `coc-authoring` and `prepare(test)`) | probe per method signature; `oracle:census --grep` for override frequency so the catalog is ordered by how often shipped tables override each | `prepare(mode="change")` "Method signature" section when the index says "not found" (today only 8 methods get this); `generate_object(mode="find-methods")` |
| `form-runtime-api` | **two oracles, per the H0 correction in §2.4**: `FormRun` (209 methods) and `xUserInfo` from `oracle:members`; `FormDataSource`, `FormDataObject` and the control classes from `oracle:probe`, because those are kernel. Plus the control-class ↔ type ↔ XML-name map exported from the generator's `getFieldControlMap` (single source, pinned by a test) | `add-control` op-spec (`controlType` enum text), `form-handler` patterns, §5.2 form tests |
| `data-entity-methods` | census over `AxDataEntityView` `<Methods>` (which lifecycle methods shipped entities override, how often) + probe | `data-entity` create op-spec; §5.2 entity tests |

### 7.3 Validator additions and the bar

Candidates: RPT003 (§6.1), RPT103 (§6.2), TST001–003 (§5.7), and **ATTR003, which shipped in H1c and was
not on the list**. The bar is unchanged: `npm run oracle:sweep` over the full install with **zero
error-severity findings**.

**ATTR003 — two attributes stacked on a METHOD.** Found while probing whether the new scaffolds compile,
and worth recording as a method as much as a rule. The first probe failed as expected but with
`Invalid token '['`, a PARSE error that names a token rather than an attribute — so it was equally
consistent with "stacking is illegal" and with "the TestEssentials claim is untrue", and proved neither.
Three follow-ups settled it:

- a census found **2,163 shipped AxClass files stack attributes**, so "stacking is illegal" could not be
  the whole story;
- a matrix probe (`coverage-v4c.ts`) showed both the short and the `…Attribute`-suffixed spellings compile
  ALONE and fail identically when stacked, ruling out name resolution;
- a second census, restricted to `<Method><Source>` blocks, found **0 of 760,583 shipped methods** stacking
  them.

So: legal above a class declaration, a parse error above a method. It earns a rule on the exact criterion
that rejected DECL001 and CONV001 — there the compiler's message was *"A local variable named 'i' cannot
be declared in this scope"*, precise and local; here it is a column number and a dead file. And the shape
is invited by our own knowledge base, which lists `[SysTestMethod]`, `[SysTestCategory]` and
`[SysTestPriority]` one under another. Both entries now say it is a menu, not a stack.

The same run also **confirmed a claim rather than correcting one**: `[SysTestCategory]` alone, without a
TestEssentials reference, fails with `Class 'SysTestCategory' was not found. Are you missing a module
reference?` The scaffold's warning and the `unit-testing` entry were right.

**ATTR003 cleared the bar.** Full-install sweep, 2026-09-02:

```
swept 105,686 files (615.3 MB of X++) in 2,504s
ERROR-severity findings (the bar is zero):  none
warnings: SEL005 17,412 · BP002 3,506 · SET001 2,103 · SEL006 1,597 · SEL004 1,560 · TTS003 1,144 · …
```

ATTR003 fired **zero** times across the install — the same answer the census gave, arrived at
independently by the rule itself, which is the check worth having: a rule agreeing with the census that
justified it is the only evidence that the rule implements the fact rather than the author's memory of it.

**Correction, measured in H0.** An earlier draft of this section claimed the sweep's type list had to
grow before TST001–003 could ship, "because the test and ATL packages have never been scanned". That was
an inference and it is false: `walkAot` iterates every package directory, filtering only by AOT *type*,
so `TestEssentials`, the nine ATL packages and the `*Tests` packages were always in scope. Measured
baseline for them on 2026-09-02, so a TST rule has a number to beat:

```
npm run oracle:sweep -- --packages TestEssentials,ATLApplicationSuite,AtlFoundation,\
  ATLTestCaseCommon,AtlSampleTests,WHSTests,FleetManagementUnitTests
→ swept 4,319 files (30.7 MB of X++) in 138.6s — ZERO error-severity findings
  warnings: BP002 303 · BP001 228 · SEL005 138 · SET001 84 · SEL004 14 · BP004 12 · DOC001 8 · …
```

So TST001–003 must hold against 4,319 real test classes, and that is checkable today with one command.
Each new rule still gets a `tests/fixtures/oracles` shape for the dry run.

### 7.4 Generator/writer

- `pattern="systest"` target kinds (§5.2) and params (§5.2, §5.3).
- Report scaffold audit (§6.1) and RDL fingerprint (§6.6).
- `report-design` op (§6.6) — only after the trim.
- Publish nothing new in the ListTools enums except what the trim pays for; the six unpublished
  patterns stay unpublished (BACKLOG).

---

## 8. Taxonomy and coverage accounting

New leaves (ids, tier, K/E/T sources): under **Quality** — `tdd-targets` (core; `unit-testing`,
`tdd-workflow`; cases §5.5), `systest-attributes` (core; G-26), `test-data-atl` (total; G-27),
`form-adaptor-tests` (total; G-28), `anytype-runtime` (total; G-02). Under **Reporting** — the five in
§6.7. Under **Code/Data model/UI/Integration** — `xrecord-buffer-api` (core), `table-methods-catalog`
(core), `form-runtime-api` (core), `data-entity-methods` (core), `integration-packs` (total; G-16).
Under **Frameworks** — `workflow-event-handlers` (total), `xds-api` (total).

Expected effect when the cases are authored: core falls from 65/65 to roughly **65/76 (≈86 %)** until the
VM captures them; that is the honest number and the same shape v2 and v3 took. `eval:coverage` is
regenerated **once at the end of the capture wave**, never mid-wave.

Two accounting fixes: the five stale v3 `note` fields (§2.1); and the seven orphan cases in COVERAGE.md
get a leaf or a `tags:` match so "unmapped proof" reads 0.

---

## 9. Phases

| Phase | Where | Work | Exit criterion |
|---|---|---|---|
| **H0 infra & truth** | repo + VM | commit `scripts/oracles/termProbe.ts` + `termMap.ts` (the §2.2 probe) and `scripts/mine-copilot-demand.ts` (redacted output only); write `scripts/capture-golden.ts` with its gates and tests; measure the sweep's coverage of the test/ATL packages (**done — it already covers them, see §7.3**); `oracle:members` batch mode over the §2.4 ✓ list → `eval/api-members.snapshot.json`; re-capture compiler facts if the platform moved; fix `ARCHITECTURE.md` rule count and the stale taxonomy notes | probe + demand + members snapshots committed; `oracle:sweep` still zero errors |
| **H1 TDD core** | repo, then VM | G-25, G-13, G-06 (K); §5.1 proactivity; §5.2 kinds table-extension CoC, class-extension CoC, event handler, SysOperation service; §5.4 runner params; probes with negative controls; cases §5.5 (first five) | probes green with controls; suite green; `L2-tdd-red-green-cycle` captured with a red AND a green run in its corpus record |
| **H2 test data & attributes** | VM | G-26, G-27 (K + scaffold params), `atlNodes.generated.ts`; cases `L2-systest-attributes-isolation`, `L3-test-data-atl` (needs D2) | both SysTests run under `SysTestConsole.exe`; rollback probe recorded |
| **H3 reports** | VM | §6.1–6.5 in order; cases §6.7 (first four) | RPT003 decided by census; scaffold audit closed either way; `L4-tdd-report-dp` runs |
| **H4 catalogs** | VM | G-14, G-15, G-10, G-12, G-17, G-18 | entries pass the three knowledge gates with a re-captured audit snapshot |
| **H5 breadth** | repo + VM | G-16 packs, G-01/03/04/05/08/09/11/32, G-02, G-28, TST rules (G-31) | sweep zero errors; coverage regenerated once |
| **H6 write op** | repo, then VM | G-22 after a measured trim | schema budget test green with the op published; case built on the VM |
| **H-close** | repo | non-goals → BACKLOG; CHANGELOG; delete this file | — |

Rough cost, by the v3 yardstick (v3 = 6 commits, ~2 VM days for 9 captures at ~35 min each, serial):
H0 ½ day · H1 2 days (5 captures + 6 probes) · H2 1 day · H3 1½ days · H4 1½ days · H5 1½ days ·
H6 ½ day. Serial on the VM because captures share `fm-mcp`; repo-only work (H0 scripts, G-09, G-25
text, tests) runs in parallel as long as it stays out of `eval/goldens|cases|corpus`.

---

## 10. Non-goals (explicit, so they can be rejected on the record)

- ALM/LCS/pipelines/deployable packages, TFVC/git workflow, version-update guidance — outside the
  copilot's tool reach; a knowledge entry would be prose the model already has.
- Extensible controls, embedded Power Apps/Power BI, SSRS sub-reports, Financial Reporting, Document
  Routing Agent internals, Key Vault/Blob SDKs — carried over from v3, no demand.
- Domain packs (tax, fixed assets, projects, HRM, retail, production, MRP, TMS) — tax only on the
  owner's ask (BACKLOG); the rest have zero demand and multi-day cost each.
- RSAT, Task recorder, performance/load tests — tooling outside the MCP surface.
- Code-quality heuristics (complexity, method length) and any rule that needs scope — the standing
  "no AST" decision; generics/`*=`/EVT001/buffer-select rules stay rejected.
- New MCP tools or new published enum values not paid for by a trim.

---

## 11. Owner decisions

- **D1** — Consolidate `testing` into `unit-testing` (G-25): rename is a breaking change for any prompt
  that names `topic="testing"`. Proposed: keep `testing` as a redirect for one minor release.
- **D2** — Add the ATL packages (`AtlFoundation`, `ATLApplicationSuite`, `ATLTestCaseCommon`, module
  ATL packages as needed) and `TestEssentials` to the `fm-mcp` sandbox descriptor so H2 can capture.
  It changes the sandbox's reference set (see `fm-mcp-sandbox-descriptor-references`); one decision,
  applied once.
- **D3** — Priority between H3 (reports) and H4 (catalogs): the plan puts reports first because the user
  named them and the scaffold audit (§6.1) may find a silent run-time defect; demand says catalogs.
- **D4** — G-22 (`report-design` op) is the only item that needs schema bytes. Approve the trim
  search, or park G-22 explicitly.

## 12. Definition of done

Every G-item either shipped with its oracle evidence cited in the commit, or moved to BACKLOG as a
dated decision. `npm run oracle:sweep` zero errors on the full install (test packages included).
`npx vitest run tests/knowledge` green on a re-captured audit snapshot. All new cases captured
(0 `golden_pending`), the R-flagged ones with a SysTest run recorded, `L2-tdd-red-green-cycle` with
both a red and a green run. `eval:coverage` regenerated once; core back at 100 % on the enlarged
taxonomy. This file deleted.
