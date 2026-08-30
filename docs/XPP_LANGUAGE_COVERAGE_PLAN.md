# X++ language & reporting coverage — plan v2.1 (2026-08-30, verified against xppc 7.0.7996.33)

**Status: G0–G4 are IMPLEMENTED** on branch `feat/xpp-compiler-verified` (9 commits). What is left
is G5 (taxonomy expansion + new eval cases) and G-VM (capturing their goldens). Every language claim
in this document was checked on this VM against the **compiler and the shipped source**, not against
Microsoft Learn — the X++ reference is incomplete and parts of it still describe AX 2012.

## Implementation status (2026-08-30)

| Phase | State | Where |
|---|---|---|
| G0.6 compiler-facts snapshot | **done** | `scripts/capture-compiler-facts.ts` → `eval/compiler-facts.snapshot.json` → `src/knowledge/compilerFacts.generated.ts`, facade `compilerFacts.ts`, ratchet `tests/knowledge/compilerFacts.test.ts` |
| G0.4 validator false positives | **done** — 5 error-severity FPs → **0** on 7,649 shipped files | shared lexer `src/utils/xppLexer.ts`; COC001/002/003, TTS001, BP001, SEL001, SEL002, `lintXppSelect` |
| G0.5 FN001 from the compiler table | **done** — 170 run-time functions + 80 intrinsics with min/max, plus FN002 | `checkBuiltinArity` |
| G0.3 knowledge corrections | **done** — the entries in §2 | |
| G0.1 coverage claims | **done** — 6 leaves re-pointed, 3 stale notes fixed, note gate widened | `src/eval/coverage/taxonomy.ts` |
| G2 new rules | **done** — BP006, MAC001, SEL008, SEL009, SEL010, ATTR001, ATTR002, EXT001, KW001, CS001 expansion | all silent on shipped code |
| G1 knowledge pack | **done for the verified half** — `runtime-functions`, `form-event-handlers`, `report-extension-patterns`. `args-object`, `display-edit-methods` and `sysoperation-ui-attributes` are NOT written: their APIs were not verified, and an unverified entry is what this branch exists to remove | |
| G3 TDD / SysTest | **done** — `pattern="systest"` (compiles clean in the sandbox), `prepare(mode="test")`, per-method result parsing, `/unattended` | `codeGen.ts`, `prepareTest.ts`, `sysTestRunner.ts`, `eval/oracle/systest.ts` |
| G4 reporting extension patterns | **done as knowledge** — the three techniques with compiler-verified shapes. The generator patterns (`report-dataset-extension`, `report-custom-design`, `report-menu-redirect`) and the catalog recipes are NOT written | |
| G5 taxonomy expansion + new cases | **not started** | |
| G-VM golden capture for the new cases | **not started** | |

### What the compiler changed about the plan

Four things the plan proposed were **dropped or inverted** once xppc answered:

- a generics rule — `List<str>` fails in a sandbox model with "does not denote a class, a table, or an
  extended data type", but that is a *resolution* failure ("Are you missing a module reference?"), not a
  syntax one, and ApplicationSuite ships `private List<str> operatingUnitNumbers;`.
- `*=` and `/=` as C#-isms — they compile (57 and 2 shipped uses).
- flagging every select expression on a buffer — a buffer named after its table resolves as the table,
  which is how 180 shipped classes write it; only an *aliased* buffer fails.
- EVT001 (a `[PostHandlerFor]` whose parameter is not `XppPrePostArgs`) — the compiler already answers
  "cannot be used as an event handler … because the parameter profile does not match", clearly and at
  the right moment. A rule would only repeat it.

Two blockers recorded in this repo turned out to be wrong:

- **SysTestConsole is not interactive-only.** `/unattended` skips the debugger-attach prompt. What stops
  a run on this VM is an assembly binding mismatch — `Bin\SysTestConsole.exe.config` redirects
  Microsoft.ApplicationInsights to 2.22.0.997 while Bin ships 2.23.0.0. Fixing that edits a
  Microsoft-owned file in the platform install, so it is described and left as the owner's decision.
- **"You can't extend RDP classes"** is Microsoft's design guidance, not a compiler restriction: a CoC
  wrapper on `SrsReportDataProviderBase.processReport` compiles.

---

## 0. Oracles used (all on this VM, reproducible)

| Oracle | What it decides | How |
|---|---|---|
| **Parser keyword table** | the reserved-word list | reflect `Bin\Microsoft.Dynamics.AX.Framework.Xlnt.XppParser.dll` → `XppParser.Keywords.KeywordHashSet` (115 words), `ExemptedKeywords` (`in`) |
| **Compiler intrinsic table** | every compile-time function + arg count | reflect `Bin\Microsoft.Dynamics.AX.Framework.Xlnt.XppCore.dll` → `Metadata.XppCompiler.Intrinsics.IntrinsicFunctionInfo` (80 entries) |
| **xppc probes** | "does this compile", exact diagnostics, run-time function min/max arity | ~700 `ConProbe*` classes written into `fm-mcp`, three full builds (`xppc -metadata -compilermetadata -modelmodule=fm-mcp -referenceFolder -output -log`), diagnostics grepped, files deleted. Harness: scratchpad `probes/run-probes{,2,3}.ts`; method in memory `xpp-compiler-probe-method` |
| **Shipped-source census** | what compiling code actually uses (and how often) | `census.mjs` over 105,685 AOT XML files / 1,108,040 CDATA blocks (comments/strings masked): 140 construct regexes, enum-member, attribute, intrinsic and run-time-function arg-count histograms |
| **Validator sweep** | false positives of `validate_code` | `runRules(classText,'xpp')` + `lintXppSelect` over 7,649 shipped class/table/form files (51 MB X++), 92 s |
| **Knowledge API audit** | every named API in `KNOWLEDGE_BASE` exists | `npm run eval:knowledge-audit -- --capture` against `data/xpp-metadata.db` (2.5 GB): 309 refs, 229 resolved, 80 allow-listed, **0 defects** |
| **Source reads** | exact member lists of framework classes | `<Method><Name>` extraction from `SysTestCase`, `SysTestAssert`, `SrsReportRunController`, `SRSPrintDestinationSettings`, `PrintMgmtDocType`, … |

