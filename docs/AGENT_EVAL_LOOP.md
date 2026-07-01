# Self-improving agent eval loop — design spec

**Status:** implemented (all phases below are live — see
[eval/ROADMAP.md](../eval/ROADMAP.md) for current status and open work)
**Related:** [ARCHITECTURE.md](ARCHITECTURE.md) · [TESTING.md](TESTING.md) · [BRIDGE.md](BRIDGE.md) · [BACKLOG.md](BACKLOG.md) · [eval/README.md](../eval/README.md)

---

## 1. Goal

An autonomous agent running on a D365FO development VM that:

1. **Implements** D365FO use-cases of varying complexity, using **only** the grounded mcp-server tool path.
2. **Builds** each one (`build_d365fo_project`) and captures structured diagnostics.
3. **Verifies correctness** against **golden metadata** (primary oracle) — not merely "it compiled".
4. **Feeds recurring failures back** into the mcp-server as concrete fixes/improvements (tool defects, knowledge gaps, validator gaps), as reviewable pull requests.

The deliverable of the loop is **a measurable, decreasing tool-defect rate** across a growing catalog of use-cases — i.e. the server gets provably better at producing X++ that compiles, is BP-clean, and matches the intended metadata shape.

### Non-goals

- Not a production code generator — it is an **eval + self-improvement harness**.
- Not auto-merge — the improver agent **opens PRs**; humans review and merge.
- Not a replacement for the existing golden quality-gate test suites — it **feeds** them.

---

## 2. Why this is mostly an orchestration problem

The hard infrastructure already exists in the server; the loop is glue + judgement on top of it:

| Loop need | Existing capability |
|-----------|---------------------|
| Generate grounded X++ | `prepare` → `validate_code` → `generate_*` → write path |
| Build + structured errors/BP warnings | `build_d365fo_project` (parses xppc output into actionable items) |
| Pre-build proof | `validate_code(mode="references")` + `validate_code(mode="syntax")` |
| Runtime correctness (optional deeper layer) | `SysTestRunner` |
| Safe, reversible writes | C# bridge `IMetadataProvider` + `.rnrproj` registration + one-call undo |
| Path safety / sandboxing | write-target path-containment (no traversal) |
| Where fixes land | TypeScript tools, knowledge base, golden test suites |

What is **missing** and this spec defines: the **use-case catalog**, the **corpus** format, the **golden-metadata oracle**, the **triage/attribution rubric**, and the **two-agent topology**.

---

## 3. Topology — two roles, one corpus

```
                         ┌────────────────────────┐
   D365FO dev VM ───────►│  IMPLEMENTER agent      │
   (full mode + bridge)  │  Claude Code + mcp tools│
                         │  generate → build →     │
                         │  golden diff → score    │
                         └───────────┬─────────────┘
                                     │ writes run records
                                     ▼
                         ┌────────────────────────┐
                         │  CORPUS (shared store)  │
                         │  one record per run     │
                         └───────────┬─────────────┘
                                     │ reads clustered failures
                                     ▼
                         ┌────────────────────────┐
   repo / CI ───────────►│  IMPROVER agent         │
                         │  Claude Code in repo    │
                         │  reproduce → fix → test │
                         │  → open PR              │
                         └────────────────────────┘
```

**Why split the roles:** the VM has the platform and the compiler; the repo is where TypeScript edits, golden tests, and CI belong. Mixing them on the VM couples slow platform builds to fast unit-test iteration and makes the improver's PRs harder to review in isolation.

The two agents communicate **only** through the corpus — no shared in-memory state. Either can run on its own cadence.

---

## 4. The loop

For each selected use-case the **implementer** runs:

