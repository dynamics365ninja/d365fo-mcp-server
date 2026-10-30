# Custom X++ Extensions Guide

This guide explains how to configure, extract, and index your custom X++ models and ISV packages alongside the standard Microsoft D365FO models.

## What this covers

- How to tell the server which models are "yours" (vs. standard Microsoft models)
- How to extract only custom models (fast, a few minutes) vs. everything (a full rebuild)
- How the `search(scope="extensions")` mode filters to your code only
- Multi-instance setups where each client has its own custom models

---

## Configuration

### Traditional (PackagesLocalDirectory)

The setup wizard (`npm run setup`, or later `npx d365fo-mcp config environment`) asks for all of this and writes it to `config/d365fo-mcp.json`. The keys involved — each overridable by its environment variable (a `.env` from an older installation keeps working as a fallback):

```jsonc
{
  "environment": {
    // Standard D365 packages path                       (env: D365FO_PACKAGE_PATH)
    "packagePath": "C:\\AOSService\\PackagesLocalDirectory",
    // Your custom models (comma-separated model names)  (env: CUSTOM_MODELS)
    "customModels": "ISV_CustomModule1,ISV_CustomModule2,CompanyExtensions"
  },
  "naming": {
    // ISV prefix — used by search(scope="extensions") for prefix filtering and by
    // code-gen tools for naming validation               (env: EXTENSION_PREFIX)
    "prefix": "ISV_"
  },
  "index": {
    // 'custom' (your models only), 'standard', or 'all'  (env: EXTRACT_MODE)
    "extractMode": "custom"
  }
}
```

**How custom model detection works:** Everything listed in `CUSTOM_MODELS` is treated as your code. All other models are automatically classified as Microsoft standard. The server never requires you to maintain a static list of Microsoft model names — the list auto-adapts to new D365FO versions.

**What to put in `CUSTOM_MODELS`:** list **every** non-Microsoft model you have source for — both the models you author into **and** any source-ISV models you only extend (never modify) — not just the ones you actively change. The classification drives `search(scope="extensions")`, workspace context ranking, form-pattern mining (ISV objects must stay out of the mined *standard* pattern catalog), and the Azure custom-build pipeline — all of which want ISV code classified as custom. Binary-only ISV models (shipped as compiled DLLs with no object XML) are never indexed, so there is no need to list them.

### UDE (Unified Developer Experience / Power Platform Tools)

In UDE environments, custom models are **auto-detected** from the custom packages path (`ModelStoreFolder` in your XPP config file). You do not need to set `CUSTOM_MODELS`:

```jsonc
{
  "environment": {
    "type": "ude",                 // env: D365FO_DEV_ENVIRONMENT_TYPE
    "xppConfigName": "MyConfig"    // env: XPP_CONFIG_NAME — name from %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\
  },
  "naming": { "prefix": "ISV_" }   // env: EXTENSION_PREFIX
}
```

Every model under `ModelStoreFolder` is automatically treated as custom; everything under `FrameworkDirectory` is Microsoft standard. Run `npm run select-config` to list available XPP configs.

---

## Extraction

### Custom models only (recommended for day-to-day updates)

```powershell
$env:EXTRACT_MODE="custom"
npm run extract-metadata
npm run build-database
```

Use after every code change or sprint. Cost scales with your custom models, not with the
database: every step is scoped to them, including full-text index maintenance and ANALYZE
(which run over the whole database on an `all` rebuild only). On a ~1.2M-symbol instance
a 3-model, ~10K-symbol build takes well under a minute.

`ANALYZE=true npm run build-database` forces the query-planner statistics to be recomputed
if you ever need them refreshed without a full rebuild.

### Everything (first-time setup or after D365FO upgrade)

```powershell
$env:EXTRACT_MODE="all"
npm run extract-metadata
npm run build-database
```

Only needed when Microsoft standard model content changes (e.g. after a D365FO upgrade).