---

## 1. Compiler facts the server must encode (contradicting docs, knowledge or v2)

### 1.1 Lexical / keywords
- Reserved (115): includes `having`, `foreach`, `async`, `await`, `namespace`, `using`, `var`, `const`, `readonly`, `internal`, `byref`, `unchecked`, `firstonly1`, `hint`, `breakpoint`, `print`, `flush`, `eventhandler`, `delegate`. **Not** keywords: `window`, `pause`, `tablelock`, `changesite`, `at`, `this`. `in` is *exempted* (usable as identifier).
- `having` / `namespace` / `async` / `foreach` are reserved but **not implemented** (`having` → "'join' expected"; `foreach` → "')' expected"; `namespace X {}` → "';' expected").
- `window 10,10;` → "Invalid token '10'"; `pause;` → "Invalid token ';'"; `tableLock T;` → "does not denote a class, a table, or an extended data type"; `changeSite(1){}` → "';' expected". `print 'x';`, `breakpoint;`, `flush T;` compile (shipped use: print 13/2 files, flush 103, breakpoint 0).
- `#define X(1)` without the dot → "The macro 'define' is not defined" (the word is parsed as a macro *reference*). `#globaldefine`, `#globalmacro…#endmacro`, `#defInc`/`#defDec`, `#linenumber`, `#undef`, `#ifnot`, `%1` params, `#localmacro` all compile; shipped use of `#globaldefine`/`#defInc` is **0**.
- A `#define` macro is a legal attribute argument (`[SysObsolete(#Msg)]`); a `const` or an expression is not ("Invalid token ','" / "Invalid token '('").
- `@identifier` escape (161 shipped uses), `@'verbatim'` (2,359), hex `0xFF` (211), exponent literals (3), date literals (3,787), utcdatetime literals (44) all compile.

### 1.2 Types & conversions (docs are wrong here)
| Assignment | Compiler |
|---|---|
| `int i = 1.5;` (real→int) | **ERROR** "loses range and precision" (docs claim implicit truncation) |
| `int64 l = 1.5;` | warning "loses precision" |
| `int64 l; int i = l;` | warning "loses range" |
| `int i = today();`, `date d = 1;` | ERROR |
| `str s = 1;`, `str s = true;`, `str s = NoYes::Yes;`, `int i = 'a';` | ERROR (no implicit to/from str) |
| `str s = "a" + 1;` | ERROR "Types 'str' and 'int' are not compatible with operator '+'" |
| `real r = 1; int i = NoYes::Yes; NoYes e = 1; boolean b = 1; int i = true; int64 l = 1;` | OK |
| `utcdatetime + int` | ERROR; `date ± int`, `date - date` OK; utcdatetime comparisons OK |
| `if (str)`, `if (real)`, `if (container)`, `if (buffer)`, `if (object)`, `if (guid)` | OK (truthiness) |
| `anytype a = 1; a = 'x';` | compiles (the "locks to first type" claim is run-time, unverified) |
| `int i == null` | ERROR "operands of type 'int' and 'nulltype'" |
| `uint`, `bool`, `decimal`, `double`, `long`, `string`, `List<int>` | ERROR "does not denote a class, a table, or an extended data type" |
| arrays `int a[10]`, `real r[100,5]`, `int d[]`, `str 10 n[3]` | OK (memory-size form has 0 shipped uses) |
| CLR array indexing `arr[0]` | ERROR "…Use the SetValue and GetValue methods on managed array types" |