1. **Isolate** — provision a throwaway sandbox model/package for this run (see §8).
2. **Implement** — drive the grounded path (`prepare` → query tools → `validate_code` → `generate_*` → write). The agent may use only mcp-server tools; no hand-edited XML.
3. **Static gate** — `validate_code(references)` + `validate_code(syntax)`. Record pass/fail and any violations.
4. **Build** — `build_d365fo_project`; capture `errors[]` and `bpWarnings[]` (structured).
5. **Oracle** — diff produced metadata against the case's **golden metadata** (§6). **Runtime gate (cases with a `systest` path):** after a clean build, deploy the case's SysTest class (`eval/systests/<id>.xml`) into the sandbox, build it, then run it via `run_systest_class` (className = the class's `<Name>`). Capture the raw tool output and feed it to the scorer (`eval:score --systest <file>`); `parseSysTestResult` turns it into `{ ran, passed, failures }` for the `systest` scorecard field (§6.3, §7). A SysTest references only standard objects (CoC is transparent), so it fails when the wrapper is missing or wrong — that is the behavioural signal a golden cannot give.
6. **Score** — compute the scorecard (§7).
7. **Triage** — classify any failure via the rubric (§9). The implementer records a *hypothesis*; the improver confirms.
8. **Persist** — append a run record to the corpus (§5).
9. **Roll back** — undo writes / wipe the sandbox model so runs never pollute each other or the index.

The **improver** runs asynchronously: cluster corpus failures → prioritise → reproduce as a minimal repo test → fix → validate against a held-out split → open a PR citing the corpus evidence (§10).

---

## 5. Corpus record schema

One record per `(case_id, run_id)`. Store as newline-delimited JSON now; a SQLite table later if query volume grows.

```jsonc
{
  "run_id": "2026-06-29T10:15:00Z__L2-coc-extension__a1b2",
  "case_id": "L2-coc-extension",
  "tier": 2,
  "timestamp": "2026-06-29T10:15:00Z",
  "server_git_sha": "11004da",          // mcp-server version under test
  "bridge_version": "1.4.0",
  "platform_build": "10.0.40",          // PU / platform version on the VM
  "generated_artifacts": ["AxClass/My_CustTableEventHandler"],
  "static_gate": {
    "references": { "passed": true, "unresolved": [] },
    "syntax":     { "passed": false, "violations": [ { "rule": "BP_SOMETHING", "severity": "error", "loc": "..." } ] }
  },
  "build": {
    "succeeded": true,
    "errors":     [],
    "bpWarnings": [ { "code": "...", "message": "...", "object": "...", "fixHint": "..." } ]
  },
  "golden_diff": {
    "matched": false,
    "missing":  [ "<element path>" ],
    "extra":    [ "<element path>" ],
    "changed":  [ { "path": "...", "expected": "...", "actual": "..." } ]
  },
  "systest": { "ran": false, "passed": null, "failures": [] },
  "score": { "build": 1, "bp_clean": 0, "golden_match": 0, "systest": null, "tier_weight": 2 },
  "classification": "TOOL_DEFECT",       // see §9
  "root_cause_hypothesis": "generate path omitted the EventHandler attribute argument",
  "suggested_fix_area": "tools/generateObject form expander",
  "evidence_refs": ["<artifact path>", "<build log path>"]
}
```

The record is **self-contained evidence** — the improver agent must be able to act on it without access to the original VM session.

---

## 6. Golden-metadata oracle (primary correctness signal)

> "Compiles + zero BP warnings" is **necessary but not sufficient** — it does not catch code that builds cleanly yet produces the wrong object shape. The golden-metadata oracle is the contract for *correctness*.

### 6.1 What a golden is

For each use-case, a **canonical, normalised serialization** of the expected produced object(s) — the metadata the server *should* generate for that instruction. Stored in the repo under `eval/goldens/<case_id>/`.

### 6.2 Normalisation (so diffs are stable)

Raw AOT metadata XML is not byte-stable. Before diffing, both expected and actual are normalised:

- strip volatile fields: GUIDs/Ax IDs, timestamps, model descriptor / `ModelSaveInfo`, ordering of unordered collections.
- canonicalise element ordering and whitespace.
- optional per-case **ignore-list / tolerances** for legitimately variable nodes (documented in the case spec).

The diff is **structural**, not textual, and classifies each delta as `missing` / `extra` / `changed` (mirrors the corpus schema).

### 6.3 Why golden fits this domain

Much of the server's generation is **deterministic** — pattern expansion for forms, table/field/relation helpers, CoC wrapper shapes. Deterministic generators should produce the same metadata every time, so a golden is a tight, high-signal oracle for them. Free-form logic (method bodies) leans more on `SysTestRunner`.

### 6.4 Authoring goldens (bootstrapping)

1. Implement the case once, build it, manually verify it is correct (compiles, BP-clean, behaves right).
2. Capture the normalised metadata as the golden and **human-approve** it (a golden is a reviewed artifact, like a snapshot test).
3. Thereafter the golden is the contract; an intentional behaviour change updates the golden in the same PR (visible in review).

**Cost note:** golden authoring is the main up-front investment. Start with deterministic tiers (tables/forms) where goldens pay off most, and grow coverage tier by tier.

---

## 7. Scorecard

Per run, layered from cheap to expensive:

| Signal | Meaning | Gate? |
|--------|---------|-------|
| `build` | xppc produced no errors | hard gate — below this, nothing else counts |
| `bp_clean` | zero best-practice **error**-severity warnings | quality gate |
| `golden_match` | normalised metadata == golden | **primary correctness** |
| `systest` | runtime assertions pass (when present) | deep correctness (optional) |

Aggregate metrics tracked over time, per tier: `pass@build`, `pass@bp_clean`, `pass@golden`, `pass@systest`, and the headline **tool-defect rate** (should trend down as the improver lands fixes).

---

## 8. Use-case catalog

A versioned set of case specs under `eval/cases/`. Each case is data:

```jsonc
{
  "id": "L2-coc-extension",
  "title": "Chain-of-Command wrapper on CustTable.insert",
  "tier": 2,
  "instruction": "Add a CoC wrapper extension class for CustTable.insert that ...",
  "target_artifact_types": ["AxClass"],
  "golden_path": "eval/goldens/L2-coc-extension/",
  "systest": "eval/systests/L2-coc-extension.xml",   // optional
  "ignore": ["<normalisation exceptions>"],
  "tags": ["coc", "extension", "table"]
}
```

Suggested complexity tiers:

| Tier | Example use-cases |
|------|-------------------|
| L0 — trivial | new EDT; new enum with elements; single label |
| L1 — single object | table + fields + field groups; index |
| L2 — extension | CoC wrapper; event handler subscription; table extension adding a field |
| L3 — composite | table relation + form generated from pattern + datasource re-bind; number sequence wiring |
| L4 — feature slice | data entity + security privilege/duty/role chain; batch job; SSRS report; posting via `LedgerVoucher` |

Start narrow (a few L0–L2 cases with goldens), prove the loop, then widen.

---

## 9. Triage / attribution rubric

The crux: **distinguish a tool defect from the model's own mistake.** Only genuine server gaps become PRs; LLM errors do not. Each failure is classified with explicit evidence:

| Class | Definition | Evidence required | Becomes a fix? |
|-------|-----------|-------------------|----------------|
| `TOOL_DEFECT` | a tool returned wrong/missing/over-eager data (bad signature, missing field, faulty pattern expansion) and the agent faithfully used it | tool response captured; the wrong datum is traceable to the output | **Yes** — tool fix |
| `KNOWLEDGE_GAP` | knowledge base lacks/has-wrong a rule the case needed (deprecated API, missing pattern constraint) | the relevant query returned nothing/incorrect | **Yes** — knowledge edit |
| `VALIDATOR_GAP` | a gate should have blocked the bad write but passed it (false negative), or blocked a valid one (false positive) | gate verdict vs. build outcome disagree | **Yes** — validator rule |
| `MODEL_ERROR` | tool output was correct; the agent misused it | correct tool data + incorrect agent choice | **No** — at most a prompt/instruction tweak |
| `ENV_FLAKE` | infra/transient (build server, locking, timeout) | reproduces only intermittently | **No** — retry/ignore |

The implementer records a **hypothesis**; the improver **confirms** the class before acting (it must be able to reproduce `TOOL_DEFECT`/`VALIDATOR_GAP` deterministically in the repo, without the VM, using a minimal test).

---

## 10. Improver workflow & anti-overfitting

1. **Cluster** corpus failures by `(classification, symptom)`.
2. **Prioritise** by `frequency × tier_weight × severity`.
3. **Reproduce** the cluster as a minimal, VM-free repo test (a new golden/unit case) that fails on `main`.
4. **Fix** the tool / knowledge rule / validator.
5. **Validate** the fix against a **held-out split** of the catalog — never only the failing case — to prevent overfitting; run the existing golden quality-gate suites for regressions.
6. **Open a PR** linking the corpus `evidence_refs`, the new repro test, and before/after scorecards.

Catalog discipline: maintain a **train/held-out split**. Improvements are accepted only if held-out scores do not regress. New cases enter the held-out set first.

---

## 11. Isolation & safety

- Every run targets a **dedicated throwaway sandbox model/package**; never a real customisation model.
- Writes are reversible (bridge one-call undo) and the sandbox model is wiped between runs, so neither the metadata nor the SQLite index is polluted.
- Path-containment is already enforced (`PackagesLocalDirectory/<Package>/<Model>/Ax<Type>/`); the harness must additionally pin writes to the sandbox model.
- Builds are **serialised** with timeouts; the VM is the throughput bottleneck (full builds are minutes, not seconds) — size cadence and batch accordingly.

---

## 12. How it runs

- **Implementer:** Claude Code on the VM with the mcp-server in `full` mode + bridge, driven by `/loop` or a scheduled agent, iterating the catalog and writing the corpus.
- **Improver:** Claude Code in the repo (or CI), reading the corpus and opening PRs.
- The two never need to run at the same time; the corpus decouples them.

---

## 13. Phased rollout — all done

| Phase | Deliverable | Exit criterion |
|-------|-------------|----------------|
| 0 — PoC ✅ | catalog + corpus schema + 1 golden case, run end-to-end by hand | one case scored build/BP/golden and produced a corpus record |
| 1 — implementer harness ✅ | automated generate→build→golden→score, multi-artifact support | green/red scorecard per case, reproducibly |
| 2 — improver ✅ | automated clustering + triage confirmation + PR drafting | tool/knowledge fix PRs sourced from corpus evidence (15+ landed) |
| 3 — guarded scale ✅ | held-out split, regression gating, CI, wider tiers | `eval-gate` CI gate green; catalog spans L0–L4 across breadth (form patterns, extensibility mechanisms, OOP mechanics, SSRS, etc.) |

Breadth is intentionally open-ended beyond this — see
[eval/ROADMAP.md](../eval/ROADMAP.md) for what's still uncovered.

---

## 14. Open questions / risks

- **Golden authoring cost** — the main up-front investment; mitigate by starting with deterministic tiers and capturing-then-reviewing.
- **Metadata serialization non-determinism** — normalisation must be robust or the oracle is noisy; needs care for unordered collections and platform-version drift.
- **Attribution reliability** — `TOOL_DEFECT` vs. `MODEL_ERROR` is judgement-heavy; the rubric reduces but does not eliminate it. Require deterministic repro before any fix PR.
- **Platform-version coupling** — goldens may drift across PU updates; record `platform_build` per run and version goldens accordingly.
- **Throughput** — VM build time caps how many cases/day; plan for batching, not real-time.
