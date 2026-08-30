# Golden: L2-select-find-options-joins — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA f01dfa7, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc and checked with xppbp; the capture script refuses to copy a golden out of
a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_the select grammar the report cases never reach_

`ConDemoCustomerQueries.metadata.xml`

| | What it has to keep showing |
|---|---|
| `topGroups` | `firstOnly10` as a find option — the database returns ten rows, rather than a loop counter throwing away the rest |
| `hasCustomers` | `exists join`, whose joined buffer fetches nothing and cannot be read in the body |
| `groupsWithoutCustomers` | `notexists join` |
| `groupNamesWithCounts` | `count()` with `group by`, and `order by` BEFORE the `where` of the same segment |
| `blockedInAny` | the `in` operator against a container VARIABLE, on an enum field |

## Notes from the capture

Built clean on the first attempt, xppbp clean.

The clause order in `groupNamesWithCounts` is the part worth keeping: written as
`select ... where Y order by X` the compiler answers only "'join' expected",
which says nothing about the actual mistake. This file compiles the correct
order, so a regression in the guidance has something to fail against.

Every field read here was confirmed in the shipped AOT XML first —
`CustGroup.CustGroup`, `CustGroup.Name`, `CustTable.AccountNum`,
`CustTable.CustGroup`, and `CustTable.Blocked` typed `CustVendorBlocked`.