### 1.3 Operators & statements
- `*=` and `/=` **compile** (57 and 2 shipped uses) — the docs' "only `= += -= ++ --`" is wrong. `int y = i++;` → "';' expected" (increment is a statement); `++i;` as a statement compiles.
- `default:` must be the **last** case ("A default part must be the last case item"). Non-constant `case y:`/`case y + 1:` compile; `switch (container)` compiles; `case 'a':` on str compiles.
- `for (int i = 0, j = 0; …)` compiles. Shadowing → exact text "A local variable named 'i' cannot be declared in this scope because it would give a different meaning to 'i', which is already used in a parent or current scope to denote something else."
- `var x;` → "The implicitly typed variable 'x' requires a value to be assigned to it"; `var` field → "Invalid token 'var'".
- `readonly` field assigned in a method → "The field 'R' is read only…"; `const` → "The const field 'K' cannot be changed."
- Local functions may be declared **after** statements (compiles; docs/knowledge say "at the top").
- `using (System.IO.StringReader r = …) { }` and `using (var r = …)` **compile** (8,306 shipped uses / 3,278 files). `dotnet-interop` R9 ("X++ has no using STATEMENT") is wrong.
- `throw;` (bare rethrow) compiles only in a catch ("Rethrow statements … can only be used in catch blocks"; 1,018 shipped uses). `throw new System.X(...)` compiles (169 uses).
- Typed CLR catch needs a **declared variable**: `System.ArgumentException ex; … catch (ex)` compiles (2,002 uses); inline `catch (System.Exception ex)` → "')' expected".
- `finally` must follow all catches; a bare `catch` before a typed catch makes the latter unreachable (warning). `retry;` outside catch → error; `break;` outside loop/switch → error; `this` in static → "Variable 'this' is not found in scope".
- `unchecked(Uncheck::X) { }` — members that exist: `TableSecurityPermission` (228 uses), `XDS` (235). `DBSchemaDrift`, `Deadlock` do not.
- `Exception::` values that compile: Error, Warning, Info, Deadlock, UpdateConflict, UpdateConflictNotRecovered, DuplicateKeyException, DuplicateKeyExceptionNotRecovered, CLRError, Numeric, Internal, Break (warning "Do not use this exception. It is reserved."), Sequence, DDEerror, CodeAccessSecurity, Timeout, TransientSqlConnectionError; shipped code also uses ViewDataSourceValidation (32), FunctionArgument (23), NoValidRunnableCode, MethodNotFound, PersistentSqlConnectionError. **Not** a value: PassClrExceptionsToApplication.
- `client`/`server` modifiers compile with **deprecation warnings** ("The 'Client' keyword has been deprecated…") — not silently ignored; only `NumberSeq` still carries them.
- `protected internal` compiles (419 uses) and `internal protected` too; `private protected` → "Conflicting modifiers"; `override`/`virtual` → "';' expected"; two methods with one name → fatal "The name 'f' denotes a method, and cannot be reused".
- Extension-method classes are **enforced**: "Extension class 'X_Extension' must be static and public or internal", "The method 'bad' must be declared as static because it is declared in a static class", "The first parameter of a public extension method must be a class or a table…". Nested classes → "Nested classes are not allowed". `abstract` method in concrete class → error. Default param before required → "Non-default parameter '_b' cannot follow default parameters".
- Attribute arity is checked: `[SysObsolete("m")]`, `("m", false)`, `("m", false, 1\1\2026)` compile; four args → "The wrong number of arguments is specified for the method".

