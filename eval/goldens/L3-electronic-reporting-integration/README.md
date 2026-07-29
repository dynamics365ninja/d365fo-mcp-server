# Golden: L3-electronic-reporting-integration — FROZEN

Captured 2026-07-29, server SHA `cd87f2b`, xppc 7.0.7858.27 (VM), model `Contoso`,
`EXTENSION_PREFIX=Con`. The artifact was written through `prepare(create)` ->
`d365fo_file(action="create")`. No hand-edited XML, no filesystem writes; the two
in-place corrections and the two negative probes went through
`d365fo_file(action="modify", operation="replace-code")`.

## Artifact

- `ConDemoErDataProvider.metadata.xml` — AxClass, `public class`, 11 methods:
  - `public static ConDemoErDataProvider construct()`
  - `public container getInvoiceTotals(Num _documentId)` — the signature the case
    demands, verbatim
  - nine `parm*` methods, **all public**, one per value the ER format consumes:
    `parmDocumentId` (`FMRentalId`), `parmDocumentTitle` (`str`),
    `parmTotalsCaption` (`str`), `parmDocumentDate` (`TransDate`),
    `parmCurrencyCode` (`CurrencyCode`), `parmVehicleAmount` (`FMVehicleTotal`),
    `parmChargesAmount` (`FMExtendedAmount`), `parmChargesQuantity` (`FMQuantity`),
    `parmTotalAmount` (`FMExtendedAmount`).

  Member state is declared `private` — the ONLY access path is the public parm
  methods, which is what "no protected state reachable only through internals"
  means here. Both strings the class returns come from labels
  (`@Contoso:ErInvoiceDocumentTitle`, `@Contoso:ErInvoiceTotalsCaption`), assigned
  as plain `"@..."` literals so the compiler emits a label reference that resolves
  in the user language; `literalStr()` is deliberately NOT used, because it would
  hand ER the label id instead of the text. The infolog message uses
  `strFmt("@Contoso:ErInvoiceDocumentNotFound", _documentId)`.

## Where the ER binding is documented

AxClass XML has **no `DeveloperDocumentation` element** — verified against a real
shipped file (`ElectronicReporting/AxClass/ERObjectsFactory.xml`): an AxClass is
`<Name>` + `<SourceCode>` (`<Declaration>` + `<Methods>`) and nothing else. A
class's developer documentation therefore IS its declaration-level XmlDoc comment,
and that is where the ER binding lives:

> the ER model mapping "Demo rental invoice (mapping)" of the ER data model
> "Demo rental invoice model" binds this class through its model mapping data
> source **"DemoErInvoiceProvider"**, declared with the data source type
> "Dynamics 365 for Operations \ Class" over class `ConDemoErDataProvider`.

Because `canonicalizeXppDocComments` collapses every `///` run before the golden
diff, the same fact is repeated in `//` comments inside `construct()` and
`getInvoiceTotals()`, which the oracle DOES pin.

## Scope limit honoured

The ER data model, model mapping and format are UI configuration, not AOT elements.
Nothing of the sort was authored: the model contains exactly one new object.

## Grounding (nothing guessed)

`get_knowledge(topic="electronic-reporting")` first, then everything checked
against the real symbol index:

| Claim checked | Result | Tool |
|---|---|---|
| `IERModelMappingExtension` / `ERModelMappingExtension` | **do not exist** anywhere in the index | `search` |
| `ERIDataSourceProvider` | exists, but is an ER **designer** interface: one member `public ERIDataSource getDataSource()`, and exactly ONE consumer in the whole AOT (`ERLookupRootComponentUIBuilder.getDataSource`) | `get_object_info`, `find_references` |
| `ERIDataSource` (its return type) | **not an X++ type** — no such class in the index | `search` |
| class-typed ER data sources | handled framework-side by `ERClassDataSourceHandlerExtension` (extends `ERDataSourceBaseExtension`) over the managed `ERClassDataSourceHandler`; nothing for an application class to extend or register | `search`, `get_object_info` |
| `ERObjectsFactory`, `ERIFormatMappingRun` | exist (the KB rules about RUNNING a format are correct) | `search` |

