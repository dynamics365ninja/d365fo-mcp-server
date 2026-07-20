# Audit knowledge base — 2026-07-20

Audit X++ knowledge base proti metamodelu tohoto VM (`data/xpp-metadata.db`),
reálnému AOT (`K:\AosService\PackagesLocalDirectory`) a learn.microsoft.com.
Všechny nálezy — P0 chybná tvrzení, P1 vnitřní rozpory/duplicity, P2 chybějící
core témata, P3 mezery v pokrytí — jsou zapracované a zafixované CI testy
`tests/knowledge/apiSymbols.test.ts` + `tests/knowledge/exampleValidation.test.ts`
+ `npm run eval:knowledge-audit`; vědomě odložené mezery jsou zaznamenané v
`src/eval/coverage/taxonomy.ts`.

## Zbývá

Golden capture zbývajících eval case. Z pěti autorovaných case jsou tři na
Contoso VM (2026-07-20) zachyceny a zvalidovány — **`L2-occ-retry-basic`**,
**`L2-table-caching-basic`** a **`L2-table-inheritance-basic`** (poslední po
opravě bridge podpory `InstanceRelationType` + rebuild/restart). Zbývají dva
blokované:

- `L3-custom-service-basic` — TOOL gap: `d365fo_file` nemá `objectType`
  `service`/`service-group`; navíc chybí fixture `ConDemoNoteHeader`.
- `L3-batch-retryable-basic` — potřebuje fixture `ConDemoNoteHeader` + tři
  SysOperation třídy.

Golden capture běží na throwaway `Contoso` sandbox modelu (eval invariant §11),
ne na reálném modelu. Plný rozpis findings je v
[`eval/ROADMAP.md`](../eval/ROADMAP.md); až padnou zbývající goldeny, smazat
i tento bod.