Timing depends heavily on the environment. On a single-label-language instance (~176 models, ~1.2M symbols) a full `all` rebuild is roughly 10–15 minutes end to end. It grows substantially when many label languages are installed, because label indexing re-indexes every Microsoft label across all languages — so a large multi-language installation can take much longer. The dominant cost is label breadth, not X++ model size.

---

## Where the prefix comes from

Development normally spans several models, each with its own prefix, and `EXTENSION_PREFIX` is a single value chosen once during setup. So the **active model's own objects decide the prefix**, and the configured value is the fallback:

1. **The prefix the model's existing objects already use.** A model whose tables are `DEMO_ArchiveAccDocErrorLog`, `DEMO_AssetIPFairValue`… and whose extensions are `AssetBookTable.DEMOExtension` teaches the tools both tokens — `DEMO_` for new objects and members, `DEMO` as the extension infix. Switching to a sibling model whose objects say `DMC_` switches the prefix with it, with no reconfiguration.
2. **`EXTENSION_PREFIX`** — used for a model with nothing to learn from, e.g. one that is still empty.
3. **The model name**, when neither of the above applies.

Inference is conservative: a model whose objects show no consistent prefix (fewer than four of them, or under 60 % agreement) falls through to step 2 rather than guessing. `get_workspace_info` reports the effective prefix and where it came from, and warns when the model's own naming overrides `EXTENSION_PREFIX`.

Compound prefixes are read in full, up to three PascalCase segments: a model whose objects are `ContosoFinSKVendPaymentTable`, `ContosoFinSKCustInvoiceJour`… yields `ContosoFinSK`, not `ContosoFin`. Where the model's extensions state the infix outright (`VendTable.ContosoFinSKExtension`), that spelling wins over anything derived.

To pin step 2 above step 1 (pre-1.8.2 behaviour) — worth doing when one model carries several feature prefixes sharing a stem, so inference learns the shared stem while your objects need the full one:

```json
{ "naming": { "prefix": "CRXCore", "prefixSource": "config" } }
```

`npx d365fo-mcp config naming` asks for it in the advanced pass. The equivalent environment variable, `EXTENSION_PREFIX_SOURCE=config`, still works and still outranks the config file.

### No prefix at all

Some teams use no prefix — a suffix convention such as `CustomerSettings_ABC`, `ProductService_ABC`. Leaving `naming.prefix` empty does **not** mean "no prefix": steps 1–3 above still run, and step 3 prefixes every new object with the model name. Say so explicitly instead:

```json
{ "naming": { "prefixSource": "none", "suffix": "_ABC" } }
```

With `prefixSource: none` (env `EXTENSION_PREFIX_SOURCE=none`):

- New objects, fields and methods keep the name as given — nothing is inferred from the model, `naming.prefix` is ignored, and the model name is never used as a prefix. `naming.suffix` (optional) is still appended to new objects, and its own underscore is not flagged by the naming check.
- Extension elements and classes still need a token that keeps two models' extensions apart, so they embed the **model name**, as Visual Studio does: `CustTable.ABC`, `CustTable_ABC_Extension` (whatever `extensionStyle` / `extensionClassStyle` say — a prefix style has no prefix to embed). A CoC class you name yourself in a `{Base}_{Kind}_{Model}_Extension` shape, e.g. `CustTable_Table_ABC_Extension`, is kept as given.
- `validate_object_naming` stops asking for a prefix, and `get_workspace_info` / `doctor` report the choice instead of warning that no prefix is set.

`npx d365fo-mcp setup` asks for this when you leave the prefix empty.

### Names exactly as given

`none` still chooses the extension token: it is always the model name. When your token is something else, an abbreviation of the model name for example, use `as-given`. The server then renames nothing:

```json
{ "naming": { "prefixSource": "as-given" } }
```

With `prefixSource: as-given` (env `EXTENSION_PREFIX_SOURCE=as-given`), in a model named `ContosoCore` whose convention uses `ABC`:

