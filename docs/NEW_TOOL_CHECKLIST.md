# New Tool Registration Checklist

Every new MCP tool requires changes in these files. Check each item before opening a PR.

## Implementation

- [ ] Create `src/tools/<toolName>.ts` — tool logic + exported `*Tool(request, context?)` function
- [ ] Define name/description/inputSchema ONLY inline in `mcpServer.ts` — do NOT export a `*ToolDefinition` duplicate (single source of truth; dead copies drift)
- [ ] Keep descriptions SHORT and precise — they are sent to every client with the tool list; document behavior the model can't infer (gates, side effects, prohibitions), not what the enum already says
- [ ] Add `import` + `case '<tool_name>':` in `src/tools/toolHandler.ts`
- [ ] Add tool `ListToolsResultSchema` entry in `src/server/mcpServer.ts`
- [ ] Add `TOOL_ANNOTATIONS` entry in `src/server/toolAnnotations.ts` (display title + readOnly/destructive hints — enforced by toolInventory test)
- [ ] Add a progress message case in `src/utils/toolProgressMessage.ts`
- [ ] Decide locality: add to `LOCAL_TOOLS` in `src/server/serverMode.ts` only if the tool requires local filesystem/Windows access

## Startup catalog (index.ts)

- [ ] Add `{ name: '<tool_name>', desc: '...' }` to the correct category in `src/index.ts` tool catalog (HTTP mode log)
- [ ] Update the `const totalTools = N` constant in `src/index.ts` (stdio mode log)
- [ ] Update the category description string in `src/index.ts` (e.g. `'8 discovery + ... + 2 code-quality'`)

## Tests

- [ ] Create `tests/tools/<tool-name>.test.ts` with at minimum: input validation, happy path, error path
- [ ] Update `tests/utils/toolInventory.test.ts`: increment `toHaveLength(N)` counts (mcpServer + startupCatalog) and the non-local count
- [ ] If the tool touches knowledge base entries: add cases to `tests/tools/xpp-knowledge.test.ts`

## Documentation

- [ ] Add tool entry to `docs/MCP_TOOLS.md` (name, description, parameters, example prompt)
- [ ] Update tool count in `README.md` (headline + paragraph + MCP_TOOLS.md reference)
- [ ] Update tool count in `docs/ARCHITECTURE.md` (tool totals in architecture description)
- [ ] Update tool count in `docs/MCP_TOOLS.md` header
- [ ] Update tool count in `docs/QUICK_START.md`, `docs/MCP_CONFIG.md`, `docs/CLAUDE_CODE_SETUP.md`
- [ ] Add tool to Core Tool Mapping table in `.github/copilot-instructions.md` if user-facing

## Prefer merging over adding (discriminator pattern)

Before adding a brand-new tool, check whether the capability belongs to an existing
**unified** tool. Many tools dispatch on a discriminator parameter instead of being
separate tools — `get_object_info(objectType)`, `analyze_code(mode)`, `labels(action)`,
`d365fo_file(action)`, `security_info(mode)`, `get_knowledge(kind)`, `extension_info(mode)`,
`validate_code(mode)`, `generate_object(mode)`, `object_patterns(domain)`. Fewer tool
names mean better model tool-selection.

If your capability fits one of these, **add a discriminator value** instead of a new tool:

- [ ] Add the new `mode` / `action` / `domain` value to that tool's enum + description in `mcpServer.ts`
- [ ] Route it inside the tool's dispatcher (e.g. `src/tools/extensionInfo.ts`) — keep the underlying handler file intact; the dispatcher remaps params and forwards the request
- [ ] Add a sub-branch to the tool's `case` in `src/utils/toolProgressMessage.ts`
- [ ] No changes to tool **count** or `index.ts` catalog are needed — the tool already exists
- [ ] Add a routing/remap test in `tests/tools/mergedDispatchers.test.ts`

Name discriminated tools concretely (`validate_code`, `object_patterns`, `extension_info`) —
a bare `validate` / `patterns` token is too vague for reliable model tool-selection.

## Quick count check

```
grep -c "name: '" src/server/mcpServer.ts  # total unique tool definitions
grep -c "name: '" src/index.ts             # must match
```
