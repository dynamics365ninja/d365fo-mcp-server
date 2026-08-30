# Golden: L2-data-types-conversions — NOT YET CAPTURED

`golden_pending: true`. The case spec is authored; no artifact here yet, which is
what keeps the `data-types` coverage leaf honestly uncovered (E is derived from a
captured golden, never from an authored spec).

Capture it with the `eval-run` skill on the VM: implement through the grounded
tool path, `build_d365fo_project` to 0 errors, `run_bp_check` to 0 error-severity
warnings, freeze the normalised `AxClass` here, flip `golden_pending`, write the
corpus record, roll the sandbox back.

What the capture has to show, beyond "it compiles": the uninitialised locals
compared against their null-EQUIVALENTS (never `null`), the backslash date
literal rather than a `str2Date` call, the `str 3` local that silently keeps
three characters, conversion FUNCTIONS in place of casts, `anytype` locked by its
first assignment, and an `@`-prefixed verbatim path.
