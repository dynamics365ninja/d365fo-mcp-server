# X++ Language & Reporting Coverage Plan

Status: **Phases A–F done (Phase F executed on the VM 2026-08-29/30).**
Phase F deltas: the knowledge-audit snapshot was re-captured (309 refs, 0 defects) after the four
rules-only topics (ssrs-contracts, ssrs-rdp-preprocess, ssrs-ui-builder, attributes-authoring) and
`transactions` gained audited examples with real symbols. xppc-verified: every FN001 arity holds except
`conIns` (variadic — removed); `protected internal` compiles, `private protected` is "Conflicting
modifiers"; `forceLaterals` is not a keyword; the attribute is spelled `SrsReportParameterAttribute`
(`<Name>`, not the file name) and `SRSReportDataSetAttribute`. Two scaffold shapes were WRONG against
the real framework and are corrected in the generator, op-specs, catalog and topics: `preProcess=true`
now pairs the TempDB tmp table with `SrsReportDataProviderPreProcessTempDB`, keeps
`[SrsReportParameterAttribute]` and emits no invented `preProcess()` hook (xppc accepted BOTH bases —
the pairing is a runtime contract; the 332:38 shipped precedent decided it); `controllerType="printMgmt"`
now implements the abstract `runPrintMgmt()` and constructs the `PrintMgmtReportRun` in
`initPrintMgmtReportRun()` — `SrsPrintMgmtController` has no `parmPrintMgmtDocType` (the old scaffold did
not compile). Three write-tool defects found while capturing L2-date-effective-table were fixed with
tests (valid-time-state index properties, add-field base type for Date EDTs, empty-value
modify-property). Five goldens captured (L2-exception-tts-retry, L2-date-effective-table,
L4-ssrs-report-preprocess, L4-ssrs-report-uibuilder, L3-print-mgmt-doctype-extension) — each with a
README marked for human review (§6.4) and a corpus record; L3-print-management-report and
L3-electronic-reporting-integration already had FROZEN goldens (2026-07-29) and were left as they are.
Phase E deltas: no separate "Language" domain — the 8 grammar leaves live in the existing `Code`
domain (data-types, declarations-scope, operators, statements-flow, exceptions-tts, attributes,
intrinsics, date-effective), Reporting gained report-contracts / rdp-preprocess / report-ui-builder.
Coverage honestly dropped 100% → 88.2% core (45/51) — the closure queue now names the grammar
leaves the old artifact-type taxonomy hid. Five cases authored `golden_pending` for Phase F:
L2-exception-tts-retry, L2-date-effective-table, L3-print-mgmt-doctype-extension,
L4-ssrs-report-preprocess (doubles as the preProcess-pairing verification),
L4-ssrs-report-uibuilder.
Phase D deltas: the report-pattern catalog is a RECIPE catalog (`src/knowledge/reportPatterns/`,
7 patterns) rather than a FormPatternSpec mirror — reports have no pattern XML to validate against.
The generator gained only `uiBuilder` (UIBuilder class + SysOperationContractProcessing binding);
the planned PreProcessTempDB switch was NOT made — the preProcess path is unproven on the VM
(no golden uses it) and the TempDB pairing claim awaits Phase F verification. Op-specs for
`scaffold:report` now advertise the previously hidden aotQuery/callerTableName/preProcess/
controllerType params. New knowledge: `ssrs-contracts`, `ssrs-rdp-preprocess`, `ssrs-ui-builder`
(rules-only — zero extracted AOT refs pending the Phase F snapshot capture; examples then).
Phase C deltas vs. the original table: `CS001` (C#-isms) implemented as planned; `RPT003`/`RPT004`
were dropped (the TempDB/preprocess-attribute claims could not be verified off-VM and risked false
errors); `RPT005` landed as two cheaper checks — `ssrsReportStr` joined the FN001 fixed-arity table
(2 args) and the references mode now resolves `ssrsReportStr`/`reportStr` first arguments against
the index ('report' type). `FN001` grew from 4 to 27 functions — **Phase F must re-verify the new
arities against xppc** before trusting them further. New `xml-report` codeType runs report-only
rules (RPT101/102) so the X++ keyword rules never scan RDL CDATA.
Phase B note: new-topic AOT references are constrained to prose + `My…` placeholders (the
apiSymbols snapshot is entry-scoped and can only be re-captured on the VM). Phase F should
re-capture the snapshot and may then upgrade prose mentions (e.g. `Exception::DuplicateKeyException`
in `transactions`, `extends SysAttribute` in an `attributes-authoring` example) to audited code shapes.
Prepared: 2026-08-29. Sources: full repo inventory + Microsoft Learn X++ reference sweep (~25 pages, current as of 2026-08).

Goal: close the gap between the full X++ language (incl. SSRS report development) and what this
MCP server encodes today — in knowledge topics, validators, generators, patterns, naming rules,
and the coverage taxonomy — without breaking the tuned grounding logic (keyword-scored knowledge,
regex validators, op-spec registries, schema-byte ratchet).

---

## 1. Where knowledge lives today (baseline)

| Layer | Location | State |
|---|---|---|
| Knowledge topics | `src/tools/knowledge/xppKnowledge.ts` — 65 entries, keyword-scored | Strong on frameworks/data access; thin on core grammar and reporting |
| Syntax validation | `src/tools/analysis/validateXpp.ts` — regex heuristics, ~25 rules | No parser; no statement/exception/attribute/report rules; `FIXED_ARITY_BUILTINS` has only 5 functions |
| Reference validation | `src/tools/write/resolveReferences.ts` | Symbol-index based; intrinsics list should be synced with the full compile-time function set |
| Generation | `src/tools/smart/codeGen.ts` (28 patterns), `generateSmartReport.ts` (7-object report scaffold incl. RDL) | Report scaffold is mature; `ssrs-report-full` pattern has a design-name bug |
| Patterns | `object_patterns` → table + form domains only (`src/knowledge/formPatterns/` catalog) | **No report domain** |
| Naming | `src/utils/objectNamingRules.ts` | No `report` objectType, no DP/Contract/Controller/Tmp suffix conventions |
| Coverage | `src/eval/coverage/taxonomy.ts` | Indexed by artifact type; `select-grammar` is the only grammar leaf — no Language domain |

## 2. Language map vs. repo — gap analysis

Legend: ✅ covered · 🟡 partial (expand existing topic/rule) · ❌ missing (new content)

### 2.1 Core language
| Area | Constructs | State |
|---|---|---|
| Data types & conversions | primitives incl. `anytype`/`utcdatetime`/BCD `real`, literals (`21\11\1998`, verbatim `@'…'`), null-equivalent values, `any2*`/`str2*`/`*2str` family, containers (`conPeek/conPoke`, `[a,b]=con`), EDT `Extends` semantics | ❌ no topic; `xpp-collections` covers collection classes only |
| Variables & declarations | declare-anywhere, no shadowing (compile error), `var`, `const`/`readonly`, `using` clauses + aliases, `using(){}` disposable statement, optional params + `prmIsDefault()` | ❌ |
| Operators | precedence table (**`&&` and `||` have EQUAL precedence — differs from C#**), `like` wildcards, `DIV`/`MOD`, ternary, `is`/`as` | ❌ |
| Statements | `switch` fallthrough (deliberate), comma case lists, loops, removed keywords (`pause`, `window`) | 🟡 BP004 flags `pause`/`print`; no topic |
| Exceptions & tts | Exception enum; **inside tts only explicit `catch(Exception::UpdateConflict)` / `::DuplicateKeyException` are catchable**; `retry` semantics (jumps to try start, infinite-loop risk); `finally` in tts scope; CLR interop catch; throw auto-aborts tts | 🟡 `error-handling` + `transactions` exist — verify/extend with tts-catch matrix and retry-guard rule |
| Macros | `#define/#localmacro/#macrolib/#defInc`, `%1..%n`, classDeclaration inheritance quirk; officially discouraged | ✅ `macros` topic — verify it flags legacy status |
| Attributes | SysAttribute authoring, literal-only ctor args, reflection retrieval (DictClass.getAllAttributes), `SysObsoleteAttribute` | ❌ |
| Casting | up/down cast, `is`/`as` (as → null), late binding via `Object`, `Common`→`xRecord` hierarchy | ❌ |

### 2.2 OOP
Mostly 🟡: `xpp-class-rules` / `class-inheritance` exist. Verify they state: **no method overloading**, single `new()` (no ctor overloads), no C# properties (parm pattern), no generics/lambdas in X++, `internal` = same-model, local functions, extension methods via static `*_Extension` classes, static ctor `TypeNew()`, delegate declaration syntax + `+=  eventhandler(...)` subscription. Add what's missing to existing topics (don't create near-duplicates — keyword scoring punishes overlap).

### 2.3 Data access
| Area | State |
|---|---|
| `select` grammar | 🟡 `select-statement` exists — diff it against the FULL find-option list: `firstFast`, `firstOnly10/100/1000`, `noFetch`, `forcePlaceholders`, `forceSelectOrder`, `forceNestedLoop`, `optimisticLock`/`pessimisticLock`, `repeatableRead`, `validTimeState(from,to)`, `f in container`, `index` vs `index hint` (+ `allowIndexHint(true)` prerequisite), outer-join-is-left-only / no `on` keyword |
| Set-based DML | ✅ `set-based` — verify `RecordSortedList.insertDatabase`, set-based fallback triggers, DuplicateKey-not-catchable-for-set-ops |
| SysDa | ✅ `sysda` — verify builder/expression class enumeration matches Learn (16 hints, `generateOnly`) |
| Date-effective | ❌ no topic (`validTimeState`, `ValidTimeStateFieldType`, auto-downgrade of set ops) |
| Intrinsics | 🟡 sync `resolveReferences.ts` intrinsic list + a new knowledge rule with the full compile-time function catalog (60+ incl. `ssrsReportStr`, `menuItemOutputStr`, `dataEntityDataSourceStr`, workflow/measure/web variants) |

### 2.4 Extension model
✅ Strong (`coc`, `coc-authoring`, `event-handlers`, `sysextension`). Verify presence of: `[Hookable(false)]`/`[Wrappable]`/`[Replaceable]` semantics, CoC-in-try/catch (PU21+), unimplemented-system-method wrapping (PU22+), form nested-type CoC targets (`formDataSourceStr`/`formControlStr`), extension-of-Global for global functions, `EventHandlerResult` respond pattern.

### 2.5 Reporting — the big gap (focus area)
| Item | State |
|---|---|
| `ssrs-reports` topic | 🟡 **rewrite**: 8 terse rules, no `examples[]`, stale tool name ("Use generate MCP tool" → `generate_object(mode="scaffold", objectType="report")`), missing `preProcess`, `additionalDatasets`, `designStyle`, `AxMenuItemOutput`; `related` doesn't link `print-management` (asymmetric) |
| Pre-processed RDP | ❌ no topic: `SrsReportDataProviderPreProcess` (regular table + `createdTransactionId`) vs `SRSReportDataProviderPreProcessTempDB`; 10-min interactive timeout as the trigger; migration steps |
| UI builders | ❌ `SrsReportDataContractUIBuilder`, `[SysOperationContractProcessing]`, dialog field lookups/events |
| Contract taxonomy | ❌ RDP vs RDL (`SrsReportRdlDataContract`) vs composite (`SrsReportDataContract`) vs print (`SRSPrintDestinationSettings`) contracts |
| Print mgmt dev | 🟡 `print-management` topic exists — extend with dev extension points: extend `PrintMgmtDocumentType` enum, `PrintMgmtNode` subclass, `getDefaultReportFormatDelegate`/`getQueryTableIdDelegate` |
| ER / modern path | 🟡 `electronic-reporting` exists — add decision guidance (SSRS vs ER vs Business Document Management) + 2024-26 deprecations: custom assemblies in SSRS unsupported, embedded drill-through links removed, VS2022-only tooling |
| Report patterns | ❌ no `domain="report"` in `object_patterns` |
| Report naming | ❌ no conventions for `…DP`/`…Contract`/`…Controller`/`…Tmp`/`…UIBuilder`, no `report` objectType in naming validator |
| Report validation | ❌ zero rules — no DP/contract/controller shape checks, no AxReport XML codeType |
| **Known defect** | `codeGen.ts:756` — `ssrs-report-full` pattern emits `ssrsReportStr(${name}, Design)` but every scaffolded AxReport names its design `Report` (`generateSmartReport.ts:968`, `xmlTemplateGenerator.ts:712`) → generated controller cannot compile against the scaffolded report |

### 2.6 Verified-current facts worth encoding as rules
- No new X++ syntax through 2026 (no string interpolation, generics, lambdas, pattern matching) — good "don't hallucinate C#" guardrails.
- `Global::runClassMethodIL` removed; `client`/`server` keywords ignored; `pause`/`window` are compile errors.
- Deprecations feed: OnDBSynchronize event, SystemNotificationsManager.AddNotification, RSAT (after 2027-05), Export to Azure Data Lake (2026-11-30 → Synapse Link/Fabric).

---

## 3. Work plan

Ordered so that everything through phase D is **repo-only** (runs on this Mac, gated by the
existing vitest suites); phases E–F need the VM.

### Phase A — Quick fixes (small PR, immediate)
1. **Fix** `src/tools/smart/codeGen.ts:756`: `ssrsReportStr(${name}, Design)` → `ssrsReportStr(${name}, Report)`; add a regression test asserting the two report paths (`pattern="ssrs-report-full"` vs `scaffold`) agree on the design name.
2. **Rewrite** the `ssrs-reports` topic (see 2.5): correct tool reference, add `examples[]` (DP + controller skeletons that pass `runRules`), add `preProcess`/`designStyle`/`additionalDatasets`/menu-item facts, fix `related` to include `print-management`.
3. Gates: `npx vitest run tests/knowledge tests/tools` (examples run through `runRules`; `apiSymbols.test.ts` — new symbol names must resolve against `eval/knowledge-audit.snapshot.json`; if a name isn't in the snapshot, mark for VM re-capture in Phase F rather than guessing).

### Phase B — Language knowledge pack (repo-only)
New topics in `KNOWLEDGE_BASE` (keep each within the concise-format budget; `TOPIC_BATCH_BUDGET` is 14 000 chars for 10 topics — target ≤1 300 chars/topic in concise form):
1. `xpp-data-types` — primitives, literals, null-equivalents, conversion-function family, container ops, EDT extends semantics.
2. `xpp-declarations` — declare-anywhere, `var`, `const`/`readonly`, no shadowing, `using` clauses/aliases/statement, optional params + `prmIsDefault`.
3. `operators-precedence` — full table; the `&&`/`||` equal-precedence trap; `like`; `is`/`as`; DIV/MOD.
4. `switch-loops` — fallthrough semantics, comma case lists, do/while/for, removed keywords.
5. `exception-tts` — catchability matrix inside tts, `retry` mechanics + guard pattern, `finally`, CLR catch, throw-aborts-tts. Cross-link (don't duplicate) `error-handling` and `transactions`; move overlapping rules rather than restating them.
6. `attributes-authoring` — SysAttribute, literal args, reflection retrieval, SysObsoleteAttribute.
7. `intrinsic-functions` — the full compile-time function catalog (table-style rules).
8. `date-effective` — validTimeState select clause, table properties, set-op downgrade.

Expansions (existing topics): `xpp-class-rules` (+no overloading, no properties, no generics/lambdas, local functions, extension methods, TypeNew), `event-handlers` (+delegate declaration syntax, subscription ordering, EventHandlerResult), `select-statement` (+missing find options per 2.3), `coc` (+Hookable/Wrappable/Replaceable, PU21/22 rules), `macros` (verify legacy framing).

Registry touches per topic: `KNOWLEDGE_BASE` entry → optional ID-table row in `src/prompts/systemInstructions.ts:124-141` → `knowledgeIds` in taxonomy (Phase E). Follow `docs/KNOWLEDGE_AUTHORING.md`.

### Phase C — Validator expansion (repo-only)
New rules in `validateXpp.ts` (regex-feasible, low-false-positive first; register in `XPP_RULES`, document in header):
| Rule | Check |
|---|---|
| `TTS002` | `catch` inside a `ttsBegin…ttsCommit` region whose filter is not `Exception::UpdateConflict`/`::DuplicateKeyException` → warn (dead catch — exception propagates out of tts) |
| `TTS003` | `retry` with no visible counter/state guard in the catch → warn (infinite-loop risk) |
| `SEL006` | `index hint` used → advise `allowIndexHint(true)` prerequisite |
| `SEL007` | `left join` / `right join` / `on` keyword in select → error (not X++; criteria belong in `where`, outer join is left-only) |
| `CS001` | C#-isms that compile-fail in X++: string interpolation `$"…"`, lambda `=>`, generics `List<T>`, `foreach`, `new()` object initializers → error with the X++ equivalent in the message |
| `FN001` data | Extend `FIXED_ARITY_BUILTINS` from 5 functions to the full runtime-function set (source list from Learn; arity-verify against real metadata on VM in Phase F) |

Also: sync the intrinsic-function list in `resolveReferences.ts` with the full catalog (2.3), so `validate_code(mode="references")` recognizes `ssrsReportStr`, `menuItemOutputStr`, `dataEntityDataSourceStr`, workflow/measure/web variants.

Report-shape rules (new; `codeType: 'xpp'` heuristics keyed on `extends SrsReportDataProvider*` / `SrsReportRunController`):
| Rule | Check |
|---|---|
| `RPT001` | DP class w/ contract usage but missing `[SRSReportParameterAttribute(classStr(...))]` |
| `RPT002` | DP dataset getter missing `[SRSReportDataSetAttribute(...)]` |
| `RPT003` | `SrsReportDataProviderBase` populating a non-TempDB tmp table (heuristic via naming/`xml-table` cross-check where available) |
| `RPT004` | `SrsReportDataProviderPreProcess*` mismatches (InMemory table with preprocess base) |
| `RPT005` | controller `ssrsReportStr(X, D)` — when the AxReport is in the symbol index, verify design `D` exists (reference-mode check in `resolveReferences.ts`) |

New `codeType: 'xml-report'` in `validateXpp.ts:55` **and** `src/server/toolSchemas/validateCode.ts:28` (schema-ratchet: enum value only, keep description in op-specs): AxReport XML rules — dataset `Query` references an existing DP class, `DataSourceType=ReportDataProvider` consistency, design-name presence.

Tests: extend `tests/tools/validate-xpp.test.ts` + new `tests/tools/report-rules.test.ts`; every new knowledge `examples[].code` must pass `runRules` (existing gate).

### Phase D — Reporting pack (repo-only)
1. **`domain="report"` in `object_patterns`** (`src/tools/knowledge/objectPatterns.ts` dispatcher + new `src/knowledge/reportPatterns/` catalog mirroring `formPatterns/` structure). Initial patterns: `simpleList`, `groupedWithTotals` (both already exist as RDL generators — document them), `headerDetail`, `preProcess`, `printMgmtFormLetter`, `queryBased`, `uiBuilderDialog`. Each: when-to-use, object roster, method stubs, cross-checks.
2. **Naming**: add report suffix conventions (`DP`, `Contract`, `Controller`, `Tmp`, `UIBuilder`) to `src/utils/objectNamingRules.ts`; add `report` to the objectType enum in `src/server/toolSchemas/validateObjectNaming.ts:16`; keep `namingValidatorAgreement.test.ts` green (generator output must satisfy the new rules — fix the generator or the rule, not the test).
3. **Generator**: extend `generateSmartReport.ts` — optional UIBuilder emission (+`SysOperationContractProcessing` hookup), preprocess variant selecting `SRSReportDataProviderPreProcessTempDB`, parameter grouping. Add `pattern="ssrs-report-uibuilder"` or fold into the existing `ssrs-report-full` via option (prefer option — 28 patterns is already a wide enum).
4. **New/updated knowledge topics**: `ssrs-rdp-preprocess`, `ssrs-ui-builder`, `ssrs-contracts` (taxonomy of the 4 contract kinds), print-management dev extension (expand existing topic), ER-vs-SSRS decision + deprecations (expand `electronic-reporting`).

### Phase E — Coverage taxonomy + eval authoring (repo-only)
1. Add a **`Language` domain** to `src/eval/coverage/taxonomy.ts` with leaves: `data-types`, `operators`, `statements-flow`, `exceptions-tts`, `attributes`, `intrinsics`, `date-effective` (plus existing `macro`, `delegate`, `select-grammar`, `transactions` re-homed or cross-referenced). Reporting leaves: `rdp-preprocess`, `ui-builder`, `report-naming`. Run `npm run eval:coverage` to regenerate `eval/COVERAGE.md` — the percentage will honestly drop; that is the point (the current 100% is an artifact-type illusion, per `eval/README.md:234`).
2. Author eval cases via the `eval-author` skill (all `golden_pending`): `L2-exception-tts-retry`, `L2-date-effective-table`, `L4-ssrs-report-preprocess`, `L4-ssrs-report-uibuilder`, `L3-print-mgmt-doctype-extension`. Keep the two existing pending report cases (`L3-print-management-report`, `L3-electronic-reporting-integration`) in the same VM capture batch.

### Phase F — VM session (requires platform)
Checklist for the implementation session on the VM (mcp-server full mode + bridge, Contoso sandbox):
1. **Re-capture `eval/knowledge-audit.snapshot.json`** — every AOT symbol named by new/edited topics must resolve live (this is the gate that cannot run on the Mac).
2. **Verify flagged unknowns against real metadata/compiler** and correct the repo content accordingly:
   - exact spelling of `SRSReportDataSetAttribute` (AX2012-sourced),
   - existence/signatures of `SrsReportRunUtil`, `SrsPrintMgmtController`/`SrsPrintMgmtFormLetterController`,
   - whether `private protected` / `protected internal` combined modifiers compile,
   - whether `forceLaterals` is accepted by the compiler,
   - arities for the expanded `FIXED_ARITY_BUILTINS` set.
3. **Capture goldens** for the Phase E cases (implement → `build_d365fo_project` 0 errors → `run_bp_check` → freeze → roll back).
4. **End-to-end report scaffold check**: `generate_object(scaffold, report)` with the new options → build → confirm the Phase A design-name fix compiles.
5. Update case statuses from `golden_pending`, regenerate `eval/COVERAGE.md`, final PR.

---

## 4. Constraints & guardrails (do not regress the tuned setup)
- **Schema-byte ratchet** (`tests/utils/toolSchemaBudget.test.ts`): new enum values only in wire schemas; all prose goes to op-spec registries (`opSpecs.ts`, `generateObjectOpSpecs.ts`).
- **Knowledge budget**: concise format is the default render; examples show only in detailed. Keep summaries/rules tight; don't create overlapping topics that split keyword score.
- **No parser ambitions**: stay with masked-regex heuristics + symbol-index cross-checks; real compilation stays out-of-band (`build_d365fo_project`, `run_bp_check`). A rule that can't be written with low false positives is written as knowledge instead.
- **Snapshot gate**: never hand-edit `eval/knowledge-audit.snapshot.json`; symbols we can't verify off-VM wait for Phase F.
- Git remote is `d365fo-mcp-server` (not `origin`) for pushes/PRs.

## 5. Suggested PR slicing
| PR | Content | Runs where |
|---|---|---|
| 1 | Phase A (bug fix + ssrs-reports rewrite) | Mac |
| 2 | Phase B (language topics + expansions) | Mac |
| 3 | Phase C (validator rules + intrinsics sync) | Mac |
| 4 | Phase D (report patterns domain + naming + generator) | Mac |
| 5 | Phase E (taxonomy + eval cases, pending) | Mac |
| 6 | Phase F (snapshot, goldens, verifications, status flips) | **VM** |
