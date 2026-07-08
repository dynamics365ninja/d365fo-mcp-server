---
description: Run an eval case end-to-end on the VM (implement → build → score → record → roll back). VM/full-mode only.
argument-hint: <case-id>
allowed-tools: Agent, Bash, Read, Grep, Glob
---

Launch the **eval-implementer** subagent (Task tool, `subagent_type: eval-implementer`)
to run this eval case through the grounded MCP tool path on the VM:

Case id: **$ARGUMENTS**

First read `eval/cases/$ARGUMENTS.json`. The subagent carries the full loop
(isolate → implement grounded-only → static gate → build → golden/SysTest oracle
via `npm run eval:score` → write corpus record → roll back → triage hypothesis).
It requires the d365fo MCP tools connected in full mode on the VM and pins all
writes to the `Contoso` sandbox — if those tools are not available, it will say so
and stop. Relay the corpus record and pass/fail verdict back to me.
