# Golden: L3-enum-field-form-downgrade-guard

Captured 2026-08-31 on the VM (model `fm-mcp`, prefix `ConDemo`, xppc 7.0.7996.33)
by the **eval-implementer** role, from a full build that reported 0 errors and an
xppbp run with 0 BP **errors**, and with the runtime oracle green (3/3).
The XML was copied byte-for-byte off `PackagesLocalDirectory` by a build-gated
capture script — nothing here is hand-authored.

## Where the case comes from

A live customer demo on 2026-08-07 (a `<Prefix>_TaxTransReportChangeLog` table in
the customer's shared core model).
Adding one enum-typed field, exposing it on the matching form and blocking a
value downgrade in `validateWrite()` cost several failed builds. The sandbox
equivalent of that task is this case.

## What the run captured

| File | Object | Notes |
|---|---|---|
| `ConDemoServiceTier.metadata.xml` | `AxEnum` | None(0) / Silver(1) / Gold(2) / Platinum(3), `Label` = `@SCM:Code` |
| `ConDemoTaxChangeLog.metadata.xml` | `AxTable` | `ServiceTier` as `AxTableFieldEnum` + `EnumType`, **no** `ExtendedDataType`; in field group `Overview`; `FormRef`; `validateWrite()` |
| `ConDemoTaxChangeLogDetails.metadata.xml` | `AxForm` | SimpleListDetails scaffold + ComboBox bound to `ServiceTier` in the details group |
| `ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml` | `AxMenuItemDisplay` | required by `FormRef` — see below |

No `AxEdt*` artifact appears in this folder, and none may — an enum table field
needs no EDT, and producing one is a case failure, not a golden variant. The run
confirmed this: `add-field` with `fieldEnumType` and no `fieldType` wrote
`<AxTableField i:type="AxTableFieldEnum">` with `<EnumType>` and no
`<ExtendedDataType>`, and `AxEdt/` stayed empty.

### Why there is a fourth artifact (`AxMenuItemDisplay`)

A table's `FormRef` property does **not** reference a form — it references a
**display menu item**. The case instruction (step 6) says "set the table's
FormRef property to the created form", and `modify-property` accepted the form
name without complaint, but the build then failed with

    Metadata Error: AxTable/ConDemoTaxChangeLog/FormRef:
    Menu item display 'ConDemoTaxChangeLogDetails' does not exist.

So the metadata chain the case asks for is table → menu item → form, and the
menu item is part of the case's output. It is named after the form (the D365FO
convention), which is why its golden file carries the legacy `.Ax<Type>` infix:
two objects of different types share one name, and `artifactKey` needs the two
files to stay distinguishable. `scripts/verify-goldens-build.ts` compiles this
folder in isolation, so a golden holding the `FormRef` without the menu item
would not build.

### The `<Value>` elements on the enum are load-bearing

`None` has no `<Value>` child (that IS 0); `Silver`/`Gold`/`Platinum` carry
`<Value>1/2/3`. An `<AxEnumValue>` without a `<Value>` is **zero**, not "the next
ordinal" — an enum written without them has every member equal to 0, compiles
with 0 errors, passes xppbp, and looks right in a golden diff, while
`enum2int()` returns 0 for every tier and the ladder silently collapses. That is
what the SysTest is for; see the 2026-08-31 corpus record.

## Why `**/AxEnumValue/Label` is on the case's ignore list

The case pins the label IDs that BP actually reasons about — the enum's own
`Label` (`@SCM:Code`), the field's `Label` (`@SCM:Description`) and the message
label in `validateWrite()` (`@TaxTransactionInquiry:HeaderNote`) — because
`BPErrorFieldLabelIsCopyOfEnumLabel` / `BPErrorTypeLabelIsCopyOfEnumLabel` is
about ID identity, and because the method body is diffed token-exact. The four
per-VALUE labels are left to the agent's own labels-index lookup (there is no
standard label for "Platinum" to pin), so their IDs are normalised out of the
diff. What is still scored for them: they must be label references, never raw
text (`BPErrorLabelIsText`). This capture used `@SYS80100`, `@SYS118646`,
`@SYS118647`, `@SYS118653`.

## BP state at capture

0 BP **errors**. 5 BP warnings, none of which the case instruction asks the agent
to remove, all reproducible from the instruction:
`BPErrorTablePrimaryKeyEditable` + `BPErrorDeveloperDocumentationNotDefined`
(table-create defaults), `BPErrorLabelNotDefined` (the `Overview` field group has
no label), `BPErrorLabelIsText` (the SimpleListDetails scaffold writes
`Caption=General` as raw text on `TabPageGeneral`) and
`BPErrorMenuItemNotCoveredByPrivilege` (a standalone menu item).

## Runtime oracle

`eval/systests/L3-enum-field-form-downgrade-guard.xml`, class
`EvalL3ServiceTierDowngradeTest`, run via `run_systest_class` — 3/3 green
(`testDowngradeIsRejected`, `testUpgradeIsAccepted`,
`testInsertAtAnyTierIsAccepted`). `systest_pending` is `false`.

## Hand-correction 2026-09-01: the writer changed under this golden

PR #984 fixed two defects in the form pattern templates, and this golden was
captured before them — so it asserted the OLD, defective output as the expected
answer, and a faithful rerun would have scored `golden_match: 0` against its own
correct result.

Changed here, mechanically and by hand (NOT a re-capture):

- `<Caption>General</Caption>` → `@SYS2952`

Both transformations are deterministic consequences of the writer fix, which is
why they were applied rather than re-captured:

- **Captions.** `<Caption>` holding raw text is `BPErrorLabelIsText`, and
  untranslatable. Each replacement id is the exact text in ApplicationPlatform's
  `SYS.en-us.label.txt` and the most-used caption of that wording across a census
  of shipped Foundation forms (#980).
- **Element order.** AOT XML is order-sensitive and the deserializer drops a
  misplaced element in silence: with `<DataGroup>`/`<DataSource>` above
  `<Controls>`, the metadata provider read the group with NO children. Verified
  against the live provider on the VM — same file, only those two lines moved:
  14 controls before, 16 after (#979).

`tests/eval/goldenFormIntegrity.test.ts` now fails on either shape, so a golden
captured from a defective writer cannot enshrine the defect again.
