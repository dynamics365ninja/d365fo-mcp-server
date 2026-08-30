# Golden: L2-date-effective-table — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30 (Phase F), server SHA 93d6658 + the Phase F working tree (the
three tool fixes below are in that tree), xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Every artifact was written through
`prepare(create)` -> `d365fo_file(action="create")` and completed with
`d365fo_file(action="modify")` operations. No hand-edited XML.

## Artifacts

- `ConDemoWorkerBonusRate.metadata.xml` — AxTable, `TableGroup=Main`, label
  `@SYS32359` ("Bonus"), `ValidTimeStateFieldType=Date`. Fields: `WorkerId`
  (`Num`, mandatory), `BonusRate` (`Percent`), `ValidFrom` (`FromDate`, i:type
  `AxTableFieldDate`), `ValidTo` (`ToDate`). Index `BonusRateIdx` over
  WorkerId + ValidFrom + ValidTo with `AlternateKey=Yes`, `ValidTimeStateKey=Yes`
  and NO `ValidTimeStateMode` element (NoGap is the SDK default — see below).
  `ClusteredIndex` / `ReplacementKey` = BonusRateIdx, no `PrimaryIndex` element
  (surrogate-key primary index, the shape of every shipped date-effective table,
  e.g. `PersonnelCore/AxTable/HcmPositionDetail.xml`). ValidFrom/ValidTo sit in the
  `AutoReport` field group next to the business fields.
- `ConDemoWorkerBonusRateService.metadata.xml` — AxClass with the three static
  methods the case demands: `addRate` (insert inside ttsbegin/ttscommit stamping
  ValidFrom/ValidTo), `effectiveRate` (`select firstonly validTimeState(_asOfDate)
  BonusRate from bonusRate where …` — validTimeState between `select` and the field
  list) and `versionCount` (a PLAIN `select count(RecId)` with no validTimeState and
  no ValidFrom/ValidTo filter — the trap the case teaches).

## Platform facts learned at capture

- There are NO `ValidFromDate` / `ValidToDate` EDTs on this platform; the shipped
  Date-effective tables use `FromDate` / `ToDate` (ApplicationPlatform, extend
  `TransDate`). UtcDateTime-effective tables use `ValidFromDateTime` /
  `ValidToDateTime` (`AgreementHeaderHistory`).
- `ValidTimeStateMode=NoGap` is the serializer DEFAULT: a bridge round-trip of the
  table dropped `<ValidTimeStateMode>NoGap</ValidTimeStateMode>`, and every shipped
  index that spells the mode out says `Gap` (HcmEmployment, HcmJobDuration,
  HcmPositionHierarchy, …). The golden therefore carries no Mode element although
  the case asks for NoGap — the request IS honoured.
- xppc accepts the date-effective table only with a ValidTimeStateKey index; before
  the fix below the build died earlier, on the field types.

## Tool defects found and FIXED (the reason the working tree matters)

1. `add-index` / `create(properties.indexes[])` could not set
   `ValidTimeStateKey` / `ValidTimeStateMode`, and `modify-property` rejects
   `BonusRateIdx.ValidTimeStateKey` as an unknown AxTable property. Fixed by a TS
   post-write (`directXmlSetIndexValidTimeState`) wired into both paths; new params
   `indexValidTimeStateKey` / `indexValidTimeStateMode` (op-spec only — no wire
   schema change). Test: `tests/tools/indexValidTimeState.test.ts`.
2. `add-field fieldType="FromDate"` wrote `i:type="AxTableFieldString"` — xppc:
   "Data type mismatch" on ValidFrom/ValidTo. The resolver walked FromDate →
   TransDate and, finding no primitive recorded for the root EDT, handed the bridge
   the ROOT EDT NAME. Fixed by using create's ladder (live metadata → edt_metadata
   chain → name heuristic). Re-adding the fields through the fixed tool produced
   `AxTableFieldDate`. Test: `tests/tools/addFieldDateEdt.test.ts`.
3. `modify-property PrimaryIndex=""` wrote `<PrimaryIndex></PrimaryIndex>`
   (BPErrorTableNoPrimaryIndex). A third post-write (`directXmlClearEmptyProperty`)
   removes the empty element. Test: `tests/tools/clearEmptyProperty.test.ts`.

## Build / BP at capture

- Build 1 (before fix 2): **2 errors** — `Fields/ValidFrom/ExtendedDataType: Data
  type mismatch`, same for ValidTo.
- Build 2 (fields fixed): **0 errors**; BP 7 warnings — 3× BPErrorTablePrimaryKeyEditable
  (BonusRateIdx was the BP-default PrimaryIndex), BPErrorTableFieldNotInFieldGroup ×2,
  DeveloperDocumentation, FormRef.
- Build 3 (field group + PrimaryIndex cleared): 0 errors; BPErrorTableNoPrimaryIndex
  from the empty element, + the two below.
- FINAL full build: **0 errors**, 1 unrelated warning (Commerce PricingEngine
  assembly, every build on this VM). BP (`bpCheck: true`, 2 elements): **Errors 0,
  Warnings 2** — `BPErrorDeveloperDocumentationNotDefined`, `BPErrorTableMissingFormRef`
  (the same two every table golden of this corpus leaves: no form exists for the
  table and no label fits DeveloperDocumentation). `bp_clean` is scored 0 for that
  reason; the case's own bar ("zero BP errors") is met.

## Descriptor / labels

Descriptor as in `L2-exception-tts-retry/README.md` (12 packages). No labels created;
the table label reuses the standard `@SYS32359`.
