# Golden: L2-systest-authoring-basic — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_a SysTest class that covers a class worth testing_

`ConDemoDiscountCalculator.metadata.xml`

| | What it has to keep showing |
|---|---|
| `percentOf` | rounds to two decimals and throws on a percentage outside 0-100 — the behaviour the test exists for |
| `isFree` | a boundary worth a test of its own |

`ConDemoDiscountCalculatorTest.metadata.xml`

| | What it has to keep showing |
|---|---|
| class attribute | `[SysTestTarget(classStr(...), UtilElementType::Class)]` — the second argument is the element TYPE; a method name there fails with "Cannot implicitly convert from type 'str' to type 'Enumeration(utilElementType)'" |
| `setUp` | runs before EACH test method (`setUpTestCase` runs once per class) |
| `testRejectsPercentAbove100` | `this.parmExceptionExpected(true)` BEFORE the call — there is no `assertExpectedException` in X++ |

## Notes from the capture

Built clean on the first attempt, xppbp clean. The shape follows
`sysTestTemplate()` in `src/tools/smart/codeGen.ts` with the generated TODOs and
`this.fail(...)` calls replaced by real assertions, so this golden also pins the
scaffold the generator emits.

No rollback attribute: rollback is the framework default and
`SysTestCaseAutoRollback` does not exist.

**Not yet executed.** Compiling a test class and running it are different
claims, and only the first is made here. `SysTestConsole.exe` starts on this VM
(see the branch notes on the two config fixes) but stops at `Login failed for
user 'AOSUser'` — which turned out NOT to be a rotated credential.
`Bin\SysTestConsole.exe.config` is the shipped template, never configured for
this machine: it names a different database and a different user, with
`$CREDENTIAL_PLACEHOLDER$` where the password belongs, while the AOS's own
`WebRoot\web.config` beside it carries all four correctly. Copying them across
edits the platform install and handles a secret, so it is left to the owner.
