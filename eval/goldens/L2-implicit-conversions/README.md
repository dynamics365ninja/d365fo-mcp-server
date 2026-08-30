# Golden: L2-implicit-conversions — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_which assignments X++ converts on its own, and which it refuses_

`ConDemoConversions.metadata.xml`

| | What it has to keep showing |
|---|---|
| `truncated` | `real` does not assign to `int` — the conversion loses range and precision and has to be asked for, here `real2int(trunc(...))` |
| `described` | neither `int` nor an enum assigns to `str`: `int2Str` and `enum2Str`, joined through `strFmt` over a label |
| `isSet` | the conversions that DO happen unasked: an enum assigns to an `int` AND to a `boolean` |
| `hasValue` | a `str` used directly as a condition. No `null` comparison anywhere — value types have none |

## Notes from the capture

Built clean on the first attempt, xppbp clean.

`real2int` is worth a note: it is NOT a predefined function on this platform
(it is absent from the compiler intrinsic and run-time tables), it is a static
method on `Global`, which is why it can still be called unqualified. FN002 does
not flag it because the captured unknown-function list is the compiler's, not a
guess: the five names there are `corrFlagGet`, `dateMin`, `int2Enum`,
`refPrintAll` and `typeName2Id`.

The enum-to-boolean assignment in `isSet` was the one line here that was not
certain in advance. It compiles.
