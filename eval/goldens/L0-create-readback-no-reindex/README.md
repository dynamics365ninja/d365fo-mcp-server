# Golden: L0-create-readback-no-reindex — CAPTURED, PENDING HUMAN REVIEW (§6.4)

Captured 2026-08-31, server SHA 278eee3, xppc 7.0.7996.33 (VM), sandbox model
`fm-mcp`, effective prefix `ConDemo`. Written through the server's own
`d365fo_file(action="create")` path — no hand-edited XML — then full-built with
xppc (0 errors, 0 warnings) and checked with xppbp; the capture script refuses to
copy a golden out of a build that was not clean. Sandbox rolled back afterwards.

## Artifacts

_an extensible enum, created and then read back in the same turn_

`ConDemoIndexProbeStatus.metadata.xml`

| | What it has to keep showing |
|---|---|
| `UseEnumValue` | `No`, and **no `<Value>` elements** — required by xppc for `IsExtensible=true`; the numbers are carried by position |
| `EnumValues` | exactly two, `Open` then `Closed`, in that order — the order IS the 0/1 |
| value `Label`s | real `@ConDemo:` references, not prose: the create call auto-resolved the raw text it was given |
| `IsExtensible` | `true`, placed **after** `<EnumValues>` — the shipped order (`ApplicationSuite/Foundation/AxEnum/AccountOrder.xml`) |

## Notes from the capture

**The case subject passed.** One `d365fo_file(action="create")` — which ended with
"Symbol index updated in place — no `update_symbol_index` call needed" — then
exactly ONE `get_object_info(objectType="enum")`, which resolved the enum and
returned `Open = 0 - @ConDemo:Open`, `Closed = 1 - @ConDemo:Closed`,
`Extensible: Yes` (`_Source: C# bridge`). No `update_symbol_index` call anywhere
in the run. #830 does not reproduce.

**`<Label>ConDemoIndexProbeStatus</Label>` is a tool defect this golden pins, not
a requirement of the instruction.** The instruction asks for no enum-level label;
`generateAxEnumXml` defaults `label` to the object's own NAME and emits `<Label>`
unconditionally, which is the run's single BP warning
(`BPErrorLabelIsText`, `bp_clean: 0`). The auto-label pass that fixed both VALUE
labels runs *before* generation and never sees this invented value. Shipped enums
omit `<Label>` freely, and `generateSmartReport.ts` already omits it for exactly
this reason. **When that defect is fixed, this golden must be re-captured in the
same PR** — the `<Label>` line is expected to disappear, not to change value.
See the corpus record for the full hypothesis.

The name: the instruction says `DemoIndexProbeStatus`, but `prepare` infers the
prefix `ConDemo` from the sandbox (overriding `EXTENSION_PREFIX=Con`, and it says
so), so the base name passed to `create` was `IndexProbeStatus` to land on the
corpus-conventional `ConDemoIndexProbeStatus`.
