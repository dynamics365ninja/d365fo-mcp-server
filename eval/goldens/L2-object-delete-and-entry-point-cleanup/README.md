# Golden - L2-object-delete-and-entry-point-cleanup

Golden metadata for [`L2-object-delete-and-entry-point-cleanup`](../../cases/L2-object-delete-and-entry-point-cleanup.json).

Captured 2026-08-23 on the D365FO VM (model `fm-mcp`, prefix `Con`, xppc 7.0.7996.33,
server SHA 4203716) through the grounded tool path only - no hand-edited XML on disk.
Corpus record: `eval/corpus/runs/2026-08-23T10__L2-object-delete-and-entry-point-cleanup__4203716.json`.

## What the four artifacts record

This is the **post-delete surviving state**:

| file | what it pins |
|---|---|
| `ConDemoScrapNote.metadata.xml` | table: `NoteId` mandatory/`Num`, `Subject`/`Name`, unique alternate-key index `NoteIdx`, `Overview` field group, `ReplacementKey`/`FormRef`/`DeveloperDocumentation` set (BP-clean) |
| `ConDemoScrapNoteForm.metadata.xml` | SimpleList form over the table |
| `ConDemoScrapNoteMI.metadata.xml` | the **surviving** display menu item |
| `ConDemoScrapNoteMaintain.metadata.xml` | privilege after `remove-entry-point`: exactly **one** entry point, `ConDemoScrapNoteMI` |

## Two assertions this golden makes by ABSENCE

A scoring run must check these outside the artifact diff - the oracle only compares
files that are staged into the actual dir:

1. `AxMenuItemDisplay\ConDemoScrapNoteAltMI.xml` is **gone** after
   `d365fo_file(action="delete", objectType="menu-item-display")`.
2. `AxIgnoreDiagnosticList\fm-mcp_BPSuppressions.xml` retains **only** the
   `dynamics://MenuItemDisplay/ConDemoScrapNoteMI` `<Diagnostic>`. The run seeds two
   suppressions on purpose; the delete must strip exactly the one whose `<Path>`
   targeted the deleted object and leave the control entry alone.

## Known non-goals of this golden

* **`.rnrproj` membership is NOT OBSERVED.** The eval sandbox carries no project file at
  all (`build_d365fo_project` builds by `modelName`). Record it as not observed, never as
  a pass or a failure.
* **`bp_clean=0` is expected.** `BPErrorPrivilegeNotCoveredByDuty` fires on any privilege
  with no duty, and the case admits no `AxSecurityDuty`. It is not an implementation defect.

## Grant element order - read this before regenerating

The entry-point `<Grant>` here is **alphabetical**: `Correct, Create, Delete, Read, Update`.
`buildAxSecurityPrivilegeXml` currently emits `Read, Update, Create, Delete` for
`accessLevel:"maintain"`; the Microsoft deserializer is sequence-ordered, so `Create` and
`Delete` are **silently dropped** and the privilege grants only Read+Update while still
building clean and passing BP. See the corpus record. If that generator is fixed, this
golden already holds the correct shape; if a future run regenerates the privilege from the
tool and this file starts to differ, the tool is wrong, not the golden.
