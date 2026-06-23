# Backlog — deferred work & future ideas

Things we consciously decided **not** to build yet, with enough context to pick
them up cold later. Each entry records *what*, *why deferred*, *the trigger that
should un-defer it*, and a concrete *sketch* so the next person doesn't re-derive
the design.

> Add a new item when you defer something during a PR. Move it to a commit (and
> delete it here) when it ships. Keep entries small and honest about the unknowns.

---

## Context pipeline — Phase 3b: live editor focus

**Status:** deferred · **Area:** `src/workspace`, `src/types/context.ts` · **Depends on:** Phase 1–3a (shipped)

**What**
- Replace the mtime-based *proxy* for the active object with the real editor
  focus, and use a file watcher instead of polling:
  - Populate `EditorContext.activeFile` (interface already exists in
    [`src/types/context.ts`](../src/types/context.ts), currently unpopulated).
  - Add `fs.watch` on the model metadata dir with debounce to invalidate the
    `WorkspaceScanner` cache on change, instead of the 15s lazy TTL added in 3a.

**Why deferred**
- MCP exposes workspace **roots**, not the focused file in the editor — there is
  no standard MCP message for "the user is looking at CustTable.xml". So real
  editor focus can only come from a client that volunteers it (e.g. Copilot in VS
  via `_meta`, or a future VSIX shim). Until we confirm the **target client
  actually consumes our MCP resources / sends focus**, this is work with no
  consumer — 3a's "most recently modified" proxy is good enough.
- `fs.watch` is platform-flaky (recursion, network/UDE drives), so it must stay
  an *optimization* over a reliable poll, never the only mechanism.

**Trigger to pick this up**
- We verify a target client reads `workspace://active` / `workspace://context`
  (or sends editor focus in `_meta`). At that point a precise active file is
  worth the watcher complexity.

**Sketch**
- `EditorContext.activeFile` ← from client-supplied focus when available; else
  fall back to the 3a mtime proxy (`contextSnapshot.activeObject`).
- `WorkspaceScanner`: add optional `fs.watch` per scanned root → debounced
  `invalidate(root)`; keep the 15s TTL as the fallback when watch is unavailable.
- Feed `activeFile` into `contextRanker` as the default anchor when a tool call
  omits an explicit object name.

**Risks**
- Watcher leaks / EMFILE on large trees → cap watched dirs to the model metadata
  dir; always tear down on disconnect.
- "Active" ≠ focus if the newest mtime is a build artifact → keep filtering to AOT
  `.xml` under the model and ignore `bin/obj/.git`.

---

## Context ranker in `search`

**Status:** deferred · **Area:** `src/tools/search.ts`, `src/workspace/contextRanker.ts` · **Depends on:** Phase 2 (shipped)

**What**
- Optionally let `search` re-rank / append a `rankContext()` "related" block when
  the caller passes an intent, reusing the ranker already wired into `prepare`.

**Why deferred**
- `search` already returns FTS5-ranked results, so the ranker is largely
  redundant there — and `search` is the hottest, most-tested path. Adding a new
  param means threading it through the large inline schema in
  [`src/server/mcpServer.ts`](../src/server/mcpServer.ts) plus `searchUnified` and
  tests, for marginal gain.

**Trigger to pick this up**
- A concrete case where plain FTS ordering misses relevance that the xref/usage
  signals would catch (e.g. users repeatedly searching then manually pulling the
  same neighbors).

**Sketch**
- Add an optional `intent`/`rankRelated` param on the single-search path; when
  set, append `renderRankedContext(rankContext(...))` after the FTS results.
  Keep it off by default so existing behaviour/tests are untouched.

**Risks**
- Schema churn on a high-traffic tool; double-ranking confusion. Keep it additive
  and clearly separated from the primary results.

---

## Tighter IDE integration (VSIX shim)

**Status:** idea · **Area:** new (out-of-repo VS extension) + `src/server` · **Depends on:** —

**What**
- A thin Visual Studio extension (à la the competitor's VSIX) that registers the
  MCP server, surfaces menu commands (refresh context, diagnose), and — crucially
  — volunteers **editor focus** and open-document context to the server. Unblocks
  Phase 3b's real `activeFile` and closes the last UX gap vs IDE-native tools.

**Why deferred (idea-stage)**
- Big surface area in a different tech stack (C#/VSIX), and most of the value is
  reachable today via MCP resources + roots without owning a VS extension. Only
  worth it if MCP-native context (resources/`_meta`) proves insufficient in
  practice with the target clients.

**Trigger to pick this up**
- Evidence that Copilot-in-VS / target clients do NOT consume our MCP resources
  or send focus, AND the proactive-context UX gap is costing real adoption.

**Sketch**
- VSIX sends active file + open docs via `_meta` on tool calls (already partially
  parsed in `extractWorkspaceFromMeta`) or a custom notification; server feeds it
  into `EditorContext` and the ranker anchor (see Phase 3b).

**Risks**
- Maintenance cost of a second codebase/release pipeline; VS Copilot LM/MCP APIs
  are still moving. Keep the server fully usable without the VSIX (graceful
  degradation), never make it a hard dependency.
