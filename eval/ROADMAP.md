# Eval loop — roadmap

Status as of 2026-07-01 (branch `feat/eval-phase1`, PR #617). Loop machinery is
complete: implementer protocol, automated golden oracle + scorer (multi-artifact,
CRLF-normalized, discriminator-aware), SysTest runtime oracle, an improver
toolchain (clusterer, held-out regression, knowledge feedback, flake detection,
case mining, fix-brief generator), committed goldens with a CI regression gate,
and a corpus scoreboard. Full history of what was built and every fix landed
lives in `git log` and the commit messages on this branch — this file only
tracks what's still open.

- Full suite **1428/1428** green; `eval-gate` GitHub Actions workflow **green**.
- Catalog: **30 cases** across tiers L0–L4. All 9 documented form patterns,
  table/table-extension, query+view, map, number sequence, financial dimension
  framework, CoC extension, event-handler, business event, SysOperation batch,
  a basic and an advanced (contract params + output menu item) SSRS report, a
  data-entity + security chain feature slice, a plain standalone class, an
  interface/abstract-class/inheritance chain, and a custom delegate.
- 17 confirmed tool/validator defects found from corpus evidence and fixed
  (see PR #617 description for the full list).

## Remaining / open work

**Never exercised by any case:**
- SSRS reports with multiple datasets or precision design — `generate_object`'s
  `additionalDatasets` parameter is already implemented internally
  (`generateSmartReport.ts`) but not exposed in the MCP tool schema
  (`mcpServer.ts`), so it's currently unreachable via the actual tool
  interface. `L4-ssrs-report-advanced` covers a real filter contract parameter
  instead (multi-dataset needs the schema wired up first).
- KPIs/tiles, workflow, XDS (extensible data security) policies — deliberately
  skipped per explicit instruction; lower priority (rarer in custom-model work).

**Known unresolved gaps:**
- `data-entity` create's larger caller-wiring fix — the shared XML builder now
  populates a real query when `primaryTable`/`fields` are passed, but callers
  still need to know to pass them. Mined as
  `L4-bridge-drops-data-entity-primarytable-fields-on-create` (`golden_pending`).
- `SysTestConsole.exe` requires an interactive console session (unconditional
  `WaitForDebugger()`/`Console.ReadKey()` even in local-AOS mode) — a platform
  limitation, not fixable from this side. 3 cases stay `systest_pending: true`
  (`L2-coc-extension`, `L3-batch-basic`, `L2-event-handler-basic`). Tried
  `vstest.console.exe` + `RunnableDropSysTest.TestAdapter.dll` as a
  non-interactive alternative — discovers zero tests, dead end.
- CI-workflow half of the autonomous improver — the VM-free fix-brief
  generator (`npm run eval:brief`) is done; wiring a GitHub Actions workflow to
  run Claude Code unattended on top of it was proposed and **explicitly
  declined** (new autonomous-agent surface needing its own sign-off). Not
  planned unless asked again.

## Invariant (never break)

All eval writes pinned to the `contoso` sandbox; never add
`D365FO_CUSTOM_PACKAGES_PATH` targeting a real model (§11).