### 1.4 Data access
- `select` find options all compile: firstOnly/10/100/1000/**1** (450 uses), firstFast, noFetch, repeatableRead, optimisticLock, pessimisticLock, forceNestedLoop, forceSelectOrder, forcePlaceholders, **forceLiterals** (57 uses in 19 Microsoft files → "avoid", not "forbidden"), generateOnly, reverse, `index hint X`, plain `index X`, outer/exists/notexists join, aggregates with `group by` then `where`.
- `order by`/`group by` must precede `where` **within a join segment**: `select cg where … order by f` → "'join' expected"; `… where … join t order by t.f where …` is legal (7,145 vs 381 shipped shapes).
- `crossCompany` accepts `: variable`, `: [literal]` (8 shipped uses) and `: (expr)` — `multi-company` R5 is wrong. `join crossCompany t` → "Invalid token 'crossCompany'" (SEL003 correct).
- **`in` operator**: right side must be a container **variable** ("Container literals in 'in' expression are not supported. Declare container variable instead."); left side must be an **enum** field — str, int64, real, date fields fail with "Types 'str(…)' and 'container' are not compatible with operator 'in'"; Set/List rejected. Works in `select`, `while select … join`, `update_recordset`. `select-statement` R6 (str/int/…/date) is wrong.
- Select expression needs the **table name**: `(select firstonly CustGroup).Name` compiles; `(select firstonly cg).Name` → "Table 'cg' is not found" (5,604 shipped uses).
- `validTimeState(x)` / `(from, to)` take **variables/literals only** — `validTimeState(DateTimeUtil::utcNow())` → "Invalid token '::'".
- `join … on` → "Invalid token"; `left outer join` → "Invalid token 'outer'"; `having` → "'join' expected".
- `update_recordset firstonly …`, `delete_from t;` without where, `ttscommit;` without begin, `next cg;` without select, `while select cg stmt;` without braces all **compile** (run-time concerns only).
- `insert_recordset dst (f1, f2) select f1, f2 from src`, `update_recordset … setting … join …`, `RecordInsertList`, all six `skip*` methods (`skipDataMethods`, `skipDatabaseLog`, `skipEvents`, `skipAosValidation`, `skipDeleteActions`, `skipDeleteMethod`), `allowIndexHint`, `queryTimeout`, `executeQueryWithParameters` compile / are shipped.

### 1.5 Run-time functions (arity from xppc messages; `Global.` = static on `Global`)
| Shape | Functions |
|---|---|
| fixed 0 | beep curExt curUserId funcName getCurrentPartition getCurrentPartitionRecId getPrefix newGuid sessionId systemDateGet timeNow today conNull dateNull dateMax |
| fixed 1 | abs acos asin atan cos cosh sin sinh tan tanh exp exp10 frac log10 logN trunc any2* char2Num(2!) date2Num enum2Str guid2Str int2Str int642Str num2Char num2Date str2Guid str2Int str2Int64 str2Num str2Time uint2Str dayName dayOfMth dayOfWk dayOfYr endMth mthName mthOfYr nextMth nextQtr nextYr prevMth prevQtr prevYr wkOfYr year systemDateSet classIdGet dimOf tableId2Name tableId2PName tableName2Id typeOf conLen strAlpha strColSeq strLen strLTrim strLwr strRTrim strUpr sleep setPrefix enum2int enum2Value enumName2Id classId2Name className2Id dateEndMth dateStartMth strLRTrim |
| fixed 2 | char2Num corrFlagSet decRound dg idg indexId2Name indexName2Id match power pt round str2Date str2Datetime str2Enum strCmp strKeep strLine strPrompt strRem strRep conPeek enum2Symbol symbol2Enum strSplit strContains strStartsWith strEndsWith dateMthFwd fieldName2Id |
| fixed 3 | cTerm fV intvMax intvName intvNo intvNorm mkDate pmt pv rate sln term time2Str strDel strIns strPoke subStr conDel strReplace |
| fixed 4 | ddb syd strFind strNFind strScan |
| fixed 5 | num2Str |
| optional tail | date2Str **7–8** (8th `DateFlags`), datetime2Str **1–2**, fieldId2Name **2–3**, fieldId2PName 2–3, info/warning/error/checkFailed **1–3**, runAs **4–7**, con2Str 1–2, str2Con 1–3, strLFix/strRFix 2–3 |
| variadic | strFmt, max, min, conIns, conFind, conPoke |
| do not exist | corrFlagGet, dateMin, int2Enum, refPrintAll, typeName2Id |
| obsolete (warning) | dateStartWk, dateEndWk, dateStartYr, dateEndYr |
| return-type gotchas | `strSplit` returns **List** (not container); `str2Con` returns container; select expression see 1.4 |
Message shapes to key rules on: `'fn' expects N argument(s), but M specified` (N = declared incl. optional), `'fn' is missing argument K of type 'T'` (too few), `The name 'x' does not denote a predefined function, a static method on the Global class nor a previously defined local function`.

### 1.6 Intrinsics (compiler table, 80) — the server's two lists must be replaced by this one
`attributeStr classNum classStr configurationKeyNum configurationKeyStr dataEntityDataSourceStr(2) dataentityviewstr delegateStr(2) dimensionHierarchyLevelStr dimensionHierarchyStr dimensionReferenceStr dutyStr enumCnt enumLiteralStr(2) enumNum enumStr extendedTypeNum extendedTypeStr fieldNum(2) fieldPName(2) fieldStr(2) formControlStr(2) formDataFieldStr(3) formDataSourceStr(2) formMethodStr(2) formStr identifierStr indexNum(2) indexStr(2) licenseCodeNum licenseCodeStr literalStr mapstr maxDate(0) maxInt(0) measurementStr measureStr menuItemActionStr menuItemDisplayStr menuItemOutputStr menuStr methodStr(2) minInt(0) privilegeStr queryDatasourceStr(2) queryMethodStr(2) queryStr reportStr resourceStr roleStr ssrsReportStr(2) staticDelegateStr(2) staticMethodStr(2) tableCollectionStr tableFieldGroupStr(2) tableMethodStr(2) tableNum tablePName tableStaticMethodStr(2) tableStr tileStr varStr viewstr webActionItemStr webDisplayContentItemStr webFormStr webletItemStr webMenuStr webOutputContentItemStr webpageDefStr webReportStr websiteDefStr webSiteTempStr webStaticFileStr webUrlItemStr webWebPartStr workflowApprovalStr workflowCategoryStr workflowTaskStr workflowTypeStr` (all others 1 arg). **Not** intrinsics: `securityPolicyStr`, `taskStr`, `typeId`, `enumCum`, `varStrLFix`, `funcName` (run-time, 0 args).

### 1.7 Testing API (read from `ApplicationFoundation/AxClass`, not TestEssentials)
- `SysTestCase extends SysTestAssert`: `setUp`, `setUpTestCase` (201 shipped overrides), `tearDown`, `tearDownTestCase`, `createSuite`, `parmExceptionExpected(boolean, msg, isRegEx)`, `exceptionExpected`, `expectedInfoLogMessage`, `assertExpectedInfoLogMessage`, `parmFaultExpected`, `useSingleInstance`, `testMethods`, `run`.
- `SysTestAssert`: `assertEquals assertNotEqual assertEquivalent assertNotEquivalent assertTrue assertFalse assertNull assertNotNull assertSame assertNotSame assertObjectEquals assertRealEquals assertUTCDateTimeEquals fail`. **No** `assertExpectedException` — expected exceptions use `parmExceptionExpected` (65 shipped uses).
- Suites: `SysTestSuite`, `SysTestSuiteCompanyIsolateClass`, `SysTestSuiteCompanyIsolateMethod`, `SysTestSuiteCompIsolateClassWithTts`, `SysTestSuiteTTS`, `SysTestSuiteNoCleanup`, `SysTestSuiteActor`, `SysTestSuiteProvider`. No `…CompanyIsolateShared`.
- Attributes that exist: `SysTestMethod`, `SysTestCheckInTest` (1,877 uses), `SysTestNonCheckInTest`, `SysTestInactiveTest`, `SysTestTarget`, `SysTestGranularity`, `SysTestRow` + `SysTestRowInactive` (ApplicationFoundation; 0 shipped uses), `SysTestProperty` (AF), `SysTestCategory`/`SysTestOwner`/`SysTestPriority`/`SysTestAreaPath`/`SysTestWellKnownDatasetDependency` (TestEssentials), `SysTestCaseDataDependency`, `SysTestCaseUseSingleInstance`, `SysTestCaseAutomaticNumberSequences`, `SysTestCaseConfigurationKeyConstraint/Dependency`, `SysTestCaseDependsOnBatch/FullDeployment/FullTextIndexes/Report`, `SysTestCaseFlightDependency`, `SysTestFeatureDependency`, `SysTestFeatureConfiguration`, `SysTestFixture`, `SysTestFilter`, `SysTestKey`, `SysTestSecurity`, `SysTestTransaction`, `SysTestCultureDependency`, `SysTestPerformanceExecutionGroup`. **No** `SysTestCaseAutoRollback`.
- ATL: `AtlDataRootNode::construct()` is the only entry; navigation is extension methods per module package — real chain from `AtlSampleTests/CostingSampleTest`: `data.invent()/.cust()/.sales()/.ledger()/.cost()/.prod()/.dimensions()`, `invent.items()/.onHand()/.sites().default()/.warehouses().default()/.postings()`, `items.bomStandardCostBuilder().setCostGroup(…).create()`, `data.cust().customers().default().record()`, `sales.salesOrders()`, `ledger.mainAccounts()`. Packages: AtlFoundation (29 classes), AtlCoreFinancial, AtlCostAccounting, AtlMaterialhandling, AtlPersonnel, AtlWarehouseOrders, ATLApplicationSuite, ATLTestCaseCommon, ATLGlobalizationLTM, AtlSampleTests.

### 1.8 Reporting / events API (read from source)
- `SrsReportRunController`: `parmReportName parmArgs parmShowDialog parmDialogCaption parmLoadFromSysLastValue parmReportContract startOperation runReport prePromptModifyContract preRunModifyContract preRunValidate outputReport runToScreen runToScreenPrintArchive setDefaultPrintDestinationSettings showPrintSettings` + delegate `renderingCompleted`.
- `SrsReportDataContract`: `parmRdpContract parmRdlContract parmPrintSettings parmQueryContracts parmReportName parmReportPath parmReportCaption parmRdpName parmDocuBrandContract`.
- `SRSPrintDestinationSettings`: `printMediumType fileFormat fileName overwriteFile emailAttachmentFileFormat emailTo emailCc emailSubject emailbody printerName numberOfCopies collate orientation landscape fromPage toPage printAllPages parmPrintToArchive parmSendToPrinterAsPdf parmEMailContract …`.
- `PrintMgmtDocType` delegates: `getDefaultReportFormatDelegate getQueryTableIdDelegate getQueryRangeFieldsDelegate getPartyTypeDelegate getPartyRecIdDelegate getEmailAddressDelegate getDestinationPartyTypeAndIdDelegate`. `SrsPrintMgmtController`: `runPrintMgmt initPrintMgmtReportRun outputReport(s) runOutputReports` (…FormLetterController adds `initFormLetterReport`).
- `SrsReportDataProviderPreProcess`: `cleanUp initialize parmCreatedTransactionId parmUserConnection parmSkipReportTransaction parmUseDefaultTransactionOnly disableLockEscalation`; `…PreProcessTempDB` adds `takeOwnershipOfTempTable releaseOwnershipOfTempTable(ByIdAndName)`. `SrsReportNameAttribute` exists (53 uses; `new`, `reportName`).
- `EventHandlerResult`: `result booleanResult hasResult checkResultValue newDefault newSingleResponse`. `XppPrePostArgs`, `DataEventArgs`, `ValidateEventArgs`, `FormEventArgs`, `FormControlEventArgs` are kernel (no AOT XML); `FormDataSourceEventArgs`, `FormDataFieldEventArgs` are AOT classes.
- Enum members actually used in handlers: `FormEventType::{Initialized Initializing PostRun Closing Activated}`, `FormControlEventType::{Lookup Clicked Modified PageActivated Validated JumpRef SelectionChanged TabChanged Validating Enter GotFocus Expanded …}`, `FormDataSourceEventType::{Activated Initialized Written QueryExecuting Created SelectionChanged InitValue QueryExecuted Deleted ValidatedWrite ValidatingWrite Writing PostLinkActive Deleting Creating MarkChanged …}`, `FormDataFieldEventType::{Modified Validating Validated JumpRef}`, `DataEventType::{Inserted Updated Deleted Inserting Updating Deleting ValidatingWrite ValidatedWrite ValidatingDelete ValidatedDelete ValidatingField ValidatedField ModifiedField ModifiedFieldValue InitializingRecord InitializedRecord DefaultedRow FinalInsertValidation FinalUpdateValidation MappingEntityToDataSource MappedEntityToDataSource InsertingEntityDataSource UpdatingEntityDataSource DeletingEntityDataSource PersistingEntity PersistedEntity InsertedLite UpdatedLite DeletedLite PostingLoad …}`, `SysOperationExecutionMode::{Synchronous ScheduledBatch ReliableAsynchronous Asynchronous}`.
- Attribute census (top): `Hookable` 71,948 · `DataMember(Attribute)` 11,850 · `ExtensionOf` 4,014 · `Wrappable` 2,876 · `SysObsolete(Attribute)` 3,254 · `SysClientCacheDataMethod(Attribute)` 2,832 · `SubscribesTo` 1,856 · `SysTestCheckInTest` 1,877 · `DataContract(Attribute)` 2,386 · `Export(Attribute)` 2,277 · `FormObservable` 1,162 · `Replaceable` 1,135 · `ExportMetadata(Attribute)` 1,258 · `SRSReportDataSetAttribute` 909 · `FormControlEventHandler` 807 · `FormDataSourceEventHandler` 738 · `DataEventHandler` 622 · `PostHandlerFor` 579 · `FormEventHandler` 436 · `SRSReportQueryAttribute` 446 · `SuppressBPWarning` 660 · `SysODataAction(Attribute)` 475 · `SysTestMethod` 336 · `SRSReportParameterAttribute` 319 · `FormDataFieldEventHandler` 204 · `PreHandlerFor` 97 · `BusinessEvents` 91 · `SysOperationContractProcessing` 78 · `SysOperationGroup` 40 · `SysOperationLabelAttribute` 35 · `SysOperationControlVisibility` 11.

---

## 2. Knowledge-base corrections required (entry · rule · evidence)

| Entry | Claim today | Verdict | Correct fact |
|---|---|---|---|
| `dotnet-interop` R9 | "X++ has no `using` STATEMENT" | **WRONG** | compiles; 8,306 shipped uses. Teach `using (…) { }` for IDisposable |
| `dotnet-interop` R2 | put CLR calls in a `server` static method | **WRONG (AX2012)** | `server` compiles with a deprecation warning; everything runs on the server tier |
| `dotnet-interop` R7 | index CLR arrays with `get_Item()/set_Item()` | OVERSTATED | compiler text: "Use the SetValue and GetValue methods on managed array types" |
| `dotnet-interop` R4 | only `catch (Exception::CLRError)` | INCOMPLETE | typed catch via declared variable `catch (ex)` (2,002 uses) |
| `select-statement` R6 | `in` works with str/int/int64/real/enum/boolean/date/utcDateTime | **WRONG** | enum fields only; container must be a variable (literal rejected) |
| `select-statement` R7 | `forceLiterals` is FORBIDDEN | OVERSTATED | compiles; 57 Microsoft uses → "avoid; SQL-injection risk with user input" |
| `select-statement` R1 | option list | INCOMPLETE | add `generateOnly`, `firstOnly1`; select expression requires table name |
| `select-statement` R15 | `validTimeState(dateFrom, dateTo)` | INCOMPLETE | arguments must be variables/literals, not expressions |
| `multi-company` R5 | crossCompany list "must be a variable, not an inline literal" | **WRONG** | `crossCompany:[…]` (8 uses) and `crossCompany:(expr)` compile |
| `switch-loops` R7 | `client`/`server` "parsed but IGNORED" | OVERSTATED | compile with deprecation warnings |
| `switch-loops` R2 | `default:` optional | INCOMPLETE | and must be the last case item |
| `xpp-class-rules` R17 | local functions "at the top of a method body" | OVERSTATED | may follow statements |
| `xpp-class-rules` R4 | modifier order `[access][static…]` | OVERSTATED | `internal protected` also compiles; `display static` compiles |
| `xpp-data-types` R6/R7 | conversions list; anytype locking | INCOMPLETE | add the implicit-conversion table (§1.2): real→int is an ERROR |
| `operators-precedence` | (implicit) only `= += -= ++ --` | INCOMPLETE | `*=`, `/=` compile (57/2 uses) |
| `attributes-authoring` R2/R7 | literal-only; `SysObsolete(msg, makeError)` | INCOMPLETE | a `#define` macro is allowed; `SysObsolete` takes 1–3 args (3rd = date); xppbp `BPCheckSysObsoleteAttributeParametersMismatch` wants all three |
| `attributes-authoring` R6 | `getAttributedClasses` on DictClass/DictMethod | PARTLY | it is **static** `DictClass::getAttributedClasses(classStr(X))` (shipped: BusinessEventsCatalogHelper); `SysDictClass::getAttributedClasses` does not exist |
| `error-handling` R4 | Exception list | INCOMPLETE | add TransientSqlConnectionError, DDEerror, CodeAccessSecurity, ViewDataSourceValidation, FunctionArgument; Break is reserved; bare `throw;` rethrow; catch order rule |
| `macros` | directive list | INCOMPLETE | add `#globaldefine`, `#globalmacro`, `#defInc/#defDec`, `#linenumber`, `#undef`, `#ifnot`, `%n`, dot-form rule, macro as attribute arg |
| `intrinsic-functions` R2 | element-name list | INCOMPLETE | add `dimensionHierarchyLevelStr`, `dimensionReferenceStr`, `dataentityviewstr`, `mapStr`, `viewStr`, `tablePName`, `fieldPName`, `configurationKeyStr/Num`, `licenseCodeStr/Num`, the 13 `web*Str` |
| `testing`/`unit-testing` | assert names, `SysTestCase` location, suites | PARTLY | see §1.7: `parmExceptionExpected` not `assertExpectedException`; `SysTestCase` is in ApplicationFoundation; suite list; `SysTestRow` exists; `SysTestCaseAutoRollback` does not |
| `ssrs-rdp-preprocess` | `…PreProcessInterface` has only cleanUp/initialize/parm* | CONFIRMED | + `disableLockEscalation`, TempDB variant adds take/releaseOwnershipOfTempTable |
| `print-management` | delegates | INCOMPLETE | 7 delegates on `PrintMgmtDocType` (§1.8) |
| `enum-conversions`, `xpp-declarations` R1–R4, `class-inheritance` R2, `select-statement` R10/R11, `transactions`, `set-based`, `intrinsic-functions` arities, `xpp-class-rules` R5/R10/R14/R16 | — | **CONFIRMED** by probe or census |
| all 75 entries — named APIs | — | **CONFIRMED** by the live knowledge audit (0 defects) |

---

## 3. Validator — measured false positives on shipped code (7,649 files)

| Rule | Sev | Hits (classes) | Verdict | Root cause / fix |
|---|---|---|---|---|
| FN001 | error | 7 | **FP** | `strFind(x, ',', 1, len)` — the masker ignores `'…'` literals, the comma inside `','` is counted as an argument. Fix the masker (§4.5) |
| CS001 | error | 1 (16 hits) | **FP** | `'????????-????-…'` inside a single-quoted string |
| SEL007 | error | 1 | **FP** | `' LEFT JOIN %2 T2 ON …'` inside a single-quoted SQL string |
| COC001 | error | 20 | **FP** | fires on *new* methods with default params in an `[ExtensionOf]` class (`findByJobId(…, boolean _forUpdate = false)`); must apply only to wrappers that call `next` |
| COC002 / COC003 | error | 3 / 1 | **FP** | 3-line lookahead after `[ExtensionOf]` reads the `/// <summary>` comment; and `public static class X_Extension` (extension-method class) is not a CoC class → exempt static classes, scan masked text |
| SEL002 | error | 2 | over-severe | Microsoft uses `forceLiterals` (57×) → warning |
| SEL001 | error | 1 | over-severe | `today()` is a BP finding, not a compile error → warning |
| BP001 | error | 12 | FP + over-severe | `EventSource.Info("…")` method calls named Info; hard-coded text is a BP warning, not an error |
| TTS001 | warning | 21 | noise | branch-dependent begin/commit counts (`ttsbegin × 7, ttscommit × 6`) |
| TTS002 | warning | 5 | doubtful | shipped code catches `Exception::Error` inside tts (dead code per docs, but compiles) |
| SEL005 | warning | 402 (1,221 hits) | noise | method calls in `where` are ubiquitous (`.name()`, `parmId()`); keep only for real functions |
| SEL004 | warning | 124 | noise | "≥2 while select, no join" heuristic |
| SEL006 | warning | 73 | noise | `allowIndexHint` is called elsewhere |
| BP002 | warning | 138 | legit advisory | `doUpdate()` |
| lintXppSelect | modify-path | 41 classes | **FP** | flags the joined table's own `where` after `join` (`while select … order by Name exists join x where …`) — standard X++ |
| TTS003, BP003, BP004, BP005, RPT002, COC006 | warning | ≤77 | mostly legit | |

Conclusion: 5 error-severity rules produce false positives on Microsoft's own code, all but two through the single-quote masking hole; three more are wrongly `error` for what the compiler accepts.

---

## 4. Merge rules (unchanged from v2, plus one)

1–10 as in v2 (extend never duplicate; ≤1,300 chars; no contradictions; rule-or-knowledge; **no AST but one shared lexer**; one intrinsics table; schema-byte ratchet; eval-first; snapshot gate; deferrals to BACKLOG).
11. **Compiler-truth gate.** A fact enters knowledge, a validator rule or a generator template only with an oracle reference: a keyword/intrinsic from the compiler tables, an arity from a probe message, a shape from the census, or a member from the class XML. `eval/compiler-facts.snapshot.json` (new, G0.6) holds these facts; tests read it instead of hand-typed constants.

---

## 5. Work plan (v2.1)

### G0 — Truth first (repo-only, ~1.5 days)
| # | Item |
|---|---|
| G0.1 | Re-point weak coverage leaves (`set-based` → `L2-performance-set-based`; `transactions` → tts/OCC cases; `select-grammar` += SysDa/date-effective/changeCompany; `menu-item` += display/action cases; `enum-extension` += `extensible-enums`); coverage rule: `runtime`-tagged leaves need `systest.ran` |
| G0.2 | Pattern-enum parity test; publish or drop the 6 hidden patterns |
| G0.3 | **Knowledge corrections of §2** (one PR, each rule cites its oracle) |
| G0.4 | **Validator FP fixes of §3**: shared lexer with `'…'`/`"…"`/`@…`/doubled quotes/`//`/`/* */`/`#`; COC001 only when the method body calls `next`; COC002/003 on masked text + static-class exemption; SEL002/SEL001/BP001 → warning; BP001 requires a *global* `info/warning/error/checkFailed(` (not `.Info(`); lintXppSelect rewritten (a `where` after `join` is legal); TTS001 downgraded to "count differs by >1" or removed |
| G0.5 | FN001 → min/max table from §1.5 (`date2Str` 7–8, `datetime2Str` 1–2, `fieldId2Name` 2–3, `error` 1–3, `runAs` 4–7, `con2Str` 1–2, `str2Con` 1–3, `strLFix` 2–3); add the fixed-arity families (`intv*`, financial, `char2Num` 2, `num2Str` 5, `time2Str` 3, `str2Date/Datetime/Enum` 2, `strKeep/strRem/strPrompt/strLine/strCmp/match` 2, `strPoke` 3); variadic list (`strFmt max min conIns conFind conPoke`); unknown-name list |
| G0.6 | `scripts/compiler-facts.ts` (VM): dumps keywords + intrinsics by reflection and runs the arity probe corpus → `eval/compiler-facts.snapshot.json`; `tests/knowledge/compilerFacts.test.ts` asserts FN001/KW/intrinsic tables equal the snapshot |
| G0.7 | BACKLOG entries for v1 deferrals; orphans claimed |

