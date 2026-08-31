# X++ language, reporting & TDD coverage — plan v3 (2026-08-31)

**Status: H0–H5 are implemented on `feat/xpp-coverage-v3`. What is left is
evidence, not code:** nine authored cases are `golden_pending` and need an
`eval-run` capture on the VM (§6), and the four `systest_pending` cases still
depend on owner decision D1 (§7).

**Lifecycle.** v1 (A–F) and v2.1 (G0–G5, G-VM) were executed and their content
removed; the durable record is `eval/COVERAGE.md`, `eval/README.md`, the goldens'
READMEs and memory. This file follows the same rule: **delete it once the capture
in §6 is done**, moving anything not built into `docs/BACKLOG.md` as a decision.

---

## 1. What this round was, and why it was not "more of the same"

Coverage read 100/100 and every leaf was green. That number is indexed by
**artifact** (table, form, SSRS report) and by cross-cutting topics — so a
construct that is not an artifact could not make it fall. This plan was built the
other way round: a construct-level map of the language against the live sources
(84 knowledge entries, 44 validator rules, 32 generator patterns, 35 write
operations, 112 eval cases), plus a mining pass over the **1,593 real MCP calls**
in this machine's Copilot logs.

**What the demand data said** (46 sessions, 3,239 tool calls): `get_object_info`
345 · `labels` 308 · `get_knowledge` 250 · `d365fo_file` 195 · `search` 90 ·
`prepare` 88 · `generate_object` **5**. Of the ~45 knowledge lookups, about
**thirty were variations of one question**: the table CoC contract —
`validateWrite`, `next` placement, `checkFailed`, `orig()`. The daily loop is
extension work on tables, forms, enums and labels.

**What that made P1**, and what shipped for it: the table-method TDD target
(§2.3), the lookup/query/system-object topics (§2.2), and the two XML rules whose
defects had both failed on the *wrong object* (§2.4).

---

## 2. What shipped

### 2.1 The oracle harness (H0.1, H0.3) — `scripts/oracles/`
The census, the validator sweep and the xppc probe harness existed **only in
session scratchpads**. The measurements behind the compiler-verified wave —
7,649 files, zero false positives — could not be re-run by anyone.

| Script | Answers | npm |
|---|---|---|
| `aotSource.ts` | shared walk of `PackagesLocalDirectory` + CDATA extraction | — |
| `census.ts` | *does anyone write this, and how* (masked, so a literal cannot count) | `oracle:census` |
| `validatorSweep.ts` | every rule over Microsoft's own X++; **bar: zero error-severity** | `oracle:sweep` |
| `aotMembers.ts` | what a framework class really exposes, from its AOT XML | `oracle:members` |
| `xppcProbe.ts` | *does this COMPILE*, in a real model, with the exact diagnostic | `oracle:probe` |

Two guards in the probe harness, both for the failure that once cost a wrong
"verified" claim — **a probe that reports nothing is not a probe that passed**:
class and method names are DERIVED from the source (xppc ignores a body whose
name disagrees with its artifact name), and every batch carries a negative
control that must fail or the run is declared invalid. Both fired during this
work.

`--dry` runs the sweep against `tests/fixtures/oracles`, a corpus of the five
shapes that DID false-positive before the shared lexer, so CI holds the bar with
no D365FO install.

### 2.2 Knowledge (H1)
New: `lookups`, `global-class-statics`, `system-objects`,
`report-print-destinations`, `document-attachments`, `rdl-design-expressions`.
Extended: `query-object-model`, `sysoperation`, `bp-rules`, `deprecated`,
`ssrs-rdp-preprocess`.

**Every API name came from an oracle, and several corrected this plan's own
drafts** — which is the point of the rule:

