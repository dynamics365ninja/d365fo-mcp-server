# Golden: L2-runtime-functions-arity — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_run-time functions at their real argument counts_

`ConDemoTextParts.metadata.xml`

| | What it has to keep showing |
|---|---|
| `firstSegment` | `strFind` with all FOUR arguments and `subStr` with THREE, where the third is a LENGTH and both are 1-based |
| `formatted` | `date2Str` with SEVEN arguments. Six does not compile; eight (a trailing `DateFlags`) also does |
| `firstTwo` | `conPeek` with exactly two arguments, `conIns` variadic — the one with no count to get wrong |
| `changedFlag` | `corrFlagSet`, because `corrFlagGet` is an AX 2012 name this platform does not have |

## Notes from the capture

Built clean on the first attempt, xppbp clean. The `date2Str` enum literals
(`DateDay::Digits2`, `DateSeparator::Hyphen`, `DateMonth::Digits2`,
`DateYear::Digits4`) were taken from shipped code —
`ApplicationPlatform/AxClass/FormJsonSerializer.xml` calls it exactly this way —
because those are kernel enums with no AOT metadata to look up.

The arities themselves came from `eval/compiler-facts.snapshot.json`, which was
captured by probing xppc rather than by reading documentation. This golden is
the other half of that: the snapshot says `strFind` is 4/4, and this file is a
compiled proof that 4 is accepted.
