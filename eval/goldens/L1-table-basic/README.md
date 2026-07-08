# Golden — L1-table-basic

This folder holds the **golden metadata** for case
[`L1-table-basic`](../../cases/L1-table-basic.json): the normalised, expected
metadata the server *should* produce for that instruction.

It is empty until the golden is captured and human-approved. A golden is a
reviewed artifact, like a snapshot test — not auto-generated trust.

## Capturing the golden (first time, on the VM)

1. Implement the case once through the grounded path and **manually verify** the
   result is correct: it compiles, is BP-clean, and the table shape matches the
   instruction (fields, types, mandatory flags, field group `Overview`, unique
   index `NoteIdx`, `TitleField1 = Subject`).
2. Take the produced AOT metadata for `DemoAgentNote` and **normalise** it
   (per docs/AGENT_EVAL_LOOP.md §6.2):
   - strip volatile fields — `@Id`/GUIDs, timestamps, `ModelSaveInfo`/model
     descriptor (the case `ignore` list pins the known ones);
   - canonicalise element ordering and whitespace.
3. Save the normalised result here as `DemoAgentNote.metadata.xml` (or `.json`
   if a normalised JSON form is used) and **get it reviewed** before relying on
   it.

Once present, every run diffs its normalised output against this golden;
`missing` / `extra` / `changed` deltas are recorded in the run's `golden_diff`.

> Note: goldens can drift across platform updates. Each run records
> `platform_build`; if the golden legitimately changes for a new PU, update it
> in a reviewed PR alongside the reason.
