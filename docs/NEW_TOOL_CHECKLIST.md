# New Tool Registration Checklist

Every new MCP tool requires changes in these files. Check each item before opening a PR.

> **Read this first, then read [Prefer merging over adding](#prefer-merging-over-adding-discriminator-pattern).**
> Most capabilities belong on an existing unified tool. Adding a tool costs every
> future request — the `tools/list` payload ships on every call, and the model's
> selection accuracy falls as the list grows.

> **Where schemas live.** Tool definitions (`name` / `description` / `inputSchema`)
> live one-per-file in **`src/server/toolSchemas/`**, aggregated by
> `src/server/toolSchemas/index.ts`. They were extracted out of `mcpServer.ts` in
> commit `a49488a`; `mcpServer.ts` now only spreads `toolSchemas` into the
> `ListToolsRequestSchema` handler and contains zero tool definitions. Any
> instruction that tells you to edit `mcpServer.ts` for a schema is stale.

## Implementation

- [ ] Create `src/tools/<toolName>.ts` — tool logic + exported `*Tool(request, context?)` function
- [ ] Create `src/server/toolSchemas/<toolName>.ts` — export `const <toolName>Tool = { name, description, inputSchema }`. This is the single source of truth for the wire schema; do NOT also define it in the handler file
- [ ] Register in `src/server/toolSchemas/index.ts` — add the `import` **and** the entry in the `toolSchemas` array. **Append**, do not insert: the array order is the serialized `tools/list` order and is covered by tests
- [ ] Keep descriptions SHORT and precise — they are sent to every client with the tool list; document behavior the model can't infer (gates, side effects, prohibitions), not what the enum already says
- [ ] Add `import` + `case '<tool_name>':` in `src/tools/toolHandler.ts`
- [ ] Add `TOOL_ANNOTATIONS` entry in `src/server/toolAnnotations.ts` (display title + readOnly/destructive hints — enforced by the toolInventory test, and the runtime tool count is derived from this map's size)
- [ ] Add a progress message case in `src/utils/toolProgressMessage.ts`
- [ ] Decide locality: add to `LOCAL_TOOLS` in `src/server/serverMode.ts` only if the tool requires local filesystem/Windows access
- [ ] Decide breadth: add to `CORE_TOOLS` in `src/server/serverMode.ts` only if the tool is a step of the plan → discover → write → build → verify loop. `tests/server/serverMode.test.ts` pins both the core membership and the excluded list, so a new tool fails until it is classified either way
- [ ] Keep parameters OUT of the wire schema when the tool dispatches on a discriminator: publish the discriminator enum + a loose `params` object and put the per-value contract in an op-spec registry reachable from `get_knowledge(kind="op-spec")` (see `src/tools/d365foFileOpSpecs.ts`, `src/tools/generateObjectOpSpecs.ts`). The ListTools payload ships on every request; a contract the agent needs once should be fetched once

## Startup catalog (index.ts)

- [ ] Add `{ name: '<tool_name>', desc: '...' }` to the correct category array in `src/index.ts` (HTTP mode log)
- [ ] Update the category description string in `src/index.ts` (the `'1 discovery + 1 labels + 3 object-info + …'` literal) so the parts still sum to the total
- [ ] **No count constant to update.** The stdio-mode count is derived at runtime from `Object.keys(TOOL_ANNOTATIONS)`, so it tracks the real number without a literal. (Older revisions of this checklist told you to edit a `const totalTools = N`; that constant no longer exists.)

## Tests

- [ ] Create `tests/tools/<tool-name>.test.ts` with at minimum: input validation, happy path, error path
- [ ] Update `tests/utils/toolInventory.test.ts`: increment both `toHaveLength(N)` assertions (the `toolSchemas` array and the `src/index.ts` startup catalog) and the local / non-local split
- [ ] Update `tests/utils/toolSchemaBudget.test.ts` — the serialized `tools/list` payload has byte ceilings. Raising one is a deliberate decision, not a rubber stamp: quantify what the new tool costs every request
- [ ] Update `tests/server/serverMode.test.ts` for the core/local classification
- [ ] If the tool touches knowledge base entries: add cases to `tests/tools/xpp-knowledge.test.ts` and read [KNOWLEDGE_AUTHORING.md](KNOWLEDGE_AUTHORING.md)

## Documentation

- [ ] Add tool entry to `docs/MCP_TOOLS.md` (name, description, parameters, example prompt)
- [ ] Update tool count in `README.md` (headline + paragraph + MCP_TOOLS.md reference)
- [ ] Update tool count in `docs/ARCHITECTURE.md` (tool totals in architecture description)
- [ ] Update tool count in `docs/MCP_TOOLS.md` header
- [ ] Update tool count in `docs/QUICK_START.md`, `docs/MCP_CONFIG.md`, `docs/SETUP.md`
- [ ] Update the `server.toolProfile` description + choice hints in `src/config/settings.ts` — `docs/CONFIGURATION.md` is **generated** from that registry (`npm run config:docs`), so editing the doc alone is reverted by the next regeneration
- [ ] Add tool to Core Tool Mapping table in `.github/copilot-instructions.md` if user-facing

## Prefer merging over adding (discriminator pattern)

Before adding a brand-new tool, check whether the capability belongs to an existing
**unified** tool. Many tools dispatch on a discriminator parameter instead of being
separate tools — `get_object_info(objectType)`, `analyze_code(mode)`, `labels(action)`,
`d365fo_file(action)`, `security_info(mode)`, `get_knowledge(kind)`, `extension_info(mode)`,
`validate_code(mode)`, `generate_object(mode)`, `object_patterns(domain)`. Fewer tool
names mean better model tool-selection.

If your capability fits one of these, **add a discriminator value** instead of a new tool:

- [ ] Add the new `mode` / `action` / `domain` value to that tool's enum + description in its `src/server/toolSchemas/<toolName>.ts` file
- [ ] Route it inside the tool's dispatcher (e.g. `src/tools/extensionInfo.ts`) — keep the underlying handler file intact; the dispatcher remaps params and forwards the request
- [ ] Add a sub-branch to the tool's `case` in `src/utils/toolProgressMessage.ts`
- [ ] No changes to tool **count**, `TOOL_ANNOTATIONS` or the `index.ts` catalog are needed — the tool already exists
- [ ] Add a routing/remap test in `tests/tools/mergedDispatchers.test.ts`

Name discriminated tools concretely (`validate_code`, `object_patterns`, `extension_info`) —
a bare `validate` / `patterns` token is too vague for reliable model tool-selection.

## Retiring a tool

Consolidations leave the old name behind in comments, error strings and "call this
next" guidance, where the model reads it and calls a tool that no longer exists.

- [ ] Add the old name to the `retired` list in `tests/utils/toolInventory.test.ts`
- [ ] Grep for the name in `src/**` — including inside template literals and comments — and rewrite every hit to the surviving tool + the discriminator value that replaces it

## Quick count check

```bash
# Published tools (schemas are the source of truth)
ls src/server/toolSchemas/*.ts | grep -v index.ts | wc -l

# Must agree with the annotations map and the startup catalog:
npx vitest run tests/utils/toolInventory.test.ts
```

The count assertions live in `tests/utils/toolInventory.test.ts`; if they pass, every
surface is in sync. (The old `grep -c "name: '" src/server/mcpServer.ts` check now
returns 0 and is meaningless — schemas moved out of that file.)
