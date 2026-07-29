# Agent eval loop

The self-improving agent eval loop. Full design in
[docs/AGENT_EVAL_LOOP.md](../docs/AGENT_EVAL_LOOP.md); live coverage status in
[COVERAGE.md](COVERAGE.md).

All phases described in the design doc are implemented: the golden + SysTest
oracle, the corpus, and the improver toolchain (clustering, held-out
regression, knowledge feedback, flake detection, case mining, fix-brief
generation) are all live. This file covers the mechanics of running a case by
hand and the standing work queues.

## Layout

```
eval/
├── README.md                     ← this file
├── cases/
│   ├── schema.json               ← JSON Schema for a use-case spec
│   └── <case-id>.json            ← one file per case (catalog listing: COVERAGE.md)
├── goldens/
│   └── <case-id>/                ← committed, reviewed golden metadata (one or more *.metadata.xml)
├── systests/
│   └── <case-id>.xml             ← SysTest class for code-heavy cases (runtime oracle)
└── corpus/
    ├── schema.json               ← JSON Schema for a run record
    └── runs/                     ← one .json run record per run (gitignored — VM-side evidence)
```

## Sandbox prerequisites (VM)

The sandbox model's `Descriptor/<Model>.xml` must list in `ModuleReferences`
every package a case **names directly** — xppc does not resolve package
references transitively for directly-named types. Today that is
`ApplicationSuite`, `Directory`, `Ledger`, `ContactPerson`, `Currency` and
`FleetManagement` (`L2-coc-extension` wraps `FMVehicleDataContract`). A missing
entry makes the case unbuildable in a way that reads like a tool defect — it is
a recurring `ENV_FLAKE`, so check the descriptor before triaging one.

## Manual run checklist (implementer path, on the VM)

Run with the mcp-server in `full` mode + C# bridge, pointed at a **throwaway
sandbox model** (never a real customisation model).

1. **Isolate** — create/confirm an empty sandbox model for this run.
2. **Implement (grounded only)** — drive the case `instruction` through the
   tool path: `prepare` → query tools (`search`, `object_info`, …) →
   `validate_code(mode="references")` → `generate_object` → write via
   `d365fo_file(action=create)`. No hand-edited XML.
3. **Static gate** — record `validate_code` references + syntax results.
4. **Build** — `build_d365fo_project`; capture `errors[]` and `bpWarnings[]`.
5. **Oracle** — normalise the produced metadata and diff against
   `goldens/<case-id>/` (see `eval/goldens/L1-table-basic/README.md` for a
   worked example of capturing a golden the first time).
6. **Score & record** — fill one record matching `corpus/schema.json` and drop
   it in `corpus/runs/`.
7. **Roll back** — undo the write / wipe the sandbox model.
8. **Triage** — classify any failure per the rubric in the design doc (§9);
   record the hypothesis, not a fix.

Each run produces **one corpus record + a verdict** on whether the case passed
build / BP-clean / golden — and, if not, which rubric class it fell into. The
improver toolchain clusters these to prioritize the next fix.

## Automated oracle

Steps 5–6 (normalise → diff golden → score) are automated and VM-free in
[`src/eval/oracle/`](../src/eval/oracle/):

```
npm run eval:score -- <caseId> <actualXml.xml> [--bp-warnings N] [--build-failed] [--systest <file>] [--write]
npm run eval:score -- <caseId> --actual-dir <dir> [...]   # multi-artifact cases
```

It flattens both the actual and the golden to an order-independent `path → value`
map (collection members keyed by `<Name>`/`<DataField>`; `ModelSaveInfo`/`@Id` and
per-case `ignore` globs stripped), diffs them into `missing/extra/changed`, and
prints the scorecard. `--write` appends a corpus record to `corpus/runs/`.

### Runtime oracle

For code-heavy cases, "compiles + golden shape" is not enough — correctness IS the
behaviour. Such a case carries a SysTest class (`eval/systests/<id>.xml`); after the
build, run it with the `run_systest_class` tool, save its text output to a file, and
pass `--systest <file>`. The oracle parses it into `{ ran, passed, failures }`
(via `src/eval/oracle/systest.ts`) and folds `systest` into the scorecard.

## Triage bias: an honest failure beats a confident lie

The most damaging defects the sweeps have found were **the tool asserting a
falsehood** rather than failing: claiming a standard EDT did not exist when the
bridge was merely unreachable, returning `✅ success` for a parameter that was
silently discarded, scoring `bp_clean: 1` from absent evidence, naming the wrong
cause in a fallback message, recommending a label syntax the compiler rejects.
Each one sent the agent off to "fix" something that was already correct.

Two consequences for triage:

- **Making the failure honest is a real fix**, not a placeholder for one. It is
  also provable in-repo even when the root cause is not, so prefer it over
  leaving a confident lie in place while the deeper fix waits.
- **A green dimension needs provenance.** `bp_clean: 1` means BP ran and was
  clean (`build.bp_checked: true`), never "BP was not run". A golden that was
  captured from defective output can never fail on the thing its case exists to
  catch — score the live behaviour (a chain walk, a SysTest), not just the shape.

## Improver toolchain

`npm run eval:clusters` (prioritized failure clusters) · `eval:report` (corpus
scoreboard) · `eval:knowledge` (MODEL_ERROR → knowledge-base proposals) ·
`eval:flakes` (flake detection) · `eval:mine` (draft a case from a failure
description) · `eval:brief` (top-priority cluster → Markdown fix brief).

