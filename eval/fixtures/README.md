# Harness-level eval fixtures

Shared **INPUT** objects that must exist *before* a case runs and must survive
the per-case rollback. This directory is the fix for
[eval/ROADMAP.md](../ROADMAP.md) step 1 ("Make `ConDemoNoteHeader` a
harness-level fixture") and is wired into the implementer protocol at
[docs/AGENT_EVAL_LOOP.md](../../docs/AGENT_EVAL_LOOP.md) §4a / §11.

## Why this exists (root cause)

`ConDemoNoteHeader` was created only as artifact 1 of case **L1-form-basic**. The
implementer protocol rolls back *every* case after scoring, so the shared table
could never survive — each rollback re-broke the ~18 other cases that read from
it. Separating the fixture from its origin case (a repo-committed definition,
provisioned before dependent cases, excluded from rollback) is the fix.

## What lives here

| File | Object | Type | Provisioned |
|------|--------|------|-------------|
| `ConDemoNoteHeader.metadata.xml` | `ConDemoNoteHeader` | `AxTable` | **yes** — the keystone fixture |

The shape is recovered verbatim from the 2026-06-30 golden
`eval/goldens/L1-form-basic/ConDemoNoteHeader.metadata.xml` (the golden of the
table itself): `NoteId` (String / EDT `Num` / Mandatory), `Subject` (String /
EDT `Name`), unique index `NoteIdx` on `NoteId`, `TitleField1 = Subject`,
`TableGroup = Main`, label `@TaxTransactionInquiry:HeaderNote`. Keep it in sync
with that golden.

## INPUT vs OUTPUT classification (the crux)

The catalog mentions ~50 `ConDemo*` / `DemoNote*` names. **Most are case
OUTPUTS** that a case *creates* and must **not** be pre-provisioned — only the
few shared **INPUTS** become fixtures. The split is derived mechanically by
`src/eval/fixtures/fixtures.ts` and audited by:

```
npm run eval:fixtures            # print the full classification + per-case plan
npm run eval:fixtures -- --check # gate: fail if any SHARED base is undecided
```

Method: normalise every demo object name to its prefix-stripped **base**
(`ConDemoNoteHeader` and `DemoNoteHeader` fold together). A base referenced by
**one** case is that case's OUTPUT; a base referenced by **more than one** case
is **SHARED** and needs an explicit decision. There are exactly three shared
bases:

| Base | Referenced by | Decision | Why |
|------|---------------|----------|-----|
| `DemoNoteHeader` | 20 cases | **INPUT** (fixture) | The shared table. Origin `L1-form-basic`; read/bound/selected by ~18 others. Provisioned. |
| `DemoNoteHeaderList` | `L1-form-basic`, `L4-entity-security` | **NEEDS_REVIEW** | Primary OUTPUT of L1-form-basic (the SimpleList form). `L4-entity-security`'s `DemoNoteHeaderDisplay` menu item points at it — a *latent* cross-case dependency. See below. |
| `DemoNoteSubject` | `L0-edt-basic`, `L2-delegate-basic` | **OUTPUT** | Not a dependency — a name collision: an **EDT** in L0-edt-basic and a self-referencing **delegate class** in L2-delegate-basic. Each case creates and consumes its own. |

Everything else (93 bases) is a single-case OUTPUT and is **not** provisioned.
Run `npm run eval:fixtures` for the full list.

### `DemoNoteHeaderList` — the one open call

`L4-entity-security` builds a display menu item (`DemoNoteHeaderDisplay`) that
targets the `ConDemoNoteHeaderList` **form**, which is created by `L1-form-basic`
and rolled back with it. A menu item pointing at a missing form typically breaks
a clean build, so `L4-entity-security` may need the form pre-provisioned too. It
is deliberately **not** auto-provisioned yet because:

- the form is a heavier, more brittle artifact than the table, and it in turn
  depends on the table fixture; and
- whether the missing-form reference is a hard build error or a mere BP warning
  can only be confirmed on the VM.

**Decision deferred to VM capture.** If `L4-entity-security` cannot reach
`bp_clean` without it, promote it: add `ConDemoNoteHeaderList.metadata.xml` here
(recoverable from `eval/goldens/L1-form-basic/ConDemoNoteHeaderList.metadata.xml`),
flip its `SHARED_DECISIONS` entry to `INPUT` with `origin: 'L1-form-basic'`, and
the per-case plan will pick it up automatically for L4-entity-security.

## Provisioning + rollback contract

- **Provision (step b):** before a dependent case, the agent creates each fixture
  the case needs (`fixturesForCase(id)`) via `d365fo_file(action=create)` from the
  committed XML here, then reindexes (`update_symbol_index`) so tools ground on it.
- **Rollback (step c):** the case's rollback must **keep** fixtures. The
  exclusion is `partitionForRollback(written, fixtureNames())`. Because the
  simplest wipe-safe implementation re-provisions from this repo at the *start* of
  every dependent case, a fixture that a case *mutates* (e.g. `L2-dimension-basic`
  adds a `DefaultDimension` field to `ConDemoNoteHeader`) is restored to its
  pristine shape on the next run regardless of how the wipe behaves.

See `docs/AGENT_EVAL_LOOP.md` §4a / §11 for the protocol prose.
