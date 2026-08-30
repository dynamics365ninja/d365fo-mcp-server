# Golden: L2-statements-switch-loops — NOT YET CAPTURED

`golden_pending: true`. The case spec is authored; no artifact here yet, which is
what keeps the `statements-flow` coverage leaf honestly uncovered.

Capture it with the `eval-run` skill on the VM (implement → build 0 errors → BP →
freeze here → flip `golden_pending` → corpus record → roll back).

What the capture has to show: a `break` closing every switch branch except one
deliberate, commented fallthrough; a comma-separated case list; and — the reason
this case is worth a golden — a loop left by a FLAG tested after the switch,
because a `break` written inside the switch leaves only the switch.
