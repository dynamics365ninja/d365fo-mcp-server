# Golden: L2-operators-precedence — NOT YET CAPTURED

`golden_pending: true`. The case spec is authored; no artifact here yet, which is
what keeps the `operators` coverage leaf honestly uncovered.

Capture it with the `eval-run` skill on the VM (implement → build 0 errors → BP →
freeze here → flip `golden_pending` → corpus record → roll back).

What the capture has to show: explicit parentheses around the `&&` pair in the
mixed `&&`/`||` chain — the unparenthesized form compiles and is wrong, so this
is the one line the golden exists to pin — plus `DIV`/`MOD` keywords instead of
`/`, the `like` operator with its wildcards, `as` followed by a null check before
any field read, and `strFmt` where a C# author would reach for interpolation.