### G1 — Language knowledge pack v2 (repo-only, ~2 days)
New: `runtime-functions` (§1.5 catalog by category, with the do-not-exist and obsolete lists), `implicit-conversions` (or fold §1.2 into `xpp-data-types`), `form-event-handlers` (4 attributes, 4 enums with the members in §1.8, signatures `FormRun sender, FormEventArgs e` etc.), `args-object`, `display-edit-methods`, `sysoperation-ui-attributes` (existing classes: `SysOperationGroup/GroupMember/RootGroup/DisplayOrder/HelpText/ControlVisibility/JournaledParameters/AlwaysInitialize/CountryRegionCodes`, `SysOperationInitializable.initialize()`).
Extend: `xpp-declarations` (`@`, arrays, `byref`, multi-assign, local-function placement, `for` multi-init), `error-handling` (§1.3 list, rethrow, typed catch, finally/catch order, SQL timeouts), `dotnet-interop` (corrections), `switch-loops` (default-last, `*=`/`/=`, `window/pause/tableLock/changeSite` gone), `macros`, `xpp-class-rules`, `attributes-authoring`, `multi-company`, `select-statement` (`in` semantics, select-expression form, validTimeState args, clause order per join segment), `intrinsic-functions` (compiler list).

### G2 — Validator v2 (repo-only; messages already verified, ~2 days)
| Rule | Sev | Shape (compiler text) |
|---|---|---|
| lexer + intrinsics table | — | §4.5/4.6; intrinsics from `compiler-facts.snapshot.json` |
| KW001 | error | identifier ∈ 115-word set (`having`, `foreach`, `namespace`, `async`, `await` included) |
| MAC001 | error | `#define X` without dot → "The macro 'define' is not defined" |
| DOC001 | error | bare `&`/`<` in `///` (xppbp BPXmlDocMalformed) |
| DECL001 | error | shadowing (exact message §1.3) |
| OP001 | warn | mixed `&&`/`\|\|` without parens |
| SEL008 | error | `order by`/`group by` after `where` **in the same join segment** ("'join' expected") |
| SEL009 | error | `in` with a container literal / non-enum field (§1.4 texts) |
| SEL010 | error | select expression on a buffer variable; `validTimeState(` with an expression |
| SET001 | warn | `update_recordset`/`delete_from` without `where` |
| ATTR001 | error | non-literal attribute argument (const/expression; macros allowed) |
| ATTR002 | warn | `[SysObsolete]` with < 3 args (BP moniker) |
| EXT001 | error | `*_Extension` without `[ExtensionOf]`: not static, non-static method, first param not class/table (compiler texts §1.3) |
| CONV001 | error | `int x = <real expr>` and the other §1.2 ERROR rows (`str = int`, `int = str`, `date = int`, `str = enum/boolean`, `str + int`) |
| CS001 | error | keep `$"` `=>` `foreach` `??` `string`; add `bool decimal double long uint List<`, `override`, `virtual`, `private protected`, `catch (System.X ex)` inline, `goto`; **do not** add `*=`/`/=` |
| BP004 | warn/error | `window`/`pause`/`tableLock`/`changeSite` → error (not keywords); `print`/`breakpoint` warn |
| resolver | — | kernel allow-list (`Uncheck{TableSecurityPermission,XDS}`, `Exception` values §1.3, `Types`, `DictClass`, `Array`, `DbBackend`, `CodeAccessPermission`, `XppPrePostArgs`, `DataEventArgs`, `ValidateEventArgs`, `FormEventArgs`, `FormControlEventArgs`, `Args`, `FormRun`); optional-param-aware arity |

