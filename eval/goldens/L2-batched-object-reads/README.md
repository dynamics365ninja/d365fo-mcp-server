# Golden: L2-batched-object-reads — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-31, server SHA 278eee3, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, effective prefix `ConDemo`. Written through the server's own write
path only — three `d365fo_file(action="create")` calls carrying
`properties.fields[]` plus an `operations[]` entry, and one
`d365fo_file(action="modify")` for a shape correction. No `overwrite=true`, no
hand-edited XML. Full-built with xppc (0 errors, 0 warnings) and checked with
xppbp; the capture script refuses to copy a golden out of a build that was not
clean, or out of a file edited after that build. Sandbox rolled back afterwards.

## What the case actually scores

The artifacts are ordinary table extensions — the point of the case is the
**read path**. The run made **exactly one** `get_object_info` call, in the plural
`objects=[…]` form, covering all three base tables *and* the EDT:

```
get_object_info(objects=[{table,VendGroup},{table,PaymTerm},
                         {table,InventItemGroup},{edt,Notes}])
→ "Fetched: 4 object(s) in parallel | Success: 4/4 | Time: 692ms"
```

Four objects, one round trip, 692 ms. Issue #831 (13 sequential single-object
reads in one audited session) does not reproduce: the batched form is
discoverable from the tool description, takes a **mixed** `objectType` array, and
returns per-object sections. `tests/eval/batchedObjectReadsCase.test.ts` pins the
tool-path requirement in the instruction so it cannot be edited away silently.

## Artifacts

`VendGroup.ConDemoExtension.metadata.xml`,
`PaymTerm.ConDemoExtension.metadata.xml`,
`InventItemGroup.ConDemoExtension.metadata.xml` — identical apart from `<Name>`.

| | What it has to keep showing |
|---|---|
| `Fields` | one `AxTableField` `i:type="AxTableFieldString"` named `EvalNoteText` |
| `ExtendedDataType` | `Notes` — the **existing** ApplicationPlatform EDT (String, StringSize -1 memo). This is the load-bearing element; see below |
| `FieldGroupExtensions` | the **base** table's `Overview` group, extended with `<DataField>EvalNoteText</DataField>` |
| `FieldGroups` | empty — no new group is invented |
| `FieldModifications` | empty — no base-table field is modified, as the instruction demands |
| labels | none authored at all: the field inherits the EDT label (`@SYS13887`) and the group is the base table's own, so the case needs no model label file |

## Notes from the capture

**`<ExtendedDataType>Notes</ExtendedDataType>` is what makes this golden
non-vacuous.** The historical table-extension defect wrote the field with no EDT
— or dropped the field entirely — because `normalizeFieldSpecsForBridge` emitted
`fieldType`/`extendedDataType` while the bridge reads `type`/`edt`; the result
built clean, which is exactly why the sibling case `L2-table-extension` still has
to `ignore` `AxTableExtension/Fields/AxTableField/ExtendedDataType`. This case
does **not** ignore it. The run read all three files back off disk instead of
trusting the success message, and then ran a negative control: deleting the
`<ExtendedDataType>` line from a copy makes the oracle report

```
− missing: VendGroup.metadata.xml::AxTableExtension/Fields/AxTableField[EvalNoteText]/ExtendedDataType
```

and renaming one `<DataField>` produces the matching field-group delta. The
golden fails on the defect it exists to catch.

**The field group shape came from the tool, not from a guess.** The first write
created a *new* group `ConDemoNotes` inside the extension — the shape the
`L2-table-extension` golden uses — and the tool answered:

> No form checked on `VendGroup` renders field group **ConDemoNotes** — a group no
> container names in `<DataGroup>` generates no controls, so a field in it is on
> no form. Rendered instead: `Overview` (form `VendGroup`, control "Grid").

That contradicts the instruction ("added to a field group **so it surfaces on
forms**"), so the run removed the new group and used
`add-field-to-field-group(fieldGroupName:"Overview", extendBaseFieldGroup:true,
autoCorrect:false)` instead. The tool then confirmed the field is rendered:
"the compiler generates `Overview_EvalNoteText` for this field, so it is already
on the form" (same for `PaymTerm`).

**Third-table asymmetry, kept deliberately.** `InventItemGroup` *does* own an
`Overview` group (the strict, `autoCorrect:false` call succeeded, so it was not
silently turned into a new group), but the advisory reports no form renders it —
`Forecast`, `PurchaseTax`, `SalesTax`, `Payment`, `RetailSAFT` are the rendered
ones. The golden keeps `Overview` on all three: uniform artifacts, the
semantically right group for a note field, and the instruction reads as a general
best-practice statement rather than a per-form audit. Worth knowing before
someone "fixes" the third file.

**Follow-up for a different case, not changed here:** by that same advisory,
`eval/goldens/L2-table-extension/CustGroup.ConExtension.metadata.xml` pins a new
group (`ConNoteInfo`) that renders on no form, and carries two raw-text labels
("Note info", "Note priority") — `BPErrorLabelIsText`. It builds clean and does
not satisfy its own instruction.

**BP provenance:** xppbp ran and reported 6 warnings, all six against the shared
INPUT fixture table `ConDemoNoteHeader` and **zero** against these three
extensions, so `bp_clean: 1` is scored for the case artifacts.
