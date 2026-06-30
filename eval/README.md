# Agent eval loop — Phase 0 scaffold

Phase 0 of the self-improving agent eval loop. See the full design in
[docs/AGENT_EVAL_LOOP.md](../docs/AGENT_EVAL_LOOP.md).

**Goal of Phase 0:** run **one** use-case end-to-end *by hand* through the
grounded path on a D365FO VM, score it against golden metadata, and write one
corpus record — proving where the tools actually break before any automation.

## Layout

```
eval/
├── README.md                     ← this file
├── cases/
│   ├── schema.json               ← JSON Schema for a use-case spec
│   └── L1-table-basic.json       ← the Phase 0 case
├── goldens/
│   └── L1-table-basic/
│       └── README.md             ← how to capture the golden on the VM
└── corpus/
    ├── schema.json               ← JSON Schema for a run record
    └── runs/                      ← one .json run record per run (git-ignored content TBD)
```

## Manual run checklist (Phase 0, on the VM)

Run with the mcp-server in `full` mode + C# bridge, pointed at a **throwaway
sandbox model** (never a real customisation model).

1. **Isolate** — create/confirm an empty sandbox model for this run.
2. **Implement (grounded only)** — drive the case `instruction` through the
   tool path: `prepare` → query tools (`search`, `object_info`, …) →
   `validate_code(mode="references")` → `generate_object` → write via
   `d365fo_file(action=create)`. No hand-edited XML.
3. **Static gate** — record `validate_code` references + syntax results.
4. **Build** — `build_d365fo_project`; capture `errors[]` and `bpWarnings[]`.
5. **Oracle** — normalise the produced metadata and diff against
   `goldens/L1-table-basic/` (see that folder's README to capture the golden the
   first time).
6. **Score & record** — fill one record matching `corpus/schema.json` and drop
   it in `corpus/runs/`.
7. **Roll back** — undo the write / wipe the sandbox model.
8. **Triage** — classify any failure per the rubric in the design doc (§9);
   record the hypothesis, not a fix.

The output of Phase 0 is **one corpus record + a verdict** on whether the case
passed build / BP-clean / golden — and, if not, which rubric class it fell into.
That verdict decides what Phase 1 automates first.
