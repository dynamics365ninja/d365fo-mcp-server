# Golden: L2-intrinsic-functions — NOT YET CAPTURED

`golden_pending: true`. The case spec is authored; no artifact here yet, which is
what keeps the `intrinsics` coverage leaf honestly uncovered.

Capture it with the `eval-run` skill on the VM (implement → build 0 errors → BP →
freeze here → flip `golden_pending` → corpus record → roll back).

What the capture has to show: every metadata name reached through a checked
intrinsic (element form, member form with the owner first, numeric id form), the
menu-item intrinsic matching each item's KIND, and no `identifierStr` and no bare
string literal anywhere. This golden is unusual in that the BUILD is most of the
oracle: a wrong element name is a compile error by construction.
