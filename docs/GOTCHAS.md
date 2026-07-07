# D365FO MCP Gotchas and Conventions

Field-learned conventions and traps for inspecting, creating and modifying D365FO objects through the MCP tools. Complements [SETUP.md](SETUP.md), [MCP_TOOLS.md](MCP_TOOLS.md) and [USAGE_EXAMPLES.md](USAGE_EXAMPLES.md).

> Tool-surface note: some items below were learned on the older flat tool set (`create_d365fo_file` / `modify_d365fo_file`). The modern server exposes them as `d365fo_file(action="create"|"modify")` and whole-object generation as `generate_object`, with a grounding chain (`prepare` -> `validate_code` -> `d365fo_file`). Prefix/suffix injection into names in particular may differ; re-verify on the current server before relying on it.

## Metadata inspection: read-only first, local write MCP as fallback

- Default inspection path is the read-only (Azure/HTTP) server: `search`, `find_references`, `get_object_info`, `labels`.
- If the read-only server returns nothing (0 hits / not found), do NOT conclude the object is missing. Re-run the same lookup against the local write server before deciding. The local companion reads the local packages directly and exposes the same read-style tools (`search`, `get_object_info`, `find_references`, `labels`) plus `update_symbol_index({ filePath })`. The remote index can be stale or may not include freshly created or not-yet-indexed custom packages.
- Using the write server only for searching/reading is read-only and safe; it does not create or modify anything.
- Order of inspection: read-only server -> if empty, same lookup on local write server -> if needed `update_symbol_index({ filePath })` -> only then a narrow filesystem glob scoped to the specific model folder (for example `PackagesLocalDirectory\<Package>\<Model>\AxEdt\<Prefix>*.xml`). Never wide-scan the whole `PackagesLocalDirectory` — it is slow, times out, and can hang the VS MCP integration.

## Labels: file ID is not the model name

- A label file ID is independent of the model that owns it. Example: label file `Anegis` lives in model `AnegisExtensions`; label file `Ang` lives in model `Anegis`. Do not assume `@<Model>:...` resolves — many `@<Prefix>:...` files do not exist at all.
- Before referencing `@<File>:<Id>` on a new or edited object, confirm the label file exists and which model it belongs to via `labels(action="info")`, and confirm the label Id exists via `labels(action="search")`.
- Create new labels in an existing label file of the target model, in every configured language. A reference to a missing label file or Id is a build error, not just a missing translation. This applies to both `Label` and `HelpText`.

## Extension object naming

- `d365fo_file(action="create")` injects the configured `EXTENSION_SUFFIX` as an infix before `_Extension`, producing class names like `<Base><Suffix>_Extension` and table/form/entity extensions like `<Object>.<Suffix>Extension`.
- A repo may follow a different established style, for example CoC classes `<Prefix><Base>_Extension` (prefix at front) and extensions `<Object>.Extension<Suffix>`. To match it you must rename after creation: rewrite the file under the correct name preserving the UTF-8 BOM, update the internal `<Name>`, and fix the `.rnrproj` `Include`/`Name`/`Link` entries.
- The prefix-front style triggers BP `ExtensionClassNamingWithExtensionOnly` (a non-blocking warning existing repo classes also carry). Do not "fix" it by re-adding the infix unless explicitly asked.

## Multiple extensions of the same base object

- A table or form can be extended from several models, but each extension object name must be unique across models.
- If another model already owns `<Object>.Extension<Suffix>`, pick a distinct, model-consistent suffix in your model.

## Writable unmapped field on a data entity (via extension)

- Add a writable, code-handled field via `AxDataEntityViewUnmappedFieldString` with `<IsComputedField>No</IsComputedField>` and an unbounded EDT. The value arrives in the entity buffer on inbound OData/DMF regardless of mapping.
- Read/consume it in a Chain of Command on the entity's `mapDataSourceToEntity`, declared with `[ExtensionOf(dataentityviewstr(<Entity>))]`.
- If the base entity already defines a method you also add (for example `changeLog`), your method is treated as a CoC wrap: it must be a valid CoC — same access modifier as the base and it must call `next`. Otherwise the build fails with `ChainOfCommandNextCallMustExist` / `ChainOfCommandMethodAccessModifierMismatch`. If you do not want CoC semantics, use a non-colliding private helper name instead.

## Source control / PackagesLocalDirectory mapping is per-machine

- Do not assume the version control system or how `PackagesLocalDirectory\<Model>` maps to source. It varies per VM: some use git (with the model folder symlinked into a git repo), others TFVC (workspace mapping), others a standalone folder.
- Before committing MCP-created changes, determine on the current machine where the files actually land and how to register them. Keep the resolved, machine-specific mapping in local config, not in shared docs.

## Write tool gotchas

### `d365fo_file(action="modify")` can reject valid PackagesLocalDirectory paths

- Symptom: `Refusing to write outside configured D365FO package roots` even though the path is inside `PackagesLocalDirectory` (backslash vs forward-slash mismatch in the root comparison). Passing `modelName`/`packageName` does not help; `action="create"` writes to the same path fine.
- Workaround: for a small change to an existing, valid metadata file use a plain text edit (preserving the UTF-8 BOM, changing only the matched fragment). Reserve `action="create"` for creating or overwriting whole objects.

### `labels(action="create")` re-sorts the whole label file

- Symptom: after adding one or two labels, the `.label.txt` diff shows every label shifted (dozens of lines), because `sortLabels=true` is the default.
- Workaround: call `labels(action="create")` with `sortLabels=false` (append at end) so the diff shows only the new labels. If the file was already re-sorted, revert it and re-add the labels with `sortLabels=false`.

### Binary (compiled) models are not in the index or the bridge

- Symptom: `search` and `get_object_info(...)` do not find objects/EDTs from a model deployed as binary, although the objects exist and are used.
- Cause: binary models ship only `bin` plus `.md` descriptors in `PackagesLocalDirectory`, with no source XML — the symbol index and bridge have nothing to read.
- Workaround: confirm existence by grepping the descriptors `bin\<Model>_Ax<Type>.md`; take class/entity content from a local `.xpp` copy if available. Compilation is unaffected as long as the target model references the binary model in its descriptor.
