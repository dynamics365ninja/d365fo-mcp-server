# Golden — L2-systest-attributes-isolation

SysTest attributes and the rollback the framework promises

Captured by `scripts/capture-golden.ts` on 2026-09-02.

| artifact | root element |
| --- | --- |
| `ConDemoIsolationTest.metadata.xml` | `AxClass` |

Build evidence: build log .h2case-evidence.txt (93 chars, no failure marker).

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
