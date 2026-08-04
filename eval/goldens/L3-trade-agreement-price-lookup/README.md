# Golden: L3-trade-agreement-price-lookup - FROZEN

`golden_pending: false` since 2026-08-03. Every byte comes from the grounded
`d365fo_file` path; nothing here is hand-authored.

| Capture | Server SHA | Role |
|---|---|---|
| 2026-08-03 (first capture) | `dffe0dc` | first-time run, no prior draft for this case; full grounded run, `Errors: 0`, 0 BP errors/warnings on the object, golden captured from this run's own verified output |

Platform xppc 7.0.7858.27, model `Contoso`, `EXTENSION_PREFIX=Con` -> object
name is `ConDemoPriceResolver`.

## Ground truth consulted first

Per the case instruction, get_knowledge(topic="trade-agreements") was
called before implementing. Its rulebook names PriceDisc.findPrice() /
findDisc() as the correct entry points ("use these, NOT direct table
queries") and states the evaluation order (specific -> group -> all -> all+all),
date effectivity and quantity-break behaviour are the framework's job. That
guidance was then cross-checked against the real, shipped method
signatures (not invented) via search/get_object_info/get_method/
find_references/analyze_code(api-usage) before any line was written:

- PriceDisc.findPrice(PriceGroupId _priceGroupId, boolean _useItemPrice = true)
  returns boolean - confirmed via get_method (both signature and full
  source, which internally walks the agreement hierarchy
  specific/group/all/all+all and calls InventDim::findDim,
  EcoResProductDimGroupSetup::copyProductDimensionsForItem, i.e. real
  hierarchy + dimension-aware resolution, not a raw select).
- PriceDisc.findLineDisc(LineDiscCode _itemLineDisc, LineDiscCode _accountLineDisc)
  returns NoYes - confirmed via get_method.
- PriceDisc.price() returns PriceCur; PriceDisc.lineDiscPct() returns
  DiscPct - both confirmed via get_method.
- PriceDiscParameters::construct() returns PriceDiscParameters (static
  factory) and PriceDisc::newFromPriceDiscParameters(PriceDiscParameters _parameters)
  returns PriceDisc (static factory) - confirmed via get_method including
  full source of newFromPriceDiscParameters, which itself calls the
  private PriceDisc constructor and priceDisc.initialize().
- The parameter-population idiom (parmModuleType, parmItemId,
  parmInventDim, parmUnitID, parmPriceDiscDate, parmQty,
  parmAccountNum, parmCurrencyCode) was not guessed - it was read
  verbatim from three independent real shipped callers via get_method
  (source): ProjEstimateDataContract.createAndInitPriceDiscParameters,
  TmpSalesItemReq.createAndInitPriceDiscParameters, and
  RetailPriceBasisCalc_SalesPurch.createAndInitPriceDiscParameters (the
  last one generic sales/purch, not Proj-specific - used as the primary
  template). RetailPriceBasisCalc_SalesPurch.calculateAgreementPrice
  (real source) is the direct precedent for deriving PriceGroupId from
  CustTable::find(accountId).PriceGroup when the caller has no explicit
  price group of its own, and for calling priceDisc.findPrice(priceGroupId, ...)
  then reading priceDisc.price().
- TmpSalesItemReq.setPriceAgreement (real source) is the direct precedent
  for findLineDisc(itemLineDisc, accountLineDisc) sourced from
  InventTableModule.LineDisc (item side) and CustTable.LineDisc (account
  side); PriceDisc_LineDisc.retrieveAndSetLineDiscFields (real source)
  confirms priceDisc.lineDiscPct() is the field read after
  findLineDisc succeeds.
- Field-level EDT compatibility was verified, not assumed:
  InventTableModule.LineDisc is EDT InventLineDiscCode, CustTable.LineDisc
  is EDT CustLineDiscCode, and both Extends: LineDiscCode (get_object_info
  on the EDTs) - i.e. they satisfy findLineDisc(LineDiscCode, LineDiscCode)
  by EDT inheritance, not a name coincidence.

## Artifact captured (the case's target_artifact_types)

- ConDemoPriceResolver.metadata.xml - AxClass, two public static
  methods:
  - Price salesPrice(ItemId _itemId, CustAccount _customer, Qty _qty, TransDate _date)
    - builds a PriceDiscParameters (module Sales, item, a blank local
      InventDim buffer, unit from InventTableModule::find(...).UnitId,
      the given date/qty, the customer account, and the customer's
      currency), constructs the PriceDisc via
      PriceDisc::newFromPriceDiscParameters, calls
      priceDisc.findPrice(custTable.PriceGroup), returns
      priceDisc.price().
  - Percent lineDiscountPercent(ItemId _itemId, CustAccount _customer, Qty _qty, TransDate _date)
    - the same parameter construction, then
      priceDisc.findLineDisc(inventTableModule.LineDisc, custTable.LineDisc),
      returns priceDisc.lineDiscPct().
  - Neither method selects PriceDiscTable directly anywhere - the case's
    explicit fail condition. All price/discount resolution goes through
    PriceDisc/PriceDiscParameters method calls only.

## How the "not a manual join" requirement was actually verified

Beyond "it doesn't contain a select ... from priceDiscTable" (true by
inspection of the written source above), the deeper claim - that agreement
hierarchy, unit conversion and date effectivity genuinely come from the
framework - rests on having read PriceDisc.findPrice's real
implementation (not just its signature) via get_method(include="source")
before relying on it: it builds inventDimAllActivated /
inventDimProductDimActivated from EcoResProductDimGroupSetup::copyProductDimensionsForItem,
resolves them via InventDim::findDim, and dispatches to
this.findPriceAgreements(findAll, findProductDim, _useItemPrice, _priceGroupId, ...)
- i.e. the specific -> group -> all agreement-hierarchy walk the knowledge
entry describes is inside the framework method itself, not something this
class would need to (or does) reimplement. _date and _qty flow in
through PriceDiscParameters.parmPriceDiscDate/parmQty, which
newFromPriceDiscParameters passes straight into the PriceDisc
constructor - date effectivity and quantity breaks are therefore evaluated
by the framework's own agreement search, not by any comparison logic in
this class.

## Build / BP at capture (2026-08-03, SHA dffe0dc)

- FULL build (fullBuild: true): first attempt failed with 6 compile
  errors - Price, PriceCur and UnitOfMeasureSymbol "does not denote a
  class, a table, or an extended data type". Root cause: those EDTs live in
  the ApplicationCommon and UnitOfMeasure packages respectively, and
  Contoso's Descriptor/Contoso.xml ModuleReferences did not list
  either (same class of issue eval/README.md already documents for
  FleetManagement/ApplicationSuite/etc - xppc does not resolve package
  references transitively for directly-named types). Fix: added
  ApplicationCommon and UnitOfMeasure to ModuleReferences in
  K:\AosService\PackagesLocalDirectory\Contoso\Descriptor\Contoso.xml
  (environment prerequisite, not a scored artifact - same category as the
  pre-existing FleetManagement entry). Rebuild after the fix: 0 errors,
  1 unrelated pre-existing warning (Commerce PricingEngine external
  assembly not found).
- BP, filtered per object (run_bp_check with an explicit targetFilter
  AND targetElementType: "class" - confirmed "1 elements processed", not
  the false "BP Check passed" / zero-elements trap): 0 warnings, 0
  errors on ConDemoPriceResolver.

The case's own gate ("must build with zero BP errors") is satisfied, and
bp_clean in the corpus score is 1 (0 warnings, 0 errors - a genuinely
clean object, not the warning-tolerant convention some sibling goldens use).

## Descriptor change (environment prerequisite, not part of the scored artifact)

K:\AosService\PackagesLocalDirectory\Contoso\Descriptor\Contoso.xml
ModuleReferences gained two entries: ApplicationCommon (owns Price,
PriceCur) and UnitOfMeasure (owns UnitOfMeasureSymbol). This mirrors
the standing pattern in eval/README.md ("Sandbox prerequisites") for
FleetManagement/ApplicationSuite/Directory/Ledger/ContactPerson/
Currency - any case that directly names a type from a package not already
referenced needs that package added once. This edit is infrastructure, not
a case output, and was left in place (not rolled back) since it is a
correctly-scoped, additive environment fix that future cases referencing
the same EDTs will also need.

## Corpus record

eval/corpus/runs/2026-08-03T20__L3-trade-agreement-price-lookup__dffe0dc.json
(first-capture record: golden_match: null per the documented
golden_pending degrade-gracefully convention - build: 1, bp_clean: 1,
classification PASS. The golden file in this folder was captured from
this run's own verified output and self-checked afterward with
npm run eval:score, which reports golden_match: 1 with no structural deltas.)
