# Golden: L2-exception-tts-retry — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-29 (Phase F), server SHA 93d6658 + the Phase F working tree,
xppc 7.0.7996.33 (VM), sandbox model `fm-mcp`, `EXTENSION_PREFIX=Con`. Written
through `prepare(create)` -> `d365fo_file(action="create")`; the one follow-up
edit went through `d365fo_file(action="modify", operation="replace-code")`.
No hand-edited XML.

## Artifact

- `ConCustCreditMaxUpdater.metadata.xml` — AxClass with exactly two methods:
  - `public static void setCreditMax(CustAccount _accountNum, AmountMST _newCreditMax)`
    — locals `CustTable custTable; int retryCount = 0; const int maxRetries = 5;`
    (a LOCAL `const` compiles — xppc accepted it, no class-level constant needed),
    then a `try` whose block holds the whole `ttsbegin … ttscommit` region, and a
    single `catch (Exception::UpdateConflict)` OUTSIDE the tts scope with
    `retryCount++; if (retryCount >= maxRetries) { throw Exception::UpdateConflictNotRecovered; } retry;`.
  - `public static void main(Args _args)` calling `ConCustCreditMaxUpdater::setCreditMax('US-001', 25000)`.

## Deviation from the authored instruction (recorded in the case file)

The select is `select firstonly forupdate custTable …`. The authored text had no
`firstonly`; the first BP run reported `BPErrorSelectUsingFirstOnly` (warning) on
that select, and `AccountNum` is the unique key, so `firstonly` is the correct
shape. The case instruction was updated at capture to say so.

## Validator evidence (the correctness this case teaches)

`validate_code(mode="both")` on the final source: **0 syntax findings** (24 rule
groups) — no TTS001/TTS002/TTS003. Two negative probes through the same tool,
never written to the model:

1. an extra `try { custTable.update(); } catch (Exception::Error) {…}` INSIDE the
   tts block → `[TTS002]` fired ("this catch is dead code … move the try/catch
   outside ttsbegin/ttscommit");
2. the catch body reduced to a bare `retry;` → `[TTS003]` fired.

So a compiling-but-wrong answer (inner catch, unguarded retry) does not pass the
static gate this case scores.

## Build / BP at capture

- Incremental build after create: **1 error** — `A reference to 'Dynamics.AX.Directory' is
  required`, then `'Dynamics.AX.ContactPerson'`. `CustTable` drags in `Directory`
  (DirPartyTable) and the VM-local `ContactPerson` model (it ships a CustTable
  extension). Fixed by extending the sandbox Descriptor (see below).
- FULL build (`fullBuild: true`): **0 errors**, 1 unrelated warning (Commerce
  `PricingEngine` external assembly, present on every build of this VM).
- BP (`bpCheck: true`, 1 element processed): **Warnings 0, Errors 0** after the
  `firstonly` fix (1 warning before it).

## Descriptor

`fm-mcp/Descriptor/fm-mcp.xml` `<ModuleReferences>` at capture: ApplicationFoundation,
ApplicationPlatform, ApplicationSuite, Directory, FleetManagement, Ledger,
ContactPerson, Currency, Dimensions, PersonnelCore, GeneralLedger,
SourceDocumentationTypes — the same set the earlier `Contoso` sandbox carried.
`ApplicationSuite` + `Directory` (+ `ContactPerson` on this VM) are the ones this
case needs.

## Labels

None created; the class carries no labels.
