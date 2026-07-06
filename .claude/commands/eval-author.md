---
description: Draft a new eval case (eval/cases/<id>.json) + scaffold its golden folder, golden_pending until captured on the VM.
argument-hint: <feature description or failure to turn into a case>
allowed-tools: Agent, Bash, Read, Edit, Write, Grep, Glob
---

Launch the **eval-author** subagent (Task tool, `subagent_type: eval-author`) to
draft a new case for the eval catalog.

What to author: **$ARGUMENTS**

The subagent carries the authoring contract (mirror existing cases at the tier →
draft via `npm run eval:mine` or by hand against `eval/cases/schema.json` →
`golden_pending: true` → scaffold `eval/goldens/<id>/` → validate schema + id/tier
match + `npx vitest run`). It will hand off with the next step: capture the golden
on the VM via the eval-implementer role. Show me the drafted case JSON.
