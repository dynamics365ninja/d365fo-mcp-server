# Authoring knowledge topics

The X++ knowledge base (`src/tools/xppKnowledge.ts`, exposed as
`get_knowledge(kind="knowledge")`) is content shipped **directly into the
model's context**. Unlike generated code — which is gated by `validate_code`,
`run_bp_check` and the build — knowledge text used to reach the agent with no
gate at all. That asymmetry produced real defects: a `SysRunnable::run()` that
does not exist in the AOT, a "deprecated" `curExt()` whose stated replacement
called `curExt()` itself, and `related:` ids pointing at topics that were never
written.

Three CI gates now stand behind this file. This document is how to get a topic
through them, and what makes a topic worth adding at all.

---

## 1. When to add a topic

Add one when **the code enforces a rule that is taught nowhere**. That is the
strongest signal, because it means the only way an agent can learn the rule is
by shipping something that fails.

The `extensible-enums` topic is the worked example: `createD365File.ts`
`generateAxEnumXml` has always forced `UseEnumValue=No` and suppressed `<Value>`
elements for extensible enums, and the create path skips the C# bridge entirely
for them — but no topic said why, so an agent writing the XML by hand produced
something xppc rejects and had no way to find out why.

Do **not** add a topic to restate something the model already reliably knows,
and do not add one that duplicates an existing topic's rules. The knowledge
payload is a token budget: every rule competes with every other rule for
attention. Prefer extending an existing topic over creating a near-duplicate.

## 2. Anatomy of an entry

```ts
{
  id: 'extensible-enums',                 // kebab-case, stable, never renamed casually
  title: 'Enums & Extensible Enums (IsExtensible / UseEnumValue)',
  keywords: ['enum', 'extensible enum', 'isextensible', /* … */],
  summary: 'One paragraph. What is different here and why it bites.',
  migration: { ax2012: '…', d365fo: '…' },  // optional
  rules: [ 'Imperative one-liners. The payload the agent actually reads.' ],
  examples: [ { label: '…', code: '…' } ],  // detailed mode only
  related: ['sysextension', 'labels'],       // MUST resolve to real ids
}
```

Field-by-field:

- **`id`** — kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`, gated). The agent types it
  back verbatim to re-request the topic, so it has to be typable. Renaming an
  id breaks every `related:` that points at it and every
  `src/eval/coverage/taxonomy.ts` `knowledgeIds` entry — grep before renaming.
- **`keywords`** — **lowercase only** (gated). `scoreEntry` matches against a
  lowercased query, so `priceDiscTable` is dead weight that can never match.
  Include the wrong spellings and the error-message words people will search
  with, not just the canonical name.
- **`summary`** — shown in both formats. Say what is *different*, not what the
  feature is.
- **`rules`** — the load-bearing field. One rule per line, imperative, and
  state the failure mode: `'xppc rejects the alternative with: "UseEnumValue
  property must be set to \'No\' when IsExtensible is True"'` is worth ten
  lines of "best practice" prose. Quote real compiler/BP text where you have it.
- **`examples`** — rendered only in `format="detailed"`. Every example goes
  through `validate_code`'s rules (see gate 2), so a deliberately-wrong example
  needs an entry in that test's `ALLOWED` list.
- **`related`** — every id must exist (gated). Note that the **concise**
  formatter — the default — prints the raw ids without resolving them, so a
  dangling id is presented to the agent as a queryable topic and costs a wasted
  round trip.

## 3. The three gates

Run all of them with `npx vitest run tests/knowledge`.

### `tests/knowledge/entryIntegrity.test.ts` — shape

Unique ids, kebab-case ids, lowercase keywords, no self-references, required
fields present, and **every `related:` id resolves**. Pure structure; no DB
needed. This is the gate that catches the copy-paste-a-topic-and-forget class
of error.

### `tests/knowledge/exampleValidation.test.ts` — examples compile-ish

Routes every `examples[].code` through `runRules` from `src/tools/validateXpp.ts`.
Any **error**-severity violation fails CI.

If your example is *deliberately* wrong (a "❌ WRONG" demonstration), add its
key to the `ALLOWED` set in that file in the form
`<entryId>::<example label>::<RULE>`. Keep those rare — one exists today.

### `tests/knowledge/apiSymbols.test.ts` — the named APIs are real

Every AOT type/API named anywhere in the entry is extracted by
`src/eval/audit/knowledgeRefs.ts` and must resolve against the real symbol
index. **This is the gate that will block your PR**, so read this section
before you write.

It runs in one of two modes:

- **Full symbol index present** (a VM with `data/xpp-metadata.db`) — resolves
  live and asserts zero findings.
- **Otherwise (normal CI, dev machines)** — every extracted reference must
  already be in the committed snapshot `eval/knowledge-audit.snapshot.json`.

The snapshot key is `entryId|kind|Name[::member]` — **scoped to the entry**. So
naming `CustTable` in a new topic is a new reference even though `CustTable` is
in the snapshot under a different topic. There is no way to satisfy the gate on
a dev machine except by not introducing the reference, or by capturing.

Three ways forward, in order of preference:

1. **Use the placeholder convention.** `knowledgeRefs.ts` skips any name
   matching `/^I?My[A-Z0-9]/` — `MyVehicleCategory`, `IMyStrategy`,
   `MyTable_Extension`. Hypothetical elements in examples should *always* use
   this form; it is the established convention and it keeps the gate honest for
   the names that are supposed to be real.
2. **Reference only names already audited for that entry.** Check with:
   ```bash
   node -e "const s=require('./eval/knowledge-audit.snapshot.json'); \
     console.log(s.ok.filter(k=>k.startsWith('YOUR-TOPIC-ID|')).join('\n'))"
   ```
3. **Re-capture on the VM** — `npm run eval:knowledge-audit -- --capture`,
   commit the updated snapshot. Required whenever your topic legitimately names
   real standard AOT elements.

`eval/knowledge-audit.allow.json` is **not** an escape hatch for this. It only
covers names that can never be in the index by construction — X++ kernel classes
and .NET interop types — and it applies to the live mode only, not to the
snapshot comparison. Its own header says it: *"Do NOT add an entry to silence a
defect — a hallucinated type is not a kernel type."*

## 4. Do not contradict another topic

The knowledge base is read one topic at a time, so a contradiction between two
topics is invisible to the reader and fatal to the agent. Before you write a
rule, grep the whole file for the API you are about to make a claim about:

```bash
rg -n 'curExt' src/tools/xppKnowledge.ts
```

`curExt()` was simultaneously listed as deprecated (topic `deprecated`),
mandated (topic `multi-company`) and used without comment (topic `direct-sql`).
Nothing detects that automatically — it is on the author.

Two specific traps:

- **Deprecation claims need evidence.** A BP rule id (`BPUpgradeCodeToday`), a
  quoted `[SysObsolete]` message, or a real compiler diagnostic. "Legacy" and
  "prefer the new one" are not deprecations, and the `deprecated` topic now
  keeps an explicit `NOT DEPRECATED — …` block for the APIs models most often
  hallucinate as obsolete. Add to that block rather than deleting a wrong claim
  outright, so a keyword search still lands on the correction.
- **Templates the tools emit must obey the rules the topics state.**
  `get_method`'s CoC template used to copy the base method's default parameter
  values — exactly what `coc-authoring` forbids and what `validate_code` reports
  as `COC001`. If you write a rule about generated shape, check the generator.

## 5. Checklist

- [ ] The rule is enforced somewhere in code, or costs a real failure if unknown.
- [ ] Not already covered by an existing topic (grep the ids and keywords).
- [ ] `id` kebab-case; `keywords` all lowercase; `related` ids all exist.
- [ ] Rules name the concrete failure mode, quoting real error text where possible.
- [ ] Hypothetical elements in examples use the `My…` placeholder convention.
- [ ] Real AOT names either already in the snapshot for this entry, or the
      snapshot re-captured on the VM.
- [ ] No contradiction with any other topic (grep the API name file-wide).
- [ ] `npx vitest run tests/knowledge tests/tools/xpp-knowledge.test.ts` green.
