# Golden: L2-enum-modify-values — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-31, server SHA 278eee3, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, effective prefix `ConDemo`. Written through the server's own write
path only — one `d365fo_file(action="create")` and then five
`d365fo_file(action="modify")` operations, no `overwrite=true` full-XML rewrite,
no hand-edited XML — then full-built with xppc (0 errors, 0 warnings) and checked
with xppbp. The capture script refuses to copy a golden out of a build that was
not clean, or out of a file edited after that build. Sandbox rolled back
afterwards.

## Artifacts

_one enum, created with three values and then maintained through the
add/modify/remove-enum-value operation surface_

`ConDemoModStatus.metadata.xml`

| | What it has to keep showing |
|---|---|
| `EnumValues` | exactly three: `Active`, `Completed`, `Archived` — **no `Draft`** (removed), **no `Closed`** (renamed), **no `Temp`** (added then removed) |
| `<Value>` | `1`, `2`, `3` — **explicit**, and this is the load-bearing part (see below). Value `0` is absent because no member holds it any more |
| member order | `Active`, `Completed`, `Archived` — the order the ops produced; the numbers are carried by `<Value>`, not by position |
| every `Label` | a standard `@SYS` reference (`@SYS95227`, `@SYS111310`, `@SYS89555`), never prose — the instruction requires reuse from the labels index |
| enum `Label` | `@SYS36398` ("Status") — supplied explicitly, so the create-path raw-text-label defect never fires |
| `UseEnumValue` | **absent**, and that is canonical: `Yes` is the metamodel default and 0 of 488 shipped `ApplicationPlatform` enums serialize it |

## Notes from the capture

**The explicit `<Value>` elements are what make this case correct rather than
merely green.** The chain ends by removing `Draft`, the member at 0. If the
enum had been created with positional numbering — which the `create(enum)`
op-spec says happens to "plain 0,1,2" values, they are accepted and then
*dropped* — the survivors would have renumbered to `Active=0`, `Completed=1`,
`Archived=2`. That enum builds perfectly cleanly and is wrong. The run avoided
it by passing `useEnumValue: "Yes"` alongside the values at create time; the
`<Value>` elements then survived every subsequent bridge round trip, including
the removal.

**`modify-enum-value` renames without renumbering.** `Closed` → `Completed`
with `enumValueInt: 2` kept the member in place, kept its value, and swapped the
label to `@SYS111310`.

**The create-path label defect does not extend to the modify path** (checked
deliberately, on a throwaway enum, not on this artifact): `add-enum-value`
without `enumValueLabel` omits `<Label>` entirely instead of inventing the
member's own name, and `add-enum-value` given raw text auto-resolves it to a
real `@Ref` and says so. Only `generateAxEnumXml` invents a raw-text label, and
only for the enum's own `<Label>`.

The name: the instruction says `DemoModStatus`, but the prefix inferred from the
sandbox is `ConDemo` and `normalizeObjectName` concatenates rather than
collapsing the shared `Demo`, so the base name passed to `create` was
`ModStatus` — landing on the catalog-conventional `ConDemoModStatus`
(cf. `ConDemoModLifecycle`, `ConDemoNoteStatus`).
