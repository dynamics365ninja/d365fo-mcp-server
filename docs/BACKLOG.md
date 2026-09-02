# Backlog — deferred work & future ideas

Things we consciously decided **not** to build yet, with enough context to pick
them up cold later. Each entry records *what*, *why deferred*, *the trigger that
should un-defer it*, and a concrete *sketch* so the next person doesn't re-derive
the design.

> Add a new item when you defer something during a PR. Move it to a commit (and
> delete it here) when it ships. Keep entries small and honest about the unknowns.

> **When something is rejected rather than shipped, it stays here** — rewritten as
> a decision (`Status: rejected <date>`), with the reasons and with what evidence
> would reopen it. A deleted rejection is indistinguishable from an idea nobody
> ever had, so the next person proposes it again and re-derives the whole
> argument. Deferrals expire into decisions; the decision is the valuable part.

> **Restored 2026-08-08.** This file was deleted by `5ef1413` ("clean up repo and
> consolidate docs") with all three items still open and not migrated anywhere —
> so the deferral rationale, the triggers and the design sketches were lost. It is
> back because that context is the whole point of the file: without it, the next
> person re-derives (or silently re-litigates) a decision that was already made.
> Editorial notes added on restore are marked *[2026-08]*.

---

## Live SysTest runs — UNBLOCKED and CLOSED 2026-08-31

**Status:** **resolved and closed 2026-08-31.** The owner applied the config copy on
the VM, the runner reached the database, and all four cases have since RUN their
tests. Kept here (rather than deleted) because the diagnosis was wrong twice before
it was right.

**What changed.** `compareSysTestDataAccess` reports all four `DataAccess.*`
settings in agreement with `WebRoot\web.config`, and `SysTestConsole.exe
/test:<a class that does not exist> /unattended` now prints

    [SysTestSuite.Rainier Test Suite] [initial partition: [UT01], initial company: [DAT] …] Suite started
    Rainier Test Suite : 0 Run, 0 Failed

— real AOS session data, so the connection is open. That also answers the one
UNKNOWN this entry carried: the 828-character encrypted password blob **is**
decryptable by the account the runner executes as, so no second blocker was hiding
behind the first.

**What was owed, and is now done.** The four cases have each been re-run.
`L2-coc-extension`, `L2-event-handler-basic` and `L3-batch-basic` passed **2/2**
apiece under `SysTestConsole.exe` ("Rainier Test Suite : 2 Run, 0 Failed"), and
`L3-enum-field-form-downgrade-guard` ran green too; the corpus records
(`eval/corpus/runs/2026-08-31T2*__*__278eee3.json`) carry
`systest: {"ran": true, "passed": true}` and `score.systest: 1`. **No case carries
`systest_pending` any more**, and 0 of the 120 cases are `golden_pending`.
`L2-tdd-red-green-cycle` — the case that proves the loop rather than the authoring
— can now be authored honestly, which it could not be while no test had ever
executed. That is the only item this entry still points at.

<details>
<summary>The original entry, kept for the diagnosis history</summary>

**Status:** open, parked as its own topic 2026-08-30. Not a code change; nothing in
this repo can close it.

**What.** Four eval cases carry `systest_pending: true` — `L2-coc-extension`,
`L2-event-handler-basic`, `L3-batch-basic`, `L3-enum-field-form-downgrade-guard`.
Their goldens are captured and they build clean; what has never run is the live
SysTest, which is the runtime-correctness half of the oracle (§6.3). Until it does,
those cases prove that the code COMPILES and nothing more.
*[2026-08-31] All four have now run and passed; none carries `systest_pending`.*

**Why it is stuck — and why the recorded reason was wrong.** `SysTestConsole.exe`
now starts (two earlier assembly faults were fixed by config edits, each with a
backup) and stops at `Login failed for user 'AOSUser'`. That was recorded as a
rotated deployment credential and it is not one. **Nothing rotated.**
`PackagesLocalDirectory\Bin\SysTestConsole.exe.config` is the shipped template,
never configured for this machine, and it disagrees with the AOS's own
`WebRoot\web.config` — same disk, works — on all four DataAccess settings:

| setting | SysTestConsole.exe.config | web.config (the working one) |
|---|---|---|
| `DataAccess.Database` | `AxDbRain` | `AxDB` |
| `DataAccess.SqlUser` | `AOSUser` | `axdbadmin` |
| `DataAccess.DbServer` | `.` | the real host name |
| `DataAccess.SqlPwd` | `$CREDENTIAL_PLACEHOLDER$` | an 828-character encrypted blob |

**Why deferred.** The fix copies four values between platform config files. That
edits the install and moves a secret, so it is the machine owner's call, not a
tool's — and an assistant's sandbox classifier blocks it outright, correctly.

**Trigger to un-defer.** Someone applies it on the VM: back up
`SysTestConsole.exe.config`, copy the four `DataAccess.*` values from
`WebRoot\web.config` **verbatim** (the password is an encrypted blob — copy, never
retype), re-run `run_systest_class`. If it then connects, flip the four cases'
`systest_pending` to false as each one actually runs, and record the runs in the
corpus.
*[2026-08-31] Applied, and the trigger fired: all four ran, all four flags are
false, and the corpus records are committed.*

**What was done instead.** `run_systest_class` performs the comparison itself and
names the settings that differ, never printing the password — only "the shipped
`$CREDENTIAL_PLACEHOLDER$`" or "set (N chars, not shown)". So the next person is
not sent hunting a password that was never wrong.
`compareSysTestDataAccess` and its five tests are in
`src/tools/sdlc/sysTestRunner.ts` / `tests/tools/sysTestRunner.test.ts`.

**Unknown.** Whether SysTestConsole can decrypt that blob at all: it is protected
for the AOS service account, and the runner may execute as a different user. If it
starts and still fails after the copy, that — not the config — is the real blocker,
and running from Visual Studio Test Explorer stays the fallback.
*[2026-08-31] It can. The unknown is closed.*

</details>

---

## v3 breadth pack — deferred, each with a probe result already in hand

**Status:** deferred 2026-08-31 · **Area:** `src/tools/knowledge/xppKnowledge.ts`

**What.** Four knowledge topics the v3 map identified as real gaps (zero hits in
the knowledge base) and that this round did NOT ship, because the P1 half of the
plan filled the day:

- `email-sending` — `SysMailerMessageBuilder` (setFrom/addTo/addCc/setSubject/
  setBody/addAttachment) + `SysMailerFactory::sendNonInteractive`. **The shape
  already compiled** in probe `MailerBuilder`.
- `file-io` — widen the read-only `file-readers` topic: write CSV, XLSX through
  `OfficeOpenXml.ExcelPackage`, and `File::SendFileToUser(stream, name)` for the
  download. Both compiled (probes `ClrExcel`, `FileSendToUser`).
- `http-json-xml` — `System.Net.Http.HttpClient`, `FormJsonSerializer`,
  `Newtonsoft.Json.Linq`, `System.Text.RegularExpressions.Regex`. All four
  resolve in the sandbox model (probe `ClrHttp2`, `ClrNewtonsoft`). Note the trap
  that probe found: `client` is a RESERVED WORD, so it cannot name the variable.
- `tax-framework` — TaxTrans/TaxTable/TaxGroup/TaxDirection and the legacy `Tax*`
  posting classes. This one is the only one that needs **domain review by the
  owner** before it ships; it is also the domain of the only live user in the
  usage data.

**Why deferred.** Each is P3 on the demand evidence mined for the v3 coverage
round (1,593 real MCP calls, since-deleted plan file): the
daily loop is table/form/enum/label extension work, and the knowledge payload is
a token budget where every rule competes with every other rule for attention.

**Trigger.** A corpus record or a real session that needed one of them, or the
owner asking for the tax pack.

**Sketch.** The API names are verified; write the entries straight from the probe
JSON (`npm run oracle:probe -- --file scripts/oracles/probes/coverage-v3.ts`) and
capture the audit snapshot afterwards.

---

## AxReport write operations — deferred on the byte budget

**Status:** deferred 2026-08-31 · **Area:** `src/tools/write/modifyD365File.ts`

**What.** There is no `d365fo_file` operation for an AxReport. A dataset field, a
parameter or a column cannot be added to a report this server itself scaffolded —
every report recipe ends with "open the Report Designer". Proposed:
`refresh-report-dataset` (fields ← the DP's temp table), `add-report-parameter`,
`add-report-column`, all refusing any design the scaffold does not own.

**Why deferred.** Three operation enum values cost ~60–80 ListTools chars against
~64 of headroom, so it can only ship by trimming another tool's schema in the
same change. Folding the three into one `report-design` operation with an
`action` op-spec parameter (~25 chars) is the cheaper shape and is the one to
build.

**Why it is not simply "use the designer".** The designer is unavoidable for
LAYOUT. Refreshing a dataset after adding a field to the temp table is not
layout — it is bookkeeping the tool already has every input for, and getting it
wrong is silent (`Field group 'X' does not exist` is the same class of failure,
and XML009 now catches that one).

**Trigger.** Demand — a session that adds a field to a scaffolded report's temp
table and then cannot surface it — or headroom freed by a measured trim.

**Risk.** A malformed RDL is not caught by a build; it fails in the SSRS renderer
at run time. Refusing foreign designs is what keeps that bounded.

---

## RPT003 (report temp-table connection binding) — REJECTED on measurement

**Status:** **rejected 2026-09-02** · **Area:** `src/tools/analysis/validateXpp.ts`

**What was proposed.** The v4 plan (§6.1, G-20) suspected the report scaffold of a
silent run-time defect: it always emits a `TableType=TempDB` temp table and never
emits `setConnection`, so if shipped data providers bind their staging buffer to
the report's own connection, every scaffolded report would build clean, run, and
render EMPTY. RPT003 would have flagged a DP that writes a temp table without
binding.

**The premise was wrong, and the census says so plainly.** Over this install:

| base | shipped classes | call `setConnection` |
|---|---:|---:|
| `SrsReportDataProviderBase` (what the scaffold emits by default) | 13 | **0** |
| the pre-processed staging bases | 331 | 65 |

So binding is not a plain-DP concern at all, and the scaffold's default path
already matches every shipped example. **There is no scaffold bug to fix.**

**And the rule cannot be written for the case that IS real.** Among pre-processed
DPs the association with set-based writes is strong — `insert_recordset` appears
in 38% of binders against 9% of non-binders (4.4x), `update_recordset` 22% vs 5%,
`delete_from` 23% vs 5% — but association is not a rule. Counting the exact
population an RPT003 would fire on:

```
pre-processed DPs                                    : 369
  …with a set-based write INTO a Tmp buffer          :  62
  …and NO setConnection anywhere (RPT003 would fire) :  31
```

**Thirty-one shipped Microsoft classes**, i.e. half of the very category the rule
claims to judge. That fails this repo's standing bar — Microsoft's code compiles
and ships, so an error we raise on it is ours — and even as a warning a check that
is right about 31 files and wrong about 31 others has no discriminating power. It
is a coin flip with a confident voice.

**What shipped instead.** The finding is real and belongs in knowledge, where a
conditional truth is allowed to be conditional: `ssrs-rdp-preprocess` now carries
the numbers, names `setConnection(this.parmUserConnection())` as the FIRST thing
to check when a pre-processed report renders empty with no error, states that a
plain `SrsReportDataProviderBase` does not need it, and says out loud that no
textual rule separates the cases. A diagnosis is useful without being predictive;
a validator rule is not.

**What would reopen it.** A discriminator that actually separates the two
populations — most plausibly something in the metadata (the staging table's own
properties) rather than in the X++ — measured to fire on few or none of those 31.
Not a re-reading of the association above: that number is the argument.

## DECL001 / CONV001 — not built, and the evidence is against them

**Status:** **rejected 2026-08-31** · **Area:** `src/tools/analysis/validateXpp.ts`

**What was proposed.** Two error-severity rules carried over from the v2.1
coverage plan (deleted 2026-09-01): DECL001 for
local-variable shadowing, CONV001 for the implicit conversions the compiler
refuses (`int i = 1.5`, `str s = 1`, `"a" + 1`).

**Why rejected rather than deferred.** Both are one-pass regex approximations of
a question that needs scope, and the first full-install sweep of this repo's
rules is a direct measurement of what that costs: 99 error-severity findings on
code that compiles, 75 of them from exactly this shape of rule (ATTR001 and
SEL010 — pattern matching where the language wanted context). Meanwhile the
compiler's own messages for both cases are exact and arrive at the same moment a
build would: "A local variable named 'i' cannot be declared in this scope…" and
"…loses range and precision". The rule would add risk without adding an answer.

**What would reopen it.** A corpus record showing an agent shipping one of these
and being unable to read the compiler's answer — not the observation that the
rules would be easy to write.

---

## Context pipeline — Phase 3b: live editor focus

**Status:** deferred · **Area:** `src/workspace`, `src/types/context.ts` · **Depends on:** Phase 1–3a (shipped)

**What**
- Replace the mtime-based *proxy* for the active object with the real editor
  focus, and use a file watcher instead of polling:
  - Populate `EditorContext.activeFile` (interface already exists in
    [`src/types/context.ts`](../src/types/context.ts), currently unpopulated).
  - Add `fs.watch` on the model metadata dir with debounce to invalidate the
    `WorkspaceScanner` cache on change, instead of the 15s lazy TTL added in 3a.
  - *[2026-08-29] The watcher's main job is already done without it.* 3a's TTL
    comment claimed `invalidate()` ran after writes; nothing called it — the
    dispatcher now does, on every `MUTATING_TOOLS` call
    ([`src/tools/toolHandler.ts`](../src/tools/toolHandler.ts)), so a file this
    server wrote is visible to the workspace readers immediately instead of up to
    15s later. What `fs.watch` would still add is picking up edits made **outside**
    this server (the developer typing in the IDE) — a smaller prize, and one only
    worth the platform-flakiness once the focus half below has a consumer.

**Why deferred**
- MCP exposes workspace **roots**, not the focused file in the editor — there is
  no standard MCP message for "the user is looking at CustTable.xml". So real
  editor focus can only come from a client that volunteers it (e.g. Copilot in VS
  via `_meta`, or a future VSIX shim). Until we confirm the **target client
  actually consumes our MCP resources / sends focus**, this is work with no
  consumer — 3a's "most recently modified" proxy is good enough.
- `fs.watch` is platform-flaky (recursion, network/UDE drives), so it must stay
  an *optimization* over a reliable poll, never the only mechanism.

**Trigger to pick this up**
- We verify a target client reads `workspace://active` / `workspace://context`
  (or sends editor focus in `_meta`). At that point a precise active file is
  worth the watcher complexity.
- *[2026-08-29] That verification is now possible — it was not before.* The
  resource and prompt handlers log every list/read
  ([`src/resources/index.ts`](../src/resources/index.ts),
  [`src/prompts/codeReview.ts`](../src/prompts/codeReview.ts)), and the HTTP
  transport stopped classifying `resources/list`, `resources/templates/list`,
  `prompts/list` and `logging/setLevel` as unimplemented probes to swallow — all
  four are served. Until then a client that read `workspace://active` and one
  that ignored our resources entirely produced identical logs, so this trigger
  could never fire. **Read the logs before doing any of the work below**; if the
  target client never lists our resources, the honest resolution of this entry
  and of the VSIX one is to close them, not to build them.

**Sketch**
- `EditorContext.activeFile` ← from client-supplied focus when available; else
  fall back to the 3a mtime proxy (`contextSnapshot.activeObject`).
- `WorkspaceScanner`: add optional `fs.watch` per scanned root → debounced
  `invalidate(root)`; keep the 15s TTL as the fallback when watch is unavailable.
- Feed `activeFile` into `contextRanker` as the default anchor when a tool call
  omits an explicit object name.

**Risks**
- Watcher leaks / EMFILE on large trees → cap watched dirs to the model metadata
  dir; always tear down on disconnect.
- "Active" ≠ focus if the newest mtime is a build artifact → keep filtering to AOT
  `.xml` under the model and ignore `bin/obj/.git`.

---

## Context ranker in `search` — REJECTED

**Status:** **rejected 2026-08-29** · **Area:** `src/tools/analysis/search.ts`, `src/workspace/contextRanker.ts`

**What was proposed**
- Optionally let `search` re-rank / append a `rankContext()` "related" block when
  the caller passes an intent, reusing the ranker already wired into `prepare` —
  via an optional `intent`/`rankRelated` param on the single-search path.

**Why it is rejected, not deferred**
Deferred twice (2026-06, 2026-08) on a cost argument. Re-examined on 2026-08-29
against the current code, every leg of the case got *worse*, so this is a "no",
not a "not yet". Four independent reasons, any one of which would be enough:

1. **There is no room to publish the parameter.** `TOTAL_BUDGET` in
   [`tests/utils/toolSchemaBudget.test.ts`](../tests/utils/toolSchemaBudget.test.ts)
   is 45,000 chars against a measured 44,998 — **2 chars of headroom** — and that
   ratchet's own rule is *"fit the change to the budget, never the budget to the
   change"*. The param could only ship by trimming a different tool's schema
   first, i.e. by making some other tool harder to call. Leaving it unpublished
   is not a way out: a parameter the model cannot see is a parameter nobody
   passes.
2. **The output slot is already occupied.** `search` ships an opt-in related
   block today — `verbose` → related-searches / patterns / tips
   ([`search.ts:429`](../src/tools/analysis/search.ts)). A second, differently-ranked
   "related" section next to it is the double-ranking confusion the original
   entry listed under *Risks*, now with a concrete collision.
3. **The path got hotter, not cooler.** The 2026-08-25 audit cut untyped `search`
   from 17.9s to 91ms. The "hottest, most-tested path" half of the original
   rationale was never the weak half, and it is now stronger.
4. **The trigger never fired in two months.** It asked for a concrete case where
   FTS ordering misses relevance the xref/usage signals would catch. Across two
   full usage audits — the second over 1,515 real MCP calls — no such case
   appeared. `prepare` remains the right home for the ranker: it is where an
   intent actually exists.

**The correction that made this decidable**
The 2026-08 note on this entry claimed the cost argument had *weakened*, because
commit `a49488a` moved the schema into its own file. That measured the wrong
cost. Moving a file cut the *editing* friction; what a published parameter
actually costs is bytes in the ListTools payload, which are rationed and were
not being counted. That note is retained here as the reason to be suspicious of
"this got cheaper" claims that name no unit.

**What would reopen it**
Nothing about implementation convenience — only demand. Concretely: corpus
evidence of callers issuing a `search`, then immediately hand-pulling the same
neighbours the ranker would have surfaced, often enough to beat the schema bytes
it would cost. Reopen by re-adding an entry with that evidence attached; do not
reopen it on the grounds that it would now be easy to build.

---

## Tighter IDE integration (VSIX shim)

**Status:** idea · **Area:** new (out-of-repo VS extension) + `src/server` · **Depends on:** —

**What**
- A thin Visual Studio extension (à la the competitor's VSIX) that registers the
  MCP server, surfaces menu commands (refresh context, diagnose), and — crucially
  — volunteers **editor focus** and open-document context to the server. Unblocks
  Phase 3b's real `activeFile` and closes the last UX gap vs IDE-native tools.

**Why deferred (idea-stage)**
- Big surface area in a different tech stack (C#/VSIX), and most of the value is
  reachable today via MCP resources + roots without owning a VS extension. Only
  worth it if MCP-native context (resources/`_meta`) proves insufficient in
  practice with the target clients.

**Trigger to pick this up**
- Evidence that Copilot-in-VS / target clients do NOT consume our MCP resources
  or send focus, AND the proactive-context UX gap is costing real adoption.
- *[2026-08-29] The first half of that trigger is now measurable — see the same
  note under Phase 3b. Both entries hang on one unanswered question, and the
  handlers finally log the answer. Note the asymmetry before reading the logs:
  silence here argues for building the VSIX and against building 3b, so "no
  client reads our resources" is not a null result for this entry.*

**Sketch**
- VSIX sends active file + open docs via `_meta` on tool calls (already partially
  parsed in `extractWorkspaceFromMeta`) or a custom notification; server feeds it
  into `EditorContext` and the ranker anchor (see Phase 3b).

**Risks**
- Maintenance cost of a second codebase/release pipeline; VS Copilot LM/MCP APIs
  are still moving. Keep the server fully usable without the VSIX (graceful
  degradation), never make it a hard dependency.

---

## X++ coverage v3 non-goals — recorded here when the plan file was deleted

**Status:** deferred / non-goal 2026-09-01 · **Area:** knowledge, generator, eval
taxonomy

**What.** `docs/XPP_LANGUAGE_COVERAGE_PLAN.md` was deleted on 2026-09-01 under its
own lifecycle rule (the capture wave finished: 0 of 120 cases `golden_pending`,
0 `systest_pending`, core coverage back to 100%). Its D2/D3/D4 decisions already
live above as their own entries. These four items had no entry anywhere, so they
would otherwise have been lost with the file:

- **Domain breadth left out on purpose:** extensible controls, SSRS sub-reports,
  Power BI embedded, Key Vault / Blob SDK, Financial Reporting. Each is a
  multi-day domain with no demand behind it in the 1,593 real MCP calls that
  round was mined from, where the daily loop is table/form/enum/label extension
  work. **Trigger:** a corpus record or a real session that needed one.
- **The `anytype` run-time re-typing probe (P2)** — the one language question the
  compiler cannot answer, because the behaviour is a run-time one. It was blocked
  while no SysTest had ever executed; since the runner reached the database
  (2026-08-31) it is merely **unwritten**. **Sketch:** a SysTest that assigns two
  different types into one `anytype` and asserts what `typeOf()` reports at each
  point; capture it as a golden the way the runtime-tagged cases are.
- **Rejected on compiler evidence, and staying rejected:** a generics rule, a
  rule for `*=` / `/=`, `EVT001`, and the buffer-select-expression rule. The
  compiler accepts (or diagnoses exactly) what each of them would have flagged.
  **What would reopen one:** a probe result contradicting the one that dropped it,
  not a re-reading of the docs.
- **The six unpublished `generate_object` patterns stay unpublished** — declined
  on schema budget: `generate_object` was 5 calls in 1,593.
  `tests/tools/patternEnumParity.test.ts` keeps every difference an explicit,
  justified entry, so the gap cannot drift back into an accident.

**Why it is worth a backlog entry at all.** The plan's durable outputs are
`eval/COVERAGE.md`, `eval/README.md`, the goldens' READMEs and CHANGELOG 1.16.0.
Those record what SHIPPED. A non-goal that is only recorded in a deleted file is
indistinguishable from an idea nobody had, which is the failure this file was
restored to prevent.
