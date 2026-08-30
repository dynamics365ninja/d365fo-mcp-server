# Golden: L2-attribute-authoring-reflection — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-30, server SHA 4dd87d5, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, `EXTENSION_PREFIX=Con`. Three `d365fo_file(action="create")` calls plus
one `replace-code` (see below); no hand-edited XML. Final build 0 errors, xppbp
0/0, golden match. Corpus record:
`eval/corpus/runs/2026-08-30T07__L2-attribute-authoring-reflection__4dd87d5.json`.

## Artifacts

| File | What it has to keep showing |
|---|---|
| `ConDemoRouteTargetAttribute.metadata.xml` | a non-abstract `extends SysAttribute` with one `str` field, `new(str)` calling `super()` first, and a parm method |
| `ConDemoCustomerSyncStrategy.metadata.xml` | the attribute applied WITHOUT its `Attribute` suffix and with a string LITERAL argument, plus a `[SysObsolete(…)]` method nothing references |
| `ConDemoAttributeReader.metadata.xml` | `new DictClass(_classId).getAllAttributes()`, the `Array` walked `1..lastIndex()`, each entry `as`-downcast and checked, and the class id from `classNum` rather than a name string |

The order of creation matters: the attribute class has to exist before anything
can be decorated with it.

## Notes from the capture

**xppbp rejected the two-argument `SysObsolete`** with
`BPCheckSysObsoleteAttributeParametersMismatch` — *"All parameters for attribute
SysObsolete need to be defined"*. `SysObsoleteAttribute.new` is
`(str _explanation = "", boolean _isError = false, date _createdDate = dateNull())`,
and BP wants all three at the usage site even though the constructor defaults
every one of them. Attribute arguments are positional, so the date cannot be
skipped: the golden passes `('…', false, 30\08\2026)`. The case instruction now
carries this.

**`DictClass` and `Array` are kernel types with no AOT metadata row**, so
`get_object_info` answers "not found" for both while the code using them compiles
fine. `SysDictClass` — the application-layer subclass — does have a row, and its
shipped `getAllAttributes()` source is where the `lastIndex()` / `value(i)` /
`as SysAttribute` walk in the reader was read from rather than guessed.

**One tool defect was found and fixed while scoring this case.**
`npm run eval:score -- --actual-dir` matched only `*.metadata.xml`, but a live
AOT folder holds plain `.xml`, so pointing it at `<Model>/<Model>/AxClass` — the
obvious thing to do during a capture — paired nothing and scored every artifact
`missing`: a silent `golden_match: 0`, not an error. `resolveActualFile` now
accepts a bare `.xml` (preferring a `.metadata.xml` neighbour when both exist)
and `buildActualArtifactsMap` keys it in the golden filename shape, without which
the resolved pair still diffed as missing + extra. Both halves are pinned in
`tests/eval/oracleScoringIntegrity.test.ts`.
