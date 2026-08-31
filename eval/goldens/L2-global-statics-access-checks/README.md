# Golden: L2-global-statics-access-checks — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-31, server SHA 9045b22, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. One `labels(action="create")` plus one
`d365fo_file(action="create")`; no hand-edited XML. Full build 0 errors /
0 warnings, `run_bp_check` on the class 0 warnings / 0 errors, golden self-match.
Corpus record:
`eval/corpus/runs/2026-08-31T08__L2-global-statics-access-checks__9045b22.json`.

## Artifact

`ConDemoGlobalAccessProbe.metadata.xml` — AxClass, six static methods. Every
call below is UNQUALIFIED: none of these names is a predefined function, they are
statics on the `Global` class, which is the third and last place the compiler
looks for a bare call.

| Method | What it has to keep showing |
|---|---|
| `canViewCustomerGroups` | `hasTableAccess(tableNum(CustGroup), AccessType::View)` and `hasMenuItemAccess(menuItemDisplayStr(CustGroup), MenuItemType::Display)` — run-time security, no `Global::` prefix, no `SecurityRights` |
| `isElevatedUser` | `isSystemAdministrator()` as a bare zero-arg call |
| `assertCanViewCustomerGroups` | `checkFailed("@ConDemo:GlobalAccessDenied")` — also a `Global` static, and a real label, not a string (see below). The two in-class calls are spelled `ConDemoGlobalAccessProbe::method()`, which is the only spelling X++ accepts |
| `isGeneralLedgerAvailable` | `isConfigurationkeyEnabled(configurationKeyNum(LedgerBasic))` — environment, not security |
| `runsUnattended` | `isRunningOnBatch()` |
| `copyCustomerGroup` | `buf2Buf(_source, target)` for the field-by-field copy; the default `TableScope::CurrentTableOnly` is what skips the system fields |

## Notes from the capture

**`validate_code(mode="references")` reports two of these as hard errors, and it
is wrong.** `AccessType::View` and `MenuItemType::Display` come back as
`unknown-static-member` under "Fix all errors before writing". Both are kernel
enums: there is no `AxEnum/AccessType.xml` or `AxEnum/MenuItemType.xml` anywhere
under `PackagesLocalDirectory`, so no metadata-backed lookup can ever prove them,
and `get_object_info(objectType="enum")` compounds it by advising
`update_symbol_index` on a file that cannot exist. `src/knowledge/kernelEnums.ts`
exists for exactly this trap but its `ENTRIES` list does not include these two
names. Both calls compile — this run's full build is the proof. The gate was off
in this environment (`GROUNDING_ENFORCE` unset); with it on, the write of correct
code would have been refused.

Second, smaller: the resolver has no exemption for the object currently being
created, so `ConDemoGlobalAccessProbe::isElevatedUser()` is reported as
`unknown-type` right up until the write lands.

**The label is deliberate.** `checkFailed` takes a user-facing message, and a
plain X++ string there earns `BPErrorLabelIsText` from xppbp. The label lives in
a `ConDemo` label file rather than one named for the model, because
`labels(action="create")` rejects a `labelFileId` containing a hyphen and the
sandbox model is `fm-mcp`. A re-capture must create `@ConDemo:GlobalAccessDenied`
first, or the class builds with an unresolved label reference.
