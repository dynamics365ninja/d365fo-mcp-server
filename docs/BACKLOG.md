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
