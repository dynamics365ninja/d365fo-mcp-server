# Agent eval loop

The self-improving agent eval loop. Full design in
[docs/AGENT_EVAL_LOOP.md](../docs/AGENT_EVAL_LOOP.md); current status and open
work in [ROADMAP.md](ROADMAP.md).

All phases described in the design doc are implemented: the golden + SysTest
oracle, the corpus, and the improver toolchain (clustering, held-out
regression, knowledge feedback, flake detection, case mining, fix-brief
generation) are all live. This file covers the mechanics of running a case by
hand; ROADMAP.md tracks what's still open.

## Layout

```
eval/
├── README.md                     ← this file
├── cases/
│   ├── schema.json               ← JSON Schema for a use-case spec
│   └── <case-id>.json            ← one file per case (see ROADMAP.md for the current catalog)
├── goldens/
│   └── <case-id>/                ← committed, reviewed golden metadata (one or more *.metadata.xml)
├── systests/
│   └── <case-id>.xml             ← SysTest class for code-heavy cases (runtime oracle)
└── corpus/
    ├── schema.json               ← JSON Schema for a run record
    └── runs/                     ← one .json run record per run (gitignored — VM-side evidence)
```

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

See [ROADMAP.md](ROADMAP.md) for current status and open work.
