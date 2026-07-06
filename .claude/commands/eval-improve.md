---
description: Work the eval-loop corpus — rank failure clusters, fix the top actionable defect, validate against held-out, open a PR.
argument-hint: [cluster/area or blank for top-priority]
allowed-tools: Agent, Bash, Read, Edit, Write, Grep, Glob
---

Launch the **eval-improver** subagent (Task tool, `subagent_type: eval-improver`)
to run the improver role of the D365FO agent eval loop.

Focus for this run: **$ARGUMENTS**
(If blank, take the top-priority actionable cluster from `npm run eval:clusters`.)

The subagent already carries the full protocol (survey corpus → confirm rubric
class → reproduce as a VM-free repo test → fix tool/knowledge/validator →
validate full suite + held-out split → open a PR citing corpus evidence). Do not
re-explain it. Relay the subagent's verdict and the resulting diff/PR back to me.
Do not commit or push unless I ask.
