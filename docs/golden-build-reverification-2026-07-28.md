# Golden build re-verification — 2026-07-28

**Result: 65/65 captured cases compile clean. No golden was invalidated.**

## Why this was run

`build_d365fo_project` replayed a *finished* build's result as the result of the
**next** call, compiling nothing (fixed the same day — see
`tests/tools/buildStaleResult.test.ts`). The tell was byte-identical phase
timings across two supposedly separate builds; the proof was that the edited
source was written 42 s *after* the build log had last been touched.

Consequence: every `pass@build` in the corpus that was **not** taken with
`force: true` was weaker evidence than it looked. Goldens are captured from the
XML on disk, so their *content* was never at risk — but the claim that the
captured artifacts **compile** rested on exactly the signal the defect could
fake. This sweep re-establishes that claim against the compiler itself.

## Method

`npx tsx scripts/verify-goldens-build.ts`

Per case, in isolation: write that case's golden artifacts into the Contoso
sandbox → **full** `xppc.exe` build (no `-incremental`, so metadata validation
actually runs) → collect errors → delete what was written. xppc is invoked
directly, bypassing the state file whose replay bug prompted the sweep.

Baseline first: the sandbox with no goldens written compiles clean, so any
error is attributable to the golden under test.

### Isolation is not optional

A bulk pass — all 143 artifacts present at once — was tried first and is only a
**screen**, not a verdict. It reported **12 errors, of which the isolated runs
showed 0 were real**:

| Bulk error | Actually |
|---|---|
| `AxEdtString/ConDemoNoteSubject: Name conflict; 'AxClass' is using the same name` | Two cases legitimately reuse the name for different object types (`L0-edt-basic` vs `L2-delegate-basic`). They never coexist in a real run. |
| `ConNumberSeqModuleDemoNote: qualifier 'NumberSeqModule' is not valid for field 'ConDemoNote'` | Name collision on `NumberSeqModule.ConExtension`: the bulk pass kept the empty-values extension from `L2-enum-extension-empty-values`, so `L2-numberseq-basic`'s own enum value was missing. |
| `Field group 'Overview' does not exist` (×3 forms) | The bulk pass overwrote the **`ConDemoNoteHeader` fixture** with a case's golden copy of it, breaking unrelated forms. |
| `AxForm/ConDemoNoteHeaderWorkspace` pattern errors (×4), `ConDemoNoteMap/CreatedDateTime`, `ConDemoNoteHeaderLine/LineNum` | Same contamination — all clean in isolation. |

Bulk-clean is also a *weaker* guarantee than isolated-clean, since one case's
object can satisfy another's dangling reference. Both directions are wrong, so
the bulk number is not reported as a result.

## Results

```
65/65 clean · 0 with errors
143 golden artifacts across the captured cases
```

Full per-case output: `golden-verify-results.json` (regenerate with the script).

### Caveat — 2 artifacts were not compile-verified

| Case | Skipped | Why |
|---|---|---|
| `L1-form-basic` | `AxTable/ConDemoNoteHeader` | Pre-existing VM **fixture**; the script never overwrites an existing file. |
| `L2-dimension-basic` | `AxTable/ConDemoNoteHeader` | Same. |

Both cases compiled against the fixture rather than their own golden copy of
that table, which is what a real case run does. Their *forms and classes* are
verified; the golden table content in those two folders is not.

## Environment change left in place

`FleetManagement` was added to `ModuleReferences` in
`PackagesLocalDirectory/Contoso/Descriptor/Contoso.xml`.

`L2-coc-extension` wraps `FMVehicleDataContract`, and xppc does not resolve
package references transitively for directly-named types — without this the
case cannot build at all. This matches the established pattern for this
sandbox (ApplicationSuite, Directory, Ledger, ContactPerson, Currency were all
added the same way for the same reason). **Kept deliberately; revert if
unwanted.**

## What this does and does not prove

- **Does**: every captured golden, as stored in the repo, is accepted by
  xppc 7.0.7858.27 with metadata validation enabled, in a sandbox where
  nothing else from the eval catalog is present.
- **Does not**: say anything about runtime behaviour (no SysTest runner on
  this VM), about BP cleanliness (not measured here), or about whether each
  golden is the *right* output — that is what the per-case golden diff is for.
