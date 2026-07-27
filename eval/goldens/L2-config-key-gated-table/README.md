# Golden: L2-config-key-gated-table

Captured 2026-07-27 on the D365FO dev VM.
Server SHA `b28515f` · xppc 7.0.7858.27 · `EXTENSION_PREFIX=Con` · model `Contoso`.

| Artifact | Type |
|---|---|
| `ConDemoModuleKey.metadata.xml` | AxConfigurationKey |
| `ConDemoGatedSetting.metadata.xml` | AxTable |
| `ConDemoGatedSettingMI.metadata.xml` | AxMenuItemDisplay |

Result: build 0 errors · BP **0 errors**, 4 warnings · `golden_match: 1`.
Corpus record: `eval/corpus/runs/2026-07-27T18__L2-config-key-gated-table__b28515f.json`.

## Why this golden was frozen rather than held

Per the sweep precedent that *a green build does not prove the XML is right*, the
gating chain was verified by **negative test**, not inference. Repointing each
`ConfigurationKey` at a non-existent key and rebuilding produced, in two separate
builds:

```
Metadata Error: AxTable/ConDemoGatedSetting/ConfigurationKey: Configuration key 'ConBogusKeyXyz' does not exist.
Metadata Error: AxMenuItemDisplay/ConDemoGatedSettingMI/ConfigurationKey: Configuration key 'ConBogusKeyXyz' does not exist.
```

Both elements are therefore genuinely consumed by the compiler — not written to
disk and silently dropped by the deserializer, which was the failure mode behind
the AxTile (V6/TileType/element-order) and AxDataEntityView (missing
SourceCode/FieldGroups) bugs. Both were reverted; the final build is green.

## Shape audit vs standard models

* **AxConfigurationKey** — exact match. 161 `ApplicationSuite/Foundation` + 11
  `ApplicationFoundation` keys reduce to `Name` + `Label`; `ParentKey`,
  `LicenseCode`, `Enabled`, `EnabledByDefault`, `IsObsolete` are all optional.
  The case mandates *no parent key*, so `Name` + `Label` is complete. No gap.
* **AxTable** — element order matches the standard convention (`ConfigurationKey`
  sorts before `Label`), verified against
  `ApplicationFoundation/AxTable/BIDateDimensionValue.xml`, itself a Main table
  carrying a `ConfigurationKey`. `GatedSettingIdx` carries `AlternateKey=Yes` and
  **deliberately omits `AllowDuplicates`**: `No` is the metadata default and
  standard files serialize the element only when `Yes` (BIDateDimensionValue.xml
  shows one alternate-key index without it beside four non-unique indexes with
  `AllowDuplicates=Yes`). The bridge reads the index back as *(unique)*. No gap.
* **AxMenuItemDisplay** — the root correctly carries **both** `xmlns:i` and the
  default namespace `Microsoft.Dynamics.AX.Metadata.V1`, which is precisely the
  class of bug that hit AxTile. Element order correct. `<Object>` is absent by
  design — this case creates no form, and an Object-less display menu item is
  legal standard shape (5 of 467 `ApplicationFoundation` display menu items omit
  it, e.g. `ReleaseUpdateInfoCenter.xml`).

## Known gap encoded in this golden (non-blocking)

`<SubscriberAccessLevel>` is **absent** from the menu item. 194/200 sampled
standard and 2/2 VS-authored custom (`HBReavisCus`) display menu items carry it.
This is a **missing property surface** in `d365fo_file` — no parameter exposes it
— *not* a dropped element: the file is provider-serialized output
(`IMetaMenuItemDisplayProvider.Create`), it builds clean, raises no BP error, and
6/200 standard files also omit it.

Frozen rather than held because freezing makes a future writer fix show up as a
deliberate, reviewable golden update. If `SubscriberAccessLevel` is added to the
writer, re-capture this golden.

## BP warnings accepted (case requires zero BP *errors* only)

`BPErrorMenuItemNotCoveredByPrivilege` (needs a privilege the case does not ask
for), `BPTableWithRecIdIndexMissingReplacementKey`,
`BPErrorDeveloperDocumentationNotDefined`, `BPErrorTableMissingFormRef` (needs a
form the case does not ask for). None is requested by the instruction, which
enumerates the required properties exactly.

## Normalization

Per the case `ignore` list: `**/@Id`, `**/ModelSaveInfo`. The provenance comment
block at the top of each file is stripped by the oracle normalizer (verified:
the golden self-checks to `golden_match: 1`).
