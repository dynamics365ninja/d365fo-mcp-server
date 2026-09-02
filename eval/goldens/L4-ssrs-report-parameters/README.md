# Golden — L4-ssrs-report-parameters

Add a report parameter and refresh a dataset after the report exists

Captured by `scripts/capture-golden.ts` on 2026-09-02.

| artifact | root element |
| --- | --- |
| `ConDemoRptParamTmp.metadata.xml` | `AxTable` |
| `ConDemoRptParamContract.metadata.xml` | `AxClass` |
| `ConDemoRptParamDP.metadata.xml` | `AxClass` |
| `ConDemoRptParam.metadata.xml` | `AxReport` |

Build evidence: build log .case-build-evidence.txt (58 chars, no failure marker).

This is a **reviewed** artifact, not a snapshot the tools may refresh at will
(docs/AGENT_EVAL_LOOP.md §6.4). Every later run diffs its normalised output
against these files; `missing`/`extra`/`changed` deltas land in the run's
`golden_diff`. When a fix legitimately changes the expected output, re-capture
in the same PR and say why here — a golden that quietly follows the code proves
nothing.

## PENDING HUMAN REVIEW

Confirm before relying on this golden: the artifacts compile, are BP-clean, and
say what the case instruction asked for.

<!-- capture-golden: provenance above, hand-written notes below -->
