# Golden: L2-declarations-scope — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA d212f3e, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. One `d365fo_file(action="create")` call, no
hand-edited XML. Full build 0 errors, xppbp 0/0, golden self-match. Corpus
record: `eval/corpus/runs/2026-08-30T07__L2-declarations-scope__d212f3e.json`.

## Artifact

`ConDemoRetryPolicy.metadata.xml` — AxClass with a `public const int MaxAttempts = 5`
and a `readonly int timeoutSec` in the declaration, plus:

| Member | What it has to keep showing |
|---|---|
| `new` | the readonly field's last assignable moment — the reason it is readonly and not const |
| `construct` | the static factory over a protected `new` |
| `totalBudget` | two for-init counters, the inner one RENAMED (`attempt` / `backoffStep`) |
| `describe` | an optional `str _prefix = ''` split by `prmIsDefault` |
| `snapshot` | `var` where the initializer says the type, a spelled-out type where it does not |

## Notes from the capture

**The case instruction was corrected here.** It asked for the second loop
"after" the first, which would not have exercised anything: two sibling `for`
loops may legally reuse a counter name, because the first one's counter is out
of scope by then. Only a NESTED block collides, so the golden nests the second
loop inside the first and the instruction now says so. A capture that had
followed the original wording would have compiled while proving nothing — which
is the failure mode this note exists to prevent on a re-capture.

`const` is read through the class name (`ConDemoRetryPolicy::MaxAttempts`) rather
than bare, which is what the compiler accepted from a static context.