**Conclusion, and the reason this class has no base type or interface:** an ER
application data source is a plain public X++ class. ER binds it in the model
mapping designer through the data source type "Dynamics 365 for Operations \ Class";
there is no X++ registration API. The KB rules that say otherwise are wrong — that
is the KNOWLEDGE_GAP recorded with this run.

Data source members were confirmed with `get_object_info(objectType="table")`
before use: `FMRental` (RentalId `FMRentalId`, StartDate `StartDateTime`,
VehicleRateTotal `FMVehicleTotal`) and `FMRentalCharge` (RentalId, ExtendedAmount
`FMExtendedAmount`, Quantity `FMQuantity`), plus
`Ledger::accountingCurrency(LegalEntity _legalEntityRecId = 0)` via `get_method`.

## Why FleetManagement and not CustInvoiceJour

The first two drafts read `CustInvoiceJour`. Both were rejected by xppc even though
`validate_code(mode="references")` had passed them:

1. `TaxAmountCur` (the EDT of `CustInvoiceJour.SumTax`) lives in model **Tax** —
   "The name 'TaxAmountCur' does not denote a class, a table, or an extended data
   type", 5 errors.
2. After removing every tax field, a plain `select` on `CustInvoiceJour` still
   failed with "A reference to 'Dynamics.AX.FiscalBooks ...' is required to compile
   this module". Isolated with a 6-line throwaway probe class
   (`select firstonly RecId, InvoiceId from CustInvoiceJour`) — the table itself
   drags the package in, because FiscalBooks contributes a table extension.

Using `CustInvoiceJour` therefore costs **two** new `<ModuleReferences>` entries
(`Tax`, `FiscalBooks`) in `Contoso/Descriptor/Contoso.xml`, which a clean sandbox
would not have — the golden would stop reproducing. `FMRental` /
`FMRentalCharge` are in **FleetManagement**, already referenced by the sandbox and
already the demo data of this corpus, so the capture added **no package reference
at all**. `ModuleReferences` is exactly as found: ApplicationFoundation,
ApplicationPlatform, ApplicationSuite, FleetManagement, Directory, Ledger,
ContactPerson, Currency, Dimensions, PersonnelCore, GeneralLedger,
SourceDocumentationTypes.

## Negative probes (a green build is not proof)

Both applied with `d365fo_file(action="modify", operation="replace-code")` and
restored; the restored file is byte-identical
(sha256 `c8faa399d0343bceaaa030a3f2f44efb0fbc3b8b8f5c26b35f6ae652d81644c3`).

1. **Signature** — `getInvoiceTotals` return type `container` -> `str`. Build
   **FAILED**: "Cannot implicitly convert from type 'container' to type 'str'".
   The container return is compiler-enforced, not decorative.
2. **Label** — `@Contoso:ErInvoiceTotalsCaption` -> `...CaptionBogus`. Build still
   **succeeded** (unknown labels are not compile errors) and the FILTERED BP run
   reported `BPErrorUnknownLabel: 1` with "1 elements processed."; restoring the
   real label made the same run clean. So the label check is live and the two
   labels really exist.

Additional deserializer check: after the write,
`get_object_info(members="names")` listed all 11 methods with exact signatures —
nothing was silently dropped.

## Build / BP at capture

- FULL build (`force: true`, `fullBuild: true`, target model): **0 errors**, 1
  unrelated warning (Commerce `PricingEngine` external assembly, present on every
  build of this VM).
- BP, filtered (`targetFilter=ConDemoErDataProvider`, `targetElementType=class`):
  "1 elements processed." — **Warnings: 0, Errors: 0**.

## Labels

Created with `labels(action="create")` in label file `Contoso` (model `Contoso`,
en-US) and removed again at rollback, because `Contoso.en-US.label.txt` is shared
across cases and kept empty. A re-run must re-create them BEFORE creating the class:

- `ErInvoiceDocumentTitle` = "Vehicle rental invoice"
- `ErInvoiceTotalsCaption` = "Invoice totals"
- `ErInvoiceDocumentNotFound` = "No vehicle rental was found for document %1."
