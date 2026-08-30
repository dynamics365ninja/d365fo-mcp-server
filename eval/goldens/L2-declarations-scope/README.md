# Golden: L2-declarations-scope — NOT YET CAPTURED

`golden_pending: true`. The case spec is authored; no artifact here yet, which is
what keeps the `declarations-scope` coverage leaf honestly uncovered.

Capture it with the `eval-run` skill on the VM (implement → build 0 errors → BP →
freeze here → flip `golden_pending` → corpus record → roll back).

What the capture has to show: `const` with its initializer at the declaration
(not a `#define`), `readonly` frozen after `new()`, a for-init counter that is
loop-scoped, a second loop that RENAMES its counter because the compiler rejects
shadowing, `prmIsDefault` telling "passed empty" from "not passed", and `var`
only where the initializer makes the type obvious.
