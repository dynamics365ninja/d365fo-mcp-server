# Golden: L2-statements-switch-loops — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA d212f3e, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. One `d365fo_file(action="create")` plus one
`remove-method` + `add-method` pair (see below); no hand-edited XML. Final build
0 errors, xppbp 0/0, golden self-match. Corpus record:
`eval/corpus/runs/2026-08-30T07__L2-statements-switch-loops__d212f3e.json`.

## Artifact

`ConDemoStatusRouter.metadata.xml` — AxClass, four static methods:

| Method | What it has to keep showing |
|---|---|
| `route` | a comma case list (`Backorder, Delivered`), a `break` on every branch but one, and exactly one commented DELIBERATE fallthrough from `Invoiced` into `Canceled` |
| `firstMatchingPosition` | a `break` inside the switch, and a separate flag test after it to leave the LOOP — the point of the method |
| `countDown` | `do { } while (...)`, body before the first test |
| `sumTo` | `for` with `continue` |

## Notes from the capture

**The first build failed, and the reason is worth keeping.** The method was
originally a `while select` over `SalesTable`, which xppc rejected with

```
A reference to 'Dynamics.AX.Retail, Version=0.0.0.0, ...' is required to compile this module.
```

A `SalesTable` buffer drags Retail's extension of that table into the module's
reference set, and the sandbox descriptor does not carry Retail. Rather than
widen the descriptor for a case that is not about data access, the loop became a
`while` over a container of statuses: the switch, the break scope and the flag —
everything the `statements-flow` leaf is about — survive unchanged. The case
instruction now records both the failure and why the shape changed.

`SalesStatus` itself is fine to reference; it is the table buffer that pulls
Retail in.
