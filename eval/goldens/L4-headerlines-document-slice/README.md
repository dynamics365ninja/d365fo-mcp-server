# Golden: L4-headerlines-document-slice

Captured 2026-08-31 on the VM (model `fm-mcp`, prefix `ConDemo`, xppc 10.0.40) by
the **eval-implementer** role, from a full build reporting 0 errors. Eleven
artifacts, copied byte-for-byte off `PackagesLocalDirectory` by the build-gated
capture script.

## Two elements here were REPAIRED by the fix PR, not captured

The capture run scored `TOOL_DEFECT`. It deliberately left two corrupted writes
in place rather than repairing its way to green — the eval loop is forward-only —
and the golden therefore enshrined output that was wrong:

| File | Element | What happened |
|---|---|---|
| `ConDemoRentHeader.metadata.xml` | `<DeleteAction>Cascade</DeleteAction>` | The XML writer emitted the entry as Name → Table → DeleteAction. Microsoft's own 126 shipped `<AxTableDeleteAction>` entries are Name → DeleteAction → Relation → Table, and the deserializer drops a misordered element **in silence**, so the provider read the entry with DeleteAction at its default and the next bridge-backed `Update()` wrote it back without the element. |
| `ConDemoRentLine.metadata.xml` | `<CacheLookup>None</CacheLookup>` | The create's property reconcile patches the file on disk, but the provider refresh was scheduled BEFORE that patch. The provider rebuilt from the pre-patch bytes, and the next `Update()` serialised the cached copy back over it. |

Both writes reported `applied` and `✅ Verified: on disk`, both objects built with
0 errors and were xppbp-clean, and the golden diff was green — the corrupted
bytes WERE the golden. Only a second write landing on the same object could show
it.

Per `docs/AGENT_EVAL_LOOP.md` §6.4 the fix PR must update the golden in the same
change, and the two diff lines

    + <DeleteAction>Cascade</DeleteAction>
    + <CacheLookup>None</CacheLookup>

are the reviewable evidence that the defects are gone. They are placed in the
canonical serialised position, which is what the fixed writers now emit. **Do not
read that update as a regression** — and note that these two elements are the
only bytes in this folder that did not come off the VM. The next run of this case
re-captures the folder from a real build and returns it to captured-only bytes.

## What the case covers

A header/lines document slice: enum + EDT + two tables with a delete action and a
number-sequence module, a DetailsTransaction form and its display menu item, and
the security privilege/duty/role chain — eleven artifacts in one feature.

## Known BP findings this golden carries

The capture recorded `bp_clean: 0`. Five `BPErrorLabelIsText` findings come from
the DetailsTransaction scaffold writing raw-text tab captions, one
`BPCheckPassiveJoinUse` from its `LinkType=Delayed`, and
`BPUpgradeMetadataDeleteAction` from a delete action with no explicit relation —
`add-delete-action` now takes `deleteActionRelation` for exactly that. They are
recorded rather than hidden: the golden is what the tools produce today.
