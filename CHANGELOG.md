# Changelog

Notable changes per release. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[semantic](https://semver.org/) with the caveat noted under *Versioning* below.

This file starts at v1.0.0 (first public release, 2026-07-21). Entries before
2026-08-08 were reconstructed from git history and release tags — they name what
changed and why it mattered, but they are a summary, not an exhaustive log. Run
`git log v1.7.0..v1.8.0` for the complete set.

**Add an entry in the same PR as the change.** Put it under `[Unreleased]`; the
release PR moves the block under a version heading. A change nobody can find is
indistinguishable from one that never shipped — nine releases went out in the
first three weeks with no human-readable notes at all, which is why this file
exists.

## Versioning

Minor versions carry behavioural changes to the MCP tool surface (tools added,
merged or retired; parameter contracts changed). Patch versions are fixes that
do not move that surface. Because the tool surface *is* the API here, a
consolidation that retires a tool name is a **breaking change for any prompt or
instruction file that named it**, even though the version only moves a minor —
those are called out explicitly below.

---

## [Unreleased]

### Added
- `CHANGELOG.md` (this file).
- `biome.jsonc` + `npm run lint` — first linter in the project's history.
  Configured as an adoptable subset: rules where a hit is a defect or dead code
  are on, and every rule left off carries the finding count that made it
  unadoptable. Notably this is the only automated check `tests/` and `scripts/`
  receive — `tsconfig.json` `include` is `src/**/*` only.
- `.github/workflows/ci.yml` — `tsc --noEmit` fast-fail, the lint gate, v8 test
  coverage with an enforced ratchet, and the VM-free `*.integration.test.ts`
  tier, which previously had no runner at all.
- Knowledge topic **`extensible-enums`**: `IsExtensible=true` requires
  `UseEnumValue=No` and forbids `<Value>` elements. The create path has enforced
  that (and bypassed the C# bridge over it) since the beginning, but nothing
  taught it, so the only way to learn the rule was to ship XML that xppc rejects.
- `docs/KNOWLEDGE_AUTHORING.md` — how to get a knowledge topic past its three CI
  gates, including the snapshot scoping rule that blocks any new AOT reference.
- `tests/knowledge/entryIntegrity.test.ts` — gates knowledge-entry shape and, in
  particular, that every `related:` id resolves.
- `npm run config:docs -- --check` — fails when `docs/CONFIGURATION.md` has
  drifted from the setting registry.
- `docs/BACKLOG.md` restored: deleted by `5ef1413` with three items still open
  and never migrated, taking their deferral rationale and design sketches with it.
- First tests for four previously-uncovered risk modules: `securityPrivilegeXml`
  (the exact path of the silent empty-privilege incident), `formInfo` (561 lines,
  zero coverage, and the tool the agent reads control names from before every
  form extension), `repairFormControls`, and `fsExtensionScanner` (the fallback
  that exists to stop the agent shelling out to PowerShell).

### Fixed
- `get_method`'s Chain-of-Command template copied the base method's **default
  parameter values** into the wrapper signature — the exact defect `validate_code`
  reports as `COC001` and the `coc-authoring` topic forbids. It was also
  undetectable: the template strips access modifiers and `COC001`'s regex only
  fired on lines carrying one. Both halves fixed.
- Knowledge base said `curExt()` was deprecated (topic `deprecated`), mandated it
  (topic `multi-company`), and used it without comment (topic `direct-sql`) — and
  the stated "replacement" called `curExt()` itself while returning a different
  type. The `deprecated` topic now carries an explicit *NOT DEPRECATED* block for
  the APIs models most often hallucinate as obsolete.
- `crosscompany` container rule taught syntax that does not parse.
- Five dangling `related:` topic ids. The default (concise) formatter prints
  related ids without resolving them, so each one cost a wasted round trip.
- `docs/MCP_TOOLS.md`: 32 → **39** AOT object types, 25 → **31** modify
  operations, and `GROUNDING_ENFORCE` documented as defaulting **off** (it does).
- `docs/NEW_TOOL_CHECKLIST.md` rewritten — it had never been updated after
  `a49488a` moved tool schemas out of `mcpServer.ts`, so following it literally
  failed at three separate steps.
- `docs/CONFIGURATION.md` regeneration is now lossless. It had been hand-edited
  after generation, so `npm run config:docs` deleted three real environment
  variables (`EXTENSION_PREFIX_SOURCE`, `D365FO_CROSS_MODEL_WRITE_MODELS`,
  `D365FO_ALLOW_CROSS_MODEL_WRITE`) and reintroduced a wrong tool count.
- `QUICK_START.md` and `SETUP.md` disagreed on which setup scenario is D and
  which is E; two dead `SETUP.md#…` anchors.

---

## [1.9.0] — 2026-08-07

### Changed
- **Round-trip cost work.** Per-call boilerplate cut out of tool responses;
  cached context is re-billed on every round trip, so payload trimming and
  round-trip elimination were both pursued.

### Fixed
- Guidance text no longer tells the agent to call tools that no longer exist.
- `setup` stopped writing `README.md` into the solutions folder.

## [1.8.5] — 2026-08-07
Write-anchor handling and `add-field` on enums.

## [1.8.4] — 2026-08-07
### Changed
- **Cross-model write consent moved to configuration** and extended to cover
  `create`. Consent deliberately lives in the environment rather than in a tool
  parameter: a parameter is something the agent can grant itself.

## [1.8.3] — 2026-08-07
### Added
- Writes into another custom model are refused by default, with the extension
  route in the active model offered instead.

## [1.8.2] — 2026-08-07
### Fixed
- `workspaceDetector` no longer silently picks the wrong `.rnrproj` when a
  solution holds several; ambiguous workspaces now resolve the model and list the
  candidates instead of guessing.
- Project-folder names corrected for enum extensions ("Base Enum Extensions"),
  menu items ("&lt;Kind&gt; Menu Items") and security duty/role extensions.
- `symbols.file_path` indexed; the prefix is taken from the active model.

## [1.8.1] — 2026-08-04
Test-timeout fix. (Tagged without a `package.json` bump — 1.8.0 → 1.8.2 in the
manifest.)

## [1.8.0] — 2026-08-04
### Added
- Bridge and DB handles are released on shutdown.
### Fixed
- Transport errors return under the client's own request id.
- Configuration loads before the modules that read it.
- Remaining single-op RPC dispatch gaps in the bridge.
- Three tool queries no longer scan the symbol table.
### Docs
- Architecture diagram corrected — the bridge is not the sole write path; the
  eval loop gets its own block.

## [1.7.0] — 2026-07-30
### Added
- `AxTable` audit system fields and `AllowRowVersionChangeTracking` exposed to
  the writers; `modify-property` for data entities.
- `AxDataEntityView` writer expresses change tracking, key naming, `IsPublic`
  and the canonical skeleton.
### Fixed
- Grounding: `Type::member` is recognised even when a local is named after the
  type; an unknown parameter list is distinguished from an empty one.
- Extension write gaps across table/form/data-entity extensions; base-table
  relations routed to `RelationExtensions`.
- `undo` no longer deletes `<Folder Include>` entries it never added.
- Labels are compiled with `labelc.exe` before the X++ compile.

## [1.6.0] — 2026-07-29
### Fixed
- `AosService` is found by scanning drives instead of assuming `K:`; platform is
  read per call rather than once at import.
- `prepare` walks the extends chain for inherited methods.
- A finished build is never replayed as a fresh result.
- `get_object_info` falls back to the symbol index when the bridge is silent.

## [1.5.2] / [1.5.1] / [1.5.0] — 2026-07-27
### Added
- `setup` generates `.mcp.json` and stages the Copilot setup files.
- Adaptive concurrency in metadata extraction.
### Changed
- Repo cleanup and doc consolidation (`5ef1413`) — this is the commit that
  deleted `docs/BACKLOG.md` and five other docs.

## [1.4.0] — 2026-07-23
### Fixed
- Line endings of bridge-written artifacts normalised.
- Query writer emits ranges instead of inventing a literal `Title`.
- Macro, aggregate-measurement and license-code writers corrected against what
  the Microsoft serializer actually produces.
- `get_object_info` for classes stopped rendering `/// <summary>` as the method
  signature.

## [1.3.0] — 2026-07-22
### Changed
- **`better-sqlite3` replaced with core `node:sqlite`** — removed the native
  build dependency that was blocking App Service startup.
### Fixed
- Search prioritises custom/ISV models so they are not buried under Microsoft
  objects.

## [1.2.0] — 2026-07-22
### Fixed
- `d365fo_file(modify)` stopped discarding parameters in silence.
- The create/generate path stopped emitting metadata that cannot build.
- The read/search/info tools stopped misreporting metadata.
- The golden oracle and `bp_clean` became honest measurements — a never-run BP
  check no longer reads as a pass.

## [1.1.0] — 2026-07-21
First iteration after the public release.

## [1.0.0] — 2026-07-21
First public release.
