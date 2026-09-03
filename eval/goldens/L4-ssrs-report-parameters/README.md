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

## 2026-09-03 — corrected by hand, not re-captured

The parameter block this golden pinned was WRONG, and the build could not see
it. `add-parameter` wrote `DataType` after `PromptString`; a census of all
13,911 parameters in the 1,063 shipped reports puts it between `AllowBlank` and
`Nullable` with zero contradicting instances, and the deserializer drops an
element it meets out of sequence without a word. So the committed
`DemoRptFromDate` compiled clean and would have reached the dialog as a
`String`, not a `DateTime`.

The block now carries the shipped order, and the three inserted elements sit on
their own lines instead of after the closing tag's indentation. The writer was
fixed in the same PR and its unit tests pin the order; a re-capture on the VM is
the next step for this case, and until then this note is the reason the
reviewed file and the capture date disagree.
