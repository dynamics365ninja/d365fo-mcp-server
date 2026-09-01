# Golden: L4-headerlines-document-slice

Re-captured 2026-09-01 on the VM (model `fm-mcp`, prefix `ConDemo`, xppc 10.0.40)
by the **eval-implementer** role, from a full build reporting 0 errors and
0 warnings. Eleven artifacts, copied byte-for-byte off `PackagesLocalDirectory`
(CRLF normalised to LF, nothing else).

**This folder was re-captured from the 2026-09-01 build**, so the two elements the
fix PR had hand-repaired are now real captured bytes. One line has been removed by
hand since — `<CacheLookup>None</CacheLookup>` in `ConDemoRentLine.metadata.xml`,
which the same run proved the platform never writes (see below). Everything else
came off the VM.

## History: two elements were REPAIRED by the fix PR before they could be captured

The 2026-08-31 capture run scored `TOOL_DEFECT`. It deliberately left two
corrupted writes in place rather than repairing its way to green — the eval loop
is forward-only — and the golden therefore enshrined output that was wrong:

| File | Element | What happened |
|---|---|---|
| `ConDemoRentHeader.metadata.xml` | `<DeleteAction>Cascade</DeleteAction>` | The XML writer emitted the entry as Name → Table → DeleteAction. Microsoft's own 126 shipped `<AxTableDeleteAction>` entries are Name → DeleteAction → Relation → Table, and the deserializer drops a misordered element **in silence**, so the provider read the entry with DeleteAction at its default and the next bridge-backed `Update()` wrote it back without the element. |
| `ConDemoRentLine.metadata.xml` | `<CacheLookup>None</CacheLookup>` | The create's property reconcile patches the file on disk, but the provider refresh was scheduled BEFORE that patch. The provider rebuilt from the pre-patch bytes, and the next `Update()` serialised the cached copy back over it. |

Both writes reported `applied` and `✅ Verified: on disk`, both objects built with
0 errors and were xppbp-clean, and the golden diff was green — the corrupted
bytes WERE the golden. Only a second write landing on the same object could show
it.

Per `docs/AGENT_EVAL_LOOP.md` §6.4 the fix PR updated the golden in the same
change, and the two diff lines

    + <DeleteAction>Cascade</DeleteAction>
    + <CacheLookup>None</CacheLookup>

were the reviewable evidence that the defects were gone. **Do not read that update
as a regression.**

## The 2026-09-01 verification run

The next run of the case did what this README promised: it re-captured the folder
from a real build. Both repaired lines came back **exactly as the fix PR had
written them**, in the same canonical positions, produced by the tools:

- `ConDemoRentHeader.metadata.xml` re-captured with `<DeleteAction>Cascade</DeleteAction>`
  intact — see below.
- `ConDemoRentLine.metadata.xml` re-captured byte-identical to its committed form,
  **and that turned out to be the wrong answer.** The run reported the new guard
  firing — `🔧 Restored after the write: CacheLookup=None.` — which sent us to
  look at why the round trip kept dropping the element. It was not dropping
  anything: `RecordCacheLevel.None` is 0, the .NET type default the serializer
  omits, so **absence already means None**. Of the 1,444 `<CacheLookup>` elements
  in 6,995 shipped tables, not one says `None`, and 95 of the 231 shipped
  Transaction tables carry no element at all. This server's omitted-default table
  named `NotInTTS` instead — the one value that appears 301 times — so it wrote an
  element the platform never writes and skipped a real one that was asked for.

  Fixed in the same PR, and the line is therefore GONE from this golden: a
  Transaction table with `CacheLookup=None` is spelled by the absence of the
  element. That single deletion is the last hand edit this folder takes; the next
  run of the case re-captures it from a build.
- `ConDemoRentHeader.metadata.xml` re-captured with `<DeleteAction>Cascade</DeleteAction>`
  intact after **two** further bridge-backed `Update()` calls on the same table
  and after a full rebuild — no guard needed, the ordering fix is a root fix.

One line changed in the re-capture, and it is deliberate rather than a
regression: `add-delete-action` now accepts `deleteActionRelation`, the run passed
it, and the entry gained

    + <Relation>ConDemoRentHeader</Relation>

That is the relation on the *child* table pointing back at the header — the shape
Microsoft's own delete actions use — and it removes the
`BPUpgradeMetadataDeleteAction` warning, taking this case from 14 BP warnings to 13.

## What the case covers

A header/lines document slice: enum + EDT + two tables with a delete action and a
number-sequence module, a DetailsTransaction form and its display menu item, and
the security privilege/duty/role chain — eleven artifacts in one feature.

## Known BP findings this golden carries

The 2026-09-01 capture recorded `bp_clean: 0` with 13 case-attributable warnings.
Five `BPErrorLabelIsText` come from the DetailsTransaction scaffold writing
raw-text tab captions and one `BPCheckPassiveJoinUse` from its `LinkType=Delayed`;
three `BPErrorTablePrimaryKeyEditable` and two
`BPErrorDeveloperDocumentationNotDefined` come from `d365fo_file(create, table)`;
`BPErrorEDTNotMigrated` / `BPUpgradeMetadataEDTRelation` are inherent to the
case-mandated standard `CustAccount` EDT. They are recorded rather than hidden:
the golden is what the tools produce today.
