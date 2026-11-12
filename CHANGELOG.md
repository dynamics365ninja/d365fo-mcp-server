# Changelog

Notable changes per release. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[semantic](https://semver.org/) with the caveat noted under *Versioning* below.

This file starts at v1.0.0 (first public release, 2026-07-21). Entries before
2026-08-08 were reconstructed from git history and release tags — they name what
changed and why it mattered, but they are a summary, not an exhaustive log. Run
`git log v1.7.0..v1.8.0` for the complete set.

**Add an entry in the same PR as the change.** Put it under `[Unreleased]`; the
release PR moves the block under a version heading. A change nobody can find is
indistinguishable from one that never shipped — nine releases went out in the
first three weeks with no human-readable notes at all, which is why this file
exists.

## Versioning

Minor versions carry behavioural changes to the MCP tool surface (tools added,
merged or retired; parameter contracts changed). Patch versions are fixes that
do not move that surface. Because the tool surface *is* the API here, a
consolidation that retires a tool name is a **breaking change for any prompt or
instruction file that named it**, even though the version only moves a minor —
those are called out explicitly below.

---

## [Unreleased]

### Added
- **`validate_code(mode="references")` checks what a Chain of Command wrapper, an event
  handler or a call binds to, not only that the name exists** (#1225). After an ISV or
  platform update, a wrapper or handler written against the old version broke only at the
  next build, and an agent writing a wrapper from memory got the same failures. The check
  now reads the indexed declaration and reports three new kinds:
  `coc-target` (the wrapped method is on no type in the `extends` chain and is not a kernel
  method, or it is private, `final` without `[Wrappable]`, public with
  `[Wrappable(false)]` or `[Hookable(false)]`, or the wrapper differs in parameter count,
  `static` or an inconvertible parameter or return type), `handler-target` (a
  `[SubscribesTo]` delegate that does not exist, is an ordinary method, is static but
  named with `delegateStr`, or whose parameters the handler does not repeat, and a pre- or
  post-handler on a `[Hookable(false)]` method or on a private one without
  `[Hookable(true)]`) and `obsolete-method` (a call to a method marked `[SysObsolete]`: an
  error when its isError argument is true, a warning otherwise or when the calling code is
  obsolete itself). Each error is a case the compiler rejects, confirmed by compiling it;
  what the compiler accepts is at most a warning (a parameter typed with another EDT, a
  protected method with `[Wrappable(false)]`). Run over every wrapper and handler Microsoft
  ships (5,758 files), the checks raise no error. They stay silent when the index cannot
  answer: a form's delegates, an owner whose base class is not indexed, or a method an
  extension adds. The same checks run in the `GROUNDING_ENFORCE` write gate, so an error
  there blocks the write.
- **`validate_code(mode="references")` checks the member of `methodStr`, `staticMethodStr`,
  `tableMethodStr`, `tableStaticMethodStr`, `delegateStr` and `staticDelegateStr` the way
  the compiler does** (#1270). Only `methodStr`/`staticMethodStr` were checked, and they
  accepted a method found on any base class, on a table or on a form. The compiler wants the
  member declared on the named type itself (an extension class's methods count, inherited
  ones and kernel table methods the table does not override do not), of the matching kind,
  and `methodStr` only takes a class. A member nobody declares, or only a base class
  declares, is now an `unknown-method` error that names the declaring type. The new
  `wrong-member-kind` error covers a static member through `methodStr`, `tableMethodStr` or
  `delegateStr`, an instance member through their `static…` twins, an ordinary method
  through `delegateStr`, and a table or form in `methodStr`, and names the intrinsic to use.
  Form members, views, maps and data entities, field groups and indexes are not checked:
  the index does not hold them. Over the 38,060 uses in shipped code the check raises no
  error.
- **`index.storeObjectSource` turns off the copy of every object's XML in the index.** Since
  1.23.0 the extraction writes each object's original XML into its JSON as `raw`, and the
  build stores it gzipped in `object_source`, so a server without the AOT files (a shared or
  Azure deployment) can still read objects. A server with the metadata folders on disk reads
  the files and never uses the copy, which costs about 2 GB of extracted JSON and 0.4 GB of
  database per full standard + custom index. Set `index.storeObjectSource` to `false`
  (`STORE_OBJECT_SOURCE=false`) to skip both: the extraction leaves `raw` out (enums keep
  theirs, it is their whole record), and neither the build nor `update_symbol_index` writes
  `object_source` rows. The default, `true`, keeps today's behaviour. It takes effect at the
  next index build; run a full rebuild (`extractMode` `all`) to remove copies already stored.
- **`d365fo_file(action="modify", operation="modify-property")` sets OperationalDomain and
  SubscriberAccessLevel on existing tables and menu items.** Menu items had no writer for
  either (the bridge's setter has no case for them), and SubscriberAccessLevel holds child
  elements no scalar writer can express, so the BP warnings on existing objects could not
  be fixed with the tool. Both are now written on the XML for `table`,
  `menu-item-action`, `menu-item-display` and `menu-item-output`, in canonical element
  order, replacing an existing element. SubscriberAccessLevel takes `NoAccess`, `Read`,
  `All`, `None` or an explicit `Read=Allow,Create=Deny` list (`All` is new). The reply
  names the value xppbp expects when the one written differs: SubscriberAccessLevel on
  tables and on menu items that open a class, OperationalDomain on tables only (for menu
  items xppbp requires one but names no value). A menu item on a form or report gets no
  hint: xppbp decides from its data sources (all TempDB gives Local and No Access). The after-write check reads SubscriberAccessLevel's child elements, so a correct
  write is no longer reported as "NOT in the file".
- **`add-relation` takes `relationOnDelete` and sets OnDelete on a relation that already
  exists, on a table or a table extension.** BPCheckMissingDeleteActions on an existing
  relation had no fix: add-relation had no OnDelete parameter and add-delete-action is
  table-only. `relationOnDelete` (None, Restricted, Cascade, CascadeRestricted) is written
  after Cardinality and before RelatedTable, as in shipped metadata. When the relation
  exists only its OnDelete changes. A new relation gets it after the add.
- **New table fields get the EDT or base enum they need, created first.** A field with only
  a primitive type drew BPErrorTableFieldNotDefinedUsingType, and a field naming an EDT or
  enum that did not exist failed the build (the scaffold refused it). `d365fo_file` create
  of a table, `add-field` on a table or table extension (single or in `operations[]`) and
  `generate_object` scaffold of a table now create the missing EDT (base type from the
  field, or implied by its name, with its label and string size) or enum (values from
  `enumValues` / `fieldEnumValues`, each labelled). A primitive-only field reuses the EDT of
  its name and base type or gets a new one named after the field. An Int64 `…RecId` EDT
  extends RefRecId. The type takes the field's label and the field drops its copy
  (BPErrorFieldLabelIsCopyOf…). The reply lists every type created. `autoCorrect=false`
  writes the fields as passed. Nothing is created when the symbol index cannot be read.
- **`run_bp_check` (and `build_d365fo_project` with `bpCheck: true`) reports the
  OperationalDomain and SubscriberAccessLevel warnings the Azure DevOps build reports.** The
  build pipeline restores newer Microsoft build packages whose BP rules check both properties
  on tables and menu items. The xppbp on a UDE has no such rule, so a clean local check met
  them for the first time in the pull request build. The check now adds them, with the
  pipeline's monikers and messages, under a "Reproduced pipeline rules (not reported by this
  xppbp)" heading, as detail lines the findings section and the build summary count. They
  are added only when xppbp reported none of them and its rule assemblies (`bin\BPExtensions`)
  do not name them, so a platform that ships the real rules keeps its own answer. A whole-model
  run checks every table and menu item of the model, a targeted run only a requested table or
  menu item. A finding in the model's suppression list is left out, as the pipeline leaves it
  out. Checked against an ISV model's pipeline log: 646 of 646 warnings, same object, rule and
  message, none extra.
- **Label false positives are marked.** A `BPErrorUnknownLabel` for a label that exists in the
  model's label files, and a `BPUnusedStrFmtArgument` in the same method on a placeholder that
  label has, get a "Likely label false positives" note. xppbp reports them when it cannot read
  the compiled label assembly, so the note tells the caller not to create the label again.
- **`run_systest_class` runs tests on UDE, in the environment's cloud runtime.** A UDE
  machine has no local AOS, so SysTestConsole cannot run there; the tool now sends the
  tests where Visual Studio sends them, through the Dataverse environment the UDE belongs
  to. It reads the test methods from the class (and from base classes in the same model),
  uploads a test request naming the built module assembly, starts the run, waits for it
  and reports per method from the `.trx` it gets back, which it also saves. Tests run
  against the code DEPLOYED to the environment, and the reply says so. `testMethod` now
  runs that one method alone (`Class::method` is accepted too); `[SysTestInactiveTest]`
  methods are reported as skipped, and a requested method that gets no result counts as
  failed. Set the new `environment.dataverseUrl` (`D365FO_DATAVERSE_URL`) to the Dataverse
  URL (not the Finance and Operations one; `pac org list` shows it). The first run in a
  server process opens a sign-in page in the browser, and calls running at the same time
  share it; tokens are kept in memory only. Tenants that block Microsoft's sample
  Dataverse client can set `environment.dataverseClientId`, and guests
  `environment.dataverseTenant`. `setup` asks for the URL on UDE.
- **`build_d365fo_project(deploy: true)` deploys the built model to its UDE environment,
  so `run_systest_class` tests the new code.** Tests on UDE run against the code deployed
  to the cloud runtime, and until now only Visual Studio could deploy it. After a
  successful build the tool now deploys the package that holds the model, and only that
  package, through the same Power Platform Tools library Visual Studio uses. It signs in
  with the server's own Dataverse token, so there is no second sign-in. By default it
  deploys a Dev package without a database sync (about 3 minutes). With `dbSync` as well,
  it deploys a Release package with a full sync in the environment (about 20 minutes),
  which a table, view, data entity, enum or EDT change needs; together with `deploy`,
  `dbSync` runs in the environment instead of a local SyncEngine. Success is read from
  the environment's status lines, and a failed deployment makes the result an error
  while the build verdict stands. A deploy that cannot happen (not a UDE, no
  `environment.dataverseUrl`, a failed sign-in, or `restartAos` given as well) is refused
  before anything is compiled. Needs Power Platform Tools for Visual Studio (a UDE
  prerequisite) and Windows PowerShell 5.1. The library is undocumented: when an update
  changes it, the tool says which members are missing and uploads nothing. The system
  prompt and `copilot-instructions.md` now tell agents to deploy before running changed
  tests on UDE, and to announce a full sync. The `run_systest_class` replies about
  undeployed code point to `deploy: true`. On UDE, `doctor` reports whether Power
  Platform Tools is installed, so a missing prerequisite shows up before the first
  deployment fails. To keep the tool list's size, the descriptions of `wait` and
  `waitTimeoutMs` are shorter; what they mean is unchanged.
- **Binary-only ISV models are indexed (signatures only).** A model shipped as compiled
  output (`bin\*.netmodule`, no `AxClass`/`AxForm` XML) used to yield nothing: `search`,
  `get_object_info`, `labels`, `security_info` and `validate_code(mode="references")` knew
  none of its classes, so every call into the ISV came back `unknown-type` and agents
  invented members. The new `BinaryModelExtractor` (net48, Windows) reads such models through
  `CreateRuntimeProvider` and `npm run extract-binary-models` imports them: classes, tables,
  EDTs and enums as signatures (X++ types, defaults, modifiers, attributes), forms, queries,
  views, data entities, maps, menu items, security and extensions through the stock
  `extract-metadata` parsers, label texts from the `Resources` satellite assemblies, and the
  compiler's chain-of-command record, so `extension_info(mode="coc")` lists wraps of binary
  extension classes. No method body or source is stored; entries say "binary ISV, signatures
  only". The import refuses a model whose references mostly do not resolve against the
  platform it was read with (`--force` overrides). `build-database` also indexes label texts
  found under `<METADATA_PATH>/<Model>/AxLabelFile`. `BinaryModelExtractor --models` takes
  names and masks by module or display name (`Contoso*,!ContosoDemo*`); `--no-aot` skips the
  object XML and labels when only signatures are needed; `--kernel` also dumps the platform
  kernel (`Common`, `xRecord`, `Object`, ...) as the model `Kernel`. See docs/BINARY_ISV_MODELS.md.
- **`d365fo_file(action="modify")` changes the duties and privileges of roles and duties.**
  After `create` nothing could change these lists: the only way was
  `create(overwrite=true)` with the complete list or hand-written XML, and
  `security-role-extension` and `security-duty-extension` were not modifiable at all. The
  new operations are `add-duty` / `remove-duty` (`dutyName`; on `security-role` and
  `security-role-extension`) and `add-privilege` / `remove-privilege` (`privilegeName`; on
  those and on `security-duty` and `security-duty-extension`). They take one name each, so
  several go in `operations[]`. An add appends to the list, and a reference already there
  is skipped and reported (names compare case-insensitively). A name the symbol index
  knows only as the other kind is refused with the operation to use; an unknown name is
  warned about and still written, and on an index with no such objects (a write-only
  companion) the reply says it could not check. An add on an extension warns when the base
  role or duty already holds the reference. A remove collapses an emptied list to
  `<Duties />` / `<Privileges />`, answers a name that is not there with the list that is,
  and refuses a name listed twice. A modify of a missing role or duty extension whose
  standard base is in the index now offers the one `create` call that does it, and the
  refusal to modify a standard role or duty names the extension types.
- **`modify-field` turns a data entity's mapped field into a computed field.**
  `computedFieldMethod` rewrites the entity's own mapped field as
  `AxDataEntityViewUnmappedField<Type>` (type, EDT and enum read from the source
  table field; system fields such as `CreatedDateTime` known without it) and writes
  its static method in the same edit: `sourceCode` when given, an existing method of
  that name, or a generated `SysComputedColumn::returnField` over the field it was
  mapped to. A key field is refused. This used to take a rewrite of the whole entity
  with `create` + `overwrite`.
- **`move-control` and `wrap-controls` on a form.** Converting a form to a standard
  pattern changes its nesting: fields go into a FieldsFieldGroups group, groups become
  FastTab pages of a Tab, a grid moves under a TabPage. No operation changed a
  control's parent, so the whole form was rewritten through `create` + `overwrite`.
  `move-control` moves an existing control, with its subtree, under another parent at a
  position. `wrap-controls` puts existing controls of one parent into a new Group, TabPage
  or Tab with Pattern (PatternVersion defaults to the newest the catalogue knows), Caption
  and Style, written in the shipped element order (a property the type never carries is
  refused). Moved controls keep their XML byte for byte, only re-indented. The design's
  own Pattern and PatternVersion are set with `modify-property`.
- **Form pattern oracles.** `npm run catalog:form-patterns` regenerates the platform
  definitions and property defaults from a local D365FO install.
  `npm run oracle:form-patterns -- verdicts` runs the platform's `PatternAnalyzer`
  (Windows, read only) over `tests/fixtures/formPatterns` and records its verdicts,
  which `tests/validation/platformPatternMatcher.test.ts` holds the validator to in
  CI. `npm run oracle:form-sweep` validates every shipped form and fails on any
  error.
- **`add-control` writes reference groups, and picks one for a surrogate foreign key as the
  form designer does.** `controlType="ReferenceGroup"` was not supported: on a form
  extension it came out as a String control (see Fixed). It now writes an
  `AxFormReferenceGroupControl` bound the way Visual Studio saves one: `<DataSource>`, the
  field from `controlDataField` as `<ReferenceField>` (a reference group has no
  `DataField`), and an empty `<Controls />`. On a plain form the bridge creates the control
  and `ReferenceField` is then written into the saved file. Without a `controlType`, a field
  dropped onto a form in Visual Studio as a reference group now gets one too: an Int64 field
  whose EDT derives from RefRecId and that relates to RecId of a table with a replacement key
  (e.g. `SalesTable.WorkerSalesTaker` → `HcmWorker`), through a table relation (also one
  in a table extension) or the EDT's `ReferenceTable`. The tables and EDTs are read from
  every package folder when the index has no path to them, so this works on a write-only
  companion too. The reply says why. When the related
  table has no replacement key the field stays an Int64 control, and the reply says how to
  ask for a reference group anyway. An explicit `controlType` always wins (`Int64` for a
  plain control). Set `ReplacementFieldGroup` afterwards with `modify-property`.
- **`modify-property` with `dataSourceName` sets JoinSource, LinkType, AllowEdit and the
  other properties of a form data source that already exists.** Join properties could be
  given only while a data source was added with `add-data-source`, and the others not at
  all, so an existing data source was edited in the form XML by hand. On `form` and
  `form-extension`, pass `dataSourceName` with `propertyPath` = `JoinSource`, `LinkType`,
  a Yes/No property (`AllowCreate`, `AllowDelete`, `AllowEdit`, `AllowCheck`,
  `AutoNotify`, `AutoQuery`, `AutoSearch`, `CrossCompanyAutoQuery`, `DelayActive`,
  `OnlyFetchActive`, `InsertAtEnd`, `InsertIfEmpty`), `Index`, `MaxAccessRight` or
  `StartPosition`. An existing element is replaced where it stands, a missing one is
  inserted in the platform's element order, and an empty value removes it. That order is
  not alphabetical. It was measured on Microsoft standard forms (13,234 data sources, no
  pair of elements in both orders), because the platform drops an element written out of
  order. A JoinSource that is not a data source of the form is refused, and so is a
  LinkType outside InnerJoin, OuterJoin, ExistJoin, NotExistJoin, Delayed, Active and
  Passive. Yes/No properties take Yes or No. InsertIfEmpty=Yes removes the element, as
  Yes is its default. On a form extension a JoinSource that is not in the extension is
  written with a note, because it must be a data source of the base form. CounterField,
  ValidTimeStateAutoQuery, ValidTimeStateUpdate, OptionalRecordMode and MaxRecordsToLoad
  are too rare to place with certainty and are refused with the supported list (#1161).
- **`add-method` with `methodName="Control.method"` adds an override on a form control.**
  On `objectType="form"` a dotted name worked for data sources (`DS.method`,
  `DS.Field.method`) and for a control override that already existed, but a new one such
  as `OkButton.clicked` became a form method literally named "OkButton.clicked", which
  does not compile. A new control override is now written by this server into the
  control's holder under `<SourceCode><DataControls>`, typed like the design control,
  where the designer keeps it and where `replace-code` already looks for it. The source
  gets the same doc comment and indentation pass as every other `add-method`. Data source
  names and overrides that already exist go to the bridge as before. A first segment that
  is neither a data source nor a control of the form is refused with the close control
  names, and nothing is written (#1161).
- **`d365fo_file` create and modify now warn when something you asked for is not in the
  saved file.** A write could answer ✅ while the platform or a writer dropped part of the
  request, for example a field or method the reply said was added, or a data entity's
  staging table. That surfaced much later as a build or data-management error naming
  something else. After a successful write the tool now reads the file back and compares
  it with the request, with no bridge round trip and for every object type, including data
  entities and their extensions, which had no read-back before. Modify checks
  `add-field`, `add-method`, `add-index`, `add-field-group`, `add-relation` and
  `add-enum-value` (the named child must be there), their `remove-` counterparts (it must
  be gone) and `modify-property` (a top-level property must hold the value). Create checks
  the scalar `properties` you passed on every type except tables, which keep their own
  reconciliation. A miss is listed in one `⚠️ Read-back` block at the end of the reply. The
  write is not rolled back and the call is still a success, so re-read the object and
  apply the listed item again. The check only reports what is certain: a property the
  serializer may omit as a default, a label given as text, a form control property and a
  control or data source method are not compared. Nothing to configure. (#1161)
- **A data entity created with `dataManagementEnabled=true` gets its staging table.**
  `d365fo_file(action="create", objectType="data-entity")` wrote
  `<DataManagementStagingTable>` and no table, so the next build failed with a missing
  table and the reply could only warn. The create now writes the table in the same model
  and project, in the shape of shipped staging tables such as
  `CustCustomerGroupEntityStaging`: a regular table with TableGroup Staging, the DMF fields
  DefinitionGroup, ExecutionId, IsSelected and TransferStatus, one field per public entity
  field, the alternate-key index StagingIdx on DefinitionGroup, ExecutionId and the entity
  key, and the relation DataEntity. Each field takes the EDT or enum of the table field it
  maps to, read from that table's file or from the symbol index. A type is never guessed:
  a field that cannot be resolved is left out and named in the reply, to add with
  `add-field`. A table of that name that already exists is left as is. `autoCorrect=false`
  keeps the create to the entity, with the old warning. `undo_last_modification` tracks
  the table like any other created file. Fields and relations marked
  `IsSystemGenerated=Yes` no longer get an EDT relation or `OnDelete=Restricted` from the
  table best-practice defaults, because shipped staging tables carry neither. The
  `data-entity-staging` template of `generate_object` said TempDB and TableGroup Main and
  now describes the same shape. Not compiled against a D365FO environment yet, so build
  the model after the first use (#1161).
- **`get_object_info` for `menu` and `menu-extension`.** It had neither type, so an agent
  placing an item had no tool to find a submenu: on a dev VM it grepped
  PackagesLocalDirectory for the menu XML and read it raw. `objectType="menu"` renders the
  menu as a tree of submenus (with label) and items (with their menu item and kind), with a
  count, and a line per extension of the menu: how many items it adds and which submenus,
  under which parent. `{"submenusOnly": true}` gives the submenu tree alone with an item
  count each. `objectType="menu-extension"` takes a full extension name (that one) or a
  base menu name (all of them) and lists each entry under its parent, with its position,
  nested items and the customizations of base elements. Both read through the index, the
  configured model and then every package folder, so a write-only companion reads standard
  menus too; `{"include": "xml"}` falls back to the package folders for both types as well.
  A read-only server reads only the files its index points to and still finds on its disk
  (some models' source, not the standard packages), and its index keeps no menu XML. When
  it cannot read a menu it says so, lists the extensions of the menu the index knows by
  name and model, and points to the local companion, instead of "not found" with search
  advice. Extensions the index knows but whose file was not read are counted in the
  heading ("5 of 7 read") and listed by name and model above the rendered ones, so a
  partial list does not read as the whole one.

### Changed
- **The server opens one read connection to the index instead of three, with a 128 MB
  page cache, and no longer opens label read connections it never used.** Reads run one
  at a time (the SQLite driver is synchronous and tools run on the main thread), so three
  round-robin connections gave no concurrency, only three 32 MB caches, statement caches
  and full-text states for the same work. The index file is larger than the memory-mapped
  window, so scans depend on that cache: the same scan took 630 to 910 ms with 32 MB and
  100 to 130 ms with 256 MB. Three label connections with a 512 MiB mapping each were
  opened beside them and nothing read from them. The default of `READ_POOL_SIZE`
  (`server.readPoolSize`) changes from 3 to 1. If you set it yourself it still opens that
  many connections, and the 128 MB is now split between them (never less than 32 MB
  each). Remove the setting to get the single connection.
- **A successful `d365fo_file` create or modify reply drops the confirmations that were
  the same on every call.** The reply holds the headline, the path and what varies with
  the call (warnings, refusals, a skip and its reason, a project the object is missing
  from, BP defaults the bridge chose, an unapplied property, a failed index update).
  Removed from every success: `✅ Verified: on disk (N bytes), referenced by the
  .rnrproj.`, `🔎 Symbol index updated in place — no update_symbol_index call needed.`,
  the `🔧 API: ✅ … via <Api>` line, and the `via IMetadataProvider.Create()` / `applied
  via IMetadataProvider.Update()` / `applied via this server's XML writer` tail of the
  headline. A `File: <path>` inside a writer message is dropped when the reply already
  prints that path. The closing `Next: build_d365fo_project(bpCheck:true)…` line and the
  batch-edit hint (`Further edits … go in ONE call…` after a create, `More edits …? Send
  them together…` after a single modify) stay, and a batch (`operations[]`) keeps its
  one `Next:` line: each was added against a measured round-trip pattern (single-op
  modify chains, and `verify_d365fo_project` / `run_bp_check` calls right after writes
  that had verified themselves). After a skipped modify the `Next:` line and the hint
  are no longer printed, since nothing was written. Nothing to change on the caller's
  side: a write that needs attention still says so.
- **`build_d365fo_project` and `run_systest_class` are no longer marked as closed-world
  tools.** Both reach the UDE environment's cloud runtime (a deployment, tests in the
  cloud), so their annotations drop `openWorldHint: false` and fall back to MCP's
  default, open-world. Clients that ask for confirmation or show a warning before
  open-world tools may now do so for these two. Every other tool keeps
  `openWorldHint: false`.
- **A broad `search` without a type filter takes about half as long.** The lookup that
  finds matches in custom models ran twice per call, once for the bridge answer and once
  for the index answer, and for a common word it is the slowest query of the call (270 to
  475 ms warm and seconds on a cold cache, against about 230 ms for the main query). When
  the index answered, the first run and its file checks were thrown away. Both lookups
  (exact name and custom models) now run once per call and feed whichever route answers.
  The file checks for the bridge answer run only when the bridge is asked. Results are
  unchanged on every route.
- **Looking up the event handlers of an object reads far fewer methods.**
  `extension_info(mode="events")`, the event handler section of
  `extension_info(mode="coc")` and the two subscriber scans in
  `extension_info(mode="points")` first selected every method in the index that has
  a `SubscribesTo` attribute (about 1,800 on a production-size index) and then read each
  one's source to look for the object name. The object name is now part of the
  full-text match, as a prefix so that longer names starting with it still match, and
  only the candidates are read. Handlers found through `classStr(…)`, `tableStr(…)` and
  `formStr(…)` are the same as before. In `mode="points"` a subscriber that has the
  object name only inside a longer identifier (`MyFooHelper` for `Foo`) is no longer
  counted, because it does not subscribe to that object. A name that starts with an
  underscore is searched the old way.
- **`validate_code(mode="references")` and the grounding gate in create and modify no
  longer stall on a label whose id or label file is not in the index.** For every
  `@File:Id` literal that did not resolve, the check asked for the full list of label
  files, which groups the whole labels table by file and model and collects the
  languages. On an index with about a million labels that took about 2 seconds per
  literal, so a class with ten such labels waited about 20 seconds. The check now asks
  only whether the file id exists: an index seek for the exact spelling, and for a
  different letter case one read of the bare id list (a few milliseconds), done at most
  once per validation. The errors and warnings reported are the same as before.
- **The symbol index is smaller and index builds write less: three indexes on `symbols`
  that no query used are gone.** Measured on a 3.3 GB index with 1.2 million symbols they
  took 284 MB, 8.6 % of the file. `idx_symbols_file_path` (223 MB) compared paths
  case-sensitively, while every lookup by path is case-insensitive and uses
  `idx_symbols_file_path_nocase`. `idx_parent_type` (49 MB) was a prefix of
  `idx_parent_type_name`. `idx_symbols_pattern_type` (12 MB) served no filter. The one
  case-sensitive path lookup, in `update_symbol_index`, is now case-insensitive like the
  rest. Nothing to do: an existing database drops the three indexes on the next start, in
  the background when it is large. The freed pages are reused by later writes, and the
  file itself only shrinks after a rebuild or a `VACUUM`.
- **`find_references` on a class is faster when it falls back to the index (no
  cross-reference database).** The fallback asks which classes implement the target with
  a `LIKE` over `implements_interfaces`, and for a target nobody implements (every
  ordinary class) that read every class row of the index: 0.6 to 0.9 s warm and several
  seconds cold on an index with 1.2 million symbols. A new partial index,
  `idx_symbols_implements`, holds only the classes that implement something, and the
  lookup now reads that instead. Results are unchanged. Nothing to do: on an existing
  database the index is built once in the background after the next start, and until it
  is there the lookup runs as before. The fallback also ran its method-body search twice
  with the same arguments and now runs it once.
- **An incremental `build_d365fo_project` build runs as a full build when a table, EDT or
  enum of the model changed since its last build.** An incremental xppc build recompiles
  only the elements whose own source changed, so after a table field moved to an EDT of
  another base type it reported 0 errors and the next full build failed in the code that
  uses the field. The build now checks the target model's tables, table extensions, EDTs,
  EDT extensions, enums and enum extensions first. A table counts as changed when its
  source is newer than its compiler-metadata copy or has none. The other types have no
  such copy and count as changed when they are newer than the newest compiler-metadata
  file of the package, which is the last time a build wrote metadata back. The result says
  `full build, switched from incremental` and why, for example "2 tables, 1 EDT changed
  since the last build: ..." with up to five names. As with the existing switch for OData
  actions, `fullBuild: false` is the same as leaving it out and does not opt out. A model
  that was never built, dependency models and builds with no such change stay as they
  were. Passing `fullBuild: true` on every build as a workaround is no longer needed.
  (#1161)
- **A new label file starts with every `LABEL_LANGUAGES` language.** A file's first
  label created all its languages, and only the supplied ones, so a first label given
  in English alone left the file English-only for good. When at least one supplied
  language is configured, a label file that has no language yet now gets every
  configured one, the untranslated ones with the English text (or the first supplied
  translation) as a placeholder, reported as a translation fallback. When none of the
  supplied languages is configured, the supplied ones are used as before.
- **A change to the custom models list applies without a server restart.** The list
  (`environment.customModels` in `d365fo-mcp.json`, or `CUSTOM_MODELS` in `.env`) was read
  once at startup, so a model added while the server ran, for example a new test model,
  stayed a Microsoft standard, read-only model until the restart. The server now re-reads
  this one setting when the file it came from has a newer modification time, checked at
  most once a second. A model added to the list is custom on the next tool call, and a
  model removed from it stops being custom, unless the server also detected it on its own
  (the workspace, the active project, a model it wrote into). A value set in the real
  environment (the shell, the `env` block of `.mcp.json`, App Settings) still wins and is
  never replaced from a file. Nothing is indexed by this: a newly listed model that is not
  in the index yet still needs `update_symbol_index(model=…)`. (#1161)

### Fixed
- **`d365fo_file(action="generate")` previews the object `create` would write, under its
  name and at its path.** Generate used `objectName` as passed and built the path as
  `<packagePath>\<model>\<model>\…`. Under a configured prefix the preview said
  `<Name>RentEquipmentJob</Name>` (and renamed the caller's `class ContosoRentEquipmentJob` back to
  match) where `prepare` and `create` named the object ContosoRentEquipmentJob, and it
  recommended the Microsoft PackagesLocalDirectory where `create` writes into the custom
  write root (`customPackagesPath`), in the package the model's descriptor names. Generate
  now names the object and resolves its file with the same code as `create`, says so when
  the name differs from the one passed, refuses a name `create` would refuse, and takes
  `packageName` / `packagePath` as `create` does.
- **`create` and `generate` find the model when `modelName` is its package's name, and warn
  before they make a new model folder.** Descriptors are matched by the model's `<Name>`, so
  `modelName: "ContosoCore"` for package ContosoCore holding model "Contoso Core" matched
  nothing and the write fell back to `<root>\ContosoCore\ContosoCore`, a new folder beside
  the model's own, without a word. A name that is the `<ModelModule>` of exactly one model
  now resolves to that model (`…\ContosoCore\Contoso Core\…`) and the reply says so and
  names the model to pass next time. A package with several models, or a name no
  descriptor knows, keeps the old fallback folder, and the reply now warns that it is a new
  model folder.
- **First-start indexing waits for its worker to finish closing the index.** The server
  terminated the indexing worker the moment it reported its result. The worker closes its
  database after it reports (the step that folds the write-ahead log into the index file
  the server then opens), so that close and the worker's last console lines could be cut
  off. The worker is now left to exit on its own and the result is handed over when it
  has. A worker that does not exit within a minute is terminated as before.
- **New tables and menu items get the OperationalDomain and SubscriberAccessLevel xppbp
  expects.** Neither writer set OperationalDomain, the bridge's property setters know
  neither property on a menu item, and a Staging or TempDB table kept Visual Studio's
  Read=Allow. Every create therefore drew BPCheckTableOperationalDomain… /
  BPCheckTableSubscriberAccessLevel… / BPCheckMenuItemOperationalDomain… /
  BPCheckMenuItemSubscriberAccessLevel… warnings. `d365fo_file(action="create")`,
  `generate_object(mode="scaffold")` for tables and the report scaffold now write the
  values the checker names in its messages: on a table Local and No Access for TempDB,
  InMemory and Staging, otherwise Company (or Shared with SaveDataPerCompany=No) and
  Read. On a menu item Local and No Access for an Action item, Shared and Read for
  Display on a form and for Output, Shared and every permission for Display on a class.
  A Display item on a form whose data sources are all Local (TempDB) tables gets Local and
  No Access, read from the form and its tables in the index.
  `properties.operationalDomain` and `properties.subscriberAccessLevel` (now also
  `"No Access"`) override them. The reply lists what was written and why.
- **A new table no longer fails the field-level best-practice rules.** After every table
  create the server now makes PrimaryIndex and alternate-key fields AllowEdit=No and
  Mandatory=Yes (BPErrorTablePrimaryKeyEditable / …NotMandatory, staging tables
  included), puts a field that is in no field group into AutoReport and fills an empty
  AutoReport (BPErrorTableFieldNotInFieldGroup, BPErrorTableMissingGroupAutoReport),
  adds the table relation a field's EDT describes, TempDB tables included, except on the
  key field the EDT itself points at (BPErrorEDTNotMigrated,
  BPUpgradeMetadataEDTRelation), and gives every relation
  OnDelete (default Restricted, or `relations[].onDelete`) plus Cardinality,
  RelatedTableCardinality and RelationshipType when missing (BPCheckMissingDeleteActions,
  BPErrorTableRelationshipPropertiesCompleteness). An explicit AllowEdit=Yes or
  Mandatory=No and fields with `ignoreEdtRelation` are left alone.
- **EDT relations point at the right field.** The scaffold took the related field from
  the EDT name and the table from `edt_metadata.reference_table`, which holds only the
  legacy ReferenceTable property. A CustAccount field got no relation at all, and an EDT
  whose key field is named differently got a wrong one. The EDT's own `<Relations>` (or
  `<TableReferences>`) is now read, so CustAccount relates to CustTable.AccountNum.
- **The smart table writers no longer add a delete action that blocks deleting the new
  table's own rows.** Both the bridge's CreateSmartTable and the XML builder wrote a
  Restricted delete action on the new table for every relation target, pointing at the
  parent table. That stopped a row from being deleted while its parent existed and drew
  "DeleteAction X has no explicit relation set" (BPUpgradeMetadataDeleteAction). The
  builder no longer writes it, the create removes the bridge's, and the relation's
  OnDelete=Restricted protects the parent instead. A delete action that names its
  relation, or comes from your own `xmlContent`, is kept.
- **On UDE, a tool call made right after the server starts no longer misses the custom
  metadata folder.** The server marked the XPP config as loaded before reading it had
  finished, so a call arriving during that read (in practice the first few seconds after
  `initialize`, while the bridge was being set up) saw no config: the custom packages path
  was empty, so e.g. `run_systest_class` reported "class not found" for a class in the
  custom model, and the environment counted as traditional instead of UDE. If the tool call
  won the race, the bridge itself was set up without the custom metadata folder for the
  whole session. Every caller now waits for the same read; an XPP config that cannot be
  read is logged and treated as missing.
- **A build, DB sync, BP check or test run no longer waits 15 minutes and fails on a lock
  whose owner died, when Windows has given that owner's process id to another process.**
  An operation lock records its owner's process id, and a lock whose owner is running is
  never taken over. When the owner died without releasing the lock (a crash, a killed
  server) and the id went to a new process, the lock looked held, and every caller waited
  the full `OPERATION_LOCK_TIMEOUT_MS` and failed with "Timeout waiting for filesystem
  lock". A lock whose owner has not refreshed it for three heartbeats (3 minutes by
  default) is now checked: if the process with that id started after the lock was taken,
  it cannot be the owner, and the lock is taken over. A restarted server that got the
  crashed one's id no longer waits on itself either. While the start time cannot be read,
  the lock is kept as before.
- **`run_systest_class` on UDE said it could not find SysTestConsole, as if a path were
  wrong.** No path can make it work: SysTestConsole only runs tests against a local AOS,
  and on UDE the AOS is hosted in the cloud, so even where it is found it stops with
  "Failed to obtain app setting ... Common.HostingEnvironment" before any test runs. On
  UDE the tool no longer looks for it and runs the tests in the cloud runtime instead
  (see *Added*). A classic VM detected as UDE can set `environment.type` to
  `traditional`; the UDE setup replies say so.
- **`build_d365fo_project` could report a build that started before your latest edits as
  this call's result.** A call that found a build of the same model running attached to
  it, without checking whether sources had changed since it started, and returned its
  "✅ Build succeeded" for code it may never have compiled. A finished build was already
  checked this way. Now such a call waits for the running build and the post-build steps
  run for it in this server process, lets the calls waiting on it collect it, and then
  builds the current sources, saying so in the result. When the check cannot finish in
  time (a large model while the compiler is reading it), the call attaches as before and
  says the result may not cover edits made after that build started.
- **A call that attached to a running build lost the post-build steps it asked for.**
  Only the call that collects the result runs `bpCheck` and `dbSync`, with its own
  options, so `dbSync: true` from a second call that attached to someone's plain build
  synced nothing; its result only noted that post-build steps ran once, for the other
  call. That call now runs the steps it asked for that the collecting call did not
  (`deploy` included). It never repeats one that already ran, and when several waiting
  calls need the same step, it runs once and they share its result. When the build was
  collected in another server process, the steps that cannot be confirmed are named, and
  a missing `dbSync` or `deploy` makes the result an error.
- **`build_d365fo_project` went silent while it ran `bpCheck` or `dbSync`.** After the
  compile the tool sent no progress notifications, so a long best-practice check or sync
  could outlast a client's request timeout (about a minute in VS Code), and the client gave
  up on a call that was still working. Now a heartbeat runs during those steps, and the
  progress value keeps increasing across all phases of the call, as MCP requires.
- **`search(scope="extensions")` returns every custom object, and `prefix` is the object
  prefix (#1212).** The scope is described as "custom/ISV models only", but it returned only
  extension-shaped rows (`*_Extension`, `Base.SuffixExtension` and their members). New custom
  classes, tables and helpers never appeared, and `type:"class"` could not bring them back.
  `prefix`, described as an object prefix (`ISV_`), was matched against the model name, so a
  model whose name does not start with its object prefix returned nothing at all. Now the
  scope returns every symbol in a custom model, and `type:"class-extension"` (or another
  `*-extension` type) narrows it to extensions. `prefix` matches the object name or, for a
  member, the object it belongs to, and anywhere in an extension-shaped name. A model name
  that starts with `prefix` still matches, so existing calls keep working. Results put an
  exact name first, then extension-shaped rows (the old result set), then names that start
  with the query. `model IN (custom models)` stays the leading predicate, so the
  `idx_symbols_model` seek is unchanged. Result captions say "custom models" instead of
  "custom extensions".
- **Menu checks on a write-only companion: the other extensions of the base menu.** The
  parent check of `add-menu-item-to-menu` and `add-submenu` on a `menu-extension`, and the
  element-name checks of both (a submenu name already in use is refused, a repeated item
  is named `<item>N`), read the other extensions of the base menu from the index only. A
  write-only companion has no index, so a parent another extension adds was refused
  there, and a name one of them uses was written and failed the next build ("The name '…'
  is not unique"). Without index rows they are now read from the package folders
  (`<root>/<Package>/<Model>/AxMenuExtension/<BaseMenu>.*.xml`); backup copies a modify
  leaves next to a file (`….xml.backup-…`) are not read. The scan is the one that finds a
  standard base menu (`findAotFilesInAllPackages`), now shared and taking the
  package/model folder list once per process, and matching file names in any casing.
- **`get_object_info` for a form no longer prints an empty code block per method** when the
  index holds method names but no source (a compiled form).
- **The cross-model guard no longer advises an extension that cannot compile.** A write
  into the workspace's test model (or any model built on the workspace model) was refused
  with "Extend it from <workspace model> instead: create class-extension …". The test
  model references the workspace model, never the reverse, so the workspace model cannot
  see the class, and that extension would not compile. Agents followed the advice, failed,
  and fell back to creating tests in the main model and moving them by hand. The guard now
  reads both descriptors when it refuses: for a model whose `<ModuleReferences>` lists the
  workspace model, it says an extension is impossible and why, names the model as the
  workspace's test model when the workspace model lists it in `<InternalsVisibleTo>`, and
  drops the "half-finished pieces are evidence of a mistake" line, which does not hold
  there. It still refuses: the only route remains the user's
  `D365FO_CROSS_MODEL_WRITE_MODELS`. For a shared model the workspace builds on, the
  original case, nothing changes, and with no descriptor found the wording is as before.
- **`labels(action="create")` writes only the languages the label file has.** Every
  folder under the model's shared `LabelResources` was treated as a language of the
  target file, so a sibling label file's `ja` added a `.ja.label.txt` and a
  descriptor to a file that never had Japanese. Supplied translations and an explicit
  `languages` scope still add a language.
- **X++ source round-trips exactly through `add-method`, `replace-code` and `create`.**
  Every XML entity in the source was decoded, so a doc comment's `P&amp;L` became a
  bare `&` (malformed XML documentation, BPXmlDocMalformed) and markup in string
  literals changed. The decode now runs only on a payload that arrived
  entity-encoded as a whole (no literal angle bracket, and an entity outside any
  string literal).
- **`modify-property` on a form's Design replaces the property in a CRLF file.** The
  "already there" match expected `\n`, so on a saved (CRLF) form a second `<Pattern>`,
  `<PatternVersion>` or `<Style>` was added beside the old one, and the deserializer kept
  the old one. An empty value now removes a Design property instead of writing an empty
  element, and the post-write check finds a value whose element carries `xmlns=""` and
  makes no value check for a removal (both were reported as "NOT in the file").
- **Form pattern validation now follows the platform's own pattern definitions.**
  `object_patterns(domain="form", action="validate")` and the `FORM_PATTERN_ENFORCE`
  gate on `d365fo_file` create checked forms against a catalog curated from the
  Microsoft Learn pages, and where it disagreed with the compiler it blocked forms
  that compile and passed forms that do not: it knew `TaskSingle` (the platform
  pattern is `Task`), wanted `FillText` 1.0 with a String (the platform has only
  "UX7 1.0", which takes a StaticText or a String), thought `ToolbarList` 1.1 was
  newest (1.2 is), took a Group for the TaskParentChild child part (it is a Tab
  after a splitter group) and never checked the property values the compiler
  requires (a CustomFilters group needs ViewEditMode Edit, a FillText child
  HeightMode SizeToAvailable). The validator now reads every FormPatterns and
  SubPatterns definition embedded in `Microsoft.Dynamics.AX.Metadata.Patterns.dll`,
  generated into `src/knowledge/formPatterns/platform.generated.ts` together with
  the metamodel default of every property they name, and interprets them the way
  the platform's `PatternAnalyzer` does: exact name and version, parts with their
  counts and order, OneOf alternatives, allowed sub-patterns per part, extension
  controls identified by their extension name, and property values checked at
  their default when the XML omits them. New rule **FP011** (error) reports a
  required property value that is not met. FP009 (curated property hints) is
  retired. Measured on the shipped forms: the platform's `PatternAnalyzer` accepts
  all 26,810 patterned nodes of the 9,502 shipped forms, and the validator raises
  zero errors on them.
- **Generators no longer emit pattern names and versions the compiler rejects.**
  The curated catalog now uses the platform names (`Task`, `LookupGridOnly` for the
  basic lookup, `SectionTiles`, `SectionRelatedLinks` and the other workspace
  sections it had as `Workspace_Tiles` and similar) and the platform's version
  lists, and drops `SidePanel` and `Workspace_SummaryNumbers_UnboundFields`, which
  are not patterns. The Dialog template sets ColumnsMode Fill on its
  FieldsFieldGroups pages and writes their Caption where the deserializer reads it,
  the Workspace template adds the required related-links section, the DetailsMaster
  template always emits the required header title control, and the pattern
  expander writes control elements in canonical order and the Design Style the
  platform requires.
- **The pattern expander builds from the platform definition, so every long-tail
  pattern gets a deterministic scaffold.** `generate_smart_form` expands patterns
  without a hand-written template through `expandPatternToXml`, which walked the
  curated catalog structure and built forms the platform rejects for 22 patterns
  (the Dialog, DropDialog, Lookup, FormPart, SimpleDetails and workspace variants,
  `Wizard`, `AdvancedSelection`), so those fell back to a template or clone. It now
  reads the platform definition of the declared pattern version: one control per
  required part in definition order (a OneOf only when none of its alternatives is
  optional), every Equals property rule the metamodel default does not already
  meet, a caption for a Caption or Text that must not be empty, a grid's
  DefaultAction pointed at the sibling default-action button, and for a
  sub-pattern part the first named sub-pattern (FieldsFieldGroups when listed),
  declared and expanded in turn. A `$Button` part whose rule sets Command becomes a
  CommandButton, a QuickFilter targets the emitted grid. All catalog patterns the
  platform defines now expand validator-clean, and the expander test's gap list is
  empty. The datasource, grid-field and caption behaviour is unchanged.
  `npm run oracle:form-expansions` (Windows) runs every expansion through the
  platform's own PatternAnalyzer, with a negative control that must fail: all 27
  are accepted. It found what the validator cannot see, now fixed: a plain
  extension control's WidthMode written after its FormControlExtension (the
  deserializer drops it), duplicate column names when a pattern has two grids, a
  QuickFilter aimed at the first grid of the form instead of its own, and an empty
  `<Controls />` on buttons and fields, which shipped forms never write.
- **Large bridge replies are read in linear time and keep their non-ASCII characters.**
  The client appended every stdout chunk to one string and searched it for the newline
  from the start, so the work grew with the square of the reply size (measured on the
  same loop: 208 ms for a 5 MB single-line reply and 2.7 s for 20 MB, against 22 and
  122 ms when only the new chunk is searched). It also decoded each chunk on its own, so
  a multi-byte character that fell on a chunk boundary became U+FFFD, which corrupted
  labels, comments and source text with non-ASCII characters in large replies. Stdout is
  now decoded as one stream and only the newly arrived text is searched. Nothing to
  change on your side.
- **Scanning the workspace no longer blocks the server for a second or more on a large
  repo.** For every `.xml` file the scan resolved the real path of the file and of the
  workspace root again, synchronously, and then read the file times one file at a time.
  On a workspace of about 2,400 files that was over a second with the server unable to
  answer anything else, and it repeated often because the scan result is kept for 15
  seconds and every write drops it. `get_workspace_info`, the context snapshot and every
  read that includes the workspace paid it. The root is now resolved once per scan, file
  times are read 16 at a time, and a real path is resolved only for an entry that is a
  link or sits below a linked directory. The same change makes the link check effective:
  a file link inside the workspace whose target is outside the workspace root was meant
  to be skipped but was listed, because the check also accepted the path as written. It
  is now skipped with a warning. Links that stay inside the root, and a workspace root
  that is itself a link or junction, work as before. Nothing to configure.
- **`analyze_code(mode="completeness")` no longer suggests methods from unrelated classes,
  and no longer scans every method in the index, for a class with no known pattern.**
  When a class had no pattern type in the index and its name did not end in Helper,
  Service or Controller, the pattern stayed `Unknown` and the tool looked for classes
  whose name ends in "Unknown". That read about a million method rows on a
  production-size index, and what it found were classes that only happen to be named
  that way, so their methods were offered as "missing". Such a class now gets no
  suggestions and no query runs. The report says that the class has no known pattern
  and nothing was compared, where it used to say the class "appears complete". Classes
  with a known pattern get the same suggestions as before.
- **Generated ListPage and Workspace forms write AllowCreate, AllowDelete, AllowEdit on
  their data source in the platform's element order.** The templates wrote AllowCreate,
  AllowEdit, AllowDelete. The order inside a form data source, measured on Microsoft
  standard forms (13,234 data sources, no pair of elements in both orders), is
  AllowCreate, AllowDelete, AllowEdit, and the platform drops an element it reads out of
  order, so the read-only data source of a generated form could lose AllowDelete=No. The
  same order is fixed in the smart XML builder. Forms generated earlier keep the old
  order: swap the two lines in the form XML, or recreate the form.
- **`d365fo-mcp index` no longer replaces a working index with an empty one when the pinned
  XPP config file is gone.** Visual Studio keeps the old XPP config after a UDE update, but a
  cleanup that deletes it, or a removed environment, leaves `environment.xppConfigName`
  naming a file that no longer exists. `start` and `doctor` warned about that pin, but `index`
  (and `rebuild-instance.ps1`, which runs it) did not check it. The extraction then found no
  UDE config and read the packages folder found by scanning the drives, which on many UDE
  machines is an empty leftover `C:\AosService\PackagesLocalDirectory`. It extracted no
  models, exited 0, and the full rebuild cleared the database. Now `index` refuses such a
  target before extracting, keeps the existing index, and names the fix
  (`d365fo-mcp instance upgrade <name>`). `extract-metadata` itself also stops with an error
  when the pinned name matches none of the XPP configs on the machine, instead of falling back
  to the drive scan. This covers direct `npm run extract-metadata` runs and a pin that differs
  from the file name only in case. A machine with no XPP configs falls back as before.
- **`build_d365fo_project` syncs a table a later call names when the build was started with
  `dbSync: true`.** `dbSync: true` syncs the project's tables (a full sync only without a
  project), but it was taken to cover any table list: a call that collected or waited on
  that build with `dbSync: ["SomeTable"]`, for a table outside the project, got the result
  with its sync section and the table was never synced. The table is now synced by that
  call, and its result shows the sync. A full sync still covers every list, and a repeat of
  `dbSync: true` still collects without syncing again. The sync tool now reports what it
  synced to the build tool.
- **A bulk label update now says "updated", and the schema names update for `labels[]`.**
  `labels(action="update", labels=[…])` already worked, because update runs the create code
  with overwrite on. The reply header was hard-coded, so a bulk update answered
  `labels(action="create", labels=[…]): N created`, and the schema tagged `labels[]` as
  `[create]` only, so an agent had no reason to try it and fixed labels one call at a time.
  The header now names the action that ran and counts what each entry reports:
  `N updated, N failed (of N)` for update, `N created, N failed (of N)` for create. An entry
  that was left alone is counted apart as `unchanged` (update with no translation that
  applies, or create of a label that already exists) or `reused` (create with
  createIfMissing). Before, each of these was counted as created. Those two counts appear
  only when they are not zero. An update that has to create a missing label still counts as
  updated. The `labels[]` schema tag is now `[create|update]`, and the labels op-spec says
  the same. Nothing to do. (#1161)
- **`build_d365fo_project` fails a build whose forms break their pattern, as a pipeline build
  does.** A pipeline build (MSBuild and Microsoft's BuildTask) compiles the whole package and
  rejected a form whose `FieldsFieldGroups` header had no `ColumnsMode` `Fill`, while an
  incremental build here had passed it with 0 errors: xppc does not report pattern errors for
  forms it does not recompile. After a successful xppc build the tool now validates every form
  of the package against the platform's pattern definitions (the rules of
  `object_patterns(domain="form", action="validate")`). Errors give
  `❌ Compiled; form pattern errors a pipeline build rejects` and list each form, control and
  property. `FORM_PATTERN_ENFORCE=false` keeps them as a warning.
- **`labels(action="create")` adds a language to a label file only when `LABEL_LANGUAGES`
  lists it.** Any supplied translation still added its language, so a caller that
  translated into every language it had seen in the model (another label file's `lt`,
  `nb-NO`) gave the target file new `.label.txt` files and descriptors anyway. Without
  `languages`, a translation for a language the file lacks is now written only when
  `LABEL_LANGUAGES` lists it, and otherwise skipped with a `Not written:` warning. The
  match is exact apart from case: `fi` and `fi-FI` are different languages, so use the
  codes of your locale folders. Languages the file already has are always written, an
  explicit `languages=[…]` still adds any language, and with `LABEL_LANGUAGES` unset or
  `all` nothing changes. The warning is also given when every other language already
  had the label. The tool description, the op-spec and the `index.labelLanguages`
  description in `docs/CONFIGURATION.md` now say so. The indexer and create
  read the setting through one parser, so the indexer also accepts `en_US` for `en-US`,
  and a value with no usable code (`" , "`) indexes no language instead of every one.
- **`labels(action="create")` no longer replaces a label file it cannot read.** A
  `.label.txt` that existed but could not be read (locked, no permission) was treated as
  empty and rewritten with only the new label, losing every other label in that
  language. The call now fails with the read error and writes nothing to that file.
- **`labels(action="create", createLabelFileIfMissing=false)` refuses a new label file
  even when the model has other label files.** The guard only fired for a model with
  no label folder at all, so a mistyped `labelFileId` in a model with other label files
  quietly became a new label file.
- **`d365fo_file(action="undo")` can remove label files that `labels(action="create")`
  created, with their project entries.** The labels tool never recorded the descriptors
  and `.label.txt` files it wrote, so undo refused to delete them ("this session did not
  create it"). They are now recorded, and undo also removes the `.rnrproj` entry of the
  file it deletes when the create added that entry, retrying while Visual Studio holds
  the project. Once a later call adds a label to such a file, undo refuses it, because
  deleting the file would also delete the labels added since.
- **`labels(action="info", labelFileId=…)` no longer lists a language whose label file is
  gone, and drops its stale index rows.** The index keeps a deleted language's rows
  until the next build, and info reported it as a language of the file, which invited a
  create that recreated it. Such languages now show as `Stale index`, each missing path
  as `(missing on disk)`, and their rows are removed from the label index, so search
  stops returning them too. Rows are removed only while another file of the same label
  file is on disk: when none is (an index built on another machine, a drive that is not
  mounted), info says so and changes nothing. Without `model`, each model's file is
  judged by its own paths.
- **`d365fo_file(action="modify", operation="remove-field")` no longer leaves the table's
  field groups naming the removed field.** The bridge removes the field from `<Fields>`
  and nothing else, so every `<AxTableFieldGroupField>` that listed it stayed in the file
  and the next build failed on a field group that references an unknown field. After a
  successful removal the server now takes the field out of the field groups of the same
  file: the `<FieldGroups>` of a table, and on a table extension both its own
  `<FieldGroups>` and its `<FieldGroupExtensions>`. Names match in any letter case and
  the reply lists the groups. Indexes, full-text indexes, relations, mappings,
  `TitleField1` / `TitleField2` and field properties that still name the field are not
  changed, because removing them changes what the table does. The reply lists each one
  in a warning with the operation that fixes it (for an index it also says when it is the
  table's `PrimaryIndex`, `ClusteredIndex` or `ReplacementKey`). Nothing to do for
  callers. A field that was in no group gets the same reply as before.
- **`d365fo_file(action="modify", operation="modify-property")` with `ReferenceField` gives
  an existing EDT its table reference.** The property was listed for EDTs but refused with
  "Unknown AxEdt property 'ReferenceField'", because the related field is not a scalar
  property. It is a child of `<TableReferences>`, which no property setter writes. So an
  EDT could not be pointed at a table and field without hand-written XML. The value is now
  written on the XML as the EDT's single `<AxEdtTableReference>` (`<RelatedField>` and
  `<Table>`). Pass `propertyValue="AccountNum"` when the EDT already has a ReferenceTable,
  or `propertyValue="CustTable.AccountNum"` to set `<ReferenceTable>` and the reference in
  one call. An existing reference is updated in place. When the EDT also carries one
  legacy `<Relations>` entry (`AxEdtRelation`), as many shipped EDTs do, that entry gets
  the same table and field and the reply says so. A bare field on an EDT with no
  reference table is refused with a message that asks for the table. An EDT with more
  than one legacy relation or more than one table reference is refused too. EDT
  extensions are not covered (#1161).
- **`modify-property` sets a menu item or menu property the file does not have yet.** The
  bridge has a case for only a few menu item properties and none for a menu, and the XML
  fallback could only replace an element that was already in the file. So
  `d365fo_file(action="modify", operation="modify-property")` with `Parameters`,
  `EnumParameter`, `EnumTypeParameter`, `ImageLocation`, `NeedsRecord` and others failed
  with "Unknown AxMenuItem property" on every `menu-item-display`, `menu-item-action` and
  `menu-item-output` that did not carry the element, and `SetCompany`, `FeatureClass` or
  `ConfigurationKey` failed the same way on a `menu`. After the bridge declines, the
  property is now written on the XML: an existing top-level element is replaced, a
  missing one is inserted where the serialiser puts it (alphabetically after `Name`, and
  ahead of `Elements` on a menu). The name is matched in any case and written in its
  real casing. An empty value removes the element, because the default is expressed by
  absence. A name that is not a property of the object is refused with the list of known
  ones, and nothing is written. The known names are the metamodel's writable scalar
  properties of `AxMenuItem` and `AxMenu` (so `ExtendedDataSecurity` on a menu item and
  `NormalImage`, `IsObsolete` or `MenuItemName` on a menu, which standard objects carry,
  are accepted), and the order was checked against the Microsoft standard menu items and
  menus. `MenuItemName` on a menu sets the menu's own element, never the one of a menu
  item below it. `ObjectType` and `OpenMode` stay with the bridge, which checks their
  values. Menu item and menu extensions are not covered (#1161).
- **`add-control` on a form extension no longer writes a String control for a type it
  does not know.** An unknown `controlType` fell back to `AxFormStringControl` and reported
  success, so a requested reference group became a text box bound to nothing. A type the
  caller names that the writer cannot produce is now refused, with the supported list, and
  nothing is written. A type picked from the field's EDT still falls back to String.
- **Writes and lookups for a model whose package has another name no longer take half a
  minute each.** When the package folder is not named after the model (a package holding
  several models, a model in a package of another name, or a mistyped model name), the
  server reads every package to build a model-to-package map. That map was thrown away
  after each use, so every create, modify, label write and project check built it again.
  The build also opened every subfolder of every package, although the comment called
  that the fallback for a package without descriptors. On a machine with 178 packages
  one build took over 30 seconds, under 2 of them for reading the descriptors. The map
  is now built once per set of package roots and shared, and subfolders are opened only
  in a package whose descriptors name no model. A model the map does not know triggers
  one rebuild when the map is older than 5 seconds, so a model created in Visual Studio
  is found without a restart and a mistyped name cannot cause a rebuild on every call.
  Changing a model descriptor through the server drops the map. One behaviour change: a
  folder with AOT content that no descriptor of its package declares is no longer
  treated as a model when that package has descriptors. Nothing to configure.

### Security
- **A menu item or menu file that starts with a long run of XML comments can no longer
  hang `modify-property`.** The pattern that skips leading comments to find the root
  element matched a comment body lazily inside a repeated group, so input such as
  `<!--` followed by many `--><!--` backtracked exponentially: 28 repetitions took about
  48 seconds and blocked the server. The comment body is now matched with no ambiguity
  and the same input returns at once. Real menu files are unaffected (CodeQL js/redos).

### Dependencies
- **New:** `@azure/msal-node` 7.1.1, for the Dataverse sign-in above. Pure JavaScript, no
  native add-ons; with `@azure/msal-common` and `jsonwebtoken` (and their `jws`, `semver`
  and `lodash.*` helpers) it adds 16 packages to the lockfile and changes none.
- **Lockfile refreshed with `npm update`.** Runtime: `@azure/msal-node` 7.2.1,
  `@clack/prompts` 1.9.0, `@modelcontextprotocol/sdk` 1.32.2, `commander` 15.1.0, `dotenv`
  18.0.10, `express` 5.3.0, `express-rate-limit` 8.7.4, `zod` 4.6.7. Dev: `@biomejs/biome`
  2.6.6, `@types/node` 26.6.6, `vitest` and `@vitest/coverage-v8` 5.1.0. The ranges in
  `package.json` are unchanged.

## [1.23.0] — 2026-11-05

### Added
- **`reserved-words` knowledge topic.** `get_knowledge(topic="reserved keywords")`
  answered with the `switch` topic. The new topic lists the compiler's own keyword
  set (`XPP_KEYWORDS`, read when the module loads, so a recapture updates it),
  grouped by kind, with the `in` exemption, the `@` escape, the positions the
  compiler rejects and where the language reference differs from the compiler.
- **Exact label lookup: `labels(action="search", exact=true)`.** The search matches
  words in the label id, text and comment, ranked by relevance, so "the label whose text
  is exactly X" came back as dozens of candidates to compare by hand; and from the third
  search call every answer opened with a STOP notice, which ended a legitimate workflow
  that checks one text per label and language before creating it. With `exact=true` the
  answer is the labels whose text equals the given text after normalising both sides
  (Unicode NFC, trimmed, inner whitespace collapsed, case-insensitive including non-ASCII
  such as umlauts), across every label file and model of that language (`model` /
  `labelFileId` narrow it). Text from `query` (string or array, in `language`) and/or
  `texts=[{language, text}, …]` (max 12). Each match is listed as
  `@File:Id  [model]  <language>: "<text>"` with the label's other indexed translations,
  in a fixed order: custom models first (`CUSTOM_MODELS`, `EXTENSION_PREFIX`,
  `D365FO_MODEL_NAME`), then label file id, then label id. `maxMatches` (1..50, default
  20) sets how many are listed; the cut comes after sorting, so a custom copy is never the
  one left out ("Buchungen" alone is 45 standard labels). With more than one match, a
  distribution line says where all of them are
  (`46 exact matches: ApplicationPlatform: SYS 27, RET 17, GLS 1`). A miss is `no exact match for "<text>" (<language>)`, with "language X is not indexed"
  when it has no rows. The lookup is deterministic, so it is not counted toward the
  search-call budget, records no search history and never carries the STOP notice or the
  "create your own label" advice. `exact`, `texts` and `maxMatches` are accepted flat or in `params` and
  documented in the op-spec (`get_knowledge(kind="op-spec", topic="labels")`); the
  published schema is unchanged. Normal searches are byte-for-byte unchanged.
- **`update_symbol_index(model="X")` re-indexes what changed in one custom model,
  without naming the files.** After a git pull, a branch switch or a Visual Studio
  session the agent does not know which files moved, so it listed them one by one or
  worked on a stale index until the next full build. The model form walks the model's
  folder and re-indexes every file whose mtime differs from the one recorded when it was
  last indexed, adds new files, and removes the rows of files deleted from disk, with
  one bridge refresh for the lot. Changes are judged per file (new table
  `indexed_files`, filled by every incremental index of a file), not against
  `last_indexed_at`, which every write bumps and which therefore hides a file changed
  before an unrelated write. A model's first pass reads all its files once (1,474 files
  in about 16 s on a real ISV model), later passes about 1.5 s when nothing changed.
  Standard models are refused (build-database owns them), and so is `filePath` together
  with `model`. The stale-index warning in `get_workspace_info` now suggests this call
  instead of the single newest file. The tool's description was tightened so the schema
  stays inside its budget.
- **Every object type can be read from the database alone, and data entities show their
  entity properties.** Builds on the stored form XML from 1.22.0 (#1178): the index now
  stores every object's original XML (gzipped, table `object_source`, keyed by object type,
  name and model), so on a host with no AOT files and no bridge, such as the Azure
  read-only instance, `options={include:"xml"}` returns the XML of any stored object
  (including `data-entity`, and `class-extension` through its AxClass), and views, data
  entities, maps, queries and reports render from the stored copy, labelled as such.
  `findBaseObjectXml` (clone and extension scaffolding) reads it too. A file on the host
  always wins over the stored copy. When the XML is read (no bridge, no older extracted
  JSON), the data-entity reader now shows public entity and collection name, OData
  (`IsPublic`), DMF, category, the data source tree, each field's data source and label
  text. Single-file `update_symbol_index` keeps the copy in step. Extensions are not
  stored. Extracted JSON for every non-extension type now carries `raw` and grows
  accordingly (sizes in SETUP_AZURE.md); stored copies appear after a re-extract and
  re-index.
- **Extension name formats.** The naming styles place one token at a fixed spot, so a
  convention that fixes the whole name could not be expressed: `{0}.CTSO` for every
  element extension, and a CoC-class token chosen by the type of the object extended
  (`CTSO_{0}Cls_Extension`, `CTSO_{0}Dbt_Extension` for tables, `CTSO_{0}Frm_Extension`
  for forms). New settings `EXTENSION_ELEMENT_NAME_FORMAT`, `EXTENSION_CLASS_NAME_FORMAT`,
  `EXTENSION_CLASS_NAME_FORMAT_TABLE`, `EXTENSION_CLASS_NAME_FORMAT_FORM` (`{0}` = the
  extended object, `_Extension` always appended to class formats) and
  `EXTENSION_NAME_FORMAT_UNDEFINED` (`ask` | `class-format`). Create, the modify lookup,
  `prepare`, `generate_object`, the cross-model suggestion and `validate_object_naming`
  apply them. The extended object's type comes from the call (`[ExtensionOf(<kind>Str(…))]`,
  `properties.baseObjectType`, `validate_object_naming(baseObjectType)`), never from
  its name or the index, so the write-only companion and the shared server produce the
  same name. Cases no format defines (form data sources/controls, views, entities, maps …,
  or no type given) are answered with "ask the user for the name and call again with an
  explicit name" by default. Empty (the default) = names exactly as before.
- **Cross-references from a SQLite export of DYNAMICSXREFDB (`D365FO_XREF_SQLITE_PATH`).**
  A server without the C# bridge (a shared read-only server on Linux) answered
  `find_references` with a name-based scan of X++ method bodies: no metadata references
  (table fields using an EDT, form data sources, relations), no type scoping, and "inconclusive"
  for EDTs, forms, queries, views and reports. With `D365FO_XREF_SQLITE_PATH` naming a SQLite
  copy of the cross-reference database (tables `Modules`, `Names`, `References` with the
  source ids, a `NOCASE` index on `Names.Path`, indexes on `References.TargetId`/`SourceId`,
  and `meta.schema = '1'`), `find_references` and the CoC-extension, event-handler and
  API-usage lookups answer from that file with the bridge's queries and result shapes. The
  bridge still comes first when it has the database. Every query is bounded: 500 rows per
  target shape as the bridge, totals counted up to 20,000 (shown as `20000+`), event and
  caller scans up to 20,000 references, with "more available" in the answer. A file whose
  export left out the references without a source name (about a third of a full xref, from
  test code; no tool can show them) and says so in `meta.refs_without_source_removed` has its
  totals read from the `TargetId` index instead: exact up to 500,000, so for any real target,
  and without a `Names` lookup per reference. The file is
  opened read-only and immutable on first use (no lock, journal or WAL files; no extension
  loading), revalidated when it is replaced, and refused with a logged reason when it is
  missing, has no `meta` table, another schema or kind, or lacks the indexes; the server then
  falls back exactly as before, and `find_references` says why the file was refused (without
  its path, which only the log and `doctor` show) and that the server's operator can fix it. A
  query on the file that fails is reported as that, with the server log as the place to look.
  The `_Source:` line names the file and its export date; `get_workspace_info` and `doctor`
  show it too. `npm run xref:bench -- <file>` measures it.
- **`find_references` in write-only mode: the hybrid companion answers from
  `DYNAMICSXREFDB`.** In the hybrid deployment the shared read-only server has the
  symbol index but no C# bridge, so its `find_references` can only search X++ code by
  name; the local write-only companion has the bridge and the developer's
  cross-reference database, but did not publish the tool. It now does (it joins
  `ALWAYS_TOOLS`). There it answers from the bridge only: a typed name is scoped to
  its container, an untyped name or `Owner.member` goes to the bridge, which expands
  it across containers itself, and labels and AOT paths are passed as given. Where
  full mode would run the name-based scan, the companion has nothing to scan (its
  index is an empty stub), so it says so and points to the shared server's
  `find_references` instead: a bare method name without its owner, no rows for a bare
  name, no bridge, no cross-reference database, or a failed query. A zero for
  `Owner.method` is reported as "0 on the owner itself", with the headline saying that
  methods added by `[ExtensionOf]` classes were not searched (the xref DB records them
  under the extension class, and only the index knows those classes) and naming the
  explicit path. Full and read-only modes are unchanged. Clients that see both
  servers' `find_references` can hide one in their tool picker.
- **`add-menu-item-to-menu` on a `menu-extension`, with `parentMenuElement`.** The
  cross-model write guard sends an agent that wants an item in a standard menu to a
  menu extension, and create wrote one, but every modify on it was refused with
  "not supported by the bridge", so the extension could not be filled. The op now
  writes an `<AxMenuExtensionElement>` with `<Parent>` and a
  `<MenuElement i:type="AxMenuElementMenuItem">`, in the shape of the shipped
  extensions (Display without `MenuItemType`), appended to the root `<Elements>`.
  `parentMenuElement` names the submenu of the base menu, nested ones by their plain name;
  omitted, the item goes on the top level. A submenu the extension adds itself takes the
  item inside its own `<Elements>`, as shipped extensions do. A submenu that is neither in
  the base menu nor added by this or another indexed extension of it is refused with the
  list of those that are. The index holds no menus, so the base menu is read from disk,
  from whichever model of the package roots has it (`OrganizationAdministration` is in
  ApplicationSuite\Foundation); when it cannot be read, the item is written with a
  warning. The same item under the same parent again is a skip.
  XML only, no bridge change; `menu` is unchanged, except that the AxMenu fallback now
  escapes the item name.
- **`add-submenu`, and items into a submenu of your own menu.** No operation wrote a
  submenu, and the `menu-navigation` knowledge topic told agents to hand-write one with a
  `<SubMenu>` field that no shipped file has. `add-submenu` (`submenuName`,
  `submenuLabel`, `parentMenuElement`) writes an inline `AxMenuElementSubMenu` with an
  empty `<Elements />`: on a `menu-extension` as a root entry with `<Parent>`, or nested in
  a submenu the extension adds; on a `menu` (a menu of your own model) in the root or in a
  submenu of that menu. A name already used anywhere in the menu, by a submenu or by a
  menu item, is refused (element names are unique in a menu, and a duplicate fails the
  build); the same submenu under the same parent again is a skip.
  `add-menu-item-to-menu` takes `parentMenuElement` on a `menu` too, through the XML
  writer, since the C# op has no parent. That writer also no longer inserts before the
  first `</Elements>` in the file, which in a menu whose first element is a submenu put the
  item inside that submenu, and it skips an item already in the target collection. An
  item placed where another element of the menu already has its name (the same item in a
  second submenu, or an item the base menu of an extension already holds) was written
  with that name and failed the build; it is now named `<item>1`, `<item>2`, … with
  `MenuItemName` unchanged, as shipped menus do, and the reply says so. On a
  `menu-extension` this reads the base menu and its other extensions for a top-level item
  too. The knowledge topic now shows the inline shape, `AxMenuElementMenuReference` for menu
  objects, and the two operations instead of hand-written XML.

### Changed
- **`object_source` replaces `form_source`; rebuild the database after upgrading.** This
  version neither writes nor reads `form_source` (added in 1.22.0). Until a database is
  rebuilt from a fresh extract, forms on a host without AOT files have no stored copy, as
  before 1.22.0. On Azure, run the data pipelines before the App Service restarts on the
  new version (order in SETUP_AZURE.md). An old `form_source` table is left in place and
  ignored.

### Fixed
- **`search` put an extension's base object in front of its name.** The exact-match line
  prefixes the owner to tell same-named members apart, and an extension's index row
  carries its base object as owner, so a menu extension read
  `OrganizationAdministration.OrganizationAdministration.ContosoExtension` and a class
  extension `SalesTable.SalesTableContoso_Extension`, as if it were a member of
  `SalesTable`. The workspace-aware listing (`includeWorkspace` with `workspacePath`)
  had the same prefix. Extensions are now named alone, with their type, in both;
  members keep the owner.
- **KW001 missed the later names of a declaration list and sized-string
  parameters.** `int a, count;` and `void f(str 20 select)` passed, although a probe
  class showed xppc rejecting both ("'identifier' expected", "invalid name for a
  parameter"). A reserved word as a `for`, `using` or `catch` variable was already
  caught, but the fix called it a parameter; it now says loop variable / variable.
- **`extension_info(mode="coc", method=…)` counted classes that wrap nothing as wrappers.**
  "Found 12 extension class(es) wrapping "validateWrite"" listed 12 classes for `SalesTable`
  where 2 wrap it: the filter also kept every class with an empty wrap list, a leftover from
  when the list held every base method a class called. The bridge sends a list for every
  class, so empty means "wraps nothing". The count now covers only the classes whose list
  names the method (case-insensitive). The other extension classes still follow, grouped by
  extended element as before, under "Other extension classes of <object> (no wrap of "<m>"
  recorded): N". A class with no list at all (an older bridge) goes under "wraps unknown"
  and is not counted. The filesystem fallback of the index path had the same clause and
  gets the same split. Without a method filter the output is unchanged; the index path's
  database rows still include classes with an empty list, because there it can mean unknown.
- **Label file descriptors and the `.rnrproj` were written with LF line endings.** Visual
  Studio writes both with CRLF. `labels(action="create")` wrote the `AxLabelFile\<Id>_<lang>.xml`
  descriptor of a newly added language with LF (and a trailing newline VS doesn't write), so the
  first save in VS showed every line as changed. Every `.rnrproj` update (adding an object,
  removing one, adding label files) rebuilt the whole project file with LF.

## [1.22.0] — 2026-10-30

### Added
- **Forms can be read from the database alone, and `find_references` lists the forms that
  use a table.** The index stores each form's original XML (gzipped, table `form_source`,
  about +37 MB for a full standard install), so on a host with no AOT files and no bridge,
  such as the Azure read-only instance, `get_object_info` renders a form from the stored
  copy and `options={include:"xml"}` returns its whole XML, paged. A stored copy is
  labelled with the time it was written and is never used for a form this machine knows
  was deleted. For a table target, the `find_references` fallback lists the forms that bind
  it as a datasource (base forms only; form extensions, views, maps and code inside forms
  are not covered). Form JSON now carries the XML as `raw` and roughly triples in size;
  stored copies appear after a re-extract and re-index (pipeline order in SETUP_AZURE.md).
- **`d365fo_file(action="modify", operations[], atomic: true)` restores the file when an
  operation fails.** A batch stops at the first failure and keeps what applied before it
  ("4/13 operation(s) applied, failed at #5"), leaving the object half-changed. With
  `atomic: true` it writes back each changed file's bytes from before the call,
  refreshes the provider and the index, and reports "0/N operation(s) applied (K rolled
  back)". The default is unchanged, and its failure text now mentions the option.
  An extension the batch had to create first, because an operation named one that did
  not exist, is not removed: it is left as created, empty and in the project, and the
  reply says so and names the delete that removes it.
  `atomic` is a top-level batch option, not published in the schema (which sits at its
  token budget), and it is not passed on to the operations.
- **`naming.prefixSource=as-given`: the server renames nothing** (#1134). `none` dropped
  the prefix but still rewrote every extension's token to the model name, so a team whose
  token is an abbreviation (`VendTable.ABC` in model `ContosoCore`) got `VendTable.ContosoCore`
  and `VendTableTable_ABC_ContosoCore_Extension`. With `as-given` (env
  `EXTENSION_PREFIX_SOURCE=as-given`) every name is written as passed: objects, members,
  extension elements and classes, with no prefix, suffix or token, and nothing inferred
  from the model. A name that cannot be an AOT name is refused with the reason instead of
  completed (an element extension without `<Base>.<Token>`, a class extension not ending
  in `_Extension`, invalid characters, more than 81 characters). `validate_object_naming`
  and `prepare` check only that structure. The prompt's CoC naming rule,
  `get_workspace_info`, `doctor` and the cross-model refusal point to the project's
  instruction file. `generate_object` says its derived class names carry no token. See
  [Names exactly as given](docs/CUSTOM_EXTENSIONS.md#names-exactly-as-given).

### Fixed
- **Kernel EDTs were refused as "does not exist"** (#1179). `RecId`, `UserId`,
  `DataAreaId`, `ValidFromDateTime`, `TimeOfDay` and the other EDTs the X++ runtime
  defines have no `AxEdt` file, so the bridge's field guard refused `add-field` with
  "extended data type 'UserId' does not exist — nothing was written",
  `generate_object(scaffold)` refused to write such a table, `validate_code(references)`
  reported `<ExtendedDataType>UserId` as an error, and `get_object_info` advised indexing a
  file that cannot exist. Fields on `TimeOfDay`, `FieldId`, `TableId` … were also typed
  String. One evidence-based list (`src/knowledge/kernelEdts.ts`, 83 names: every EDT
  shipped fields or EDTs use that `readEdt` cannot resolve, with the base type all their
  fields agree on) now answers those paths, mirrored in the bridge and kept equal by a
  parity test. The bridge also writes `Time` fields and EDTs, which it could not before.
- **`update_symbol_index` left a changed form's datasources and patterns stale.** It wrote
  only the form's symbol row; it now writes everything the full build writes for a form,
  and removing a form removes its datasource, pattern and stored-XML rows.
- **Re-adding a table element that exists failed the call or the batch.** The bridge's
  table `AddField`, `AddIndex`, `AddFieldGroup`, `AddFieldToFieldGroup` and
  `AddRelation` added without checking the name, so an element that existed failed
  inside the SDK ("already exists among elements") and stopped the `operations[]` batch
  it was in. Table create always writes the five Auto field groups, so a follow-up
  `add-field-group AutoReport` always collided. Each now answers as a skip, nothing
  written, with the reason and the operation that changes the element. The index,
  field-group and relation wrappers report it as "⏭️ NOT written" (the field paths
  already did). The XML index fallback's "✅ already present" is a skip too, and the
  valid-time-state and relation-property follow-ups no longer run after a skip. An
  `add-field-group` with `fields` on a group that exists puts the missing fields into
  it instead of dropping them, so `add-field-group AutoReport` with fields does what it
  asked for.
- **An EDT that extends an enum EDT had no enum.** The base-type inference from
  `extends` left enum parents alone, so `extends: "NoYesId"` wrote a string EDT. And
  neither writer could set the enum at all: the bridge's `SetAxEdtProperty` had no
  `enumType` case (reported unsupported) and `generateAxEdtXml` never wrote
  `<EnumType>`. An enum parent now gives `edtType: Enum` and the parent's `enumType`
  (bridge `readEdt`, then the index chain), an explicit `edtType: Enum` without an enum
  gets the parent's, and both writers write `<EnumType>` after `<TableReferences />`,
  as all 1,512 shipped children of enum EDTs do.
- **A value the bridge rejected was written anyway by the XML template.** When a bridge
  create threw, create fell back to the template, also when the bridge had validated a
  value and refused it ("'RegularTable' is not a valid TableType"). The template wrote
  the same value unchecked, and the invalid object reached disk with only a "Written by
  the local XML template" note. Such rejections (`-32602` with "is not a valid" or
  "Invalid …") now stop the create with the bridge's message. Other bridge failures,
  such as a model its provider does not know, still fall back as before, and so does
  the field EDT check: the provider reports kernel EDTs (`RecId`, `UserId`,
  `ValidFromDateTime`, …) as missing, so its "does not exist" is not proof that the
  input is wrong. Such a rejection also no longer
  gets the dispatcher's "bridge errored … re-run once the bridge is healthy" note: the
  bridge answered, it is the input that was wrong.
- **`undo` and `delete` left the element's compiler-metadata copy behind.** The copy at
  `<Package>\XppMetadata\<Model>\<AxType>\<Name>.xml` was removed only by the phantom
  prune of this server's incremental build, so a Visual Studio build or a packaging step
  in between kept the deleted element in the manifests. Both now remove the copy when
  they remove the source, by the prune's own rule, and drop the copy's type folder if
  that left it empty.
- **`undo` deleted a whole object that was merely uncommitted.** Inside a git work tree,
  any untracked file was deleted, so an undo after a bad modify of an object from an
  earlier session (common where objects are committed only at PR time) removed the
  object itself, with no backup to restore and its `.rnrproj` entry left dangling. An
  untracked file is now deleted only when this session created it, the rule the
  non-git path already applied. Otherwise undo refuses and says why. The tables, forms
  and report objects `generate_object(scaffold)` writes to disk are now recorded as
  created too, so undo can still delete them (it could not outside git before).
- **TTS001 warned on replace-code fragments and never reached extension classes.** The
  write-time check counted `ttsbegin`/`ttscommit` in the text sent, so adding a line
  after `ttsbegin;` in a balanced method warned "ttsbegin × 1, ttscommit × 0". For a
  `replace-code`, TTS001 now stays only when the edit changes the balance between
  `oldCode` and `newCode`. Separately, a method sent to an extension class was wrapped in
  a synthetic class header whose line the rebase dropped, together with the TTS001 that
  sat on it. That violation is now kept on line 1 of the code sent.
- **COC004 reported `next` inside `try`, `finally` or `using` as conditional.** Any
  block deeper than the method body counted as conditional, so CoC methods the compiler
  accepts (`next insert()` inside `try … finally`, `return next insertFromForm()` inside
  `using`) were refused as SYS10028 errors. Only blocks whose header branches or loops
  (`if`, `else`, `while`, `for`, `do`, `switch`, `case`, `default`, `catch`) now make
  `next` conditional, also when the header spans several lines (`if (a` / `&& b)` / `{`).
  Across 3,193 shipped CoC classes that call `next`, COC004 fell from 189 hits to about
  120. The rest are `[Replaceable]` base methods and data source overrides, which need a
  lookup of the target method.
- **A multi-line `replace-code` always missed in the bridge.** The bridge matches with
  `Contains` against method source read through `IMetadataProvider`, which keeps the
  file's CRLF, while clients send `oldCode` with LF. Every multi-line edit therefore
  fell through to the XML writer with a "bridge declined" note (168 of 176 in one
  project's sessions, against 3 of 181 single-line ones). `oldCode` and `newCode` now
  reach the bridge in the line endings of the file on disk, which also keeps inserted
  code in the file's own style.
- **An already-applied `replace-code` counted as applied in a batch.** Its "no change
  needed" answer returned before the outcome was marked skipped, so `operations[]`
  reported it in "N/N operation(s) applied" and in the "verified on disk" trailer for a
  write that never happened. It is now counted as skipped, as a bridge skip is.
- **Every modify warned "overwrite: IGNORED" although nobody passed it.** MCP clients
  send the schema's published defaults, so `overwrite: false` arrived on each call and
  the silent-drop guard answered "not a recognised d365fo_file parameter … Re-run with
  the correct parameter name(s)" after a call that had succeeded, once per entry in a
  batch. A parameter whose value equals its published default is no longer reported.
  A real value the operation cannot use (`overwrite: true` on modify) still is.
- **`validate_code` accepted any value on a known enum; no check for an update on a
  buffer never selected for update; prefix inference followed a minority prefix**
  (#1164). `PurchStatus::NoSuchStatus` passed as verified once `PurchStatus` existed.
  The references check now reads the value names from the enum's XML and from every
  indexed `AxEnumExtension` of it (plus, for packages shipped without XML, the compiled
  `bin\<Package>_AxEnumExtension.md`) and reports `unknown-enum-value` as an error.
  Over the 312,533 `Enum::Value` uses in shipped X++ it raised 30, every one a .NET enum
  of the same name brought in by a `using` directive, so a source with such a directive
  gets a warning instead; a namespace-qualified `A.B.Enum::Value` and an enum whose XML
  is not on this machine are not checked. New rule SEL011 warns on `buf.update()` /
  `buf.delete()` when every select of `buf` since its declaration lacks `forupdate`,
  `pessimisticlock` and `optimisticlock` — 20 hits over 1.1M shipped CDATA blocks,
  all code paths that throw if reached. And the regular-object sample prefix inference
  reads was the model's first 60 names in (type, name) order, so in a 3,800-object
  `xyz` model with 69 `xyz3PL` names (digits sort first) inference answered `xyz3PL`;
  the sample is now drawn as eight short runs spread over the model's rows.
- **`add-method` and `remove-method` failed on a data entity.** The bridge has no
  data-entity arm for either, so `d365fo_file` modify returned "add-method not supported
  for objectType 'data-entity' via bridge (use XML fallback)" and applied nothing — the
  fallback the message named did not exist. When the bridge declines an object type this
  way, the method is now upserted into (or removed from) the root `<SourceCode><Methods>`
  by the XML writer, with the same doc-comment and indentation pass the bridge path
  applies, and read back before the reply says it landed. `replace-code` already fell back.
  A multi-method `add-method` also stops at the first refusal and reports it, instead of
  summarising a failed write as "Added N methods".
- **`find_references` called the owner of a field or method "not a class".** The hint for
  a form or table name passed as a class also checked the owner of every `Owner.member`
  target, so `SalesTable.SalesId` as a field, or `SalesTable.initFromSalesQuotationTable`
  as a method, came back with "⚠️ Type Mismatch: … is not a **class**" when no class was
  asked for. The hint now runs only for a name looked up as a class.
- **Labels were not compiled (on labelc 7.0.8199.32), behind a green build.** The build
  passed the located csc and SDK tool folders as `-CompilerPath` / `-SdkToolsPath`;
  that labelc lists both in its usage text but does not parse them, so it printed the
  usage text, compiled nothing and exited 0, and new labels kept being reported as
  unknown. The folders now go first on labelc's own PATH, which every labelc version
  searches. A labelc run that reports no compilation result is now a failure instead
  of a success.
- **`run_systest_class` lost the result of a class with failing tests.** SysTestConsole
  exits non-zero when a test fails, and the tool took that for a runner error: it never
  read the XML result the run had written, replied `❌ Tests failed:` with the raw
  console log, and the 5,000-char response cap cut that log mid-stack-trace — on a
  43-test class with two failures, the counts and the second failure never arrived, and
  the eval oracle scored the run as one that never ran. A run that wrote results is now
  reported as `❌ Tests FAILED` from the XML: the counts, then each failure with its
  message, then the passing tests, the path of the result file and the raw log last.
  The tool has its own 12,000-char cap, and its truncation note no longer suggests
  paging parameters it does not have.
- **A default argument that is a call renamed the method on class create.** The class
  split named each method after the identifier before the last `(` of its signature,
  so `void run(TransDate _from = dateNull())` was written as a method named `dateNull`.
  For methods inside the class body, a signature over several lines also lost its
  attribute and every line above that call, with no error. The name and the method start
  now come from the `(` that matches the signature's last `)`.
- **An EDT that extends a real, integer or date EDT was created as a string EDT.** With
  `extends` but no `edtType`, both the bridge and the XML template fell back to
  `AxEdtString`, so `extends: "AmountCur"` wrote a string EDT extending a real one and
  every field built on it was mistyped. The base type now comes from the parent EDT
  (bridge first, then the symbol index). String and enum parents, and parents that
  cannot be resolved, are left to the writers as before. `edtType` in the `AxEdt*` form
  (`AxEdtReal`) also reaches the bridge as `Real` instead of falling through to a string.
- **`find_references` blamed "this server mode" for a missing setting.** Whenever it fell
  back to the name-based search it said "the cross-reference bridge is unavailable in this
  server mode". On a traditional VM the usual cause is a running bridge with no
  cross-reference database configured, since no XPP config names DYNAMICSXREFDB there.
  The reply now tells three cases apart. A bridge that is still starting says so and asks for
  a retry, rather than reporting a configuration problem (#826). A bridge that is not
  connected says so. A bridge running without a cross-reference database says that, with a
  separate line on how to configure one: `D365FO_XREF_DB_NAME` (usually DYNAMICSXREFDB),
  `D365FO_XREF_DB_SERVER` when SQL Server is on another machine, where to set them, and to
  restart the server. Label where-used gives the same reason and advice. For a type the
  name-based search cannot serve (EDT, form, query, view, report), a failed query is now told
  to check the bridge log and a disconnected bridge how to get it running, instead of both
  being told to set `bridge.xrefDbName`. `doctor` now gives
  the same advice. It used to name only the config file, although the `env` block of
  `.mcp.json` takes precedence.
- **Writes without a configured `projectPath` landed in an arbitrary project.** The
  solution-folder scan returned the first `.rnrproj` whose file name contained the model
  name, in directory order. In a solution with one project per feature area of a model
  every project matched, so every create, modify and label write registered into the
  alphabetically first one, and an exact `<Model>.rnrproj` lost to a shallower substring
  match. The scan now returns `<Model>.rnrproj` wherever it sits, or the only project that
  matches, and otherwise no project, as `autoDetectProject` already does when several
  projects share a model. The log names the count and asks for `projectPath`, and the
  create reply says how many projects matched instead of "Could not find .rnrproj".
- **`replace-code` refused an edit that `methodName` made unambiguous.** The bridge
  replaces only inside the named method, but the file-level preflight and the direct-XML
  fallback counted `oldCode` over the whole file: a line such as `ttsbegin;` that also
  occurs in another method was refused with "matches 2 times … or scope the call with
  methodName", although the call already had one. Both now count only inside the named
  method, the class declaration for `classDeclaration`, or the control or data source
  override for `Owner.method`. The fallback also no longer edits a different method
  when the named one does not contain `oldCode`, and `newCode` already present in another
  method no longer turns the edit of the named one into "Nothing to do".
- **`add-enum-value` without a value collided with the enum's first member.** The op
  documents that the next available value is assigned, but the dispatcher sent 0 and the
  bridge wrote it, so the new member duplicated the first one (the member without a
  `<Value>`). xppc reports "Duplicate value '0' detected", and only on a full build. A new
  member of an enum now gets one past the highest value in its XML. Enum extensions keep
  0, which writes no `<Value>`: the platform numbers the members of an extensible enum,
  and most shipped extensions (219 of 278) carry none.
- **KW001 missed reserved-word names on EDT, table and class types and on parameters.**
  The rule only matched declarations whose type was a primitive (`int from;`), so
  `TransDate from;`, `CustTable outer;` and a parameter `(AmountMST sum)` reached the
  build, where xppc names the token after the word instead of the word. It now takes any
  type and also checks parameters. Statements whose first word is reserved (`return
  count;`) and `order by` lists (`asc`, `desc`) are skipped. Across 95,753 shipped and
  ISV class, table and form files it reports nothing. It did find one: the `args-object`
  knowledge example declared `MyOrderTable order;`, and `order` is reserved, so the
  example is now `orderTable`.
- **An incremental build silently removed a data entity's OData actions.** xppc's
  `-incremental` mode rewrites the `bin\Dynamics.AX.<Package>.ODataExtends.runtime`
  entry of every entity it recompiles without its actions, and the AOS reads them from
  there at startup: after any edit to an entity with a `SysODataActionAttribute` method,
  a green build and an AOS restart took every action of that entity out of OData —
  including ones that had worked. A build asked for as incremental now runs as a full one,
  as Visual Studio's does, when it would recompile an entity, entity extension or class
  that declares an OData action, or when the deployed file already lacks one; the result
  says why. A successful build whose file still lacks a declared action no longer reads
  `✅ Build succeeded`, and after an incremental build `restartAos` is withheld until a
  full build has written them.
- **A write said an object outside every `.rnrproj` "will not compile".** xppc compiles
  the whole model folder, project or not; the message now says the object compiles but no
  project shows it in Visual Studio.
- **`run_bp_check` ignored `D365FO_PACKAGE_PATH` and its own `packagePath`.** With no XPP
  config it took the metadata root from the drive scan, which finds
  PackagesLocalDirectory. On a single-root VM whose metadata lives elsewhere (a repo
  folder with the standard packages linked in) xppbp then failed with "No module with
  the name … could be found under the source path". The root is now resolved as
  `build_d365fo_project` resolves it: `D365FO_PACKAGE_PATH` before the drive scan, and an
  explicit `packagePath` over both.
- **`run_systest_class` could not find, or ran a stale, `SysTestConsole`** (#1143).
  Current platforms ship the runner as `Bin\SysTestConsole.17.0.exe`; the tool looked
  only for `SysTestConsole.exe`, so on an install without it no test could run, and on
  an upgraded box that still has one it ran that leftover — on a 7.0.7858 VM it was
  7.0.7452 from December 2024, beside a 17.0 build matching xppc. The highest versioned
  `SysTestConsole.<version>.exe` now wins, the plain name is the fallback, and the
  login and binding-redirect diagnoses read and name the `.config` of the binary that ran.
  The debugger-prompt and per-method notes name that binary too. A versioned runner that
  cannot start (an assembly missing from `Bin`, or a `.config` that cannot log in) hands
  over to the plain one, and the reply says so: on another 7.0.7858 VM the 17.0 runner
  lacks `System.ValueTuple 4.0.3.0` and has the unconfigured template, while the plain
  one beside it runs green.
- **A map listed no fields or method signatures, and most maps no mapped tables.**
  `get_object_info` on an AxMap now renders its declaration, fields and method
  signatures; map methods are indexed (search with `type: "map"`, `get_method_source`,
  and the SQLite body fallback when the XML is unreachable). Table-to-map bindings were
  read only from the map's own `<Mappings>`, which holds 147 of the shipped AOT's
  bindings; the other 1,913 are declared by the tables and are now indexed too. Re-extract
  metadata and rebuild the index to pick them up, or run
  `scripts/backfill-map-mappings.mjs` against an existing index.
- **`bpCheck` and `dbSync` were lost when a build was collected by a later call.**
  A build that outlives its wait window (`wait: false`, or past `waitTimeoutMs`) is
  collected by another call, usually with the model name alone, and that call's
  arguments decided the post-build steps — the BP check and sync the build was
  started with were skipped without a word. The build now records them when it
  starts (as a restart build already did); a collecting call can still add a
  `bpCheck`, and a `dbSync` scope given at the start is kept (tables the collecting
  call names are added to it).
- **A second call waiting on the same build waited out its whole window.** When
  two `build_d365fo_project` calls wait on one build (typically a client that gave
  up on the first call and asked again), whichever sees it finish first consumes
  its state; the other found nothing left to read and polled until `waitTimeoutMs`
  (30 min by default) ran out. It now returns as soon as the state is gone, with
  the same result the first call got when that call ran in this server process —
  the post-build `bpCheck`/`dbSync` still run once — and otherwise says the build
  was collected elsewhere.

## [1.21.0] — 2026-10-15

### Added
- **Optional `trace_d365fo`: measure X++ and SQL time with ETW instead of timer
  code.** Published only when `trace.enabled` is true (`config trace`). `start`
  runs a `logman` capture of the AOS's X++ method and SQL latency events — the
  agent reproduces the scenario itself (`mode: auto`, e.g. through a browser
  extension) or asks the user to (`mode: manual`) — and it stops by itself at a
  time and size limit. `analyze` reads the `.etl` in the bridge binary
  (`--analyze-trace`, its own process): enter/exit paired per thread,
  exclusive/inclusive time, SQL by statement and by caller, statements repeated
  in loops; parameter values are never returned. When no folder is set, or it
  lacks space, `start` lists the drives and remembers the folder chosen. See
  [docs/TRACE.md](docs/TRACE.md). Statements are grouped by their whole text — the
  kernel lists every column, so FROM and WHERE often start past the 300 characters
  shown, and a cut key merged different queries on a table into one "repeated"
  row; the shown text keeps `FROM … WHERE`. The drive list is probed off the event
  loop with the packages-root scan's budget and `D365FO_SCAN_DRIVES` (a dead mapped
  drive cannot stall the server), a relative `outputDir` is refused, a failed
  analysis no longer reads as "analysing" on the retry, a capture whose state file
  cannot be written is stopped at once (`TRACE_STATE_FAILED`), and a capture that
  ended while `stop` was asked is reported stopped, not `TRACE_STOP_FAILED`.
- **No prefix at all: `naming.prefixSource=none` (#1085).** For teams on a
  suffix convention (`CustomerSettings_ABC`). An empty `naming.prefix` never
  meant "no prefix": the server inferred one from the model's objects, then fell
  back to the model name. `none` (env `EXTENSION_PREFIX_SOURCE=none`) skips all
  of it — new objects, fields and methods keep the name as given, `naming.suffix`
  is still appended (and its own underscore no longer trips the naming check),
  and extension elements and classes embed the model name (`CustTable.ABC`,
  `CustTable_ABC_Extension`), since they still need a collision-avoiding token.
  `validate_object_naming` stops asking for a prefix, `generate_object` stops
  warning "No prefix resolved", and `get_workspace_info` / `doctor` report the
  choice (including the model-name class style it forces) (doctor warns when it ignores a `naming.prefix` that is still set). The
  cross-model refusal suggests the model-name extension, modify can auto-create
  a missing `Base_Model_Extension` class, report copies from `generate_object`
  carry the model token trailing (`SalesInvoiceABC`), and the type checks read
  a role suffix before the configured one (`CustomerExportEntity_ABC`).
  `naming.prefix` is no longer marked required; `setup` asks which one you mean
  when you leave it empty. Without the setting nothing changes.
- **`modify-property` sets properties on a form's own controls.** With
  `controlName` (or a dotted `propertyPath`, `"PostButton.NeedsRecord"`), it now
  reaches a control of an `objectType="form"` and a control a form extension
  ADDS — before, it stopped at `<Design>` and at base-form controls through
  `<ControlModifications>`, so setting MenuItemName, MultiSelect or NeedsRecord
  on such a button meant rewriting the whole form XML. The property is written
  on that control in the element order shipped metadata uses for its type (the
  census in `formControlElementOrder.generated.ts`), since the deserializer
  drops an out-of-order element silently (#979); a property the type never
  carries (MenuItemName on a plain Button) is refused, an empty value removes
  the element, and an ambiguous or unknown control name writes nothing. That
  holds for a dotted path too: its first segment must be `Design` or a control
  of the form, so a misspelt `PostButon.Caption` is refused instead of setting
  the form's own caption. A value that is already set is reported as a skip.
- **Optional `axdb_sql`: read-only, live SQL against AxDB on the development VM,
  for debugging.** Off by default, and not published at all until a SQL server
  is configured, so a default install's tool list is unchanged. Setup offers it
  only on a classic AOSService VM whose `AosService\WebRoot\web.config` names
  the AOS database server (`DataAccess.DbServer`; the database is
  `DataAccess.Database`, AxDB when it is absent), proposing those values; UDE
  skips it, and `d365fo-mcp config sql` configures it by hand.
  The bridge runs it with Windows authentication over an encrypted connection,
  opened on demand. Actions: `contract`, `status`, `schema` (columns, keys,
  defaults of a physical table) and `query` (one parameterized SELECT, bounded
  rows and bytes, counted cell by cell as the rows stream in; a capped answer
  cancels the rest of the result set instead of reading it to the end). Two guards, because the dev-VM account is normally sysadmin:
  the statement must be exactly one SELECT on the ScriptDom syntax tree, and
  every operation runs in a transaction that is always rolled back. Catalog
  reads are limited to database-scoped sys views (no `sys.sql_logins`,
  server principals or DMVs). No result cache, no replay, no retry. Excluded
  from `read-only` mode. See [docs/AXDB_SQL.md](docs/AXDB_SQL.md).
- **`add-field` on a view.** `modify` had no view path: `dataField` + `dataSource`
  (the natural guess — it is the data-entity shape) was refused as data-entity
  only, and `fieldType` reached the bridge, whose AddField resolves tables only, so
  it failed with "Table or table-extension not found" and blamed a same-session
  create. It now writes an `AxViewFieldBound` — `dataSource` (a data source of the
  view, case-corrected against the ones the view declares), `dataField` (defaults
  to `fieldName`), optional `fieldLabel` — in the shape 25,946 of the 28,493
  shipped bound view fields use. `prepare` and the op-spec describe the view
  contract instead of the table/entity one.
- **`add-data-source` takes `insertIfEmpty` on a form or form extension.** The
  bridge's AddDataSource has no such property, so a new data source always kept
  the platform default (Yes), while the VS designer writes `<InsertIfEmpty>No` for
  one — the usual choice for a joined, read-only source. `insertIfEmpty=false`
  writes it where all 12,798 shipped occurrences sit (every one of them `No`;
  Yes is never serialized), `true` removes it. The data source's `<Fields>` list
  stays empty: the designer fills it on save, but Microsoft ships a view data
  source with an empty one whose controls bind to its fields, so it is not needed.
  When a data source of that name is already there (the bridge skips the add),
  it is set on that one, which is the only way to set it on an existing data
  source. If it cannot be placed, the call fails and says that the same call,
  retried, finishes it. On any other type, data entities included, it is
  refused before anything is written. The existing data source is found whatever
  the case of the name (as the bridge's skip does), and the reply credits the XML
  writer when that is what changed the file.

### Changed
- **`build_d365fo_project` no longer carries the multi-model build queue (#1122).**
  Building referenced models has been switched off for a while and the queue
  could not form, but its result branch would have skipped `bpCheck`, `dbSync`
  and the last-build note had it ever run. The queue is removed; a
  `buildReferencedModels` argument from an older client is still ignored, and a
  full build now reports itself as `full build`, not `full build (target),
  incremental (deps)`.
- **Code comments are written in English.** Neither the system instructions nor
  the knowledge base said which language a `//` or `///` comment is in, so an
  agent talking to the user in Czech often commented the X++ in Czech, and
  nothing caught it (xppc and BP never check the language of a comment). Both
  now say: always English, whatever language the conversation is in, and
  another language only when the user explicitly asks. A comment explains what
  the code below it does and why, not the syntax. Templates were already English.
- **Every `.rnrproj` write is bounded by the configured solution roots.**
  `d365fo_file(action="project")` refused a project outside them, while
  `create`'s `addToProject` — and modify, labels and generate_object
  registration — wrote whatever `.rnrproj` it was given, so `add-object` refused
  the very project `create` had just registered objects into. They now share the
  bound; a refused registration is reported and the object is still written.
  The folder of a configured `workspace.projectPath` / `D365FO_PROJECT_PATH`
  counts as a root, a project activated with `get_workspace_info(projectPath=…)`
  does not — set `workspace.solutionsPath` to the folder holding your projects.
  That switch now says so at once (new objects are written but not added to the
  project) instead of leaving it to a "failed to add to project" on every later
  create. Activating the project the server itself detected keeps its root.
  `delete` still removes its own entry from any project listing it, since a
  dangling include stops the project loading.

### Fixed
- **A boolean written as text in the config file was always on.** A hand-edited
  `"enabled": "false"` (or `"no"`, `"off"`, `"0"`) is a non-empty string, and the
  projection onto the environment read it by truthiness — so, for example,
  `sql.enabled: "false"` published `axdb_sql`. Text is now read the way `.env`
  values are (`true`/`1`/`yes`/`on`), for every boolean setting. `doctor`'s
  `sql.enabled` check reads it the same way and, like the server, lets a variable
  set in the real environment outrank the config file.
- **`update` left an old bridge binary in place when the bridge's sources changed
  (#1115).** It judged the bridge only by whether the exe survived, and `git pull`
  never touches `bin\Release` while `npm install -g` never touches the data
  directory, so the rebuild was offered as "recommended after a D365FO version
  upgrade" and the server could run new TypeScript against an old bridge without a
  word. Every bridge build now writes `D365MetadataBridge.sources.json` next to the
  exe (an MSBuild target, the same source hash `bridgeAttest.mjs` computes);
  `update` requires the rebuild when that stamp is missing or differs from the
  sources, `doctor` warns, and `setup` defaults to rebuilding such a bridge. A
  bridge built before the stamp existed is asked about once. The D365FO-upgrade
  prompt is unchanged for a bridge that matches its sources.
- **`trace_d365fo(action="analyze")` refused when the bridge had not started.** The
  analysis runs the bridge binary as a separate `--analyze-trace` process and needs no
  D365FO assembly, but it took the binary's path from the running bridge only, so a
  bridge that failed to start (no packages path, a cold-VM timeout) meant
  `TRACE_BRIDGE_UNAVAILABLE`. It now falls back to the binary the server would start:
  the configured `bridge.exePath`, else the first built candidate.
- **`add-control` puts a control where it was asked, and moves one that exists.**
  On `objectType="form"` `previousSibling`/`positionType` were dropped (the bridge
  appends to the parent), and an existing control could not be moved at all:
  add-control again answered "already present — skipped" with a ✅ and
  modify-property refuses `PositionType`/`PreviousSibling`. Display-method fields
  added to a custom form stayed at the end of their group. A control the file
  already defines is now moved (same parent; by order, or by the envelope's
  position pair on a base-form parent) and never added a second time. A position
  that cannot work (unknown `positionType`, a `previousSibling` outside the parent)
  is refused before the bridge writes the control, the design-root names the
  bridge accepts (`FormDesign`, `Root`, `<Form>Design`) work for placement too,
  and a move or refusal the bridge took no part in no longer reads as
  "applied via IMetadataProvider.Update()" / "Bridge operation failed". A move
  names the creation arguments it did not apply (`controlType`,
  `controlDataSource`, `controlDataField`, `controlLabel`) instead of dropping them
  silently, and is not refused by the DataGroup or pattern pre-flight over them;
  "already on the form" names the parent the control is really in.
- **`doctor` said nothing when `axdb_sql` was missing because `sql.enabled` was
  off.** The tool is published only when `sql.enabled` is true and `sql.server`
  is set. The wizard writes both, but a hand-edited config can carry the server
  alone, and then `axdb_sql` is simply absent. `doctor` now warns about it for
  the root config and for each instance, and names the fix.
- **`axdb_sql` refused `maxRows` and `parameters` a client sent as text.** The
  MCP inputSchema declares only `action` (the strict schema is the contract), so
  a client has no type for the other parameters and may send `maxRows: "50"` or
  `parameters` as a JSON string, which failed with "expected number, received
  string". Those two are now read back from text; limits still apply, and a
  parameter's value is never converted (an `int` sent as `"5"` is still refused).
  Blank text counts as omitted, and a whole number written `"1e3"` or `"50.0"` is
  read as one.
- **`build_d365fo_project(bpCheck: true)` could return megabytes.** The build
  result is uncapped, and the BP section was the whole `run_bp_check` text: on a
  model with ~5,300 warnings, 2.7 MB in one result, past what an MCP client shows
  inline. Past 12,000 characters the section is now a summary — the verdict,
  xppbp's own Errors/Warnings totals, findings counted by rule (top 25) and the
  first 15 — and the complete text is saved next to the build log
  (`<log>.bp.txt`); `run_bp_check` still returns it in full. The summary leads
  with xppbp's totals because the parser counts only BP rule lines (not
  CodeAnalysis ones), so its own count can be lower. Error rules and error
  findings come first whatever their count — one error among thousands of
  warnings is the finding that fails a pipeline — and `run_bp_check`'s
  label-compile caveat is kept.
- **`labels(action="update")` with only en-US overwrote every other language
  with English, and every developer comment with the default (#1105).** Update
  writes each existing language folder; one with no supplied translation got the
  en-US (last-resort) text, and every written label got `description`'s default
  (the VS project name, else the labelFileId) as its comment. Now, for a label that
  already exists in a folder, update writes the text only where the call supplies
  a translation (exact, parent or regional match) — a folder that would only get
  the fallback keeps its text, unless that text is a copy of the current en-US
  text, which follows the update. Only en-US counts as a copy source: when a call
  leaves en-US out, en-US is never taken for a copy of the language it supplies,
  although two languages often share a word (Status, Name, Filter). A genuine
  translation that reads exactly like the old English cannot be told apart from
  such a copy, and follows it too. Update replaces the comment only with a
  `comment`, `defaultComment` or `description` the call states, and adds none to
  a label that had none; text and comment come from the same entry when a locale
  is given twice. The reply lists
  the kept folders with their text (bulk mode too). A folder where the label is
  missing still gets it, and create is unchanged.
- **Modify no longer leaves `.backup-*` files for calls that changed nothing.**
  Outside git the pre-modify copy was taken before the operation was validated,
  so every refused call left a copy of an unchanged file beside the AOT source —
  on a TFVC workspace, a pending add each. The copy is still taken first, and is
  now removed when the call ends without changing the file: a refusal, a skip,
  or a success that changed nothing, such as a value that was already set. A
  file created in the same session gets none (undo deletes it), so `create` with
  `operations[]` no longer leaves one per operation. `createBackup=true` now
  names its copy in the response (and, like the forced copy, it is removed when
  the call left the file unchanged). `insertIfEmpty` on a type other than a form
  is refused before anything is written.
- **`undo` described a non-git workspace wrongly.** The schema said "untracked →
  deleted" and the forced-backup note said undo "would not work here". Outside git
  undo deletes a file `create` made in this server session and refuses everything
  else; both texts now say so.
- **The solutions-path scan could pick a project of another model.** With no
  project resolved from the workspace, the `workspace.solutionsPath` scan took
  the first project in disk order. A projects folder that also held one stray
  project of another model — scanned first, the only one of its model — had that
  project selected, its model registered as custom, and every new object of the
  configured model registered into it, failing that project's build. A configured
  `modelName` now limits the pick to that model's projects; if the folder holds
  none, nothing is selected and the server says so.
- **Wrong headings and progress labels.** `create` with `operations[]` headed its
  results `d365fo_file(action="modify")`; `undo`, `delete` and `project` calls
  showed "📁 Creating …" while they ran.
- **`workspace.projectPath` / `D365FO_PROJECT_PATH` pins the project again.**
  The config file loads its settings as `D365FO_*` environment variables, but
  `getProjectPath()`, `getSolutionPath()` and `get_workspace_info` read only the
  `.mcp.json` context — so the documented "Pinned .rnrproj file" setting did
  nothing: `Project : (not detected)`, and no write could register a file in the
  project. Both are read now, the environment first (the order `getContext()`
  already used), and the top-level `context` block of `.mcp.json` as well as
  `servers.context`; the same holds for `workspace.solutionPath`. A pinned path
  also outranks a detected one in the context snapshot, as it does for writes.
- **`d365fo_file(action="create")` keeps an extension class name that already
  carries the model's token after its base.** `SalesTableMcpCreditHold_Extension`
  with `[ExtensionOf(tableStr(SalesTable))]` was written as
  `SalesTableMcpCreditHoldMcp_Extension` — the token was only looked for at
  either end of the name — and a delete + re-create renamed it again, so the name
  a task asked for could not be written through the server at all. The base named
  in `[ExtensionOf]` (or `properties.baseClass`) now decides: base, then the
  token as its own word, means already prefixed. Without a stated base the
  symbol index stands in: the longest known table/class/form/view/query/entity/map
  the token follows is the base, and with none known nothing changes.
  `validate_object_naming`, `prepare(mode="create")` and create all derive the
  base the same way, and try the same tokens (the learned infix and the raw
  prefix), so they predict and write the same name. A stem that is itself a known
  object is its own base: `AgreementAutolinkHelperSalesLine_Extension` under the
  token `Sales` is not read as `AgreementAutolinkHelper` already prefixed, which
  matters for model names that are ordinary D365 words (Sales, Invent, Tax,
  Ledger) and most under `naming.prefixSource=none`. Found by the model ×
  MCP benchmark (`ref-credit-hold-extension`), where it cost three with-MCP runs
  a check the runs without MCP passed.
- **Form and form-extension XML passed as `xmlContent` gets the metadata
  namespace.** Written without `xmlns="Microsoft.Dynamics.AX.Metadata.V6"`, an
  `AxFormExtension` builds clean and then fails xppbp ("Error reading
  FormExtension … not found"); create now adds it to the root and `xmlns=""` to
  the grandchildren — the layout every one of the 10,530 shipped `AxForm` /
  `AxFormExtension` files has (no other root type carries the namespace) — and
  says so in the response. Matched pair on the benchmark's own files: as written,
  2 xppbp errors; fixed, 0.
- **A label could land in English in a language folder, without a word.**
  `labels(action="create")` looked up each existing language folder's
  translation by exact, case-sensitive name, and fell back to the en-US text
  for anything else — so `it` for an `it-IT` folder, `it-it`, and above all
  `de-DE` for the bare `de` folders Microsoft's own models use all wrote
  English, listed as written with nothing saying it was a substitute. Locales
  now match case-insensitively (`it_IT` reads as `it-IT`; the exact spelling,
  then the first case variant, wins), then fall back along the target's parent
  chain (`it-IT` → `it`; `zh-Hant-TW` → `zh-Hant` → `zh`), then — for a
  bare-language folder — to the one supplied regional translation of that
  language (`de-DE` → `de`; two candidates such as `de-AT` and `de-CH` fall
  through, and a sibling region is never used), and only then to en-US or the
  first supplied translation. Each parent or regional fallback is reported on
  its own line, the last-resort ones in one line per source, and bulk mode
  (`labels[]`) forwards those lines instead of dropping them.
- **`get_workspace_info` no longer waits 5 s for a `.rnrproj` scan it does not
  need.** When `D365FO_MODEL_NAME` or the config names the model, the first call
  answered only after the background project scan — and with the server started
  in a folder that holds no `.rnrproj` (a package folder, a CLI session outside
  the solution), that scan fell back to every package under
  PackagesLocalDirectory (7.5 s on the dev VM, nothing found), so the call hit
  its 5 s cap on every session. It now answers at once (0.2 s, measured) and
  reports the project as still being detected; the scan finishes in the
  background. When nothing names the model the call still waits, since the scan
  is how the model is found. The fallback scan itself now covers only the
  package whose descriptor declares the detected model instead of the whole
  root, so it also holds when the package and model names differ (#1086).
- **The form element-order check no longer reports an empty element as unknown
  (#1093).** Microsoft's own `CustInvoiceJournal.ApplicationSuite_Extension`
  (ApplicationSuite 10.36) writes an empty `<Items />` on a string control, so
  the shipped-metadata census failed on that VM, and a form write carrying the
  same element got a warning about a value the platform would ignore. An empty
  element carries no value, so it is no longer an `unknown` finding; one with
  content still is, and the blocking `order` check is unchanged.
- **The bridge build command the CLI prints failed in Windows PowerShell 5.1.**
  `doctor` and `update` suggested `cd "…\D365MetadataBridge" && dotnet build -c
  Release`, and the bridge's "executable not found" error a relative
  `cd … && …`. PowerShell 5.1 — the default shell on D365FO VMs — rejects `&&`
  as a statement separator, so the suggested fix failed exactly where it is
  printed. Both now name the project in a single `dotnet build` invocation
  (`dotnet build "<repo>\bridge\D365MetadataBridge\D365MetadataBridge.csproj"
  -c Release`, plus `-o` for an npm install), which runs from any directory in
  any shell.
- **Creates into a model whose package has a different name reported failure
  (#1086).** The C# bridge built the reported path as `{Model}\{Model}\Ax…`, so
  for package `Enhancements` holding model `Sales Integration` it named a folder
  that does not exist. The object itself was written correctly, but the server
  checks, indexes and adds to the `.rnrproj` the *reported* path, so the create
  came back as "the file is NOT on disk after a reported success". The bridge now
  looks up the package from the model descriptor. The on-disk fallback that
  finds which model an existing object belongs to had the same `{pkg}\{pkg}`
  assumption and now walks the model folders.

## [1.20.0] — 2026-10-02

### Added
- **`naming.extensionClassStyle` / `EXTENSION_CLASS_NAMING_STYLE` accepts a new
  value, `prefix-leading`.** `prefix` and `model-name` both put the token right
  before `_Extension` (`CustTableCr_Extension`); some conventions instead lead
  the class name with it (`CRCustTable_Extension`) — the Avanade D365FO
  Development Guidelines are one, and neither existing value can express it.
  `validate_object_naming` and `get_workspace_info` recognise and render the
  new style; `d365fo_file(action="create")` and `normalizeObjectName` write it,
  including converting a name written under the trailing `prefix` style
  instead of double-prefixing it. The prefix is matched only as a separate
  PascalCase word, with one derivation shared by the writer and the validator, so
  a base ending in the same letters keeps them (`Le` + `SalesTable` →
  `LeSalesTable_Extension`), and a camelCase base is upper-cased behind the prefix
  (`CtsoWhsWorkExecute_Extension`) so re-running stays stable. Element extensions are unaffected — the new
  style only applies to CoC classes, since Microsoft's own dot-notation shape
  (`Base.{Infix}Extension`) cannot lead with the infix.
- **Edit an existing data entity in place, and set AllowEdit and IgnoreEDTRelation on
  table fields.** `d365fo_file(action="modify", objectType="data-entity")` now supports
  `modify-property` for `ConfigurationKey`, `PrimaryCompanyContext`, `CountryRegionCodes`,
  `SingularLabel` and the Yes/No entity properties (`IsObsolete`, `AllowArchival`,
  `AutoCreateDataverse`, `EnableSetBasedSqlOperations`, `ValidTimeStateEnabled`, alongside the
  ones the bridge already handled). It writes one top-level property per call, in the
  serialised element order measured over shipped entities. A nested path is refused, and
  `Modules`, `OperationalDomain` and `SubscriberAccessLevel` are refused because their values
  are not validated here; `EntityCategory` must be one of the enum's values. Space-indented
  entity and table files are edited too. `add-data-source` adds an embedded, joined query datasource
  (`joinField`, `relatedField`, `linkType`, `dataSourceReadOnly`) and `add-field` a mapped
  field (`dataField` + `dataSource`). These used to fail with "Unknown AxDataEntityView
  property" / "add-data-source not supported for objectType 'data-entity'" and ended in a
  hand-edited file. Entity `create` now also honours `isReadOnly`, `tags`, `configurationKey`,
  `primaryCompanyContext` and `surrogateKey` (a `SourceKey` field mapped to `RecId`, as
  shipped entities name it), lists any `properties` key it does not read instead of dropping
  it silently, and says when `dataManagementEnabled` writes a staging-table reference that
  nothing creates. `dataManagementEnabled` now accepts `"Yes"` / `"true"` as well as `true`,
  like the other Yes/No properties. Table `create` accepts `fields[].allowEdit` and
  `fields[].ignoreEdtRelation`, and `modify-field` accepts `fieldAllowEdit` and
  `fieldIgnoreEdtRelation` (for `BPErrorTablePrimaryKeyEditable` and `BPErrorEDTNotMigrated`).
  A table field given only `enumType` is now an enum field (it became a string field through
  the bridge).
- **Tables get "Subscriber access level", as Visual Studio creates them
  (#1073).** A new regular table now carries
  `<SubscriberAccessLevel><Read>Allow</Read></SubscriberAccessLevel>`, which
  VS writes on every new table. TempDB/InMemory tables get none — a choice
  rather than a measured rule, since about a quarter of shipped temporary
  tables carry the element, the same share as regular ones. The property
  can be set on create (`properties.subscriberAccessLevel`: `"Read=Allow,Create=Deny"`,
  `{ "read": "Allow" }` or `"None"`) and with
  `modify-property propertyPath="SubscriberAccessLevel"`; an invalid value is
  refused before anything is written. Table reads show
  it together with `AllowRowVersionChangeTracking`. It holds one child element
  per permission, so the scalar property writer could neither express nor place
  it, and the name was dropped. `AllowRowVersionChangeTracking` stays opt-in:
  it is not a Visual Studio default. The regular-table eval goldens now include
  the element.

### Fixed
- **Extension-class names under the `prefix` and `model-name` class styles now
  match the infix / model token only as a separate PascalCase word. This changes
  the name existing `prefix`-style users get for some bases.**
  - A base whose last letters spelled the infix was read as already prefixed and
    never got one: with prefix `Le`, `SalesTable` was written as
    `SalesTable_Extension`; it is now `SalesTableLe_Extension` (likewise `Ne` +
    `SalesLine` → `SalesLineNe_Extension`). Names that really end in the infix
    (`CustTableCtso_Extension`, `CustTableCTSO_Extension`) are kept as before.
  - A bare base that begins with the infix as a word was also read as already
    prefixed: `ProjTable` under prefix `Proj` gave `ProjTable_Extension`, and is
    now `ProjTableProj_Extension` (also `TaxTrans` + `Tax`, `CRMTable` + `Cr`).
    A full name you pass already ending in `_Extension` (`ProjTable_Extension`)
    is still kept as given — from the name alone it cannot be told apart from a
    prefixed one.
  - `model-name` style no longer cuts a base whose last letters spell the model
    token (`SalesTable` under model `Able` was written `SalesT_Able_Extension`).
  - `validate_object_naming` derives the base by the same rule, so it no longer
    accepts `SalesTable_Extension` as carrying the infix `Le`.
  - A class-extension skeleton created without `properties.baseClass` derived its
    `[ExtensionOf(classStr(…))]` target with a regex that only fit the
    `model-name` shape — `CustTableCtso_Extension` targeted itself. It now uses
    the same base derivation for all three class styles.
- **`labels(action="rename")` is now held to the cross-model write guard.**
  `labels(action="create")` refused to write a label into another model's
  label file, but a rename of a label in that same file went through and
  rewrote it. The rename now gets the same refusal (also for `dryRun:true`),
  and the same configuration (`D365FO_CROSS_MODEL_WRITE_MODELS`,
  `D365FO_ALLOW_CROSS_MODEL_WRITE`) allows it, with a note on the result.
  References the rename finds through `searchPaths` are held to the same
  guard: a file in another model, or outside every package root, refuses the
  whole rename before anything is written.
- **`labels(action="rename")` no longer creates a duplicate label ID.** In a
  `.label.txt` without a BOM, an ID on the first line was invisible to the
  "target already exists" check, so renaming another label onto it left two
  declarations of the same ID (and renaming that first-line label itself
  answered "not found"). The checks and the rewrite now read the file the same
  way. The rename also keeps the file's BOM as it was instead of adding one.
- **`find_references` without the xref database no longer drops calls written
  in a different letter case or with a space before the parenthesis.** X++
  identifiers are case-insensitive, so `this.validatewrite()` and
  `this.validateWrite ()` call `validateWrite` — the index lookup matched them,
  then an exact `validateWrite(` text match threw them away. The same applies
  to instantiations (`new mycontroller ()`). The match also no longer takes a
  longer name ending in the target (`revalidateWrite(`) for a call, and a
  call found both in the index and in the declaring type's file is listed once.
- **`web.config` / `SysTestConsole.exe.config` settings are read as XML reads
  them.** A previous `Infrastructure.HostUrl` kept in a `<!-- … -->` comment
  above the live one was taken as the AOS address by `restartAos` without an
  `aosUrl`, and the SysTest data-access check read commented-out entries too.
  That check also missed an entry written `value="…" key="…"` and compared
  `&amp;` undecoded. Both now go through one reader (`src/utils/appSettings.ts`)
  that skips comments, accepts any attribute order and quote style, decodes
  entities and reads only `<appSettings>`.
- **A source changed while a build was running no longer comes back as
  compiled.** Whether a finished build result still describes the disk was
  measured from when the build *ended* — written only after runtime metadata
  regeneration (and the AOS restart, when asked for). A file edited during
  the compile or the "finalizing" phase (~40 s on a real VM) was older than
  that, so the next call collected "✅ Build succeeded" for sources xppc never
  saw. It is now measured from when the build started; the build's own
  outputs (`bin`, `XppMetadata`, and labelc's `Resources`) are not counted.
- **labelc no longer runs on every build of a model whose label file has
  its own name.** The "are the label assemblies current?" check looked for
  `Resources\<model>.dll`, but labelc writes one assembly per label file
  (`Resources\<LabelFile>.dll`). A model such as `VLTBase` with label file
  `VLTLabel` never had the file it looked for, so every build recompiled
  its labels and rewrote `Resources`.
- **Table info without the C# bridge no longer answers "not found" for
  standard tables.** The symbol-index fallback rejected every row whose
  recorded file path did not exist on this machine, but the index records the
  path it was built at: a CI build agent for the shipped index, or an older
  UDE version folder after an upgrade. So `CustTable` and every other standard
  table came back "not found" although the index held the full field list. A
  row now counts as stale only when the table's folder is present here and the
  file is not, which is the rolled-back object the check was written for. Table
  names also resolve case-insensitively (#1071).

## [1.19.1] — 2026-09-30

### Fixed
- **`d365fo-mcp update` no longer fails on Windows when it renames the
  installed package.** npm replaces a global package by first renaming its
  folder under `%APPDATA%\npm\node_modules`. The update started npm from inside
  that same folder, and Windows does not rename a folder that is a running
  process's working directory, so npm stopped with `EBUSY`/`EPERM`. npm now
  runs from the home directory. If the install still fails, the command says
  that a running MCP server can also lock the folder.

  **Updating from 1.19.0 or older:** `d365fo-mcp update` still runs the old
  code, so it fails once more. Install this release by hand. Close VS Code /
  Visual Studio first if they run the MCP server, then start npm from any
  folder outside the package:

  ```
  cd C:\
  npm install -g d365fo-mcp@latest
  ```

  From 1.19.1 on, `d365fo-mcp update` works again.

## [1.19.0] — 2026-09-29

### Added
- **`build_d365fo_project` can restart the local AOS after a successful build**
  (`restartAos: true`, off by default). A build can succeed while a new object,
  for example a menu item, is still missing in the browser until the AOS is
  restarted. With `restartAos` the tool does that restart itself, once
  compilation, runtime metadata and any requested DB sync have succeeded. It
  restarts only the one local IIS `AOSService` pool or IIS Express instance that
  matches the environment URL, then waits until the AOS answers again. The URL
  is `aosUrl`, or on a classic VM `Infrastructure.HostUrl` from
  `AosService\WebRoot\web.config` (UDE needs `aosUrl`). When the match is
  ambiguous or the restart can't be confirmed, it says so instead of guessing,
  and collecting the result later never restarts again. If the server exits
  before the restart stage, the next build releases its reservation; only an
  exit during the restart itself needs a manual check. See `docs/AOS_RUNTIME_RESTART.md`.
- **`d365fo_file(action="project")` manages Visual Studio projects.** The server could
  add objects to an existing `.rnrproj` but not make, remove or re-populate one, so a new
  ticket started with a hand-written project file and a hand-edited `.sln`. One action,
  picked with `params.operation`:
  - `create` writes `<projectsRoot>/<name>/<name>.rnrproj` (BOM + CRLF, fresh GUID, build
    tasks version taken from a sibling project) and registers it in the solution — a
    shared `<Model>.sln` (with `dependsOn` written as `ProjectDependencies`) or a new
    per-project `.sln`, detected from the folder; an undecidable layout stops and asks.
    It is configured for every configuration the solution declares, mapped the way its
    existing projects are. The new project becomes the active one, and a project made
    for another model keeps the write anchor on the workspace's own model.
  - `delete` takes a project out of its solution (entry, configuration and dependency
    lines) and, with `removeFiles`, deletes only its own files. A folder holding anything
    else, or a project no solution lists, is refused. Model metadata is never touched.
  - `add-object` / `remove-object` register existing objects in, or unregister them from,
    a project (up to 20 per call, objects of its own model only), including label
    files (`objectType="label-file"`, add only). The files stay; removing the last reference needs `allowOrphan`.

  Nothing is overwritten, and the folder must already look like a projects folder.
  Contract: `get_knowledge(kind="op-spec", topic="project")`.

### Fixed
- **`d365fo_file(action="project")` checks an explicit label-file `languages` list
  against the files on disk.** `add-object` with `objectType: "label-file"` and a
  `languages` list wrote an entry for every listed language without looking for its
  `<name>_<lang>.xml`, so a language with no file (or a mistyped tag) was registered and
  the Visual Studio build failed later. Without the list the languages already came from
  disk; with it, a language that has no file is now refused, naming the ones that exist.
- **The name-based `find_references` fallback no longer counts a method's declaration as
  a call to it, and says what a table count leaves out.** In the declaring method's own
  body the first `name(` is `public void name(`, which was reported as a caller; it is
  skipped now (a recursive call still counts). A table target used to get a bare number,
  although its declarative references — form data sources, relations, entity mappings —
  are only in the cross-reference database; it now says so, as an EDT target already did.
- **`find_references` finds methods added by `[ExtensionOf]` classes.** The
  cross-reference database records such a method under the extension class only
  (`/Classes/<Ext>/Methods/<m>`); `Owner.method` queried `/Tables/<Owner>/Methods/<m>`,
  which does not exist, and reported 0 for a method with callers. It now also queries
  every class extension of the owner that declares the method, from the index's
  extension records. A bare method name (no owner) is resolved to the types that
  declare it and queried by their full paths, instead of reaching the bridge as a bare
  name that matches nothing and falling back to the name-based search; past 25
  declaring types it stays a bare-name lookup.
- **`find_references` includes declarative metadata references.** The bridge looked
  a target up only in its X++ shape (`/Tables/X`, `/Edts/X`), on the belief that
  targets are always plural with a leading slash. Metadata references are stored
  singular and without it, and for an EDT under its concrete subtype (`Table/X`,
  `Form/X`, `EdtString/X`, members `Table/X/TableFieldString/F`, `Table/X/Method/M`):
  on a live DYNAMICSXREFDB 2.3M of 19.5M references. A custom table's where-used
  returned 334 of its 785 references, missing every form data source and entity
  mapping; a custom EDT's, 12 of 108, missing every table field typed with it. Both
  shapes are queried now — including for `Owner.member` and explicit AOT paths, whose
  metadata twins are derived for methods of tables, classes, forms, views, data entities
  and maps, and for fields of tables, maps, views and data entities, each field under
  its exact type segment (a wildcard also matched a field group of the same name) —
  and metadata rows read as "object › member › property".
  The bridge returns exact totals split into code and metadata (references whose source
  no longer exists in the database are left out of both, as they are of the rows), and up to 500 rows per
  shape instead of 500 in all: sorted by source path, code rows used to fill the cap, so
  a large table (CustTable) showed no metadata reference at all. The list gives each
  shape its share of `limit`. A `targetType` that names a type now scopes a bare name to
  it (`CustTable` with `table` no longer counts the form, menu item and query named
  CustTable). The bridge's `--xref-database` help no longer claims a default it does
  not have.
- **The cross-reference database can be configured on a traditional VM.** The bridge got
  its DYNAMICSXREFDB server and name only from the XPP config, which exists only on UDE,
  so on a traditional VM it always started without cross-references and `find_references`
  quietly answered from its name-based search, missing every metadata reference. New
  settings `bridge.xrefDbName` / `D365FO_XREF_DB_NAME` (usually `DYNAMICSXREFDB`) and
  `bridge.xrefDbServer` / `D365FO_XREF_DB_SERVER` (defaults to localhost) take
  precedence over the XPP config, and `doctor` says when a traditional VM has none set.
- **`find_references` finds enum values, members an extension adds, entity members,
  table indexes, field groups and form data source methods.**
  An enum value is found as `Enum::Value` or `Enum.Value` (`/Enums/E/EnumValues/v`,
  `Enum/E/EnumValue/v`); there was no way to ask for one. A table field or enum value
  an extension adds is stored under the extension only (`/TableExtensions/T.Ext/Fields/f`,
  `/EnumExtensions/E.Ext/EnumValues/v`, and their metadata shapes), so `PurchLine.<added
  field>` returned 0; those are queried now. The index records a data entity as a view,
  so `Entity.field` was looked up under `/Views/` and matched nothing. New `targetType`
  values `data-entity`, `map` and `menu-item` scope a bare name like the other types do:
  an entity is not under `/Views/`, and a menu item often shares its name with the class
  or report it runs. `Table.Name` with `targetType` `index` or `field-group` finds a table
  index (`/Tables/T/TableIndexs/i`, `Table/T/TableIndex/i`) or field group
  (`/Tables/T/TableFieldGroups/g`, `Table/T/TableFieldGroup/g`); only when asked, because
  they often share a name with a field. `Form.DataSource.method` finds a form data source's
  method (`/Forms/F/DataSources/DS/Methods/m`, `Form/F/FormDataSourceRoot/DS/Method/m`).
- **A button added with `add-control` shows its caption** (#1047). The label was always
  written as `<Label>`, but buttons keep their caption in `<Text>` and groups in
  `<Caption>`. D365FO dropped the unknown element without an error, so the button
  rendered blank while the tool reported success. The caption element now follows the
  control type, in the order shipped forms use, on both the form-extension writer and
  the bridge. A data binding that the control type cannot carry (for example
  `dataField` on a Button) is no longer written; the reply says it was skipped.
  `controlType: "CommandButton"` and `"MenuFunctionButton"` in a form extension were
  written as String controls; they now produce the requested button.
- **`d365fo_file(action="project")` only touches projects under the configured solution
  roots.** Its `.rnrproj`/`.sln` writes and deletes were bounded only by "the folder looks
  like a projects folder", which every Visual Studio repo on the machine passes, and so
  does `%TEMP%`. One call could take a project out of another repo's solution and
  delete its files, or add a project there. `create`, `delete`, `add-object` and
  `remove-object` now refuse a path outside `D365FO_SOLUTIONS_PATH`, `workspacePath` or
  `solutionPath`. The error names these settings. The active project does not
  count as a root, because `create` activates what it makes and a project created in a
  foreign folder would otherwise vouch for the next call there. `delete` checks the
  projects folder rather than the project, since the shared `.sln` it rewrites sits one
  level above the project folder.
- **A table field's length is available without the bridge.** The full index
  build stored a field's bare base type as its signature and dropped the EDT the
  extracted metadata carried, so `DirPartyTable.Name` indexed as `String`
  rather than `DirPartyName`. `update_symbol_index` already stored the EDT, so
  the same column meant different things depending on which path last wrote the
  table. On a deployment with no bridge, `get_object_info(table)` therefore could
  not give a field's length at all, and an agent asked for it had to guess. The full
  build now stores the EDT (or enum type, or the base type when a field has
  neither), the same as the incremental path. The index-only table reader
  resolves each field's size through the EDT chain in `edt_metadata`:
  `Name: DirPartyName (String Size 160)`, and for a derived EDT that declares
  no size of its own, `(String Size 160, inherited from DirPartyName)`.
  The EDT is found whatever casing the field spells it in, and the output says
  the size leaves EDT extensions out — the index stores none, and an extension
  can change `StringSize`. Consumers that read the signature as an EDT —
  relation generation, table patterns, find-method parameter types, "fields
  typed as X" — now get one on a full index too. **Takes effect only after a
  full index rebuild.**
- **`search` ranking is unchanged by the above.** `search` full-text-matches
  the signature, and a table field is very often named after its EDT, so such a
  field would have matched the EDT's name twice and outscored everything that
  matches it once: on an ApplicationPlatform + Directory + Foundation index,
  `CustName` returned 20 fields called CustName out of 20 and lost every EDT and
  method. Table fields are now scored without their signature, which is exactly
  how they scored when it held a base type; view and data-entity fields, whose
  signature was never an EDT, keep theirs. Across 12 common EDT-name queries the
  top 20 is identical to the previous index's. The query still sorts by FTS5's own
  `rank` and re-scores the streamed rows, stopping as soon as no later row can enter
  the window: sorting on the score expression in SQL gave the same answer but made a
  broad query 2–3× slower on a full index (`Trans` 172 → 499 ms). Streamed, it costs
  0–45 ms (`Trans` 189 ms, `Name` 64 → 107 ms, warm cache).

### Dependencies
- **Major:** `vitest` and `@vitest/coverage-v8` 4.1.11 → 5.0.2 (dev only; no test or
  config change was needed, the coverage thresholds hold) and `dotenv` 17.4.2 → 18.0.4.
  dotenv 18 keeps the `config`/`parse` API the server uses; its log line moved from
  stdout to stderr, and the server passes `quiet: true` anyway, so the MCP stdio stream
  stays clean (checked with an `initialize` + `tools/list` round trip).
- Within the existing ranges: `@modelcontextprotocol/sdk` 1.30.0 → 1.31.0,
  `@azure/storage-blob` 12.33.0 → 12.34.0, `@types/node` 26.6.1 → 26.6.3, `tsx`
  4.23.13 → 4.23.15, plus transitive updates. Supersedes Dependabot #1058–#1063.

## [1.18.0] — 2026-09-24

### Added
- **Extension classes can follow their own naming style.** `EXTENSION_NAMING_STYLE`
  drove two independent decisions — the token of an element extension
  (`CustTable.ContosoRobotics`) and that of a CoC class
  (`CustTable_ContosoRobotics_Extension`) — so a convention spelling them
  differently had to pick one and have the other rewritten on every `create`.
  New setting `naming.extensionClassStyle` / `EXTENSION_CLASS_NAMING_STYLE`
  (`inherit` | `prefix` | `model-name`) applies to extension classes only; the
  default `inherit` keeps today's behaviour. `applyObjectPrefix`,
  `normalizeObjectName`, the naming check, `validate_object_naming` and
  `get_workspace_info` each ask the style that belongs to the name in hand.
- **Method bodies are served from the symbol index when the bridge and the
  metadata files are both unreachable.** A read-only deployment has neither a
  C# bridge (.NET Framework) nor a PackagesLocalDirectory, which were the only
  two sources the body readers consulted, so every request for X++ source there
  answered "not found" or "signatures only" — for bodies the server had already
  indexed. `symbols.source` is populated at index time for every method-owning
  type: measured on a production index, 639,397 method rows, 100% with a
  non-empty body, averaging 763 characters against the 331-character
  `source_snippet` preview. `get_object_info` (both `options:{method,
  include:"source"}` and the `compact:false` listing) and `find_references` now
  fall back to it, always LAST, and label the output as coming from a snapshot
  that can lag the live model. No schema change, no re-index. What it does not
  change: `symbols_fts` still indexes `source_snippet`, so which methods
  `find_references` can FIND is the same — a caller that never mentions the name
  in its first ten lines stays invisible.
- The fallback is skipped when the object's own metadata file WAS read and does
  not declare the method. That is a live fact about the model, and the index is
  a snapshot that can still hold a method renamed or deleted since — serving it
  would beat a correct "not found" with a stale body, under a line claiming the
  metadata files were unavailable when one had just been parsed.
- **A model descriptor's `<ModuleReferences>` can be edited through the tool**
  (#1030, #1031). New `objectType="model-descriptor"` on
  `d365fo_file(action="modify")` with `add-module-reference` /
  `remove-module-reference` (parameter `moduleReference`) — the last file under
  `Metadata/` with no write path, so adding a reference before writing code that
  names another model's type no longer means hand-editing XML. XML-only; nothing
  is created implicitly (a missing descriptor or `<ModuleReferences>` element is
  reported, not invented); a duplicate is refused case-insensitively; the module
  is probed as a package folder and a miss warns rather than refuses; the entry
  lands in sorted position when the file is sorted, indentation and BOM are kept,
  and an `i:nil="true"` element is materialised the way Visual Studio does it. A
  standard Microsoft model's descriptor is refused, and only
  `objectType="model-descriptor"` may target a descriptor path at all.
  `get_workspace_info(diagnostics=true)` lists the current references, and a
  write refreshes the model's visibility cache so `resolve_references` sees it
  without a restart. Before release, an audit found that the FIRST reference
  added to a descriptor with none was followed by the write's preservation guard
  "restoring" duplicate `Publisher`/`SolutionId`/`Version*` elements out of
  order — its XML scan did not recognise the end tag `</d2p1:string>`.
  Namespace-prefixed element names are now part of that grammar.

### Changed
- **The model-visibility oracle is stricter** (#1030). The descriptor parser
  scanned the whole document for `<d2p1:string>`, so `<InternalsVisibleTo>` and
  `<AppliedUpdates>` entries counted as module references: 112 of 176 real
  descriptors over-reported, 606 phantom references in all. Both the build-queue
  ordering of `build_d365fo_project` and the visibility check behind
  `resolve_references` read that list, and every phantom made the check more
  permissive. Only `<ModuleReferences>` is read now — so "type not visible"
  findings that were silently waved through can appear, and under
  `GROUNDING_ENFORCE=true` they can block a write.

### Fixed
- **`generate_object` names an extension class what `create` will write** (#1041).
  The pattern generator assembled `{Base}{Infix}…_Extension` by hand, while
  `d365fo_file(action="create")` normalises every `_Extension` name with the token
  right before `_Extension` — so `SalesTableCRForm_Extension` and
  `SalesTable_SalesLineCRDS_Extension` were written as `…CRFormCR_Extension` and
  `…CRDSCR_Extension` even in the default style, and a model-name class style was
  ignored outright. The generator now asks the writer's own `normalizeObjectName`,
  in every style including `EXTENSION_CLASS_NAMING_STYLE`. The form-handler,
  form-datasource and form-control skeletons therefore carry the token after
  `Form`/`DS`/`Ctrl` (`SalesTable_SalesLineDSCR_Extension`), the placement shipped
  code uses: of 217 form data-source extension classes, 12 put it after `DS` and
  none before.
- **A misspelled naming style is flagged instead of silently meaning the default.**
  `EXTENSION_NAMING_STYLE=modelname` behaved as `prefix`, and an unknown
  `EXTENSION_CLASS_NAMING_STYLE` as `inherit`, with nothing said. `get_workspace_info`
  now names the variable, its value and what it is treated as.
- **A write the bridge declined is no longer reported as a write that happened.**
  The bridge answers a skipped operation with `{ success: true, skipped: true, reason }`
  — nothing failed, nothing changed. `BridgeWriteResult` never declared `skipped`, so
  not one wrapper read it: all four skippable operations (`add-field` on a
  data-entity-extension, `add-field-to-field-group`, `add-menu-item-to-menu`,
  `add-data-source`) fell through to their success branch and rendered
  "✅ … added" over a file the provider never opened, discarding the bridge's own
  explanation on the way past. A batch of three such operations replied
  "✅ 3/3 operation(s) applied" and "✅ Verified: on disk" over a byte-identical
  file whose mtime had not moved; the caller then built and checked in against
  metadata that did not exist. `skipped` and `reason` are now on the result type,
  rendered by `skippedMessage()` as "⏭️ NOT written — …" with the reason, counted
  separately in the batch header ("2/3 applied, 1 skipped"), and kept out of the
  set of files the per-file "Verified: on disk" and symbol-index trailers sign off
  on — in a batch and on a single operation alike. The symbol index was never at risk: it re-parses from disk, so it recorded
  the unchanged file correctly throughout.
- **`add-data-source` no longer drops a data source because its table is already
  bound.** The idempotency guard skipped on a *table* match as well as a name
  match, on the stated theory that "adding a second binding to the same table is
  almost always an accident". A form routinely joins one table into several
  branches of its query — Microsoft's own `PurchLineBackOrder` carries `PurchTable`
  and `PurchTable1`, both over `PurchTable` — so the rule silently discarded
  legitimate metadata — and not only through joins: a census of the 8,310 shipped
  forms with data sources found 313 that bind one table in two or more *unjoined*
  root data sources (`DocuHistoryForm`: `DocuHistoryHeaderDS` and
  `DocuHistoryGridDS`, both over `DocuHistory`), so no join-based narrowing of the
  rule would have been safe either. Both the `form` and `form-extension` branches
  now skip on a name collision only. A data source whose table is already bound
  is written and the reply names the existing bindings, so an accidental
  duplicate of a template stub is visible without being refused. **Requires a rebuilt bridge binary**; the reporting fix
  above is TypeScript and takes effect without one.
- **The naming check no longer warns about the canonical extension-class name.**
  `CustTableBku_Extension` is exactly what the prefix style produces and what the
  write path returns untouched, yet the check answered "Extension name does not
  include model's extension infix Bku" and recommended `CustTableBkuBku_Extension`.
  When `baseObjectName` is not supplied it is derived as everything before
  `_Extension` — `CustTableBku` — which leaves an empty middle for the infix test to
  look at. `prepare(mode="create")` never sends `baseObjectName` and the validator's
  parameter is optional, so the warning landed on every correctly named extension
  class asked about through either door. The derived base now gives the token back:
  it also fixes the reported `Base Object:` (`CustTable`, not `CustTableBku`) and the
  suggestions built from it, which had offered `CustTableBku.BkuExtension`.
- **The check now says when the write path will use a different name.** An assembled
  name such as `CustTable_Bku_Table_Extension` satisfies every rule and then lands on
  disk as `CustTable_Bku_TableBku_Extension`, because the trailing `_Extension` makes
  the whole string read as a base class and the infix is applied a second time; the
  caller went looking for the file under the name it asked for. `class-extension`
  names are now compared against what `d365fo_file(action="create")` would write, and
  a difference is reported with both names. Only when the token both paths use is the
  same one — an explicitly passed `modelPrefix` is not what the writer reads — and not
  on a name already rejected.
- **Converting a model-name-styled class name to the prefix style left a stray
  separator.** `CustTable_ContosoRobotics_Extension` under `EXTENSION_NAMING_STYLE=prefix`
  became `CustTable_Ctso_Extension`: the model token was stripped but the underscore it
  sat behind was kept, so the infix landed one character late. It is now
  `CustTableCtso_Extension`, the spelling every name of this shape in
  PackagesLocalDirectory uses.
- **A full build shipped runtime metadata for code that no longer existed**
  (#1026). xppc's metadata write-back does not reliably refresh an existing
  `XppMetadata` tree: a class whose field was removed compiled to IL without it,
  while its `XppMetadata` — and so the binary `.md` manifest serialized from it —
  still declared it, under a green build. `build_d365fo_project(fullBuild: true)`
  now clears the model's compiler-metadata tree before compiling, so the
  write-back is unconditional; a failed delete warns (the `.md` may then not
  match the code) rather than failing the build. The incremental counterpart is
  the next entry.
- **An incremental build still shipped runtime metadata for code that no longer
  existed.** xppc's metadata write-back rewrites an element's
  `XppMetadata` file when the element gains something, but never when it loses
  something: a removed field or a deleted class stays declared there, and the
  binary `.md` manifests are serialized from that tree — under a green build.
  #1026 fixed this for `fullBuild: true` by clearing the whole tree; an
  incremental build (the default) cannot do that, because xppc then writes back
  only what it recompiles and every unchanged element would disappear. Before
  every incremental compile, `build_d365fo_project` now deletes only the
  metadata files whose source is newer (and touches that source, so xppc is
  sure to recompile it even if an earlier build already did) or whose source is
  gone. A model folder with no source at all is left alone. Verified against
  xppc on a UDE box: removed fields and deleted classes disappear from the
  metadata and the `.md`, unchanged elements are untouched, and the scan takes
  ~0.3 s for a 4,400-element package.
- **Writing a descriptor no longer invents a class or a missing project entry**
  (#1030). A file in no `Ax*` folder was classified as a class by the symbol
  indexer — every descriptor write added a phantom CLASS named after the model,
  which `search` returned as an exact match — and the inline write verification
  reported a missing `.rnrproj` entry for an invented `AxClass\<Model>`. Such
  files are no longer indexed (a re-index cleans up earlier phantoms), and the
  membership check is skipped for any type with no `Ax*` folder.

### Dependencies
- Routine lockfile refresh within the existing semver ranges: `@clack/prompts`
  1.8.0 → 1.8.1, `@biomejs/biome` 2.5.12 → 2.5.14, `@types/node` 26.5.1 →
  26.6.1, `zod` 4.6.1 → 4.6.5, `hono` 4.13.7 → 4.13.8, plus transitive updates
  (`package-lock.json` only). `@clack/prompts` 1.8.1 now types a cancelled
  prompt as `typeof CANCEL_SYMBOL` instead of `symbol`, which broke the
  type-check of every CLI prompt; the CLI's `ensure()` helper now strips any
  symbol from the result type. No runtime change.

## [1.17.4] — 2026-09-10

### Dependencies
- Routine bump of direct dependencies within their existing semver ranges:
  `@clack/prompts` 1.7.0 → 1.8.0, `@types/node` 26.4.1 → 26.5.1, `zod` 4.5.4 →
  4.6.1, plus the transitive updates `npm install` pulled in alongside them
  (`package-lock.json` only — no `package.json` range changed).

### Fixed
- **`doctor` kept its own copy of the query that hung the server, and the copy
  was the unfixed one.** 1.17.3 put the unary `+` on the prefix sample's
  `parent_name IS NULL` so the planner seeks `idx_symbols_model`; `doctor` read
  the same evidence through a duplicate of the query that never got the fix, so
  the command a user runs *because* the server looks stuck took the same eight
  minutes — and, missing the two-band split as well, inferred the prefix from a
  different sample than the server it was diagnosing. Measured on a production
  database (1,188,748 rows, 2.5 GB) with a cold file cache: **483 s** on the
  plain plan, 632 ms warm, 17 ms on the model plan. Both now call one
  `readModelObjectNames`, and a test EXPLAINs the SQL that function actually
  issues rather than a copy written in the test, which is what let the two drift
  apart in the first place. A sweep of the other nine `parent_name IS NULL`
  queries found no third instance: every one of them carries a selective
  equality (`name`, `type`, `file_path`) that outranks the parent_name index.
- **The drive scan no longer blocks the event loop.** C:, K:, J: and I: are
  probed unconditionally — deliberately, since skipping one hides the packages
  root on it — but `statSync` on a disconnected mapped network drive freezes the
  thread it runs on for the SMB timeout, and on the main thread that is every
  request, every log line and every heartbeat. The scan now runs on
  `fs.promises` (`warmPackagesRoots`), started at server startup in both
  transports and awaited by `ConfigManager.ensureLoaded()`, which every request
  passes through before it reaches a synchronous getter. Same letters, same
  budget, same ranking — the stall just lands on the libuv threadpool instead.
  Probes stay sequential on purpose: the pool has four threads, and several dead
  drives probed at once would occupy all of them. The synchronous scan remains
  as the fallback for the CLI and for anything that beats the warm-up.

### Changed
- **`idx_symbols_parent_name` is dropped, and the prefix sample gets a covering
  index.** Two schema changes that between them retire the defect above rather
  than patch it again.

  The bare index on `parent_name` earned no query and cost several. Verified on
  the production database before removing it: every legitimate member lookup —
  `parent_name = ?`, `parent_name = ? AND type = ?`, `type = ? AND parent_name = ?`
  — already planned on `idx_parent_type_name` (covering) or `idx_type_parent`.
  The one shape that chose the bare index was `parent_name IS NULL`, which is
  the shape it must never serve. 1.17.3 defused the known instance with a unary
  `+`; dropping the index means no future query can be captured by it, whether
  or not whoever writes it knows to add the guard. The `+` guards stay: they
  cost nothing, they document the hazard, and they still hold on a database
  built before this.

  `idx_model_type_name ON symbols(model, type, name, parent_name)` covers the
  sample outright. Without it the plan seeks `idx_symbols_model` and then reads
  the table row by row, and since the query is `ORDER BY type, name LIMIT n` it
  had to pass over EVERY row of the model before the limit could apply — so a
  large model cost 9.2 s cold and 2.4 s warm even on the *right* index. Ordered
  (model, type, name) the seek walks in the order asked for and stops at the
  limit, and with `parent_name` carried as a fourth column nothing touches the
  table at all.

  Measured end to end on a copy of the production database (2,386 MB,
  1,188,748 rows): the prefix read for a large model goes **1,143 ms → 0.2 ms**,
  and the plan loses its `USE TEMP B-TREE FOR ORDER BY`. `ANALYZE` is
  deliberately not run afterwards — verified with zero `sqlite_stat1` rows for
  the new index, the planner still chooses it, because a covering index that
  also satisfies the ORDER BY wins structurally rather than statistically.

  Migration costs, also measured on that copy: the `DROP` is **139 ms** and
  frees its pages without reading the table, so it runs inline at open. The
  `CREATE` is **53 s**, which is precisely why it does not: it joins the
  existing deferred-index mechanism (`ensureFilePathIndexes` → renamed
  `ensureDeferredIndexes`), inline on a small or empty database and on a worker
  thread on a large existing one. Building it on the main thread would have
  recreated the very startup freeze this release removes. Net file size
  2,386 → 2,402 MB: the dropped index frees most of what the new one takes.
- **"Still loading" says what it is loading.** A first start with an empty
  database indexes the whole packages directory before `dbReady` resolves —
  tens of minutes on a real install — and every symbol-backed tool in that
  window got a sentence that was byte-identical on the first retry and the
  twentieth, so nothing distinguished a build that was progressing from a server
  that had died. `indexMetadataDirectory` now reports its phase, the startup
  worker forwards it, and the wait answers with the model being read and its
  position in the build order ("model 3 of 32, 6 min in"). Deliberately no
  percentage: models are indexed largest-first and differ by two orders of
  magnitude in size, so a percentage drawn from the count would be a confident
  lie — the honest signal is that the count keeps moving.

---

## [1.17.3] — 2026-09-07

### Fixed
- **The first `get_workspace_info` of a session took 337 s and printed
  nothing.** Measured live on 2026-09-07, and 356 s / 424 s on two earlier cold
  starts; the same call warm is 0.2 s. Three independent causes, all fixed:
  - The prefix inference behind the `Prefix :` line seeked on the wrong index.
    `parent_name IS NULL` reads like an equality and `ANALYZE` prices it as one
    (~13 rows per value), but NULL is every top-level object of every model —
    180,664 of 1,188,748 rows on a production index, against 274 for the model
    being asked about. The term now carries the unary `+` that strips its index
    affinity, so the seek is on `idx_symbols_model`: 454 ms to 1 ms warm, and
    cold the difference between minutes of random reads over a 2.5 GB file and
    none. The sample of regular objects is also capped at 60 (extensions stay
    first and uncapped): inference needs four of them and decides on 60 %
    coverage, so reading 400 answered a question 60 settle.
  - `get_workspace_info` skipped the `dbReady` wait, and with it the 55 s
    ceiling every other tool has. The exemption rode on `LOCAL_TOOLS`, which
    answers a question about *locality* — can this run away from the `K:` drive
    — and was read as "needs no index"; this tool reads the index twice. It now
    waits, and says "still loading, retry" instead of hanging. So does
    `update_symbol_index`, which writes THROUGH the context's symbol index and
    before the swap was reindexing the in-memory stub and reporting success.
  - Nothing could be printed while it worked. In stdio mode `console.log` is
    filtered down to error-bearing lines, and the `LOG_FILE` mirror sits on
    stderr, so every startup progress line was dropped from both — a five-minute
    hang left a log holding a start banner and nothing else. Those lines are now
    kept in `LOG_FILE`, timestamped, while the client's pane stays clean, and an
    in-flight tool call re-announces itself every 15 s so a slow call is
    distinguishable from a stuck one (and, for clients that honour progress
    notifications, its request timeout is reset).
- **`get_object_info(include="xml")` could not read another model's object.**
  It resolved the file through the configured model's folder layout and nothing
  else, so a Microsoft class — or any other custom model's — came back as "no
  file on disk, pass `options.modelName`", a whole round trip for a fact the
  same tool prints in every other include mode (`**Model:** Foundation`). The
  lookup now falls back to the symbol index, which knows every model, resolves
  the rows that store a path relative to a packages root, and checks each
  candidate on disk so a stale index row stays a clean "not found". The message
  names the models that DO hold the object: told only to pass `modelName`, an
  agent guessed `"Application Foundation"` before `"Foundation"` — three calls
  for one file.
- **"Call again for the verdict" could never be carried out.** Both background
  scans behind `get_workspace_info` (index freshness, recently edited objects)
  cached their result for 30 s and then fell back to "still running", so an
  agent re-asking any later than that got the identical line — observed as three
  calls 105 s apart with byte-identical output. `pending` is now said only until
  the first scan completes; after that the last result is served and the refresh
  runs behind the answer. A `fresh` verdict drawn from an aged scan says how old
  it is; `stale` does not need the caveat, since files only ever get newer.

---

## [1.17.2] — 2026-09-04

### Changed
- **Workspace detection prints only conflicts.** The four-line
  `Auto-detection successful` block (ProjectPath / ModelName / SolutionPath /
  Source) went to stderr on every start, and VS Code shows every stderr line as
  `[warning]` - four warnings per session on every machine, working or not,
  which made a healthy resolution look like a fault. The routine outcome (and
  the cache-hit, root-match, git-branch and BFS-fallback lines around it) now
  goes to the debug log (`DEBUG_LOGGING=true`); `get_workspace_info` and
  `d365fo-mcp doctor` still report the resolution with its source. What IS
  printed, once per distinct case, is the one state that was never reported
  before: the model named in `D365FO_MODEL_NAME` / `.mcp.json` disagreeing
  with the `<Model>` of the project the workspace scan picked - the state in
  which writes target one model while new files are registered into a project
  of another. Silent when a `projectPath` is configured too, because the
  detected project is unused then. The per-call `Using explicit packagePath`
  line, printed on most tool requests, moves to the debug log as well.
- **The AosService drive scan is bounded.** It probed C: to Z: with one
  synchronous stat per letter, lazily on the first tool call that needed a
  packages path - and a stat on a disconnected mapped network drive stalls for
  the SMB timeout, which is how `get_workspace_info` could hang for tens of
  seconds and then be instant for the rest of the session. C:, K:, J: and I:
  are now probed first and always, the other letters only inside a 2 s budget;
  `D365FO_SCAN_DRIVES` (e.g. `C,K`) pins the probed set. `doctor` and the
  not-found messages name the letters that were skipped and any probe that
  took over a second, so a missed volume is reported rather than silent.
- **The .rnrproj walk skips profile and system folders.** The workspace it
  starts from is whatever the client reported - `process.cwd()` when VS Code
  gives nothing better - and that has been `C:\Users\<user>` itself, where
  five levels of `AppData` is hundreds of thousands of entries walked to find
  nothing. `AppData`, `$Recycle.Bin`, `Windows`, `Program Files`, `ProgramData`
  and the package caches are skipped now, case-insensitively.
- **First-start metadata indexing runs on a worker thread.** With an empty
  symbol database and `METADATA_PATH` set, the server indexes before it
  declares itself ready - synchronously, end to end, and inline on the main
  thread, so every tool call (`get_workspace_info` included) hung for the whole
  build on exactly the machine where the server was being tried for the first
  time. The same build now runs in `startupIndexWorker` on its own WAL
  connection; `dbReady` is still held until it completes, so symbol-backed
  tools keep answering "still loading" instead of returning empty results, but
  the event loop is free and the tools that need no symbols answer at once.
  The worker's console output is routed to stderr (stdout is the protocol
  channel in stdio mode), and a failed build is reported by name rather than
  as "metadata path not accessible".


---

## [1.17.1] — 2026-09-04

### Fixed
- **`install.ps1` failed on every machine without a `K:` drive** (#1010). The
  installer probes `K:\d365fo-mcp-server` for a pre-npm checkout, and Windows
  PowerShell 5.1's `Join-Path` validates the drive and throws
  `DriveNotFoundException` before the npm install ever starts - which is the
  case on a stock D365FO VHD. The `.git` probe now composes the path without
  drive validation; a candidate on a missing drive is simply skipped.

---

## [1.17.0] — 2026-09-03

### Removed
- `docs/XPP_LANGUAGE_COVERAGE_PLAN.md` (the **v4** plan) is **deleted**, under the
  lifecycle rule it carried itself: all phases H0-H6 shipped, core coverage 74/74,
  total 124/124, 0 `golden_pending`, and the full-install validator sweep clean at
  105,686 files with zero error-severity findings.

  The durable record is where it belongs and not in a plan file: the census
  figures are inside the knowledge rules that use them, the rejected options are
  in the source that implements the alternative (`reportDesignXml.ts` explains why
  there is no `add-column` and no provenance fingerprint; the TST rule comments
  explain why they are not what the plan specified), the evidence is in the
  goldens and the two committed SysTest documents of `L2-tdd-red-green-cycle`, and
  the reasoning per phase is in PRs #999-#1006.

  Its non-goals, its measurement-rejected rules, the six eval cases deliberately
  not authored and the one noted-but-unfixed defect moved to `docs/BACKLOG.md`
  rather than disappearing with it. This is the second plan file to go the same
  way; the v3 one was deleted 2026-09-01.


### Added
- **`report-design` — the first write path an AxReport has ever had.**
  `d365fo_file(action="modify", objectType="report", operation="report-design")`
  with `reportAction="refresh-dataset"` (copy the temp table's fields onto the
  report's dataset — the information is on disk, nothing about it is a design
  decision) or `reportAction="add-parameter"` (declare a parameter AND bind it
  to the dataset in one write, because the two elements must agree). New
  parameters: `reportAction`, `tableName`, `datasetName`, `parameterName`,
  `parameterDataType`, `parameterHidden`, `promptString`. Layout stays with the
  Report Designer: there is deliberately no `add-column`, because an RDL error
  surfaces only in the SSRS renderer where no build and no test can see it. The
  operation is metadata-only and additive-only, and that guarantee is a property
  of the operation, not of the file's provenance — a fingerprint that refused
  "foreign" designs was rejected for having the wrong shape.

  It paid for its schema bytes with a measured trim: tool annotations that only
  repeat the MCP spec default (`readOnlyHint: false` on 6 tools,
  `idempotentHint: false` on 4) are no longer sent. `destructiveHint: true` is
  also a default and is kept on purpose: a client that reads absence as
  "unknown" becomes MORE cautious about a missing `readOnlyHint` and LESS
  cautious about a missing `destructiveHint`, and only the first direction is
  safe. ListTools headroom 49 → 251 chars. (PR #1001)

- **`add-field` can write a container field.** `fieldBaseType="Container"` was
  refused as a parameter that changes nothing and `fieldType="Container"` as a
  missing EDT; the C# bridge had handled it since it was written and only the
  TypeScript side never routed to it. A census settled the type question on the
  way: 280 of 332 shipped container fields DO carry an EDT (`Bitmap` is what a
  shipped report temp table uses for a company logo), and typing the field with
  it silences `BPErrorTableFieldNotDefinedUsingType`. (PR #1002)

- **Reports, the runtime half.** `get_knowledge` topics for the report runtime
  API (contracts, print destinations, pre-processing) and for the RDL people
  actually write, from a census over the 961 shipped designs: `IIf` 29,703 uses
  across 775 reports; `Avg` and `Lookup` zero — an aggregation belongs in the
  data provider, where it can be tested. `generate_object(pattern="systest")`
  gains `testTargetType="report-dp"`, and four eval cases were captured from
  clean builds, one of them (`L4-tdd-report-dp`) with a red-then-green run under
  `SysTestConsole.exe`. That red run corrected the case's own premise:
  `assertNotNull(dp.getTmp())` takes `Object`, an empty buffer boxes to null,
  and the assertion tests whether the last select found a row. (PR #1002)

- **SysTest attributes and ATL, both re-derived from usage.** The scaffold takes
  `attributes: string[]` and `arrange: "buffer" | "atl"`; `prepare(mode="test")`
  names the ATL packages a model is missing and what each costs. The catalogue is
  a census of the 884 shipped test classes, and it inverted the plan: the two
  most-used attributes (`[SysTestCheckInTest]` 1,875 uses, `[SysTestGranularity]`
  165) were missing from it, most of what it listed has zero shipped uses, and
  `SysTestSuiteCompanyIsolateClass` — named as THE isolation mechanism — has been
  `[SysObsolete]` since 2014. The ATL tree is read from the AOT
  (`src/knowledge/atlNodes.generated.ts`, 1,105 data classes, 351
  record-producing nodes); 107 of them hand back an `AtlEntity` wrapper that
  needs `.record()`, which the oracle's own header example had omitted. (PR #1003)

- **Six knowledge catalogues written from censuses, and every one got SMALLER.**
  `form-runtime-api` (of `FormRun`'s 209 methods, 49 are ever called through
  `element.` across 9,442 shipped forms; `args()` alone is 92% of platform calls;
  `UpdateDesignMode` appears in zero files), `data-entity-methods` (ranked over
  5,805 entities; `mapEntityToDataSource` outnumbers its "pair" 11 to 1), CoC
  target kinds (`queryStr` has zero shipped uses; `mapStr` and `viewStr`, which
  the plan omitted, both ship), `IncludedColumns` (zero in 18,377 tables),
  relation types and index properties. The censuses H2 and H3 had shipped were
  re-measured first: a hand-rolled `<root>/<pkg>/<pkg>/<AxType>` walk silently
  skipped the 12 model folders not named after their package, ApplicationSuite/
  Foundation among them. `npm run oracle:usage` and `npm run oracle:atl` now walk
  models the way the server does. (PR #1004)

- **H5 breadth: twelve gaps, three validator rules, one refuted claim.** Topics
  `email-sending`, `file-io-write`, `http-json-xml`, `xrecord-buffer-api` and
  eight extended ones. `validate_code` gains **TST001** (`assertExpectedException`
  does not exist; 0 of 66,754 shipped classes), **TST002** (`[SysTestMethod]` in
  a class that extends NOTHING — not "does not extend SysTestCase", because 31 of
  the 56 shipped classes reach it through a chain and the literal rule would fire
  on more shipped classes than it caught) and **TST003** (a test method with no
  `assert*(`, warning; triggered by the attribute, since only 2.4% of shipped
  test methods are named `test*`). Whole-install sweep: 105,686 files, zero
  error-severity findings. An R-only case measured that an `anytype` CAN be
  re-typed at run time, contrary to the folklore. `get_knowledge` topic
  `tdd-workflow` — asked for by the plan, logged as shipped, never written until
  the taxonomy's dangling-id check caught it. (PRs #1005, #1006)

- **`L2-tdd-red-green-cycle` commits the RED run beside the green one**, from one
  uninterrupted cycle on the VM: the assertion failed for the stated reason, then
  passed with only the implementation changed. Every other case commits a green
  document, and a green document alone cannot tell a working test from an empty
  one. (PR #1006)

- **The red-first loop, made findable.** It was complete and unused: across 1,603
  real MCP calls in 47 sessions, `prepare(mode="test")` was called 0 times and
  `run_systest_class` 0 times, while `prepare(mode="change")` ran 54 and
  `d365fo_file(modify)` 195 — and roughly thirty-five of about fifty genuine
  knowledge questions were the table `validateWrite` Chain of Command contract,
  the exact rule the loop was built to test. A feature nobody finds is
  indistinguishable from one that does not exist.

  `prepare(mode="change")` now carries a `### Test first?` section and a write
  that lands X++ on an untested object gets one `> **Untested.**` line. Both cost
  zero ListTools bytes — they are response text, not schema.

  The trigger is BEHAVIOUR, never structure. A testable object family is
  necessary and not sufficient: the deciding signal is the operation, so
  `add-method` and `replace-code` fire and `add-field` on the same table
  extension does not. Adding a field is metadata, its oracle is the golden diff,
  and a SysTest asserting it would only check that the compiler did its job.

- **Three more SysTest shapes** (`testTargetType`: `coc`, `event-handler`,
  `service`, beside `class` and `table`), because they observe the behaviour in
  three different places and the wrong one produces a test that compiles, runs,
  passes and proves nothing:
  - `coc` exercises the BASE class and never names the wrapper — Chain of Command
    is transparent at the call site, so a test that references the `_Extension`
    class passes with `next` never reached. Two inputs, because a wrapper that
    ignores `next` and returns a constant passes a single assertion.
  - `event-handler` performs the write and reads back what the handler changed; a
    handler fires out of band and cannot return a value.
  - `service` calls a SysOperation service directly with a hand-built contract —
    no controller, no dialog, no batch queue.

  All three are promoted from SysTests that actually EXECUTED on the VM
  (2026-08-31, 2/2 each) and were then compiled by
  `scripts/oracles/probes/coverage-v4.ts` — green without a TestEssentials
  reference, which is what the scaffold's own warning promises.

  `prepare(mode="test")` picks the shape and prints the call that selects it, so
  the two halves of the loop cannot disagree. It reduces an extension name to its
  base first, index-verified: the infix between base and `_Extension` is a
  per-model convention, so stripping the suffix alone leaves a name that is not
  an object.

- **ATTR003 — two attributes stacked on a method.** X++ takes several attributes
  on a method only inside one bracket, comma-separated. Two bracketed lines is a
  parse error, and the compiler answers `Invalid token '['` with a column number
  and abandons the whole file — it names a token, not a rule. That is the precise
  opposite of the case that got DECL001 and CONV001 rejected, where the
  compiler's own message was exact and local.

  The exemption is the hard half and it was measured, not reasoned: a census
  found 2,163 shipped AxClass files stacking attributes on a CLASS declaration
  and **0 of 760,583 shipped methods** doing it. Our own knowledge base invites
  the mistake by listing `[SysTestMethod]`, `[SysTestCategory]` and
  `[SysTestPriority]` one under another; both entries now say it is a menu, not a
  stack.

- **The measurement harness the coverage work runs on is in the repo**, after two
  rounds of losing it to a session scratchpad: `npm run oracle:terms` (1,165
  language constructs matched against what the server teaches, checks, writes and
  proves — no D365FO install needed), `npm run oracle:demand` (what callers
  actually ask for, redacted to values the server itself defines because the logs
  hold customer object names), `scripts/capture-golden.ts` (the eval step that had
  no script, with four gates and tests), and `eval/api-members.snapshot.json` over
  a committed list of the API surface.

### Fixed
- **`report-design(add-parameter)` wrote `DataType` where the deserializer drops
  it.** The writer emitted `Nullable, PromptString, DataType`; a census of all
  13,911 parameters in the 1,063 shipped reports puts `DataType` between
  `AllowBlank` and `Nullable` with zero contradicting instances (before
  `PromptString` 3,104:0, before `Nullable` 2,139:0). An element met out of
  sequence is dropped without a word and the build stays green, so a
  `System.DateTime` parameter reached the dialog as a `String` — in the committed
  golden of `L4-ssrs-report-parameters`, too, which was corrected by hand and
  says so in its README. The order is now the shipped one, the tests pin it
  against what the scaffold itself emits, and the `axreport-anatomy` topic
  carries the census and no longer claims the operation does not exist.

- **`add-parameter` wrote half a parameter and called it success.** The
  declaration was written BEFORE the dataset was resolved; when no dataset could
  be found (several datasets and no `datasetName`, a wrong name, a self-closing
  `<Parameters />`) the reply was ✅ "bound it to dataset '(none — no dataset
  resolved)'", and the retry with the right name hit the "already declared"
  guard, so the parameter could never be bound at all — the exact half-write the
  operation exists to prevent. Both insertion sites are now resolved before the
  first byte is written, an unresolved dataset is an error that writes nothing,
  and a parameter left declared-but-unbound by the old version is bound on the
  next call rather than refused. Also: `promptString` is XML-escaped,
  `parameterDataType` must look like a .NET type name, inserted elements take
  the closing tag's line instead of doubling its indentation, and
  `refresh-dataset` drops the memoised table listing before looking the temp
  table up, so one created a moment ago is no longer "not found on disk".

- **ATTR003 fired on a legal class-level attribute stack** whenever a comment
  sat between the attributes and `class`. `maskStringsAndComments` keeps the
  comment opener and blanks the rest, so a `///` line comes back as `//` and
  spaces: the `startsWith('///')` skip never matched, `//` and `/* */` lines were
  not skipped at all, and the comment became the "declaration". Shipped code
  puts its doc comment above the attributes, which is why the 105,686-file sweep
  was clean. TST003 had the same skip and silently did NOT check a test method
  behind a comment; both share one masked-line helper now.

- **TST002 reported `extends nothing` when the `extends` clause sat on the next
  line.** The header regex stopped at the newline; it now runs to the opening
  brace.

- **`testTargetType` was invisible.** It shipped in 1.16.0 as the selector for the
  table test shape and was absent from the `pattern` mode's op-spec `optional`
  list — and since these parameters are deliberately kept off the wire schema, the
  op-spec is the only place they are documented. The mirror image of the failure
  this repo has twice paid for, where an error demanded a parameter the caller had
  no way to send.
- **`docs/ARCHITECTURE.md` claimed 40 validator rules** and listed their ids, for
  months after the count was 50 — it had missed two entire coverage waves
  (COC006, BP005, DOC001, OP001, SET001, RPT101/102, XML008-010). A stale roster
  is worse than none: it is what a reader consults to decide whether a check
  already exists, so the answer it gives sends them to write a duplicate.
  `tests/tools/validatorRuleInventory.test.ts` now derives both sides.
- **Seven coverage-taxonomy notes claimed a case did not exist** when it had been
  captured on 2026-08-31, so `eval/COVERAGE.md` rendered a green row beside a
  sentence saying the proof was missing. The existing gate only knew the word
  "pending"; these said "No case yet", "no captured case yet", "is the one to
  author". The gate now matches future-tense phrasings, and was verified against
  the pre-fix taxonomy.
- **Two testing topics that both explained SysTestCase** and disagreed about the
  naming convention. The base is read one topic at a time, so a contradiction
  between two of them is invisible to the reader. `unit-testing` is now
  authoritative and absorbed the two facts only `testing` had — that
  `[SysTestTarget]`'s second argument is the element TYPE, and the ATL entry
  point; `testing` keeps the one question it uniquely owns, which kind of test to
  write at all.

### Changed
- Dependencies: `@biomejs/biome` 2.5.11 → 2.5.12, `@types/node` 26.4.0 → 26.4.1,
  `tsx` 4.23.12 → 4.23.13 (30 lockfile entries, no major). `npm update` on
  Windows had dropped the two Linux `@biomejs` optional-dependency entries from
  the lockfile, which broke `npm ci` on the Linux CI runners; they are restored.
  (PR #1007)


---

## [1.16.2] — 2026-09-01

### Fixed
- **The installed server would not start: `ERR_MODULE_NOT_FOUND` on
  `dist/eval/oracle/systest.js`.** `run_systest_class` reads per-method results
  out of the XML document SysTestConsole writes, and since the TDD-loop work it
  imported that parser from the eval oracle — `src/eval/oracle/systest.ts`.
  But `src/eval/**` is a dev-only tree that package.json keeps out of the
  published tarball (`"!dist/eval/**"`), so every `npm i -g d365fo-mcp` got a
  `sysTestRunner.js` importing a file that is not there, and the MCP server died
  on load with the whole tool surface gone.

  Nothing in the repo could see it: typecheck, lint and the test suite all
  resolve against `src/`, where the excluded tree is present. It only exists in
  the tarball.

  The parser moved to `src/tools/sdlc/sysTestXml.ts` — beside the runner that
  loads it, inside a published tree — and the eval oracle re-exports it, so the
  dependency now runs eval → tools and never back. The published `files` list is
  unchanged; the eval tree stays out.

  `tests/packaging/publishedFiles.test.ts` now walks the import closure of every
  packed `dist/**/*.js` and fails on any specifier that resolves to a file the
  tarball excludes, so the next tree cut out of the package is covered too, not
  just this pair.

---

## [1.16.1] — 2026-09-01

### Fixed
- **`d365fo-mcp setup` died on a database lock it took out on itself.** Opening an
  existing large index hands the deferred `file_path` index builds to worker
  threads, and each worker opens its own *write* connection to the same file.
  `build-database` then sets `locking_mode = EXCLUSIVE` on the writer, which
  cannot coexist with a second writer — whoever lost the race failed with
  SQLITE_BUSY, on a machine where the build had already run for minutes. The
  script did call `closeReadPool()` first, exactly as that method's doc comment
  instructs, but the pool is not the only other connection the class opens: it
  drains readers and knows nothing about the workers.

  Three separate things were wrong and all three are fixed:
  - `XppSymbolIndex` takes `{ backgroundIndexBuilds: false }`, and both
    `build-database` and `build-fts` pass it. The worker exists to keep the
    server's event loop answering; a one-shot CLI has no event loop to protect,
    so it builds inline on the connection that already holds the lock.
  - The worker dispatch no longer *assumes* WAL — it checks `journal_mode` and
    refuses to spawn off it. Build scripts switch to `journal_mode = MEMORY` two
    steps later, where a second connection cannot work by construction, so the
    race is now closed even if a future caller forgets the flag.
  - `closeReadPool()` documents what it does not cover and warns on stderr when
    it is called with index builds still running; `close()` tears them down.

  Deliberately not fixed by raising `busy_timeout` (masks the race) or by
  retrying `createFTSTriggers` (one of many places that hit the same lock).

### Changed
- Build scripts defer the `file_path` indexes past their bulk load
  (`{ deferFilePathIndexes: true }`) and build them once at the end. Every row of
  the load previously maintained two extra B-trees, and a full rebuild threw the
  result away in `clear()` anyway.
- `XppSymbolIndex` accepts a `largeDbThresholdBytes` override. The existing tests
  could not have caught this bug: they run on databases far below the 200 MB
  threshold, where the worker never starts. With the threshold injectable, the
  worker path is reachable in a unit test — and the new tests fail against the
  old code.

---

## [1.16.0] — 2026-09-01

### Added
- **TDD for a TABLE method — the loop's most-asked task had no red-first path.**
  Across 1,593 real MCP calls the single most-requested X++ topic was the table
  Chain of Command contract (`validateWrite`, where `next` goes, `checkFailed` vs
  `error`, `orig()`): roughly thirty `get_knowledge` calls were variations of that
  one question. Both `prepare(mode="test")` and
  `generate_object(pattern="systest")` resolved **classes only**, so the rule a
  developer most wants to pin down could not be tested through the server at all.
  `prepare(mode="test", objectName="CustTable.validateWrite")` now resolves
  tables (dotted form included) and emits the scaffold call with
  `testTargetType: "table"` already set. The scaffold arranges a buffer with
  `initValue()`, asserts the boolean verdict **and** the infolog line the rule
  writes, and adds the ACCEPTING case beside the rejecting one — without it a rule
  that refuses every row passes its own test. Write methods get a transaction and
  a re-read from the database. Compiler-verified before it was written
  (`UtilElementType::Table`, `assertExpectedInfoLogMessage` after the act), and it
  costs no ListTools bytes: the parameter lives in the op-spec.
- **Six knowledge topics for constructs nothing could measure**: `lookups`,
  `global-class-statics`, `system-objects`, `report-print-destinations`,
  `document-attachments`, `rdl-design-expressions` — plus extensions to
  `query-object-model` (range vs filter on an outer join, the range expression
  language, `[QueryRangeFunction]`), `sysoperation` (the packed query parameter),
  `bp-rules` (`SuppressBPWarning`), `deprecated` (the RunBase lifecycle and its
  `#CurrentVersion` bump) and `ssrs-rdp-preprocess` (`AX_RdpPreProcessedId`).
- **The oracle harness is in the repo** (`npm run oracle:sweep|census|probe|members`).
  The census, the validator sweep and the xppc probe harness had lived only in
  session scratchpads: the measurements behind the compiler-verified wave could
  not be re-run. `--dry` runs the sweep against `tests/fixtures/oracles` so CI can
  hold the zero-error bar with no D365FO install.
- **The runtime oracle runs, and it discriminates.** X++ test code had never once
  executed in this project: `SysTestConsole.exe` stopped at `Login failed for user
  'AOSUser'`, diagnosed twice as a rotated credential and twice wrong — the shipped
  `SysTestConsole.exe.config` had simply never been configured for the machine. With
  the four `DataAccess.*` values copied from the AOS's own `web.config`, the runner
  opens a real AOS session. A passing run only proves the instrument is on, so a
  negative control was built and run in one pass: a deliberate assertion failure and
  a deliberate throw come back **failed** beside a passing method, and
  `parseSysTestXml` reports all three. That real failing document is committed as
  `tests/fixtures/systest/negative-control.xml` — every earlier parser test used
  synthetic XML, which only proves the parser handles what its author imagined.
  All twelve remaining goldens and every runtime-tagged case have since run:
  **0 of 120 cases are `golden_pending`, 0 are `systest_pending`**, both for the
  first time.

### Fixed
- **Thirty-one defects the golden-capture runs found, and a green 5,700-test suite
  could not.** Each eval case was implemented on the VM through the grounded tool
  path, which is the only thing in this repo that compares INTENT against OUTPUT;
  the test suite compares code against expectations someone already held. Twenty-one
  runs across the wave, and the passes are the least interesting part — these are
  the defects the runs produced on the way:
  - `create(class)` **silently dropped every multi-line method attribute block**.
    Attributes are syntactically optional, so xppc and xppbp stayed green — a data
    contract with no data members, a SysOperation dialog with no fields, and no
    message anywhere. It had already corrupted a committed golden
    (`L3-sysoperation-dialog-attributes` contained none of the five attributes its
    own README describes); that golden is removed and queued for re-capture, and a
    blast-radius audit confirmed it was the only one.
  - A member list **renamed methods out of existence**: the completion formatter
    printed the signature instead of the name, so `SysQuery::range` appeared as
    `#ISOCountryRegionCodes` and `RunBaseBatch.dialog()` as a doc-comment sentence.
    Runs concluded the APIs did not exist and worked around them.
  - `search(type="report")` **did not filter to reports** — the bridge's type map
    has no entry for that kind, so the query ran unfiltered and answered with
    tables and queries. Now enforced adapter-side, for every unmapped type.
  - `validate_code(mode="references")` reported **code that compiles** as errors:
    kernel enums (`AccessType`, `MenuItemType`, `JoinMode`) and a class calling its
    own statics — the only spelling X++ accepts. With `GROUNDING_ENFORCE` on, both
    would have refused the write.
  - `get_object_info(form, searchControl)` **did nothing**: implemented on the XML
    path while the bridge answers first, and every existing test used the
    explicit-`filePath` branch, which returns before the bridge.
  - `create(class)` doubled the prefix on any `_Extension` name already carrying
    one, making `SysQueryRangeUtil_Extension`-shaped names unreachable.
  - Two refusals **named a parameter the caller cannot send** (`query` on
    bp-moniker search, `baseObjectName` on `prepare`).
- **Five knowledge errors, all written in this same wave**, caught by the first
  independent use of the topics: `attachFile` takes nine arguments, not eight, and
  the short call compiles while storing the notes as the attachment name;
  `registerOverrideMethod` lives on the concrete `FormStringControl`, not
  `FormControl`/`FormReferenceControl`; `SysTableLookup` *does* have
  `addLookupMethod` (inherited); `infolog.num()` and `setPrefix` are not where the
  entry said to look for them; and RunBase needs `canRunInNewSession()` plus a
  retained `#CurrentList<n>` — "bump the version" alone makes saved batch jobs stop
  running rather than run wrong.
- **The lesson behind most of them:** "it compiles" is not "it is correct". The
  `attachFile` error came from a probe that passed eight arguments and built clean.
  For a call with optional tail parameters the compiler cannot answer the question
  being asked; read the signature and count. Now stated in the probe harness.
- **Seven validator false positives on Microsoft's own X++**, found by the first
  full-install sweep (105,686 files, 615 MB): `ATTR001` on an attribute argument
  carrying an inline comment (72 hits), `SEL010` on `validTimeState` used as an
  ordinary method name in the SysDa API (14), `FN001` on `new Info()` and on a
  local function shadowing a predefined name (7), `CS001` on a C#-looking type the
  file legally aliased with `using string = System.String;` (3, and 448 shipped
  files use that form), `COC003` on the lower-case `_extension` suffix the
  platform itself ships (1), `RPT001` on an abstract DP base class (1), and
  `SEL008` reading a select across a `#localmacro` boundary (1).
- The shared X++ lexer had **no tests**, which is how its documented "delimiters
  survive" contract could be false for `*/` without anyone noticing — the reason
  the `ATTR001` fix initially matched nothing. 16 tests now pin the behaviour.
- **The scoring oracle could diff a form against the menu item that opens it.**
  `resolveActualFile` matched on a lossy logical key with `find()` — first match
  wins — and `artifactKey` strips the `.Ax<Type>` infix, so a golden folder holding
  a form and its display menu item reduced both to one key. Swept over all 119
  committed golden folders: 10 artifacts mispair under canonical capture naming and
  18 under the other assignment of the undecorated filename, 8 of them outright
  cross-pairings — two unrelated objects compared against each other, or one
  artifact silently vanishing from the run. Pairing now resolves in three ranked
  stages (the golden's own filename, type-CHECKED · the identity each document
  DECLARES plus its root element · the legacy key with ties broken by type), and an
  undecidable pairing is **reported and scored missing, never guessed**. In the same
  pass: `canonicalizePrefix` could not see a prefix used as an INFIX, which is
  Microsoft's own `{Base}{Prefix}_Extension` convention — a differential sweep over
  326 golden files x 5 prefix specs shows that silently cost 7 golden folders, and a
  collision sweep over 7,095 identifiers adds no new collision. The fix proposed for
  this eight weeks ago in a corpus record was measured here and does **not** work.
- **Capture runs recorded `generated_artifacts: []` for eight weeks.** The CLI's
  golden-pending branch kept a private "what counts as an artifact" filter
  (`*.metadata.xml`) while the resolver accepted both shapes, and a capture points
  `--actual-dir` at an AOT folder, which holds bare `<Name>.xml`. One shared filter
  now, and the list is printed.
- **A golden captured before the writer documented classes can never match.** The
  create path started injecting a class-level `///` block in August; goldens
  captured in July could not be reproduced by any faithful re-run — 34 of the 159
  goldens carrying a class or interface `<Declaration>` have no doc comment, 32 of
  which the writer would inject into. The presence signal is **directional** now: a
  doc comment on the ACTUAL side only compares equal
  (`BPXmlDocNoDocumentationComments` fires on ABSENCE, and the content was already
  canonicalised to a placeholder), while one present in the GOLDEN and missing from
  the actual still fails — that is a real regression. Replayed over the whole
  corpus, this and a symmetric blank-line rule resolve 14 real false-mismatches
  across 69 stored `changed` entries and suppress nothing else. Deliberately not a
  batch re-capture: each case refreshes its own golden the next time it runs.
- **Report goldens were unreproducible by construction.** An AxReport carries its
  RDL inside CDATA and the RDL carries `rd:DataSourceID` / `rd:DataSetID` /
  `rd:ReportID`, minted afresh on every generation — text inside a payload, which a
  case's `ignore` globs cannot reach. Six committed goldens carry them. Masked at
  comparison time only; the stored artifact is never rewritten and a real design
  change still fails.
- **The report scaffold made a temp table's first column unique.**
  `buildPrimaryKeyIndex` always emits a unique index and the report path handed it
  `tableFields[0]` — which under `designStyle="GroupedWithTotals"` is by
  construction the GROUP key, so the second row in a group failed on a duplicate key
  at RUN time, from metadata that builds clean. A report temp table has no natural
  key; it is `RecId` now, confirmed on live scaffold output.
- **A corpus record had been silently dropped since July.** A writer put Windows
  paths into JSON without escaping the backslashes, so a strict parser rejected the
  whole document — and `loadJsonRecords` skips an unparseable file without a word.
  A record classified `TOOL_DEFECT` was therefore invisible to every cluster, report
  and held-out check for eight weeks: the improver had been ranking failures over a
  corpus it did not know was short. Repaired by **escaping only** — the separators
  the original writer dropped are not reconstructed, because guessing them would
  turn damaged data into something that reads as evidence.
  `tests/eval/corpusRecordsParse.test.ts` now fails on any unparseable record, and
  asserts the corpus is of real size so a broken path cannot make it pass forever.
- **A root element could be read out of an XML comment** (CodeQL,
  `js/incomplete-multi-character-sanitization`, 2 high). `aotRootElement` found the
  root by `replace()`-ing the prologue away, and a single-pass strip leaves an
  unterminated `<!--` in place — so the type deciding which golden pairs with which
  file could come out of a comment. Replaced with an ordered token scan; ordered
  alternation alone was not enough, which the new test caught before it was pushed.
  `tests/eval/oracleScoringIntegrity.test.ts` carried its own copy of both readers
  (the second alert) and imports the shipped ones now, so it cannot drift from the
  code under test.
- **Two `js/regex-injection` findings in the oracle CLIs** (high, CodeQL):
  `census.ts --grep` compiled its argument as a regex and is a literal substring
  match now; `xppcProbe.ts` interpolated a probe's class name into a regex, and the
  name is validated as an identifier before use. Testing that guard is what made it
  worth doing — the first version captured `Bad` out of `class Bad.Name`, a valid
  identifier producing an artifact whose `<Name>` disagrees with its own source,
  which is exactly the silence the harness exists to prevent.

- **An enum whose members were all 0 — and nothing said so.** `create(enum)`
  suppressed every explicit `<Value>` whenever the resolved mode was
  UseEnumValue=No, on the premise that "plain 0,1,2 numbering states nothing the
  order does not". The premise is false: an `<AxEnumValue>` with no `<Value>` is
  **0**, not the next ordinal. A four-tier ladder came out with None = Silver =
  Gold = Platinum = 0, compiled with 0 errors, passed xppbp and matched its golden,
  while `enum2int()` returned 0 for every tier — the runtime oracle is the only
  thing that could see it (2026-08-31, `L3-enum-field-form-downgrade-guard`,
  "expected False, actual True"). Every member now carries its number, the 0
  excepted, which is the shape the serialiser and all 3,913 shipped AxEnum files
  use. Two claims went with it, both checked rather than reasoned about: a census
  of shipped metadata (of 3,818 multi-member enums, exactly six omit `<Value>`
  everywhere, and all six are extensible) and an xppc probe on the VM —
  `IsExtensible=true` + `UseEnumValue=No` + non-positional values **compiles
  clean**, while the same enum with `UseEnumValue=Yes` fails with the documented
  message. So the knowledge entry's "an explicit `<Value>` forces UseEnumValue=Yes
  at compile time" was wrong, the refusal built on it is gone, and the one pairing
  xppc really rejects is the only one still refused.
- **A delete action that read as Cascade on disk and as nothing to the platform.**
  The XML writer emitted `<AxTableDeleteAction>` as Name → Table → DeleteAction,
  a shape copied from a C# object initialiser. All 126 entries Microsoft ships are
  Name → **DeleteAction** → Relation → Table, and the metadata deserializer drops
  a misordered element in silence — so the provider read the entry with
  DeleteAction at its default and the next bridge-backed `Update()` serialised it
  back without the element. The 2026-08-31 run recorded this as "the bridge
  destroyed the delete action"; the bridge only wrote back what it had been able
  to read. Canonical order now, `<Relation>` supported (`deleteActionRelation` —
  without it xppbp reports BPUpgradeMetadataDeleteAction), and re-sending the same
  action with a different type **rewrites it in place** instead of answering
  "already present — skipped", which is what left the run with no forward-only
  repair path at all.
- **A create scheduled its provider refresh before its own last write.** The table
  property reconcile patches the file on disk after the bridge create, but the
  refresh was requested *first*, so the provider rebuilt from the pre-patch bytes
  and the next modify's `flush()` saw a refresh newer than its own request and did
  nothing. The first bridge-backed `Update()` then wrote the cached copy over the
  patch — reproduction 1 of the same run (`CacheLookup=None`, gone). The refresh
  now happens after the last byte the call writes.
- **One object, three different names.** `create(class, xmlContent=…)` applied the
  model prefix to the file name and to the X++ declaration but not to the metadata
  `<Name>`, reported "Created" plus "Verified: on disk", and the next build died
  with "must be named X instead of Y to be consistent with its file name". The
  prefix rewrite now covers `<Name>` too, and a last gate before the write refuses
  any document whose file name, `<Name>` and declaration disagree — a build cycle
  earlier, and with all three spelled out. (The declaration is read through the
  shared X++ lexer: the first version matched the word "class" inside a `///`
  comment and refused correct creates, which the full suite caught the same hour.)
- **`CacheLookup=None` was an element the platform never writes** — and the entry
  that said otherwise cost two defects pointing opposite ways. The omitted-default
  table named `NotInTTS` as the value the AxTable serialiser leaves out. It is
  `None`: reflection over `Microsoft.Dynamics.AX.Metadata.Core.dll` gives
  `RecordCacheLevel.None = 0`, the .NET type default, and the census agrees — of
  the 1,444 `<CacheLookup>` elements in 6,995 shipped tables **not one says None**
  (Found 758 · NotInTTS 301 · FoundAndEmpty 209 · EntireTable 176), while 95 of the
  231 shipped Transaction tables carry no element at all, which IS None. So a
  create asking for `None` had an element patched in that every later metadata
  round trip normalised away again — the behaviour the 2026-08-31 run recorded as
  "a bridge modify destroys properties this server wrote" — and a create asking for
  `NotInTTS`, a real non-default value, was told it had been honoured and got None.
  Found by the verification run below: the new preservation guard fired on it, and
  a guard firing on a non-event is how the wrong default came to light. The guard
  now ignores any value whose absence means the same thing, so it cannot cry wolf.
  The other seven entries in that table were checked against the same census and
  are correct.
- **Two guards, because the class of defect matters more than the three
  instances.** Every bridge-backed write now compares the file before and after:
  a top-level property that vanished without being asked about is put back, in the
  position it held, and said so in the response. And "✅ Verified: on disk" is no
  longer the only claim a write makes — where the operation names an unambiguous
  result (a modify-property value, a delete action's type, an enum member's
  number), the value is looked for in the file that was actually written, and its
  absence is reported as a failure instead of a byte count.

### Changed
- Five new validator rules: `XML008` (an `AxTableExtension` carrying `<Methods>`,
  which the deserializer drops silently), `XML009` (a control bound to a field
  group the table does not declare — a full build catches it, an incremental build
  does not), `DOC001` (a bare `&` or `<` in a `///` comment → `BPXmlDocMalformed`;
  a **warning**, because Microsoft ships it too), `SET001`
  (`update_recordset`/`delete_from` with no `where`) and `OP001` (`&&` mixed with
  `||` unparenthesised — they have equal precedence in X++, unlike C#).
- Coverage fell to **core 90.8% / total 91.7%** mid-wave and finished at **core
  100% (65/65) / total 109/109**. Nine leaves were added for constructs the
  artifact-indexed taxonomy had no way to count, each starting `golden_pending`,
  and the number climbed one captured golden at a time. It was never 100% for those
  constructs before; there was nothing to count.
- Two standing claims in the docs were false and were quietly steering work: that
  the runtime oracle had never executed because `SysTestConsole.exe` gates on an
  interactive console (it does not — that was configuration drift), and the eval
  README's standing "capture the pending goldens" queue. Both closed. One survivor
  is left alone as out of scope: `src/server/serverMode.ts` still repeats the
  interactive-console claim in a tool-tiering rationale, where the tiering decision
  is unaffected but the sentence is wrong.
- `docs/XPP_LANGUAGE_COVERAGE_PLAN.md` is **deleted**, under the lifecycle rule it
  carried itself: the capture it was waiting on is done. The durable record is
  `eval/COVERAGE.md`, `eval/README.md`, the goldens' READMEs and this entry; its
  non-goals and still-open decisions moved to `docs/BACKLOG.md` rather than
  disappearing with it.

### Known issues
- `L3-warehouse-work-slice` has a captured golden and `build: 1`, but its corpus
  record still carries `bp_clean: null` — BP never ran for it. A small, real gap,
  named rather than papered over.
- Four defects the verification runs found or re-confirmed are **open, with
  issues**, all in the form/scaffold path and none of them touched by this
  release: the scaffold writes explicit child controls under a `<DataGroup>`-bound
  group, which its own `add-control` op-spec refuses (#977); `generateControls`
  changes nothing and the reported control count is not the number written (#978);
  `get_object_info(form)` hides the children of such a group, reporting 14 controls
  where the XML holds 16 (#979); and every scaffolded form starts BP-dirty because
  the tab captions are raw text (#980).

### Verified on the VM
All three write-path defects were re-run end to end through the grounded tool
path on the sandbox model, against a server running this build:

| Case | Score | What it proves |
|---|---|---|
| `L3-enum-field-form-downgrade-guard` | build 1 · golden 1 · **systest 3/3** | One `create(enum)` call — no `useEnumValue`, no `modify-enum-value` repair — wrote `<Value>1/2/3</Value>` and the runtime downgrade guard passes. The runtime oracle was the only thing that could ever see this defect. |
| `L2-event-handler-basic` | build 1 · golden 1 · **systest 2/2** | `create(class, xmlContent=…)` canonicalised all three identities instead of writing three different ones; the build that used to die with the naming-consistency error is 0 errors. `golden_match` is 1 against the untouched 2026-07-01 golden, which retires the plan to re-capture the seven other pre-doc-comment class goldens. |
| `L4-headerlines-document-slice` | build 1 · golden 1 | `<DeleteAction>Cascade</DeleteAction>` read back intact after the write, after **two** further bridge-backed `Update()` calls on the same table, and after a full rebuild — no guard needed, the ordering fix is a root fix. `BPUpgradeMetadataDeleteAction` is gone. The golden was re-captured from that build, so the two lines the fix PR had hand-repaired are now real captured bytes. |

Each run rolled the sandbox back and left a corpus record
(`eval/corpus/runs/2026-09-01T06__*__0fba518.json`).

---

## [1.15.0] — 2026-08-30

### Added
- **The TDD loop for X++: `prepare(mode="test")` and a red-first SysTest scaffold.**
  The server could teach SysTest and run a class; it could not help write one, and
  part of what it taught was an API the platform does not have.
  `generate_object(mode="pattern", pattern="systest")` now emits a `SysTestCase`
  subclass with one `[SysTestMethod]` per named method, each ending in
  `this.fail(...)` so the first run is red on purpose — a scaffolded test that
  passes before the behaviour exists has proven nothing about the assertion inside
  it. Only verified API is emitted (the second argument of `SysTestTarget` is a
  `utilElementType`, an expected exception is declared with
  `parmExceptionExpected`, and there is no rollback attribute because rollback is
  the default); the generated class compiles under xppc 7.0.7996.33 with 0 errors
  and 0 warnings. `prepare(mode="test")` answers in one call what used to take
  three tools and a guess: the methods worth covering with their real signatures,
  the test classes that already cover the target, whether the model references
  `TestEssentials`, the scaffold call, the red-first order and a grounding token.
  Its index lookup cost one measurement to get right — `parent_name = ? COLLATE
  NOCASE` cannot use the index on that column, so it degraded to a full scan of a
  2.5 GB table (74 s cold); plain equality with the existing nocase fallback is
  ~1 ms.
- **Ten more `validate_code(mode="syntax")` rules, taken from real compiler
  diagnostics** — static set 30 → 40. Each exists because xppc answered a probe,
  and each quotes that message in its fix text so the developer reads what the
  build would have said: `FN002` (a predefined function this platform removed —
  `corrFlagGet`, `dateMin`, `int2Enum` and friends read as AX 2012 habits),
  `BP006` (`pause`/`window`/`tableLock`/`changeSite`, which the compiler reports
  only as `Invalid token '10'`), `MAC001` (`#define X(1)` defines nothing),
  `SEL008` (order by / group by after the where of the same segment), `SEL009`
  (`in` with an inline container literal), `SEL010` (a select expression on a
  buffer whose name differs from its table), `ATTR001` (a non-literal attribute
  argument), `ATTR002` (`[SysObsolete]` without all three arguments), `EXT001`
  (a non-static extension-method class) and `KW001`. All ten were swept over
  7,649 shipped `AxClass`/`AxTable`/`AxForm` files — 51 MB of compiling X++ —
  and the sweep ends with zero error-severity findings.
- **Knowledge written from compiler probes rather than memory:**
  `runtime-functions` (~170 predefined functions by category with the argument
  counts the compiler stated, including the optional trailing parameters the
  language reference presents as fixed, the four variadic ones no arity rule may
  police, the five AX 2012 names that are gone and the four reported obsolete),
  `form-event-handlers` (built from the platform's own handlers: the sender of a
  `[FormEventHandler]` is `xFormRun`, not `FormRun`), `args-object`,
  `display-edit-methods`, `sysoperation-ui-attributes`, and three techniques for
  extending a report that already ships. Writing them disproved two things this
  repo already said — among them `xpp-class-rules`' claim that `display static`
  compiles, which came from a probe whose method name did not match its XML
  entry, so the body was never compiled.
- **Nine coverage leaves for the language surface the artifact taxonomy hid.**
  The old taxonomy asked whether the server can create each kind of AOT object,
  and the answer was yes for all 51 core leaves; it never asked whether the server
  knows what the **compiler** accepts inside them — which is where this wave found
  twenty-two wrong knowledge rules and five false-positive validator rules. Adding
  the question dropped core coverage to 86.4% on purpose before the VM goldens
  took it back to 100% (59/59); total closed to 100/100 once the mobile-app
  goldens were captured at the end of the cycle (see *Fixed*).
- **`object_patterns(domain="mobile-app")` — warehouse-app screen recipes, and the
  framework choice they hang on.** D365FO builds the SAME mobile device screens
  with **two frameworks**, and picking the wrong one is a rewrite rather than a
  refactor: `ProcessGuide` (current — controller → step → page builder → data
  processor → navigation agent → action, each one an extension point, and no
  `WHS` prefix because production and inventory flows use it too) and the legacy
  `WHSWorkExecuteDisplay` hierarchy (one `displayForm()` per `WHSWorkExecuteMode`
  that processes input, runs logic, increments the step and builds the next
  screen). Both are instantiated by `SysExtension` off the same attribute, so the
  only way to tell which owns a flow is what the registered class derives from —
  the new domain's list view leads with exactly that, then offers 7 recipes:
  `processguide-flow` (create a flow), `processguide-page-control` (add a control
  to a standard screen), `processguide-page-replace`, `processguide-step-insert`,
  `app-step-identity` (the step ID, icon and title the app shows — the step ID is
  the control name of the screen's primary input), `legacy-workexecutedisplay`,
  and `gs1-scan-input`. Each ships copy-ready X++, and every skeleton is run
  through the offline BP validator in CI — a template that emits BP-failing X++
  is worse than no template. The addition was paid for inside the same schema
  (redundant prose trimmed), so the ListTools budget is unchanged.
- **Knowledge topic `process-guide-framework`.** The class model and its traps:
  registration is by attribute, so a class with the right base and no attribute
  compiles and never runs; the base marks a screen complete on OK alone, so a
  screen that collects a value without overriding `isComplete` moves on before
  its validation ran; inserting a step means re-pointing BOTH edges of the route;
  an exception is the framework's rollback, not yours to catch.
- **Four eval cases for the mobile surface**, one per framework plus the two
  scanning halves: `L3-processguide-flow-slice`, `L2-processguide-page-control`,
  `L3-legacy-workexecutedisplay-extend` and the reframed
  `L3-warehouse-scan-resolve-slice`. All four were captured on the VM before this
  release shipped — see *Fixed*. A new VM-free gate,
  `tests/eval/mobileAppCaseGrounding.test.ts`, executes each case's own grounding
  calls and asserts the answer names what the case then asks the implementer to
  write — a case whose ground truth is missing now fails here instead of on the
  VM after a paid run. Coverage taxonomy gains `warehouse-app-screens`, the
  second of the two leaves this release adds to the closure queue.

- **Warehouse-scanner knowledge pack (SCM audit).** D365FO drives barcode
  scanners through Warehouse management, and the base was silent on it: querying
  `get_knowledge` for `barcode`, `gs1` or `scanning` returned *"No matching
  knowledge entries found"*, `item barcode` returned the **menus** topic (the
  token `item` hits the keyword `menu item`), `license plate` returned ISV
  **license codes**, and `scanner` returned **Electronic Reporting** — `scoreEntry`
  credits `token.includes(keyword)` and "scanner" contains "er". A wrong topic
  reads as authoritative, so this was worse than a gap. Two new topics close it:
  `warehouse-mobile-app` (the warehouse app is a stateless container protocol, not
  a form: screen state travels in the round-tripped payload and never in member
  variables; menu items and app steps are configured data, not AOT elements; work
  is posted through the work-execution hierarchy or it loses its undo) and
  `barcode-scanning` (printing and scanning share no code; a scan resolves through
  the barcode setup, never against `ItemId`; GS1-128 is parsed application
  identifier by application identifier with the FNC1 separator, never sliced at
  fixed offsets; a GTIN carries unit and pack quantity; an unresolved scan is a
  business case, not a throw). `warehouse-mobile-app` also covers the half that
  makes a scanner a scanner rather than a parser — it reads a code and then DOES
  something: what runs is chosen by the menu item's mode and activity
  (configuration, so "the scanner does nothing" is a setup question before it is
  an X++ one), the action must complete inside the one server call that received
  the scan (a device that walks out of range mid-conversation must not leave a
  half-posted document), it must be idempotent with the guard inside the
  transaction because devices retry and operators re-scan, and it ends in a
  document posted through the journal/posting framework rather than a raw insert.
  `warehouse-management` lost its one vague mobile
  line — it named a flow class that the audit could not confirm — and now points
  at both. Routing is pinned by regression tests, in both directions: the scanner
  queries above must land on the new topics, and the neighbours they used to be
  answered by must keep their own.
- **Eval case `L3-warehouse-scan-resolve-slice`** — GS1-128
  application-identifier parse, item-barcode resolution restricted to input codes,
  batch/serial applied through the `InventDim` find-or-create API, and the action
  itself: an inventory movement journal posted through the journal framework in a
  single transaction, idempotent on the action key. Fixed-offset slicing, an
  `ItemId` string compare, a raw `InventDim` insert, a direct journal-transaction
  insert and an idempotency guard outside the transaction each fail the case.
- **Coverage taxonomy leaves `warehouse-mobile-scanning` and
  `warehouse-app-screens`** (w2 each, total tier). The scanner half of WHS was
  uncovered while looking covered under `warehouse`, whose case exercises
  wave/work creation only; the screen half was not modelled at all. Both leaves
  are honest gaps rather than closures, so they reopened the total tier that the
  golden capture above had just closed: **core 59/59 (100%), total 98/100 (98%)**
  at the time, with both named in the weight-ordered closure queue. Both closed
  before the release — the four cases were captured on the VM and total reads
  **100/100** (see *Fixed*).
- **X++ language-core knowledge pack (Phase B).** The knowledge base was strong
  on frameworks and data access and silent on the language itself, so an agent
  could look up `SysOperation` but not how `switch` falls through. Seven new
  topics — `xpp-data-types`, `xpp-declarations`, `operators-precedence`,
  `switch-loops`, `attributes-authoring`, `intrinsic-functions`,
  `date-effective` — plus six expansions: `select-statement` (firstOnly
  variants, exists/notexists semi-join semantics), `xpp-class-rules` (no
  overloading, properties, generics or lambdas), `event-handlers` (delegate
  declaration vs eventhandler subscription, no firing-order guarantee), `coc`
  (next-in-try/catch PU21+, implicit system-method wrapping PU22+),
  `transactions` (the precise in-tts catchability matrix, replacing the
  overbroad "never try/catch inside tts"), `error-handling` (retry semantics,
  infolog discard, `finally` — and a correction: the literal is
  `DuplicateKeyException`, not "DuplicateKeyConflict").
- **Ten new `validate_code(mode="syntax")` rules (Phase C)**, taking the static
  set from 20 to 30. `CS001` rejects C# constructs that cannot compile in X++
  (`$"…"` interpolation, `=>` lambdas, `foreach`, `??`, the `string` type), each
  with the X++ equivalent in the fix message. `TTS002` catches a dead catch
  inside an open tts scope — only `Exception::UpdateConflict` and
  `DuplicateKeyException` reach an inner catch, everything else unwinds outside
  the transaction. `TTS003` flags a `retry` with no guard in its catch, which
  loops forever on a deterministic error. `SEL006` (index hint without
  `allowIndexHint(true)`, silently ignored) and `SEL007` (`left`/`right join`,
  `join…on` — SQL syntax X++ does not have). `RPT001`/`RPT002` catch SSRS data
  providers that compile clean and fail at report run time. A new
  `codeType="xml-report"` runs report-only checks (`RPT101` missing design node,
  `RPT102` dataset without `<Query>`) and pointedly does not run the X++ keyword
  rules over RDL CDATA. `FN001`'s fixed-arity catalog grew from 4 builtins to
  27, including `ssrsReportStr`'s two arguments — the missing-design-argument
  mistake now fails at write time instead of at build.
- **`object_patterns(domain="report")` — SSRS implementation recipes (Phase D).**
  Seven patterns (SimpleList, GroupedWithTotals, HeaderDetail, PreProcess,
  PrintMgmtFormLetter, QueryBased, UIBuilderDialog). Unlike a form pattern there
  is no pattern XML to validate, so a report pattern is a *recipe*: the object
  roster with base classes, the one `generate_object` scaffold call that
  produces it, method guidance, and the checks to run afterwards. Alongside it:
  `validate_object_naming(objectType="report")` warns when an AxReport name
  carries a companion-class suffix and returns the full roster;
  `generate_object(mode="scaffold", objectType="report")` gained `uiBuilder`,
  and its op-spec now advertises `aotQuery`, `callerTableName`, `preProcess`,
  `controllerType` and `uiBuilder` — all implemented already, none of them
  visible to an agent before.
- **Index warm-up at startup** (`INDEX_WARMUP`, `INDEX_WARMUP_BUDGET_MS`).
  87% of a 23-minute benchmark run was tool time over SQL that takes
  milliseconds once the pages are cached. Measured on the reference VM
  (1.19M symbols / 2.5 GB): the `idx_symbols_name` covering scan is 83 s cold
  and 0.11 s warm; the run's own 189 s search batch and 174 s first label search
  are that same cold cost. A worker thread now reads the hot indexes on its own
  connection, budget-capped and never awaited. It buys the session's first
  questions, not the whole session — the two databases are larger than the cache
  they compete for, and a build evicts them again.
- **A running tool call now says which phase it is in** (`SLOW_CALL_HEARTBEAT_MS`,
  default 30 s, 0 to turn it off). The phase block in the reply is only ever read
  afterwards, and the create that took 341 s reported all of it as
  `(unmeasured)` — so there was nothing to look at either way, during or after.
- **Op-spec topics for the build/verify/BP overrides.** `packagePath` on
  `build_d365fo_project`, `verify_d365fo_project` and `run_bp_check` was
  unpublished to pay for schema cost and had nowhere to be discovered — it
  points those tools at metadata outside the configured PackagesLocalDirectory
  and has no published equivalent, so the capability existed and nothing could
  tell a caller it was there.
- **Eval catalog 87 → 98 cases, and both coverage tiers closed at 100%**
  (core 51/51, total 89/89). Phase E added the grammar and reporting leaves,
  Phase F captured their goldens on the VM, five language cases and a final
  attribute/reflection case closed the queue — each built, xppbp-clean,
  golden-matched and rolled back on the VM.
- **Three scaffolds for extending a report that already ships**, closing the last
  G4 gap — the technique was knowledge-only, so an agent could read what to do
  and still had to hand-write it. `generate_object(mode="pattern", pattern=…)`
  now emits `report-dataset-extension`, `report-custom-design` and
  `report-menu-redirect`, each paired with a recipe in
  `object_patterns(domain="report")` (10 recipes now: seven that create a report,
  three that change one). Every emitted shape was compiled on the VM against real
  standard objects — `AssetBarCodeDP`/`AssetBarCodeTmp`,
  `AssetBarCodeController`, `SalesInvoiceController` — **with a negative control
  in the same build**, because a probe that reports nothing is not a probe that
  passed. Three details the compiler settled and the scaffolds now carry:
  - the dataset accessor is a *parameter*, never derived from the temp-table
    name: the platform's own `AssetBarCodeDP` spells its getter
    `geAssetBarCodeTmp`, a shipped typo. Give it and you get the bulk
    `[PostHandlerFor]` shape; omit it and you get the per-row
    `[DataEventHandler]`, which needs no accessor at all;
  - `linkPhysicalTableInstance` is load-bearing in the bulk shape — a temp-table
    buffer merely declared in the handler is a *different, empty* table, so the
    handler would appear to work while updating nothing;
  - a catalog recipe can no longer name a `generate_object` pattern that does not
    exist: `CODE_GEN_PATTERNS` is exported and the catalog gate checks every
    pattern name in the file against it.
- **Nine eval goldens captured on the VM**, taking core coverage from 86.4% back
  to 100% (59/59) — this time on goldens that exist rather than on leaves marked
  pending. Every artifact was written through the server's own
  `d365fo_file(action="create")` path (no hand-edited XML), full-built with xppc
  7.0.7996.33, checked with xppbp and rolled back; a golden is only committed out
  of a build that was clean. 15 files across `L2-runtime-functions-arity`,
  `L2-implicit-conversions`, `L2-select-find-options-joins`,
  `L2-args-record-caller`, `L2-display-edit-methods`,
  `L2-systest-authoring-basic`, `L3-form-event-handler-class`,
  `L3-sysoperation-dialog-attributes` and `L3-report-dataset-extension`, each with
  a README recording what it has to keep showing and what the capture taught.
  One case spec was wrong and the platform said so: `L2-display-edit-methods`
  asked for an `AxTableExtension`, and an `AxTableExtension` carries no
  `<Methods>` element at all — not one shipped table extension in ApplicationSuite
  has one — so display and edit methods on a table you do not own belong in an
  `[ExtensionOf(tableStr(…))] final class`.

### Fixed
- **`run_systest_class` was recorded as blocked by a platform limitation it does
  not have.** This repo stated that `SysTestConsole.exe` requires an interactive
  console session (an unconditional `WaitForDebugger`/`Console.ReadKey`). It does
  not: the binary documents `/unattended` in its own `/?` output, and with the
  flag it skips the prompt and reaches "Executing test(s) ...."  — the tool passes
  it now. What actually stopped a run on the reference VM is named instead of
  blamed on the test model: `Bin\SysTestConsole.exe.config` redirects
  `Microsoft.ApplicationInsights` to a version the install does not have, and once
  that is corrected the next assembly (`System.ValueTuple` 4.0.3.0) is correctly
  redirected but simply absent from `Bin`. Both are config-only fixes on the
  platform installation, so they are described rather than made here; the tool
  recognises the failure and explains it.
- **`barcode-scanning` told the agent to write a GS1 parser it must not write.**
  Inside a warehouse-app flow the platform parses GS1 before the scan reaches the
  flow — global prefix/group-separator/unknown-identifier options on Warehouse
  management parameters, the application-identifier list, and a bar-code data
  policy on the mobile device menu item for one scan filling several fields. The
  topic now leads with that, keeps the hand-written parser only for the paths
  with no menu item behind them (rich client, integrations), and adds the two
  facts that decide whether scanning works at all: the scanner hardware must add
  a recognised AIM prefix and convert the ASCII 29 group separator to a printable
  character, and multiple-field scanning changes *when* a flow has its values, so
  a custom step can be skipped. The eval case was reframed to match. Sourced from
  Microsoft's own documentation rather than recall.
- **`labels(action="search")` recommended labels that are not on disk.**
  `action="info"` has checked a single id against the `.label.txt` since August;
  search — the call an agent makes *before* it reuses a label — never did. One
  benchmark run took all three labels it needed from a single search, every one
  a resolvable index hit left behind by a rolled-back session and none of them
  on disk. xppc does not check labels, so the 115 s build passed and
  `run_bp_check` found them two steps later (`BPErrorUnknownLabel` ×2, plus two
  bogus `BPUnusedStrFmtArgument` — an unresolvable label reads as a format
  string with no placeholders). Recovery cost a second build and a second BP
  run. Search now confirms hits against disk, marks a phantom row, and never
  picks one as the recommendation.
- **An EDT read back its constructor default instead of its inherited
  `StringSize`.** `IMetadataProvider` returns an EDT exactly as its own XML
  declares it and fills in nothing it inherits, so a derived string EDT that
  declares no size reported 10: `ItemFreeTxt` is really 1000, `ItemId` and
  `CustAccount` really 20. The table reader carried the same defect and is the
  higher-traffic consumer — across ten core tables **310 of 564 string fields
  (55%) reported the wrong size**. A derived EDT that *declares* its own size is
  authoritative (228 in the shipped corpus do) and is left untouched; only the
  unset case is filled in. A follow-up audit also bound the two hand-rolled
  fallbacks by name: the CLR resolves a method token when it JITs the
  *containing* method, so the `MissingMethodException` they existed for surfaced
  one frame up and their inner catch never ran — verified on .NET Framework 4
  x64 against an assembly with the helper removed.
- **SSRS scaffolding produced reports that could not compile or bind.** The
  `ssrs-report-full` pattern emitted `ssrsReportStr(X, Design)` while every
  scaffolded AxReport names its design `Report`, and `ssrsReportStr` is
  compile-time checked against that name — so the generated controller could
  never compile against the generated report; a regression test now pins the two
  paths together. The pre-process scaffold paired a TempDB table with the wrong
  data-provider base, and the print-management controller did not implement the
  abstract `runPrintMgmt`, so it did not compile. Report EDT resolution is now
  model-aware: a field of that name already in the target model wins, and a
  candidate that is another model's prefix glued onto the field name is demoted
  — which is what made a bare `fieldsHint` pick an un-migrated
  `PlCorrNoteId` (`BPErrorEDTNotMigrated`).
- **Write-path gaps found while capturing a date-effective case on the VM:**
  `add-index`/`create` could not set `ValidTimeStateKey`/`Mode`, `add-field`
  handed the bridge the root EDT name for a Date EDT (`Data type mismatch`), and
  a `modify-property` with an empty value left an empty element behind.
- **Options a tool accepted and then quietly dropped.** An option silently
  ignored is worse than one refused, because the caller draws a conclusion from
  the absence. `get_object_info(objectType="table", options:{relations:true})`
  is read only by the bridge renderer; on the symbol-index and disk fallbacks
  the knobs were parsed, defaulted and dropped, so the answer came back with no
  relations and nothing to explain it — which reads as "this table has none".
  Those paths now name what they could not honour, and why. Separately,
  `workspace://active` and `workspace://files` rendered from the NON-blocking
  context snapshot and never read its pending flags, so a scan still running was
  reported as an empty result — at session start, exactly when the caches are
  cold, a workspace full of recent edits could come back as "no recent edits". A
  resource read is not on the latency path a tool call is, so it now waits.
- **`d365fo_file(action="create", objectType="table")` silently dropped
  `properties.fieldGroups`.** The `<FieldGroups>` block was a hardcoded literal
  holding only the five `Auto*` groups. A table with no groups of its own still
  builds clean, so this stayed invisible until the SimpleList form template
  emitted `<DataGroup>Overview</DataGroup>` and the build failed with *"Field
  group 'Overview' does not exist"* — on the **form**, pointing away from the
  table that had actually lost it.
- **`d365fo_file(action="create", objectType="form")` never resolved field
  control types**, so every grid column came out `AxFormStringControl` —
  invisible for a string field, and a build error for anything else (a date
  column fails with *"DataField: Data type mismatch"*, again naming the form
  rather than the type it disagrees with). The templates have accepted a
  `fieldTypes` map all along and `generate_object` supplies one; only this
  builder did not. It now resolves them off disk, which also covers a table
  written moments earlier in the same call and therefore absent from the symbol
  index. `createTablePropertyHonesty` needed no change and got none — it reads
  the XML that was actually written rather than a maintained capability list, so
  it stopped reporting field groups by itself, and its test now asserts that
  silence.
- **The knowledge base told agents to call two methods that do not exist.** Both
  were found by compiling what it recommends rather than by reading it again.
  `form-event-handlers` said a control lookup ends with `_e.CancelSuperCall()`;
  xppc answers *"Class 'FormControlEventArgs' does not contain a definition for
  'CancelSuperCall'"* — the args have to be narrowed to
  `FormControlCancelableSuperEventArgs` first (and a data source write is
  cancelled through its own `FormDataSourceCancelEventArgs.cancel(true)`).
  `report-extension-patterns` said a custom-design controller's `main()` calls
  `initArgs(...)`; there is no `initArgs` on `SrsReportRunController` or anywhere
  in its hierarchy. Shipped controllers use `parmArgs` + `parmReportName` +
  `startOperation`, which is what both the rule and the scaffold now do.
- **`run_systest_class` blamed the wrong thing for a failed database login.** It
  reported `Login failed for user '…'` as "a deployment credential", which sent
  the reader hunting a rotated password. On the machine this was recorded from,
  nothing had rotated: `Bin\SysTestConsole.exe.config` is the shipped template,
  never configured for that install, and it disagreed with the AOS's own
  `WebRoot\web.config` on **all four** DataAccess settings — database, user,
  server, and a password still reading `$CREDENTIAL_PLACEHOLDER$`. The tool now
  compares the two files itself and names the settings that differ, and it never
  puts the password in its answer: only "the shipped placeholder" or "set, N
  chars, not shown". Applying the fix edits the platform install and moves a
  secret between files, so it stays the operator's call — the four
  `systest_pending` eval cases remain pending, now with an accurate reason.

- **A write did not invalidate the workspace scan cache.** `WorkspaceScanner`'s
  own doc comment said its 15s TTL was "paired with invalidate() (called after
  writes)"; `invalidate()` had no production caller at all — only tests and its
  own `clearCache()` alias. So for up to 15 seconds after a create, the
  workspace-backed readers and the `workspace://files` / `workspace://active`
  resources could not see a file this same server had just written. The
  dispatcher now clears it at the same choke point that bumps the write epoch,
  which is the sibling cache with the same failure mode and the same fix.
- **Four served MCP methods were logged as if unimplemented.** The HTTP
  transport's `SILENT_PROBES` set carried `resources/list`,
  `resources/templates/list`, `prompts/list` and `logging/setLevel` under a
  comment reading "capability-probe methods that always return Method not
  found". All four are served — the first three since resources and prompts got
  handlers, and `logging/setLevel` by the SDK itself off the declared
  `logging: {}` capability, which is why no grep for a request schema in this
  repo ever found it. Nothing was broken for clients; what it cost was evidence.
  A client that reads `workspace://active` and one that ignores our resources
  produced byte-identical logs, and that difference is precisely the trigger two
  `docs/BACKLOG.md` entries (context-pipeline Phase 3b, VSIX shim) have been
  waiting on. The resource and prompt handlers now log each list/read
  themselves, so the signal survives stdio too — where VS Code and VS 2022, i.e.
  every target client, connect and the transport logs nothing per request.
  `SILENT_PROBES` is now pinned against the SDK's real handler registry.
- **Docs and the architecture diagram re-aligned with the code.** The numbers
  drift audit: the SVG still advertised 26 tools (it is 20 — the same fold this
  block documents), TESTING.md still said 23 tools and ~2,900 tests across ~220
  files (5,000+ across ~350), ARCHITECTURE.md carried a pre-fold "80 cases"
  (87), "~19 patterns + ~20 sub-patterns" (36 + 30), "11 static rules" (20),
  "31 modify ops" (27 distinct C# dispatcher ops) and a `/health` rate limit
  that does not exist (`/health` is exempt). MCP_TOOLS.md now documents
  `labels(action="update")` and `get_knowledge(kind="bp-moniker")`, the
  extension objectTypes of `get_object_info`, the per-mode tool counts
  (read-only 14 / write-only 9), and gained a short section on the 8 MCP
  prompts and 5 workspace resources nothing user-facing listed before. The
  heaviest table cells (`get_object_info`, `generate_object`, `d365fo_file`,
  `object_patterns`) were unpacked into bullet lists — same facts, readable
  shape. CUSTOM_EXTENSIONS.md and SETUP_AZURE.md stopped teaching the legacy
  `.env`/`PACKAGES_PATH` configuration as the primary route now that the
  wizard writes `config/d365fo-mcp.json`. Re-run against the Phase B–F work
  that landed after it: 87 → 98 eval cases, 20 → 30 static rules, coverage
  44/44 + 78/78 → 51/51 + 89/89, and the `object_patterns` report domain,
  report naming and `uiBuilder` scaffold documented for the first time.
- **Writes silently landed in whichever project scanned first.** When workspace
  heuristics resolved nothing, the `D365FO_SOLUTIONS_PATH` fallback pinned
  `all[0]` — so in a solution where several `.rnrproj` build one model (the
  ordinary D365FO shape: one real solution here has 190 projects across 31
  models, the largest model built by 20 of them), every file registered itself
  into an arbitrary project nobody chose, on every fresh session. The model still
  resolves — every candidate agrees on it — but the project is now left unset,
  and the projects it is between are NAMED: by `get_workspace_info` (`Project :
  (not selected — N projects build this model)` plus their file names) and by the
  create warning, which listed nothing before. `d365fo-mcp doctor` no longer
  prints the project that was deliberately not selected. When the scan root holds
  several custom models, the log now says the model was picked by scan order
  rather than deduced — the pick itself stands, because for many workspaces this
  scan is the only model source.
- **`get_workspace_info` answered a refused `projectName` with nothing else.**
  It is the first call of every session, and the parameter is one the agent is
  told to pass from context, so a miss is expected traffic — and it cost the whole
  call plus a round trip to ask again without the argument. The refusal now comes
  first, still with `isError` so it cannot read as a completed switch, followed by
  the workspace facts the call was made for.
- **A bridge provider that FAILED was reported as "object not found".**
  `PickProvider` swallowed the exception from both metadata providers and
  returned null, and every caller maps null to `-32001 Object not found`. So a
  metamodel mismatch, a `TypeLoadException` or an unreadable model reached the
  agent as "that object does not exist" — and an agent told an object is absent
  creates it, which is how you end up with two. The catch stays (the primary
  provider legitimately throws for an object only the UDE reference provider
  carries, and swallowing that is what makes the fallback work), but a failure is
  now remembered and surfaced when NEITHER provider said yes.
- Bridge write wrappers logged their exception to stderr and returned a plain
  failure message, bypassing the per-call failure sink the read wrappers use — so
  a write that threw reached the model with nothing saying the bridge was what
  broke. 27 of them now record into it. Same stderr line, same return shape.
- **`d365fo_file(action="generate")` produced X++ that could not compile.**
  `XmlTemplateGenerator` was declared twice — once in `createD365File.ts`, once
  in `generateD365Xml.ts` — with a comment on each half asserting the two were
  mirrors. They were not: **26 of the 27 shared methods had diverged**, every
  divergence a fix made on the create side that never reached the generate
  mirror. The one users could feel: the generate copy's "a member variable is a
  line ending in `;`" rule dropped `#Library` / `#define` / `#localmacro`
  directives out of a class declaration, so the XML it handed back referenced an
  undefined macro. The others were quieter and no smaller — the generate copy
  ignored `sourceCode` on tables entirely (methods and declaration never reached
  the XML), skipped self-reference normalisation on classes and data entities,
  and wrote `<DataField>undefined</DataField>` for the documented
  `fields: ["AccountNum"]` shape on a table extension.
  There is now ONE implementation, in `src/tools/xml/xmlTemplateGenerator.ts`,
  imported by both former homes and by `generateSmartReport`. Verified live
  against the VM: for a class carrying a `#Library` include, an enum and a
  security privilege, `generate` output and what `create` writes to disk are now
  identical **after line-ending normalisation** — same elements, same values,
  macro directives included. They are NOT byte-identical, and cannot be:
  `create` writes through `normalizeD365Xml` (LF to CRLF, trailing newline
  stripped) while `generate` returns the text unnormalised, so the same class
  measures 636 B returned against 668 B on disk. `generate` also does not apply
  the model-name prefix that `create` does, so the documented
  generate-then-create flow must pass the final name if it wants the same
  `<Name>`. An earlier claim of "byte-identical" here was wrong: the probe that
  produced it normalised `\r\n` and trailing whitespace away before comparing,
  i.e. it erased exactly the difference it was meant to detect.
  `tests/tools/xmlTemplateGeneratorSingleton.test.ts` fails if a second class or
  a second `generateAx*Xml` implementation ever appears — output-comparison
  tests cannot catch this, because a fork drifts in the methods nobody thought
  to compare.
- Seven rewrites moved onto the atomic write helper: in `createD365File.ts` the
  two post-create reconciliations and the primary create write; in
  `createLabel.ts` the `.label.txt` rewrite; in `renameLabel.ts` the `.label.txt`,
  the `.xpp` sources and the XML metadata it rewrites when a label id changes.
  A torn write to a `.label.txt` does not corrupt one label, it corrupts every
  label in that model's file, and that file has no undo outside git. The two
  remaining plain writes in `createLabel.ts` create a NEW file behind an
  `fs.access` miss and are correctly left alone.
- **`d365fo_file(action="create", objectType="table")` also dropped
  `properties.indexes`** — the third collection it lost after field groups, and
  the one with no way back: `createTablePropertyHonesty` correctly reported the
  loss and offered `add-index` as the repair, but that operation requires the C#
  bridge, so a create running on the XML-template path could not produce an index
  at all. `<Indexes>` is now rendered by a builder shared with the
  table-extension path, so the two cannot drift. `<Relations />` is still a
  literal and stays reported by that same honesty check.
- **The form templates named a field group they had no reason to believe
  existed.** `<DataGroup>Overview</DataGroup>` was hardcoded on the grid in three
  patterns. Binding a grid to a field group is right — shipped forms do it, and
  `CustGroup` and `VendGroup` both bind `Overview` — but naming a group the table
  does not declare is a build error, and an *incremental* build passes it
  silently, which is how it survived several captures. The builder now reads the
  bound table and omits the element only when it has **positively** established
  the group is absent; a table it cannot read leaves the binding alone, because
  absence of evidence is not evidence of absence.
- **Three goldens that could not build have been re-captured on the VM**, closing
  the "Fixture ⇄ golden mismatch" row of `eval/golden-build-verification.json`.
  `L1-form-basic`'s table golden did not satisfy its own case instruction, which
  asks for an `Overview` field group *and spells out why* ("a form whose grid
  names a field group the table does not declare fails FormPatternValidation at
  build time") — it carried `<FieldGroups />`, because the create path had
  silently dropped it. `L1-form-simplelistdetails`'s form carried a `<DataGroup>`
  with no sibling `<DataSource>`, so the group could not be resolved against any
  table. `L1-form-detailsmaster` needed no re-capture and went green once the
  fixture table was correct. All three now build clean in isolation, and
  `eval/fixtures/ConDemoNoteHeader.metadata.xml` is re-synchronised with the
  re-captured golden — a copy of a golden again rather than a hand repair of one.
  Golden re-verification: **93/100 clean over 224 artifacts** (was 57/65 over
  143; the catalog grew by 35 cases in between, so a third of it got its first
  isolated verdict here). Exactly three cases changed state — the three above.
  Nothing regressed.
- **`find_references` answered "0 references — symbol might be unused" for a
  method that is called twice.** With the cross-reference bridge down, the
  fallback matches call sites against `source_snippet`, which is a method's
  **first ten lines** by construction — so a call on line 11 or later of any
  caller is structurally invisible, and `WHSWorkExecuteDisplayAdjustIn.displayForm`
  (hundreds of lines) calls `buildAdjustIn` twice from well below the cut. An
  eval run whose scored requirement was "run `find_references` FIRST and record
  what you found" recorded a confident falsehood. The coverage gap first
  suspected was not the cause — Foundation has 351,660 method rows and
  `buildAdjustIn` is one of them. Intra-type calls, the commonest miss and the
  cheapest to recover, are now read from the declaring type's own source (one
  indexed lookup, at most three files, size-capped, best-effort); a degraded zero
  names its own blind spot instead of concluding "unused"; and an `ownerName` the
  fallback cannot honour is reported rather than swallowed — the note used to
  print only when no owner was given, so a caller who *did* scope the lookup got
  an unscoped answer that looked scoped.
- **`search` returned nothing for a multi-word query whose answer was in the
  index.** `search(query="ProcessGuide AdjustIn")` found 0 rows while
  `InventProcessGuideAdjustInController` — a name carrying both tokens — sat in
  the index and an exact-name search returned it. The substring-scan guard
  skipped every query containing whitespace, on the premise that "no name can
  contain a space": right about the SQL it guarded, wrong about the query, which
  never meant one verbatim string but *a name containing all of these* — one AND
  of LIKEs over the same single covering scan. A selective token is now defined
  in one place (at least 3 characters, at most 4 of them), so a query with
  nothing selective left still does not scan, and the term count is part of the
  statement-cache key, without which a two-token query would reuse the one-token
  statement. The eval run that hit this took the empty answer as evidence,
  targeted an obsolete class instead, caught the `[SysObsolete]` only as a
  compile warning, and rolled back.
- **`labels(action="create")` wrote labels under a file id nothing can
  reference.** A model named `fm-mcp` gets the label file id `fm-mcp`; create
  accepted it, wrote the label into every language file, reported success and
  advertised `literalStr("@fm-mcp:ScanContainer")` — a reference that resolves to
  nothing, because the hyphen ends the identifier. Two witnesses agreed the write
  was useless: `labels(action="info")` could not find the label it had just
  created, and xppbp raised `BPErrorLabelIsText`. The charset was never in doubt
  — `parseLabelReference` has always refused to parse `@fm-mcp:X` — the read side
  and the write side disagreed and the write side won silently. The create schema
  now rejects an unusable id and names the one that would work (`fm-mcp` →
  `fmmcp`) rather than restating the rule, the default pick prefers a
  referenceable file over the one named after the model, and the auto-label path
  returns null instead of a broken reference: the caller keeps its raw text and
  the BP advisory, which is worse copy but true.
- **`prepare` and `validate_object_naming` demanded opposite things, and no name
  satisfied both.** Extending `whsWorkExecuteDisplayChangeBatchDisp` — one of the
  camelCase classes the product ships — `prepare` refused the lowercase extension
  name ("Name must start with an uppercase letter (PascalCase)") while
  `validate_object_naming` refused the PascalCase one ("Class extension names
  must start with the base class name"), prescribing exactly the name `prepare`
  had just refused. The write succeeded at all only because
  `d365fo_file(action="create")` ignored the caller's input and derived the
  correct lowercase form itself. PascalCase is a rule for a name you **invent**;
  an extension name is derived from one you did not, and `{Base}{Prefix}_Extension`
  inherits its first letter from the base. `prepare` now defers to the base's
  casing when the proposed name starts with the object being changed, in both the
  `_Extension` and the dotted element-extension forms. A name that does not start
  with a letter at all is still an error, and a name the caller invented is still
  held to PascalCase. `validate_object_naming` is unchanged — it was the one in
  the right.
- **`object_patterns` truncated a recipe in half.** It ran on the generic
  5,000-character response cap: measured live, the mobile-app `processguide-flow`
  spec renders 9,328 characters and lost 4,406 of them — the `addActionControls`
  half of the page-builder skeleton and the entire silent-step skeleton never
  reached the agent, which rebuilt both from Microsoft source at several round
  trips each. A pattern recipe is a code skeleton, and half a skeleton is not a
  smaller answer but a wrong one; a round trip re-bills the whole cached context,
  so the cut cost more than it saved. The cap is 12,000, which clears the largest
  recipe in the catalog (next: `app-step-identity` at 3,853, report
  `PrintMgmtFormLetter` at 3,051) and still bounds a runaway render. The
  truncation advice is this tool's own now — the generic text pointed at
  `methodOffset`/`fieldsOffset`, parameters `object_patterns` does not accept, and
  this file already records that advice naming a knob the tool lacks gets
  followed. A ratchet test fails when a new recipe outgrows the cap, so the cap is
  raised deliberately with the measurement in hand rather than discovered by an
  agent silently reconstructing what it did not receive.
- **The `processguide-flow` skeleton routed through a confirm step it never
  creates.** The shipped recipe routed prompt → confirm → register → prompt and
  the eval case asked for the same cycle, but neither ever creates a confirm
  screen: the case names five artifacts and the pattern's own object roster four
  roles, none of them a confirm step. `classStr()` is compile-time checked, so the
  skeleton does not compile as printed — `classStr(MyDemoProcessGuideConfirmStep)`
  resolves to nothing — and there is no reusable framework confirm step to borrow,
  because every `ProcessGuide*Confirm*Step` in the product is process-specific
  with its own page builder. Both sides now route prompt → register → prompt, and
  the skeleton says why a route may name only steps the flow actually creates. The
  `processguide-page-replace` and `processguide-step-insert` recipes are untouched
  — they reference *standard* Microsoft confirm classes, which is the point of
  those patterns.
- **The four warehouse mobile-app goldens are captured**, so this release ships no
  `golden_pending` case from that wave. All four ran on the VM and passed —
  `L2-processguide-page-control` (1 artifact), `L3-processguide-flow-slice` (5),
  `L3-legacy-workexecutedisplay-extend` (1), `L3-warehouse-scan-resolve-slice`
  (1) — build clean and xppbp clean (0 errors / 0 warnings, incremental and full,
  plus an object-scoped BP check on every artifact). The two leaves those cases
  were opened for close with them: **core 59/59 (100%), total 100/100**, and the
  README badge follows. Their taxonomy notes still claimed "goldens pending VM
  capture" and are rewritten to what the runs actually showed — `coverage.test.ts`
  has a gate for exactly that lie, and 37 notes had told it before, one of them in
  the published `COVERAGE.md`. Two gaps the runs found are recorded in the corpus
  records and **not** fixed here: `validate_code(mode="references")` accepts
  `methodStr()` where xppc requires `staticMethodStr()` for a static method, and a
  stale `visibilityCache` in `metadata/modelDescriptor.ts` makes a `Descriptor`
  edit invisible for the rest of a server session.

### Changed
- **The compiler is the oracle for the validator now.** Measured against the
  platform this server writes for — 7,649 shipped files (51 MB of X++) swept
  through `runRules`, plus ~700 probe classes compiled by xppc — the validator
  used to report 5 error-severity findings on Microsoft's own compiling code. It
  now reports none while checking six times more. Two causes: every one of those
  false positives came from maskers that recognised only double-quoted strings
  (`strFind(text, ',', 1, len)` read as a wrong arity, a GUID mask as a C# `??`,
  an SQL string as a `left join`), so all five are replaced by one lexer in
  `src/utils/xppLexer.ts` that handles both quote styles, verbatim literals and
  doubled/escaped quotes while preserving offsets; and reserved words, intrinsics
  and function arities are now captured from the shipped parser and compiler
  assemblies into `eval/compiler-facts.snapshot.json` (115 keywords, 80
  intrinsics, 170 functions) instead of 28 hand-typed entries — so `FN001` knows
  that `date2Str` takes 7 **or** 8 arguments and that `strFmt`/`conIns`/`max`/`min`
  are variadic. Several rules were narrowed by the shipped code that disproved
  their old shape, `COC001` (which fired on new methods an extension class merely
  adds) among them.
- **Knowledge claims re-verified against xppc on the VM (Phase F).** `conIns`
  left `FIXED_ARITY_BUILTINS` (xppc accepts 2 and 4 arguments), `protected
  internal` compiles while `private protected` does not, `forceLaterals` is not
  a keyword, and the attribute is spelled `SrsReportParameterAttribute` per its
  own `<Name>`. Examples added to the SSRS and attribute topics against real
  symbols — 309 references audited, 0 defects.
- **A write no longer sweeps the whole metadata root to resolve its package.**
  `PackageResolver.buildMap()` reads every package directory, every descriptor
  and every subdirectory again — ~5 s on a 214-package PackagesLocalDirectory,
  paid on every write because both paths build a fresh resolver. It now probes
  `<root>/<modelName>` first (two readdirs): **5,073 ms → 6 ms**, agreeing with
  the full sweep on 211 of 212 models, and the sweep still runs for a package
  not named after its model. The fallback write path also names its phases, so
  a slow create can no longer attribute five minutes to `(unmeasured)`.
- The direct-XML writers moved out of `modifyD365File.ts` into
  `src/tools/write/directXmlWriters.ts`.
- An event-loop lag monitor ships behind `DEBUG_LOGGING`. The audit could
  measure the symptom — 268 real `labels` calls averaging 5.6 s server time
  while the FTS query inside them takes 6-11 ms, a first call after the
  handshake taking 1.3 s and the same call 18 ms eight seconds later, and the
  tool's own phase timer reporting 0.0 s throughout — but not the cause. Measured
  from outside on this VM with a warm OS file cache, the loop is barely blocked:
  three ~140 ms stalls in the first 5.5 s, 415 ms in total across 25 s, on top of
  a 1,749 ms `initialize`. The corpus averages come from cold caches, which
  cannot be recreated on demand. So rather than invent a fix for blocking that
  cannot currently be measured, the measurement now lives in the server.
- A successful bridge `create` no longer rebuilds the metadata provider twice.
  The C# dispatcher runs `RefreshProvider()` itself after `createObject` /
  `createSmartTable`, and the TypeScript side then scheduled and flushed another
  full `DiskProvider` rebuild of the same tree. The adapter now records the
  bridge-side refresh, and the second one runs only for the direct-XML create
  path, which genuinely has nothing else to schedule it. Measured live, A/B over
  the same call: create + 3 operations 5,754 → 5,452 ms and 3,455 → 3,138 ms.
- **The published tool surface is 20 tools, down from 23.** Every tool schema is
  sent on every request, so a merge only pays when the merged description is
  shorter than the sum of the parts. Three were, and each fold went into the tool
  that already owned the subject and already had the parameter:
  - `undo_last_modification` → **`d365fo_file(action="undo", filePath)`**.
    `filePath` was already there, the tool is already annotated destructive, and
    the warning that carried the tool — *git checkout HEAD discards ALL
    uncommitted changes to that file, not just the last edit* — moved with it.
  - `review_workspace_changes` → **`get_workspace_info(changes=true)`**. Both were
    local, read-only and about the same workspace. The description was corrected
    in the move: the retired tool advertised "BP violations, missing labels, CoC
    patterns" and its handler only ever ran `git diff HEAD --unified=3`. It also
    no longer needs a directory argument (it derives one from the workspace) and
    says plainly that there is nothing to show when the workspace is not a git
    work tree, instead of failing — 2 of its 7 recorded real calls failed exactly
    that way.
  - `trigger_db_sync` → **`build_d365fo_project(dbSync)`**, mirroring the existing
    `bpCheck` knob: a sync always follows a successful build, so it should not
    cost a second round trip. `dbSync: true` syncs the project's syncable
    objects (full-model when it has none); `dbSync: ["CustTable"]` syncs exactly
    those.
- Schema trims paying for the folds: `get_object_info` stopped inlining the
  object-type enum a second time inside `objects[]`, four discriminator
  parameters stopped restating the bullet list their own tool description already
  carries (`generate_object.mode`, `security_info.mode`, `object_patterns.domain`,
  `validate_code.mode`), and `update_symbol_index` dropped the half of its
  description that had become an essay. `ListTools` fell from 48,019 to 44,919
  characters.
- The base-object XML locator moved out of `modifyD365File.ts` into
  `src/utils/baseObjectXml.ts`. `generateSmartForm` had been importing a
  5,600-line write tool to read a form's XML; `tests/utils/layering.test.ts` now
  fails if a generator imports a write tool again (the 93-line write-anchor
  guard stays allowed and says why), and pins the two remaining upward imports
  so a third cannot appear unnoticed.

### Breaking
- **`undo_last_modification`, `review_workspace_changes` and `trigger_db_sync` are
  no longer published.** Any prompt, instruction file or `MCP_EXTRA_TOOLS` list
  that names one must be updated to the folded form above; this repo's own
  `.github/copilot-instructions.md` and system prompt were. All three names stay
  **routable**, so an agent still holding one gets its answer rather than an
  unknown-tool error — and `trigger_db_sync` remains the way to run a partial
  sync with no rebuild in front of it.

---

## [1.14.0] — 2026-08-24

_Reconstructed from `git log` and the release tag: this version shipped without
notes, so the entries below name what changed and why it mattered, not every commit._

### Added
- `d365fo_file`: `operations[]` on **`action="create"`** as well as modify, applied
  against the name the create actually wrote (which is not always the name passed —
  the model's naming style decides it).

### Changed
- **Round trips became the unit of optimisation.** A session audit fitted the real
  billing of a 19-minute agent session and established that cached context is
  re-billed on *every* request, so the number of calls a task needs dominates cost.
  The four dominant serial patterns gained plural forms, framing the caller cannot
  act on was removed from responses, four fixed costs came off every tool call, and
  schemas stopped advertising knobs nobody turns and stopped stating the same rule
  twice. `ListTools` fell to 25 tools / ~53 KB, and `MCP_TOOL_PROFILE=core` (18
  tools) arrived for setups that want less.
- Bridge metadata **reads now overlap**; writes stay exclusive. `SearchObjects` no
  longer materialises every collection's primary-key list per search.
- `d365fo_file`: a wrong parameter **shape** now answers with the operation's full
  contract instead of a bare validation message.
- Naming rules are one shared implementation, used by `prepare` as well as by
  `validate_object_naming`. The duplication that made unpublishing the latter look
  attractive is gone; the tool stays published because `prepare` never covered
  extensions.

### Fixed
- **Kernel enums were reported as hallucinated symbols.** 44 enum names that shipped
  metadata uses (`NoYes`, `TableGroup`, `AccessRight`, ...) have no AOT artifact, so
  an index-only existence check could not find them and failed a call it was in no
  position to judge. Such a check now warns instead of erroring.
- `add-entry-point` silently dropped `accessLevel`, granting Read only.
- FP002 crashed on a `Custom` form pattern and advised "undefined".
- The duplicate-call advisory called a legitimate re-read-after-write a loop.
- A bridge read that cannot print no longer takes the request loop down with it.

---

## [1.13.0] — 2026-08-21

### Added
- `d365fo_file`: `remove-control` (form / form-extension) and `remove-entry-point`
  (security-privilege) — the missing inverse of `add-control` and of the entry
  point `create` writes for `targetObject`, neither backed by a bridge op (no
  `RemoveControl`, and security objects have no bridge write path at all), so
  both are XML-only writers admitted through a new `XML_ONLY_MODIFY_PAIRS` gate
  in `bridgeAdapter.ts`. Plus `action="delete"` — removes an object's XML and
  un-registers it from every `.rnrproj` of the model that lists it.
- `d365fo_file`: `remove-diagnostic-suppression` and `add-diagnostic-suppression`
  (`ignore-diagnostic-list`) — add/remove a `<Diagnostic>` in a model's
  `{Model}_BPSuppressions.xml` by its `<Path>` (+ `<Moniker>` when the same path
  carries more than one). `add-diagnostic-suppression` builds the block with the
  same `buildSuppressionXml` the `get_knowledge(kind="bp-moniker",
  action="suppress")` render-only helper already used (that helper now points at
  this operation instead of telling you to paste the block by hand), refuses a
  duplicate (same path + moniker) instead of writing a second copy, and creates
  the file — and its `AxIgnoreDiagnosticList` folder — for a model that has
  never suppressed anything before, in the shape measured from the 339
  suppression lists of a shipped PackagesLocalDirectory. `delete` now also
  strips any suppression whose `<Path>` targets the object being deleted
  automatically, across **every** list in that folder (a model routinely carries
  several, under names tied to neither the model nor a convention), closing the
  gap where deleting an object by hand left its BP-check suppression behind,
  silencing a rule against nothing.

### Fixed
- One definition of `.rnrproj` include identity, on the add side too.
- An XML writer whose first-match replace ranged over a block whose collection also
  nests could land a write on the wrong object and still report success.

---

## [1.12.0] — 2026-08-17

_Reconstructed from `git log` and the release tag: this version shipped without
notes, so the entries below name what changed and why it mattered, not every commit._

### Added
- `get_knowledge(kind="bp-moniker")` — validate an exact best-practice moniker,
  search by scenario when there is no moniker yet, or render a `_BPSuppressions.xml`
  `<Diagnostic>` block. Backed by names extracted from the **local** D365FO install
  and regenerated per instance from that instance's own version, so it never invents
  a moniker or claims one from a different install.

### Fixed
- `add-control` on a **form extension**: values interpolated into the control XML are
  escaped, placement and refusal errors name the right source, a control is placed by
  resolving its parent, and files damaged by the old writer stay usable.
- `run_bp_check` / `build`: `-compilermetadata` points at the model store rather than
  the framework directory, and cleans up after itself.
- `search` falls back to LIKE when FTS5 returns **zero rows**, not only on a syntax
  error — bounded to the queries that fallback can actually answer.
- Guidance stopped telling agents to call method readers that are not published, and
  the class reader stopped promising method bodies a follow-up call cannot deliver.

---

## [1.11.0] — 2026-08-13

### Security
- **GHSA-8764-fh3m-wf7g — the documented Azure deploy path produced an
  unauthenticated public MCP endpoint.** The one-click template declared `apiKey`
  with `defaultValue: ""`, which flows into the App Service `API_KEY` setting.
  Empty makes `apiKeyAuth` a pass-through and the server bound `0.0.0.0`, so
  following the deploy steps as written served the whole read surface —
  including the `source_snippet` fields carrying the customer's own X++ — to
  anonymous callers. The hostname is not obscure either: it derives from the
  resource group name (`d365fo-mcp-server-<customer>.azurewebsites.net`) and
  appears in Certificate Transparency logs. Reported by Lucas Weber (CyberSec42)
  under coordinated disclosure; fixed in #897. `apiKey` became a required
  template parameter with `@minLength(32)`, `resolveBindHost()` now defaults the
  bind to `127.0.0.1` until `API_KEY` or `ALLOW_UNAUTHENTICATED` is set, and
  `authStartupError()` refuses to start when the resolved host is not loopback
  and nothing authenticates it.

  Affects **`<= 1.10.1`**. The advisory first named **1.10.2** as the patched
  version, and that version was never published — `package.json` on `main`
  carried it through the fix window, but the release shipped as **1.11.0**
  (npm, 2026-08-13). Anyone acting on the advisory was pointed at a version they
  could not install; corrected in the advisory on 2026-09-08. CVE requested, not
  yet assigned.

### Breaking
- **An HTTP server with no `API_KEY` binds `127.0.0.1` instead of `0.0.0.0`.** A
  keyless deployment that relied on being reachable from the network must set
  `API_KEY`, or `ALLOW_UNAUTHENTICATED=true` where authentication is enforced
  upstream (Easy Auth, Private Endpoint, authenticating proxy). Setting `HOST` to
  a public interface with neither is refused at startup. `NODE_ENV` is no longer
  read for this decision: the first guard fired only on `NODE_ENV=production`,
  which the Bicep template sets but the `.azure-pipelines/` deploy onto a
  hand-created App Service does not — leaving that path exactly as exposed as
  the one reported, with the guard silent throughout. Local development got
  quieter rather than louder: `npm start` with no key binds loopback and needs no
  new variable to do it.

### Changed
- `EXTENSION_PREFIX_SOURCE` is now the config key **`naming.prefixSource`**
  (`model` | `config`), asked in the advanced pass of the `naming` section
  (#893). It was `env-only` — a tier meant for values whose reader the
  wizard-managed JSON cannot honestly describe: the cross-model consent
  switches, re-read from the `.env` before every guard decision, and the lock
  heartbeat, read in a process the wizard never configures. This one is a static
  naming preference with no hot-reload path; it landed in that group only
  because registering it was how the docs generator stopped deleting it. The
  cost fell on multi-instance installs, where pinning a prefix meant adding an
  `instances/<name>/.env` holding one line next to the
  `instances/<name>/d365fo-mcp.json` holding everything else. Precedence is
  unchanged — the environment variable still works and still outranks the config
  file — and a legacy `.env` that sets it now migrates into the JSON instead of
  being skipped.

- `d365fo-mcp doctor` reported a prefix conflict that the server does not have
  to anyone who had already pinned their prefix, and offered as the fix the
  setting they had already applied. The check called `inferPrefixFromObjectNames`
  directly, one level below `getInferredModelPrefix`, which is where the pin is
  honoured. It now states the pinned value and names the model's own prefix as
  ignored rather than winning — and warns when the pin has nothing to pin
  because `naming.prefix` is empty.

### Added
- `validate_code`: **COC006** (a table CoC re-reading the record it already holds) and
  **FN001** (a fixed-arity built-in called with the wrong argument count).
- `prepare` answers for the table methods a **kernel type** declares.
- Knowledge: enum conversions documented, and an absent name admitted rather than
  guessed.

### Fixed
- **`extension_metadata` is written on a reindex, not only on a full build.** Until
  this, a field added to a table extension — or a method added to a CoC class — was
  invisible to every reader keyed on the base object until the next rebuild, and
  `resolve_references` reported it as an error that refuses the write carrying it.
- `create` discloses in the response the name the write actually used.
- A class-extension name in element style is rewritten rather than suffixed twice.
- `undo` removes the `.rnrproj` entry on the git path too.
- `run_bp_check` withholds the green tick when nothing has compiled the model.
- `labels` budgets searches by call count, on both verdicts.
- The index stopped trusting a `file_path` that points at the JSON cache.

---

## [1.10.1] — 2026-08-11

_Reconstructed from `git log` and the release tag: this version shipped without
notes, so the entries below name what changed and why it mattered, not every commit._

### Fixed
- Follow-ups to the 1.10.0 audit landing (PRs #889, #890). No tool-surface change.

---

## [1.10.0] — 2026-08-10

_The 2026-08-08 full-repo audit, executed as 23 PRs (#847-#869) plus follow-ups._

### Added
- `CHANGELOG.md` (this file).
- `biome.jsonc` + `npm run lint` — first linter in the project's history.
  Configured as an adoptable subset: rules where a hit is a defect or dead code
  are on, and every rule left off carries the finding count that made it
  unadoptable. Notably this is the only automated check `tests/` and `scripts/`
  receive — `tsconfig.json` `include` is `src/**/*` only.
- `.github/workflows/ci.yml` — `tsc --noEmit` fast-fail, the lint gate, v8 test
  coverage with an enforced ratchet, and the VM-free `*.integration.test.ts`
  tier, which previously had no runner at all.
- Knowledge topic **`extensible-enums`**: `IsExtensible=true` requires
  `UseEnumValue=No` and forbids `<Value>` elements. The create path has enforced
  that (and bypassed the C# bridge over it) since the beginning, but nothing
  taught it, so the only way to learn the rule was to ship XML that xppc rejects.
- `docs/KNOWLEDGE_AUTHORING.md` — how to get a knowledge topic past its three CI
  gates, including the snapshot scoping rule that blocks any new AOT reference.
- `tests/knowledge/entryIntegrity.test.ts` — gates knowledge-entry shape and, in
  particular, that every `related:` id resolves.
- `npm run config:docs -- --check` — fails when `docs/CONFIGURATION.md` has
  drifted from the setting registry.
- `docs/BACKLOG.md` restored: deleted by `5ef1413` with three items still open
  and never migrated, taking their deferral rationale and design sketches with it.
- First tests for four previously-uncovered risk modules: `securityPrivilegeXml`
  (the exact path of the silent empty-privilege incident), `formInfo` (561 lines,
  zero coverage, and the tool the agent reads control names from before every
  form extension), `repairFormControls`, and `fsExtensionScanner` (the fallback
  that exists to stop the agent shelling out to PowerShell).

### Fixed
- `get_method`'s Chain-of-Command template copied the base method's **default
  parameter values** into the wrapper signature — the exact defect `validate_code`
  reports as `COC001` and the `coc-authoring` topic forbids. It was also
  undetectable: the template strips access modifiers and `COC001`'s regex only
  fired on lines carrying one. Both halves fixed.
- Knowledge base said `curExt()` was deprecated (topic `deprecated`), mandated it
  (topic `multi-company`), and used it without comment (topic `direct-sql`) — and
  the stated "replacement" called `curExt()` itself while returning a different
  type. The `deprecated` topic now carries an explicit *NOT DEPRECATED* block for
  the APIs models most often hallucinate as obsolete.
- `crosscompany` container rule taught syntax that does not parse.
- Five dangling `related:` topic ids. The default (concise) formatter prints
  related ids without resolving them, so each one cost a wasted round trip.
- `docs/MCP_TOOLS.md`: 32 → **39** AOT object types, 25 → **31** modify
  operations, and `GROUNDING_ENFORCE` documented as defaulting **off** (it does).
- `docs/NEW_TOOL_CHECKLIST.md` rewritten — it had never been updated after
  `a49488a` moved tool schemas out of `mcpServer.ts`, so following it literally
  failed at three separate steps.
- `docs/CONFIGURATION.md` regeneration is now lossless. It had been hand-edited
  after generation, so `npm run config:docs` deleted three real environment
  variables (`EXTENSION_PREFIX_SOURCE`, `D365FO_CROSS_MODEL_WRITE_MODELS`,
  `D365FO_ALLOW_CROSS_MODEL_WRITE`) and reintroduced a wrong tool count.
- `QUICK_START.md` and `SETUP.md` disagreed on which setup scenario is D and
  which is E; two dead `SETUP.md#…` anchors.
- Every remaining place that still advertised the pre-consolidation tool
  surface. README's **first line** said "25 AI tools"; `MCP_EXTRA_TOOLS` was
  documented with `security_info,get_method` in README, `MCP_CONFIG.md` and the
  `server.extraTools` placeholder (which generates `CONFIGURATION.md`); `SETUP.md`
  promised the write-only companion exposes `get_method`; and
  `.github/copilot-instructions.md` — handed to the agent verbatim — taught
  `get_method(include="signature")` as *the* route to a CoC signature, which is a
  guaranteed unknown-tool call. `get_method`, `suggest_edt` and `batch_get_info`
  have been folded into `get_object_info`/`prepare` since 1.9.0; their handlers
  still route, so nothing broke loudly — it just cost a round trip each time.
- The tool-count gate could not see either shape that had drifted. It matched
  only a count directly adjacent to "tools", so `"25 AI tools"`,
  `"25 specialized MCP tools"` and `"18 tools instead of 25"` all passed. It now
  bridges up to three intervening words and reads the second number of a
  comparison, and a companion gate forbids naming a retired-but-routable tool in
  the eight files a reader or an agent is actually pointed at.
- `tests/utils/loadEnvDepth.test.ts` measured the developer's machine rather than
  `loadEnv`: with no config in the temp tree, precedence rule 4 falls back to
  `process.cwd()/.env`, which under vitest is the repo root. Any working
  (gitignored) `.env` therefore supplied a real `D365FO_PACKAGE_PATH` and the
  "no configuration anywhere" case failed locally while passing in CI. The test
  now runs from its own temp directory.

### Removed
- README's *"Keep the tool catalogue small"* section. The advice it carried
  (turn off unused tool sets; `MCP_TOOL_PROFILE=core`) is documented where it is
  configured — [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) and
  [`docs/MCP_CONFIG.md`](docs/MCP_CONFIG.md).

---

---

## [1.9.0] — 2026-08-07

### Changed
- **Round-trip cost work.** Per-call boilerplate cut out of tool responses;
  cached context is re-billed on every round trip, so payload trimming and
  round-trip elimination were both pursued.

### Fixed
- Guidance text no longer tells the agent to call tools that no longer exist.
- `setup` stopped writing `README.md` into the solutions folder.

## [1.8.5] — 2026-08-07
Write-anchor handling and `add-field` on enums.

## [1.8.4] — 2026-08-07
### Changed
- **Cross-model write consent moved to configuration** and extended to cover
  `create`. Consent deliberately lives in the environment rather than in a tool
  parameter: a parameter is something the agent can grant itself.

## [1.8.3] — 2026-08-07
### Added
- Writes into another custom model are refused by default, with the extension
  route in the active model offered instead.

## [1.8.2] — 2026-08-07
### Fixed
- `workspaceDetector` no longer silently picks the wrong `.rnrproj` when a
  solution holds several; ambiguous workspaces now resolve the model and list the
  candidates instead of guessing.
- Project-folder names corrected for enum extensions ("Base Enum Extensions"),
  menu items ("&lt;Kind&gt; Menu Items") and security duty/role extensions.
- `symbols.file_path` indexed; the prefix is taken from the active model.

## [1.8.1] — 2026-08-04
Test-timeout fix. (Tagged without a `package.json` bump — 1.8.0 → 1.8.2 in the
manifest.)

## [1.8.0] — 2026-08-04
### Added
- Bridge and DB handles are released on shutdown.
### Fixed
- Transport errors return under the client's own request id.
- Configuration loads before the modules that read it.
- Remaining single-op RPC dispatch gaps in the bridge.
- Three tool queries no longer scan the symbol table.
### Docs
- Architecture diagram corrected — the bridge is not the sole write path; the
  eval loop gets its own block.

## [1.7.0] — 2026-07-30
### Added
- `AxTable` audit system fields and `AllowRowVersionChangeTracking` exposed to
  the writers; `modify-property` for data entities.
- `AxDataEntityView` writer expresses change tracking, key naming, `IsPublic`
  and the canonical skeleton.
### Fixed
- Grounding: `Type::member` is recognised even when a local is named after the
  type; an unknown parameter list is distinguished from an empty one.
- Extension write gaps across table/form/data-entity extensions; base-table
  relations routed to `RelationExtensions`.
- `undo` no longer deletes `<Folder Include>` entries it never added.
- Labels are compiled with `labelc.exe` before the X++ compile.

## [1.6.0] — 2026-07-29
### Fixed
- `AosService` is found by scanning drives instead of assuming `K:`; platform is
  read per call rather than once at import.
- `prepare` walks the extends chain for inherited methods.
- A finished build is never replayed as a fresh result.
- `get_object_info` falls back to the symbol index when the bridge is silent.

## [1.5.2] / [1.5.1] / [1.5.0] — 2026-07-27
### Added
- `setup` generates `.mcp.json` and stages the Copilot setup files.
- Adaptive concurrency in metadata extraction.
### Changed
- Repo cleanup and doc consolidation (`5ef1413`) — this is the commit that
  deleted `docs/BACKLOG.md` and five other docs.

## [1.4.0] — 2026-07-23
### Fixed
- Line endings of bridge-written artifacts normalised.
- Query writer emits ranges instead of inventing a literal `Title`.
- Macro, aggregate-measurement and license-code writers corrected against what
  the Microsoft serializer actually produces.
- `get_object_info` for classes stopped rendering `/// <summary>` as the method
  signature.

## [1.3.0] — 2026-07-22
### Changed
- **`better-sqlite3` replaced with core `node:sqlite`** — removed the native
  build dependency that was blocking App Service startup.
### Fixed
- Search prioritises custom/ISV models so they are not buried under Microsoft
  objects.

## [1.2.0] — 2026-07-22
### Fixed
- `d365fo_file(modify)` stopped discarding parameters in silence.
- The create/generate path stopped emitting metadata that cannot build.
- The read/search/info tools stopped misreporting metadata.
- The golden oracle and `bp_clean` became honest measurements — a never-run BP
  check no longer reads as a pass.

## [1.1.0] — 2026-07-21
First iteration after the public release.

## [1.0.0] — 2026-07-21
First public release.