### G3 — TDD / SysTest pack (repo + VM, ~3 days)
- Knowledge `systest`: §1.7 verbatim (class location, lifecycle, assert list, `parmExceptionExpected`, suite list, attribute list, `TestEssentials` reference for Category/Owner/Priority); `atl-navigation` from `AtlSampleTests` chains; `tdd-workflow`.
- `generate_object(pattern="systest")`, `prepare(mode="test")`, `run_systest_class` XML parsing, ConPTY experiment (time-boxed), cases `L2-systest-authoring-basic`, `L2-systest-row-data-driven`, `L3-atl-sales-order-reservation`, `L2-tdd-red-green-cycle` — as in v2.

### G4 — Reporting pack v2 (repo + VM, ~3 days)
As in v2, with the API lists of §1.8 as the only allowed member names; RPT003 (TempDB pairing) now verifiable; EVT001 (`XppPrePostArgs` param) / EVT002 (static subscriber) — kernel types go through the resolver allow-list.

### G5 — Taxonomy expansion + eval authoring (repo-only, ~2 days) — as in v2 (16 leaves, 16 pending cases) plus `implicit-conversions` and `in-operator` cases.

### G-VM — capture (VM, ~1.5 days): knowledge-audit snapshot (already clean), `compiler-facts` snapshot, ConPTY, `eval-run` of pending cases, coverage regen, §6.4 review, delete this file.

### G6 — Platform-drift watch: monthly; re-run `compiler-facts` after every platform update (the keyword/intrinsic tables and arities are version-bound).

---

## 6. Probe list — resolved

All 20 v2 probes were run; results are in §1. Still open: P9 (bridge vs TS writer disagreement on `&amp;` in `///`), P13 (ConPTY), P16 (`[PostHandlerFor]` wrong parameter → compile vs runtime), P17 (CoC on an RDP class). New: `in` with an `int` field (only enum/str/int64/real/date probed), `anytype` re-assignment at run time.

## 7. Schema budget ledger — unchanged from v2 (no new tool; enum values + op-specs; trim `labels`).

## 8. Risks & non-goals — unchanged, plus: the compiler facts are bound to **xppc 7.0.7996.33 / 10.0.4x**; the snapshot records the version.

## 9. PR slicing
1. `fix(knowledge,validate): G0 — compiler-verified corrections, lexer, FP fixes, compiler-facts snapshot`
2. `feat(knowledge): G1 — language pack v2`
3. `feat(validate): G2 — 14 rules from compiler diagnostics`
4. `feat(test): G3` · 5. `feat(reports): G4` · 6. `feat(eval): G5` · 7. `feat(eval): G-VM` (deletes this file)
