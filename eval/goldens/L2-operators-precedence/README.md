# Golden: L2-operators-precedence — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA d212f3e, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. One `d365fo_file(action="create")` plus one
`replace-code` (see below); no hand-edited XML. Build 0 errors on both attempts,
xppbp clean on the second, golden self-match. Corpus record:
`eval/corpus/runs/2026-08-30T07__L2-operators-precedence__d212f3e.json`.

## Artifact

`ConDemoAccessRules.metadata.xml` — AxClass, five static methods:

| Method | What it has to keep showing |
|---|---|
| `canPost` | `_isAdmin \|\| (_isOwner && _isEnabled)` — the parentheses are the case. Without them the expression still compiles and means `(_isAdmin \|\| _isOwner) && _isEnabled`, denying a plain administrator |
| `pagesFor` | `DIV` and `MOD` keywords, and `wholePages++` as its own statement |
| `matchesFilter` | the `like` operator, not a hand-rolled scan |
| `describeBuffer` | `is` to test, `as` to downcast, and a null check before the field read |
| `summarise` | `strFmt` placeholders where C# would interpolate |

## Notes from the capture

**The first build was clean but xppbp was not: `BPXmlDocMalformed` on `canPost`.**
The remark described the trap using the operators themselves, and a doc comment
is parsed as XML, where a bare ampersand is not well-formed. Pre-escaping it as
an entity does not survive either — the write path decoded it back to the raw
operator before it reached the file. The fix, applied through `replace-code`, is
to name the operators in prose. The case instruction now carries that note so a
re-capture does not rediscover it as a failure.

Second observation, recorded but not acted on: the C# bridge refused that
`replace-code` with "oldCode not found in ConDemoAccessRules" while the
TypeScript XML writer found the same text and applied it. The two disagree about
the source they are matching against; worth a look if it shows up again.
