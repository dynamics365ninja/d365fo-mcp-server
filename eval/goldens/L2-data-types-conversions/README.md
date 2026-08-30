# Golden: L2-data-types-conversions — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA d212f3e, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. One `d365fo_file(action="create")` call, no
hand-edited XML, no follow-up edit. Full build 0 errors, xppbp 0/0, golden
self-match. Corpus record:
`eval/corpus/runs/2026-08-30T07__L2-data-types-conversions__d212f3e.json`.

## Artifact

`ConDemoTypeUtil.metadata.xml` — AxClass, seven static methods:

| Method | What it has to keep showing |
|---|---|
| `nullEquivalents` | four uninitialised locals compared to `dateNull()` / `''` / `0` / `false` — never to `null`, which value types do not have |
| `millenniumEve` | the date LITERAL `31\12\1999`, backslash-separated, not a `str2Date` call |
| `truncatedCode` | a `str 3` local holding `'ABCDEF'` — the compiler says nothing and three characters come back |
| `parseCount` | `str2Int`, a conversion FUNCTION; X++ has no casts |
| `formatAmount` | `num2Str(_amount, 0, 2, 1, 0)` — width, decimals and both separators are positional |
| `lockedAnytype` | an `anytype` locked to int by its first assignment, read back with `any2Int` |
| `backupFolder` | an `@`-prefixed verbatim path, backslashes literal |

## Notes from the capture

Nothing went wrong: this is the one case of the five that built and passed BP on
the first attempt. Worth knowing all the same — the class produces no
user-visible prose, only `strFmt` placeholder strings, so it needs no label file
and stays BP-clean without one.
