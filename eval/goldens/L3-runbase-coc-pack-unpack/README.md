# Golden - L3-runbase-coc-pack-unpack

Golden metadata for [`L3-runbase-coc-pack-unpack`](../../cases/L3-runbase-coc-pack-unpack.json).

Captured 2026-08-31 on the D365FO VM (model `fm-mcp`, prefix `Con`, xppc 7.0.7996.33,
server SHA 6322622) through the grounded tool path only - `prepare` -> `get_knowledge(topic="deprecated")`
-> `get_object_info` / `analyze_code` -> `validate_code` -> `labels(create)` -> `d365fo_file(action="create")`
-> `d365fo_file(action="modify", operation="add-method")`. No hand-edited XML, no `overwrite=true`.
Corpus record: `eval/corpus/runs/2026-08-31T09__L3-runbase-coc-pack-unpack__6322622.json`.

## What the artifact records

`ConDemoLegacyNoteJob.metadata.xml` - one `RunBaseBatch` subclass carrying the complete legacy
lifecycle. Five things must hold:

1. **The macros live in the class DECLARATION, not in a method.** `#define.CurrentVersion(2)`,
   `#define.Version1(1)`, `#localmacro.CurrentList` and `#localmacro.CurrentListV1` sit inside the
   `<Declaration>` block next to the member variables. A macro declared inside a method body does
   not compile here.
2. **`pack()` is `return [#CurrentVersion, #CurrentList];`** - the version number FIRST, then the
   field list, because that is what `conPeek(_packed, 1)` reads back.
3. **`unpack()` switches on the version and never assigns blindly.** `case #CurrentVersion:` reads
   `[version, #CurrentList]`; `case #Version1:` reads the RETAINED `[version, #CurrentListV1]` and
   defaults the field that version 2 added; `default:` returns **false**. A version-blind unpack -
   one that assigns `#CurrentList` whatever the container says - fails this case, because it reads
   an old container into a new list and the job then runs with silently wrong parameters. The
   `case #Version1:` branch is the other half of the same rule: bumping the version without keeping
   the old list turns every already-saved batch job into a silent no-op.
4. **The dialog lifecycle is complete and symmetric.** `dialog()` builds a `DialogRunbase` and KEEPS
   each `DialogField` returned by `addFieldValue` in a member variable; `getFromDialog()` reads the
   same fields back with `.value()` and returns `super()`; `validate(Object _calledFrom = null)`
   keeps the base default value (it is an override, not a CoC wrapper) and reports through
   `checkFailed` with a real label; `run()` does the work.
5. **`canRunInNewSession()` is overridden.** It is not in the lifecycle list of the `deprecated`
   knowledge topic, but `Runbase.canRunInNewSession()` is `throw error(Error::missingOverride(...))`
   and xppbp raises `BPUpgradeCodeRunBaseMissingMethod` without it. This was the single BP finding
   of the first build.

The class-level `<remarks>` block carries the required comment on why NEW code uses SysOperation
(framework-serialized contract, so no hand-written container and no `#CurrentVersion` to bump; and
contract/controller/service separation), together with the counter-rule that an EXISTING RunBase
class must not be ported, because the batch records already saved hold the packed container.

## Naming note

The obvious name for this artifact, `ConDemoNoteArchive`, is already the OUTPUT table name of case
`L2-performance-set-based`. `prepare(mode="create")` reported no collision because it only sees the
live sandbox index, which had been rolled back. The class was renamed to `ConDemoLegacyNoteJob`
before the golden was captured so that no two cases pin the same base name.

## Labels

The four user-visible strings resolve against the `ConDemo` label file
(`@ConDemo:NoteArchiveCaption`, `NoteArchiveSubjectFilter`, `NoteArchiveSimulate`,
`NoteArchiveNoFilter`, `NoteArchiveResult`, `NoteArchiveSimulated`). The label file is run residue,
created by `labels(action="create", createIfMissing=true)` and removed at rollback - it is not part
of the golden. Plain strings in `info`/`checkFailed` fail xppbp with `BPErrorLabelIsText`.
