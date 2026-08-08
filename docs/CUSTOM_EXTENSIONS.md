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

Add to your `.env` file:

```env
# Standard D365 packages path
PACKAGES_PATH=C:\AOSService\PackagesLocalDirectory

# Your custom models (comma-separated package/model names)
CUSTOM_MODELS=ISV_CustomModule1,ISV_CustomModule2,CompanyExtensions

# ISV prefix — used by search(scope="extensions") for prefix filtering and by code-gen tools
# for naming validation (e.g. class names must start with this prefix)
EXTENSION_PREFIX=ISV_

# Extraction mode: 'custom' (your models only), 'standard', or 'all'
EXTRACT_MODE=custom
```

**How custom model detection works:** Everything listed in `CUSTOM_MODELS` is treated as your code. All other models are automatically classified as Microsoft standard. The server never requires you to maintain a static list of Microsoft model names — the list auto-adapts to new D365FO versions.

**What to put in `CUSTOM_MODELS`:** list **every** non-Microsoft model you have source for — both the models you author into **and** any source-ISV models you only extend (never modify) — not just the ones you actively change. The classification drives `search(scope="extensions")`, workspace context ranking, form-pattern mining (ISV objects must stay out of the mined *standard* pattern catalog), and the Azure custom-build pipeline — all of which want ISV code classified as custom. Binary-only ISV models (shipped as compiled DLLs with no object XML) are never indexed, so there is no need to list them.

### UDE (Unified Developer Experience / Power Platform Tools)

In UDE environments, custom models are **auto-detected** from the custom packages path (`ModelStoreFolder` in your XPP config file). You do not need to set `CUSTOM_MODELS`:

```env
D365FO_DEV_ENVIRONMENT_TYPE=ude
XPP_CONFIG_NAME=MyConfig    # name from %LOCALAPPDATA%\Microsoft\Dynamics365\XppConfig\
EXTENSION_PREFIX=ISV_
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

```env
EXTENSION_PREFIX_SOURCE=config   # pin step 2 above step 1 (pre-1.8.2 behaviour)
```

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
- **`model-name`** embeds the **model name**, matching the Visual Studio developer-tools default (which uses the model name because it is already guaranteed unique). Use this when your model name is long/customer-specific (e.g. `ContosoRobotics`) but your prefix is a short abbreviation (e.g. `CR`) — the prefix still applies to **new** objects (`CRMyTable`) and to fields/methods added inside extensions (`CRApprovingWorker`); only the extension element/class token switches to the model name.

Run `get_workspace_info` to see the active style and worked examples of exactly what the tools will emit.

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

If you work on several D365FO environments (different clients, different ISV prefixes), use the multi-instance scripts in `instances/`:

```powershell
.\instances\add-instance.ps1    # creates instances\clientA\ with its own .env
```

Each instance has its own `CUSTOM_MODELS`, `EXTENSION_PREFIX`, and database. See [Scenario F in SETUP.md](SETUP.md#scenario-f--multiple-instances).

---

## Benefits

1. **Fast incremental updates** — rebuild only custom models after a sprint, not the entire 350-model Microsoft index
2. **Focused search** — `search(scope="extensions")` returns only your code, not noise from standard models
3. **Correct naming validation** — `EXTENSION_PREFIX` prevents code-gen tools from generating objects without the required ISV prefix
4. **Automatic classification** — no static Microsoft model list to maintain across D365FO version upgrades
5. **Multi-instance isolation** — each client environment has its own index, no cross-contamination