| Claim as drafted | What the oracle said |
|---|---|
| `SysReferenceTableLookup::newParameters(tableNum, FormStringControl)` | argument 2 must be a **FormReferenceControl** |
| `registerOverrideMethod(..., methodStr(Cls, staticHandler), ...)` | "must not specify a static method" — the handler is an **instance** method |
| `DocumentManagement::attachFile(..., DocuType record, ...)` | argument 4 is a **DocuTypeId** (a string) |
| `SysOperationProgress::newGeneral(0, …)` | first argument is a **str**; `setTotal`/`incCount`/`setText` are on the BASE class |
| `infolog.line()` | **obsolete** — "use the infologLine method on the Global class" |
| `SysComputedColumn::comparisonExpression` | it is `comparisonField` (and `comparisionExpressionList`, Microsoft's own typo) |
| "`SecurityRights` does not exist" (from an AOT read) | it **does** — a kernel class; the compiler resolves it and refuses a bogus method on it |
| render a report to bytes | `SrsProxy.renderReportToByteArray` compiles **with** "marked InternalUseOnly"; teach print-to-file instead |
| `prmIsDefault` is a predefined function | it is a compiler **form**: "PrmIsDefaultIllegal: The name of a default parameter must be passed" |

Report facts come from a census of 400 shipped reports: design kind is an XML
`i:type` (**precision 416 : auto 56**), zero RDL `<Code>` blocks, and six
platform parameters including `AX_RdpPreProcessedId` (346), which nobody here
knew about.

### 2.3 TDD for a table method (H3.1)
`prepare(mode="test")` and `pattern="systest"` accepted **classes only**. A
table's rules run on a buffer, answer with a boolean and report through the
infolog rather than throwing, so `new X()` and `parmExceptionExpected` are the
wrong shape for every one of them.

Now: `prepare(mode="test", objectName="CustTable.validateWrite")` resolves
tables, says which kind the target is, and emits the scaffold call with
`testTargetType: "table"`. The scaffold arranges a buffer with `initValue()`,
asserts the verdict **and** the infolog line, and writes the ACCEPTING case
beside the rejecting one. Compile-verified first (probe `TableMethodTest`). Zero
schema bytes — the parameter lives in the op-spec.

### 2.4 Validator (H2) — and seven regressions the sweep found
Five rules shipped: **XML008** (an `AxTableExtension` carrying `<Methods>`),
**XML009** (a control bound to an undeclared field group — a full build catches
it, an incremental build does not), **DOC001**, **SET001**, **OP001**.

Then the first full-install sweep ran — **105,686 files, 615 MB** — and failed
the bar 99 times across six rules, five of which had shipped in earlier waves:

| Rule | Hits | Why it was wrong |
|---|---:|---|
| ATTR001 | 72 | an attribute argument carrying an inline comment; the masker keeps the opening `/*` and blanks the closing `*/`, so a "strip closed comments" fix matched nothing |
| SEL010 | 14 | `validTimeState` as an ordinary method name in the SysDa API |
| FN001 | 7 | `new Info()`, and a **local function** shadowing a predefined name — the third place the compiler's own message says it looks |
| CS001 | 3 | `public string …` in a file that opens `using string = System.String;` — legal X++, and 448 shipped files do it |
| COC003 | 1 | the platform ships `..._extension` in lower case |
| RPT001 | 1 | an **abstract** DP base whose concrete subclasses carry the attribute |
| SEL008 | 1 | a select inside a `#localmacro` is a fragment; the matcher ran past `#endmacro` |

`DOC001`, added hours earlier in this same wave, was error-severity and fired on
shipped code too (a bare `&` in 4 of 6,000 AxClass files, a bare `<` in 9). It is
a warning now — BPXmlDocMalformed is a best-practice finding, not a build stopper.

The shared lexer had **no tests at all**, which is how its documented
"delimiters survive" contract could be false for `*/` unnoticed. 16 tests pin it.

### 2.5 Taxonomy and cases (H5, H0.4/H0.5 partial)
Nine leaves added — `lookups`, `global-statics`, `system-objects`,
`query-object-model-advanced`, `sysoperation-query-param`, `runbase-lifecycle`,
`rdl-expressions`, `report-destinations`, `document-attachments` — with nine
authored cases, all `golden_pending`. **Core coverage fell 100% → 90.8%, total to
91.7%.** That is the honest number: it was never 100% for these constructs;
there was nothing to count.

Also: `generate_object` accepts 32 patterns and publishes 26. The six hidden ones
were never a decision, and two are named by eval cases that tell an implementer
to call something the tool does not offer. `tests/tools/patternEnumParity.test.ts`
makes every difference an explicit, justified entry, and the op-spec (free) names
them. Publishing them was **declined** on budget grounds — `generate_object` is 5
calls in 1,593.

---

## 3. Merge rules (unchanged)
Extend before duplicating · ≤ ~1,300 chars per entry · no contradictions ·
rule-or-knowledge, not both · **no AST, one shared lexer** · one intrinsics table ·
schema-byte ratchet · eval-first · snapshot gate · deferrals to BACKLOG ·
**compiler-truth gate**: nothing enters knowledge, a rule or a template without an
oracle reference.

---

## 4. Schema budget
`TOTAL_BUDGET` 45,000; measured 44,936 before and after — **this wave spent
zero**. `testTargetType` lives in the op-spec; the pattern enum is unchanged; the
six unpublished patterns stay unpublished.

---

## 5. Probes run (39 across two batches, both with a live negative control)
Results are in `.oracle-probe-v3*.json` (not committed — regenerate with
`npm run oracle:probe -- --file scripts/oracles/probes/coverage-v3b.ts`).
Batch 1: 22 probes, 9 surprises — most of them **this plan's errors**, and each
one a fact worth keeping (`client` is a reserved word and cannot name a variable;
`CustTableListPage` is not in the sandbox reference set). Batch 2 re-asked every
question in the shape the compiler accepts: **17 probes, 15 compile, 0 surprises.**

Still open, deliberately: P2 (`anytype` re-typing at run time) needs a SysTest, so
it waits on D1.

---

## 6. What is left — the capture

Nine cases are authored and `golden_pending`; each needs `eval-run` on the VM to
implement → build → score → capture → roll back. Until then they prove nothing,
which is why coverage counts them as uncovered:

`L2-lookup-reference-multiselect` · `L2-query-range-expression-sysqueryrangeutil` ·
`L2-system-objects-infolog-box` · `L2-global-statics-access-checks` ·
`L3-sysoperation-query-parameter-batch` · `L3-runbase-coc-pack-unpack` ·
`L3-attachment-docuref-pdf` · `L4-ssrs-report-print-destinations` ·
`L4-ssrs-report-design-rdl`

Then: `npm run eval:coverage`, the §6.4 human sign-off on the new golden READMEs,
and **delete this file**.

---

## 7. Owner decisions

| # | Decision | State |
|---|---|---|
| **D1** | Copy the four `DataAccess.*` values from `WebRoot\web.config` into `Bin\SysTestConsole.exe.config`. Without it the whole **runtime** column stays unprovable — four cases are `systest_pending` and `L2-tdd-red-green-cycle` cannot be authored honestly. | **owner applied it 2026-08-31**; a live `run_systest_class` still has to confirm the connection before the four flags flip |
| D2 | P3 breadth (journals, tax, e-mail, file-io, HTTP/JSON) | **partly taken**: `document-attachments` shipped (probe-verified) and the CLR entry points were confirmed reachable (`HttpClient`, `Newtonsoft.Json.Linq`, `OfficeOpenXml`, `Regex`, `FormJsonSerializer` all compile in the sandbox). `email-sending`, `file-io`, `tax-framework`, `posting-engine` extensions → BACKLOG |
| D3 | `d365fo_file` operations on a scaffold-owned AxReport | **not built** → BACKLOG, with the budget arithmetic |
| D4 | Drop DECL001/CONV001 if they cost false positives | **not built**: the sweep's own evidence argues against them — the two rules of that shape already produced 75 of the 99 findings, and the compiler's messages for both are exact and immediate |

---

## 8. Non-goals & already-decided
Extensible controls, sub-reports, Power BI embedded, Key Vault/Blob SDK,
Financial Reporting → BACKLOG. Context ranker in `search` stays **rejected**. No
new tool; no AST. The generics rule, `*=`/`/=`, EVT001 and the
buffer-select-expression rule stay dropped on compiler evidence.
