# Custom X++ Extensions Guide

This guide explains how to configure, extract, and index your custom X++ models and ISV packages alongside the standard Microsoft D365FO models.

## What this covers

- How to tell the server which models are "yours" (vs. standard Microsoft models)
- How to extract only custom models (fast, a few minutes) vs. everything (slow, 1–2 h)
- How the `search_extensions` tool filters to your code only
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

# ISV prefix — used by search_extensions for prefix filtering and by code-gen tools
# for naming validation (e.g. class names must start with this prefix)
EXTENSION_PREFIX=ISV_

# Extraction mode: 'custom' (your models only), 'standard', or 'all'
EXTRACT_MODE=custom
```

**How custom model detection works:** Everything listed in `CUSTOM_MODELS` is treated as your code. All other models are automatically classified as Microsoft standard. The server never requires you to maintain a static list of Microsoft model names — the list auto-adapts to new D365FO versions.

### UDE (Unified Developer Experience / Power Platform Tools)

In UDE environments, custom models are **auto-detected** from the custom packages path (`ModelStoreFolder` in your XPP config file). You do not need to set `CUSTOM_MODELS`:

```env
DEV_ENVIRONMENT_TYPE=ude
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

Takes a few minutes. Use after every code change or sprint.

### Everything (first-time setup or after D365FO upgrade)

```powershell
$env:EXTRACT_MODE="all"
npm run extract-metadata
npm run build-database
```

Takes 1–2 hours (standard Microsoft models are large). Only needed when Microsoft standard model content changes.

---

## Searching Custom Extensions

Use `search_extensions` to search only within your custom/ISV models:

```
search_extensions(query="Cust", prefix="ISV_")
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

Each instance has its own `CUSTOM_MODELS`, `EXTENSION_PREFIX`, and database. See [Scenario F in SETUP.md](SETUP.md#scenario-f-multiple-instances--one-machine-multiple-d365fo-environments).

---

## Benefits

1. **Fast incremental updates** — rebuild only custom models after a sprint, not the entire 350-model Microsoft index
2. **Focused search** — `search_extensions` returns only your code, not noise from standard models
3. **Correct naming validation** — `EXTENSION_PREFIX` prevents code-gen tools from generating objects without the required ISV prefix
4. **Automatic classification** — no static Microsoft model list to maintain across D365FO version upgrades
5. **Multi-instance isolation** — each client environment has its own index, no cross-contamination