| Proposed name | Type | `none` | `as-given` |
|---|---|---|---|
| `VendTableABC` | table | kept | kept |
| `VendTable.ABC` | table-extension | → `VendTable.ContosoCore` | kept |
| `VendTableTable_ABC_Extension` | class-extension | → `VendTableTable_ABC_ContosoCore_Extension` | kept |
| `VendTable` | table-extension | → `VendTable.ContosoCore` | **refused**: no token to invent |

- Nothing is prefixed, suffixed or given a token: `naming.prefix`, `naming.suffix`, the naming styles and the model's own objects are all ignored. Fields and methods added to an extension keep their names too.
- A name is refused, with the reason, only when it cannot be a valid AOT name: an element extension without exactly one dot (`<Base>.<Token>`), a class extension that does not end in `_Extension`, characters other than letters, digits and `_`, or more than 81 characters. Collisions are reported as before.
- `validate_object_naming` and `prepare` check that structure only. The prompt's CoC naming rule, `get_workspace_info`, `doctor` and the cross-model refusal stop naming a token and point to your instruction file.
- Names the server would otherwise derive itself, such as the class names in a `generate_object` CoC scaffold, carry no token. Rename them before `d365fo_file(action="create")`; the reply says so.

Write the convention into the project's instruction file (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, …). In this mode the model follows that file and nothing else.

## Objects owned by another model

A customer solution is commonly split across several **custom** models — a shared `ContosoFinanceCore` plus country models `ContosoFinanceSK` / `ContosoFinanceCZ` that extend it. The workspace targets exactly one of them; every other model is code this workspace only consumes.

So any write — `d365fo_file(action="modify")`, `action="create"`, a scaffold from `generate_object(mode="scaffold")`, or a new label — that resolves into a model other than the workspace's own is **refused**. Asked to "add a field to `ContosoCore_TaxTransReportChangeLog`", the tools would otherwise resolve that table by name, land in the Core model that owns it, and edit it in place — the field would never appear in the active model's project or version control, and every other model built on Core would inherit it. What was wanted is a table extension in the active model:

```
d365fo_file(action="create", objectType="table-extension",
            objectName="ContosoCore_TaxTransReportChangeLog.ContosoSKExtension",
            modelName="ContosoFinanceSK")
```

…and the field added to that extension, prefixed per the active model (`ContosoSK_…`). The refusal spells this out, and names the extension the active model **already** has when one exists, so the answer is a copy-paste away.

### A project switch moves reads, not writes

`get_workspace_info(projectName=…)` changes which project is **active** — what gets built, BP-checked and written into. It is not a way to reach another model's code: `get_object_info`, `search`, `find_references` and the rest query the index across every model, switched or not.

Writes therefore stay anchored to the model the workspace resolved on its own, and a create/modify/scaffold into the switched-to model is refused like any other cross-model write. Otherwise the switch would be self-served consent: refused write → switch project → same write, no refusal. The anchor is dropped when the user genuinely moves — the client reports a different workspace root, or a git branch that resolves to another project — because then the workspace really did change.

If the switch is what the user wanted and the writes belong in the other model, that is the allow-list below, not the switch.

### Consent lives in configuration, not in the call

The first version of this guard accepted `modelName="<owning model>"` on the call as consent. For a human that is a reasonable "I know what I'm doing"; for an agent it is not — the refusal text named the parameter, so the agent added the parameter and wrote into the shared model anyway, then explained why afterwards. A bypass the caller can mint for itself is not a bypass.

Allowing a cross-model write is therefore a **configuration** change — a file the user edits and the agent has no tool to write:

```env
D365FO_CROSS_MODEL_WRITE_MODELS=ContosoFinanceCore   # allow these models (comma-separated)
D365FO_ALLOW_CROSS_MODEL_WRITE=true                  # allow any model
```

These two settings are re-read from `.env` before every decision, so an answer given mid-task applies to the **next attempt** — no restart, no lost session. That matters for the guard rather than against it: while the only sanctioned route cost the user their session, all the pressure was on finding a cheaper one. Nothing else is re-read; this is a policy refresh, not a configuration reload.

