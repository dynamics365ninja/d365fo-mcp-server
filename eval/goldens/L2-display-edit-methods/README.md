# Golden: L2-display-edit-methods — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_display and edit methods on a table that is not yours_

`CustGroupCon_Extension.metadata.xml`

| | What it has to keep showing |
|---|---|
| `conGroupSummary` | a `display` method carrying `[SysClientCacheDataMethodAttribute(true)]` — it runs once per VISIBLE ROW on every refresh, and reads nothing but the record in hand, so the per-record cache is safe |
| `conEditableName` | an `edit` method with the `(boolean _set, <T> _value)` signature: `_set` is false while the form paints and true when the user commits, and both calls return the value to show |

## Notes from the capture

**The case spec named the wrong artifact type, and the VM is what said so.**
It asked for an `AxTableExtension`. An `AxTableExtension` document has no
`<Methods>` element at all — not one shipped table extension in ApplicationSuite
has one — so display and edit methods on a STANDARD table cannot live there.
They have to go in an `[ExtensionOf(tableStr(CustGroup))] final class`, which is
what this golden is. The case spec and its `target_artifact_types` were
corrected to match.

Built clean, xppbp clean. Neither method may be `static`: the compiler answers
"Conflicting modifiers 'static display'". Neither may be used in a `select`
where clause either — they are X++, not SQL — which no build will tell you.
