# Golden: L3-enum-field-form-downgrade-guard — PENDING

`golden_pending: true`. Nothing here is captured yet: this folder is a
placeholder so the case can be reviewed before the VM run. The golden itself is
captured from a real, human-reviewed build (docs/AGENT_EVAL_LOOP.md §6.4) by the
**eval-implementer** role — do not hand-author any `*.metadata.xml` here.

## Where the case comes from

A live customer demo on 2026-08-07 (customer table `AslFinCore_TaxTransReportChangeLog`).
Adding one enum-typed field, exposing it on the matching form and blocking a
value downgrade in `validateWrite()` cost several failed builds. The sandbox
equivalent of that task is this case.

## What the run must capture

| File | Object | Notes |
|---|---|---|
| `ConDemoServiceTier.metadata.xml` | `AxEnum` | None(0) / Silver(1) / Gold(2) / Platinum(3), `Label` = `@SCM:Code` |
| `ConDemoTaxChangeLog.metadata.xml` | `AxTable` | `ServiceTier` as `AxTableFieldEnum` + `EnumType`, **no** `ExtendedDataType`; in field group `Overview`; `FormRef`; `validateWrite()` |
| `ConDemoTaxChangeLogDetails.metadata.xml` | `AxForm` | SimpleListDetails scaffold + ComboBox bound to `ServiceTier` in the details group |

No `AxEdt*` artifact may appear in this folder — an enum table field needs no
EDT, and producing one is a case failure, not a golden variant.

## Why `**/AxEnumValue/Label` is on the case's ignore list

The case pins the label IDs that BP actually reasons about — the enum's own
`Label` (`@SCM:Code`), the field's `Label` (`@SCM:Description`) and the message
label in `validateWrite()` (`@TaxTransactionInquiry:HeaderNote`) — because
`BPErrorFieldLabelIsCopyOfEnumLabel` / `BPErrorTypeLabelIsCopyOfEnumLabel` is
about ID identity, and because the method body is diffed token-exact. The four
per-VALUE labels are left to the agent's own labels-index lookup (there is no
standard label for "Platinum" to pin), so their IDs are normalised out of the
diff. What is still scored for them: they must be label references, never raw
text (`BPErrorLabelIsText`).

## Capture checklist (implementer)

1. Provision nothing extra — every object in this case is its own OUTPUT; there
   is no fixture dependency (`npm run eval:fixtures` lists no INPUT for it).
2. Run the case end to end on the VM through the grounded `d365fo_file` path.
3. Build with a build that actually recompiles these objects, then run BP with an
   explicit per-object target (an untargeted `run_bp_check` reports a false clean).
4. Human-review the metadata, commit it here, flip `golden_pending` to `false`.
5. Live SysTest (`eval/systests/L3-enum-field-form-downgrade-guard.xml`,
   class `EvalL3ServiceTierDowngradeTest`) is tracked separately by
   `systest_pending`.