A value set in the real environment (shell, the `.mcp.json` `env{}` block, App Settings) still outranks the file, exactly as at boot.

The refusal deliberately offers the caller no workaround, and says outright that half-finished pieces of the same feature already sitting in the other model — a matching enum, field or label left by an earlier run — are evidence of an earlier mistake, not a reason to continue there.

Writes into **standard Microsoft** models stay refused regardless — see the model-ownership guard.

## Extension Naming Style

When code-gen tools name an **extension element** (table/form/view/etc. extension) or an **extension class** (CoC / augmentation), the token that distinguishes your extension from others is controlled by `EXTENSION_NAMING_STYLE`:

```env
EXTENSION_PREFIX=CR
EXTENSION_NAMING_STYLE=prefix        # default — or "model-name"
```

| Style | Element extension | Extension class |
|-------|-------------------|-----------------|
| `prefix` (default) | `CustTable.CrExtension` | `CustTableCr_Extension` |
| `model-name` | `CustTable.ContosoRobotics` | `CustTable_ContosoRobotics_Extension` |

- **`prefix`** embeds the `EXTENSION_PREFIX` infix (Microsoft's prefix-based naming guideline).
- **`model-name`** embeds the **model name** — with any character an AOT identifier cannot hold removed, so a model called `Contoso Robotics` yields `CustTable.ContosoRobotics` (the same spelling the platform itself derives: `<Name>Monitoring and Telemetry</Name>` → `<ModelModule>MonitoringandTelemetry</ModelModule>`) — matching the Visual Studio developer-tools default (which uses the model name because it is already guaranteed unique). Use this when your model name is long/customer-specific (e.g. `ContosoRobotics`) but your prefix is a short abbreviation (e.g. `CR`) — the prefix still applies to **new** objects (`CRMyTable`) and to fields/methods added inside extensions (`CRApprovingWorker`); only the extension element/class token switches to the model name.

Run `get_workspace_info` to see the active style and worked examples of exactly what the tools will emit.

### Classes named differently from elements

Some conventions spell the two halves differently — Visual Studio element extensions (`CustTable.ContosoRobotics`) with prefix-style CoC classes (`CustTableCr_Extension`), or the reverse. A single style cannot express that: `model-name` rewrites the class to `CustTable_ContosoRobotics_Extension`, `prefix` rewrites the element to `CustTable.CrExtension`. Set the class style separately:

```env
EXTENSION_NAMING_STYLE=model-name          # element extensions
EXTENSION_CLASS_NAMING_STYLE=prefix        # extension classes — default: inherit
```

Unset (or `inherit`), `EXTENSION_CLASS_NAMING_STYLE` follows `EXTENSION_NAMING_STYLE`, so existing setups behave exactly as before. `get_workspace_info` and `validate_object_naming` report both styles when they differ.

**There is no custom naming template.** The name is normalised in code on every create and modify:

- An **element extension** always gets the style's token after the dot — `ProdTable.BKU_TableExtension` is written as `ProdTable.BKUExtension`.
- An **extension class** given a bare base name gets `{Base}{Infix}_Extension` (`ProdTable` → `ProdTableBKU_Extension`). A full name whose part before `_Extension` already *ends* with the infix is kept as passed, so `ProdTable_BKU_Extension` survives — but only when the agent passes that exact name. The infix counts only as its own PascalCase word: with infix `Le`, `SalesTable_Extension` is a base that still needs it (`SalesTableLe_Extension`), not one that already ends in it. A base that itself *starts* with the infix as a word (`ProjTable` under infix `Proj`) cannot be told apart from an already-prefixed name, so pass the bare base (`objectName: "ProjTable"`, `objectType: "class-extension"`) to get `ProjTableProj_Extension`; a full `ProjTable_Extension` is kept as given.

The extension patterns in `copilot-instructions.md` (or any other rules file) only *describe* this behaviour: editing them does not change what the tool writes, and it leaves the agent's instructions contradicting the tool. To switch styles, run `d365fo-mcp config naming` (or set `EXTENSION_NAMING_STYLE`) and restart the server. With `prefix`, the infix follows `EXTENSION_PREFIX`, or the spelling the model's existing extensions already use.

### Prefix leading the class name

Both `prefix` and `model-name` put the token right before `_Extension` — `CustTableCr_Extension`, `CustTable_ContosoRobotics_Extension`. Some conventions instead lead the class name with the token, e.g. the Avanade D365FO Development Guidelines: `CRCustTableDbt_Extension`, not `CustTableDbtCR_Extension`. `EXTENSION_CLASS_NAMING_STYLE=prefix-leading` writes that shape:

```env
EXTENSION_PREFIX=CR
EXTENSION_CLASS_NAMING_STYLE=prefix-leading   # extension classes only — elements keep EXTENSION_NAMING_STYLE
```

| Base name | Written as |
|-----------|------------|
| `CustTable` | `CRCustTable_Extension` |
| `CustTableDbt` (a caller-embedded type abbreviation — the tool has no notion of `Dbt`/`Frm`/`Cls` itself) | `CRCustTableDbt_Extension` |
| `whsWorkExecute` (a camelCase base) | `CRWhsWorkExecute_Extension` — the base's first letter is upper-cased so the prefix stays recognisable on re-run; X++ names are case-insensitive |

The prefix is recognised only as a separate PascalCase word, so a base whose name merely starts or ends with the same letters keeps them: with `EXTENSION_PREFIX=Le`, `SalesTable` becomes `LeSalesTable_Extension`. One case cannot be told apart from the name alone — a base that itself starts with the prefix as a word (`ProjTable` under prefix `Proj`). Pass the bare base (`objectName: "ProjTable"`, `objectType: "class-extension"`) and it is written as `ProjProjTable_Extension`; a name you pass already ending in `_Extension` (`ProjTable_Extension`) is read as already prefixed and kept as given.

Element extensions are unaffected — `prefix-leading` only exists for classes, because `Base.{Infix}Extension` is Microsoft's own dot-notation shape and leading the infix there would not parse as an AOT name. A name already written under the trailing `prefix` style is converted rather than double-prefixed the first time it is normalised (`CustTableCr_Extension` → `CRCustTable_Extension`).

---

## Searching Custom Extensions

Use `search(scope="extensions")` to search only within your custom/ISV models:

```
search(scope="extensions", query="Cust", prefix="ISV_")
```

Results are restricted to non-Microsoft models and grouped by model name. The `prefix` parameter further narrows results to objects whose names start with the given ISV prefix.

You can also use the main `search` tool and filter by model:

```
search(query="CustTable extension", objectType="table-extension")
```

---

## Multi-Model Packages

A single D365FO package can contain multiple models (e.g. package `CompanyExtensions` may have models `CompanyCore` and `CompanyReporting`). List all model names — not just the package name — in `CUSTOM_MODELS`:

```env
CUSTOM_MODELS=CompanyCore,CompanyReporting
```

The server uses the two-level workspace path (`PackagesLocalDirectory\PackageName\ModelName`) to resolve files to the correct subfolder.

---

## Multiple Clients / Instances

If you work on several D365FO environments (different clients, different ISV prefixes), use the instance commands:

```powershell
npx d365fo-mcp instance add     # creates instances\clientA\ with its own config, database and port
```

Each instance has its own `customModels`, `naming.prefix`, and database. The `instances\*.ps1` scripts remain for installations still configured through per-instance `.env` files. See [Scenario F in SETUP.md](SETUP.md#scenario-f--multiple-instances).

---

## Benefits

1. **Fast incremental updates** — rebuild only custom models after a sprint, not the entire 350-model Microsoft index
2. **Focused search** — `search(scope="extensions")` returns only your code, not noise from standard models
3. **Correct naming validation** — `EXTENSION_PREFIX` prevents code-gen tools from generating objects without the required ISV prefix
4. **Automatic classification** — no static Microsoft model list to maintain across D365FO version upgrades
5. **Multi-instance isolation** — each client environment has its own index, no cross-contamination