## Golden compile re-verification

`npx tsx scripts/verify-goldens-build.ts` (VM) writes every captured golden into
the sandbox **one case at a time**, full-builds it with xppc directly, and
records the verdict in [`golden-build-verification.json`](golden-build-verification.json).
Isolation is not optional: a bulk pass both hides failures (one case's object
satisfies another's dangling reference) and invents them (cases legitimately
reuse names that never coexist in a real run) — measured at 12 bulk errors, 0
real. Pre-existing files are never overwritten, so a fixture the case reads is
reported as `skipped` rather than compile-verified.

**Current record: 57/65 clean over 143 artifacts** (2026-07-29, xppc
7.0.7858.27). A sweep on 2026-07-28 reported **65/65** over the same 65 cases,
the same 143 artifacts and the same two fixture skips; it does not reproduce
against a sandbox that holds only the fixture. The 07-28 number therefore rested
on **catalog residue** — objects earlier runs had created and not rolled back,
sitting in the sandbox and satisfying references the goldens do not carry
themselves. A clean `--baseline` does not prove an empty sandbox: it only proves
that whatever is in there compiles. Inventory `<Model>/<Model>/Ax*` before
trusting an isolated verdict.

The eight open failures (per-case errors in the JSON), by class:

| Class | Cases | Evidence |
|---|---|---|
| Golden defect, environment-independent | `L1-map-basic`, `L1-form-workspace`, `L3-form-detailstransaction` | a map field named `CreatedDateTime` (reserved for system fields); 4 `FormPatternValidation` errors on the workspace Design; `ConDemoNoteHeaderLine.LineNum` EDT data-type mismatch |
| Fixture ⇄ golden mismatch | `L1-form-basic`, `L1-form-detailsmaster`, `L1-form-simplelistdetails` | all three bind a grid to field group **`Overview`** on `ConDemoNoteHeader`; no fixture and no golden in the catalog defines that group — not even `L1-form-basic`'s own golden copy of the table |
| Cross-case dependency the case never creates | `L4-entity-security`, `L2-oracle-discriminator-random-wrapper-name` | menu item → form `ConDemoNoteHeaderList` (created by `L1-form-basic`); form extension → field `ConHasNotes` (created by `L2-form-extension-basic`'s table extension) |

The last class cannot pass a *real* case run either — the protocol rolls back
every case, so the dependency is gone by the time the next one starts. Each of
the eight needs the question settled first and only then a re-capture through
the tool path (`eval-run`); re-capturing straight from output that may itself be
defective is how a golden stops being able to fail on the thing its case exists
to catch.

The sweep exists because the `build_d365fo_project` stale-result defect
(`tests/tools/buildStaleResult.test.ts`) had made every non-`force` `pass@build`
weaker evidence than it looked.

## Status & open work

**Coverage is generated, never hand-maintained.** `npm run eval:coverage`
rewrites [COVERAGE.md](COVERAGE.md) + `coverage.json` from the live catalog,
knowledge base and tool schema; `-- --check` is the CI gate. Read the numbers
and the weight-ordered closure queue there, not from prose.

Standing queues:

- **Capture the pending goldens (VM).** Cases with `golden_pending: true` have
  been authored but never run; coverage counts them as uncovered because they
  prove nothing until captured. `eval-run` captures each on the VM — flip the
  flag as each lands.
- **Coverage closure loop** (~2–4 leaves/week): `eval-author` drafts a case for
  each leaf missing **E** → `eval-run` captures the golden → MODEL_ERROR
  clusters flow through `knowledgeFeedback` into proposed knowledge entries
  (human review stays mandatory, as the module enforces) → TOOL_DEFECT /
  VALIDATOR_GAP go down the standard improver path. Where model training data
  is weak, the knowledge entry's canonical example is mined from the real AOT,
  not written from memory.
- **Platform drift**: 100% is relative to the current platform version. A
  monthly release-notes check adds new leaves flagged `uncovered`, so staleness
  is visible instead of hidden.
- **Knowledge audit** — closed against this repo (`npm run eval:knowledge-audit`
  + `tests/knowledge/apiSymbols.test.ts` + `exampleValidation.test.ts`), with
  two gaps still open: the `d365fo-cli` skill files (separate repo) have never
  had the `apiSymbols` treatment, and proving knowledge code examples actually
  *compile* needs a real VM build — only the offline BP slice is automated.

Blocked / declined (not planned):

- `SysTestConsole.exe` requires an interactive console session (unconditional
  `WaitForDebugger()` / `Console.ReadKey()` even in local-AOS mode) — a platform
  limitation. Three cases stay `systest_pending: true` (`L2-coc-extension`,
  `L3-batch-basic`, `L2-event-handler-basic`). `vstest.console.exe` +
  `RunnableDropSysTest.TestAdapter.dll` discovers zero tests: dead end.
- CI-workflow half of the autonomous improver. The VM-free fix-brief generator
  (`npm run eval:brief`) is done; running Claude Code unattended on top of it in
  GitHub Actions was **explicitly declined** as a new autonomous-agent surface
  needing its own sign-off. Not planned unless asked again.

The isolation invariant (all eval writes pinned to the sandbox model, never a
real customisation model, never `D365FO_CUSTOM_PACKAGES_PATH` at one) is
[AGENT_EVAL_LOOP.md §11](../docs/AGENT_EVAL_LOOP.md) and is not negotiable.
