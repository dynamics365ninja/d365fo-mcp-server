# Golden — L2-tdd-red-green-cycle

The red-green cycle, with both runs recorded

Captured by `scripts/capture-golden.ts` on 2026-09-03.

| artifact | root element |
| --- | --- |
| `ConDemoDiscount.metadata.xml` | `AxClass` |
| `ConDemoDiscountTest.metadata.xml` | `AxClass` |

Build evidence: build log .rg-evidence.txt (90 chars, no failure marker).

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
