# Golden — L4-tdd-report-dp

Red-first SysTest for a report data provider

Captured by `scripts/capture-golden.ts` on 2026-09-02.

| artifact | root element |
| --- | --- |
| `ConDemoDpTestTmp.metadata.xml` | `AxTable` |
| `ConDemoDpTestContract.metadata.xml` | `AxClass` |
| `ConDemoDpTestDP.metadata.xml` | `AxClass` |
| `ConDemoDpTestDPTest.metadata.xml` | `AxClass` |
| `ConDemoDpTest.metadata.xml` | `AxReport` |

Build evidence: build log .dpcase-evidence.txt (56 chars, no failure marker).

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
