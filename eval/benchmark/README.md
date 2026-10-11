# Model × MCP benchmark

How much does the D365FO MCP server change what a model costs, how long it takes
and what it writes — and how is that moving over time, model by model? Full
guide in [docs/BENCHMARK.md](../../docs/BENCHMARK.md).

```
eval/benchmark/
├── prompts/<id>.json   the prompt catalogue — one experiment each (id, title, prompt, expects);
│                       ref-*.json: three reference use-cases that write into a sandbox (objects named);
│                       daily-*.json: three everyday tasks that name no standard object (find it first)
├── runs/<runId>.json   one record per run (committed — the report is derived from these)
├── credits.json        AI-Credits pricing: creditsPerUsd, per-model USD rates
├── schema.json         JSON Schema of a run record
└── reports/            generated HTML + markdown (ignored by git)
```

```bash
npm run cli -- benchmark prompts                                   # the catalogue
npm run cli -- benchmark run all --models sonnet,opus --repeat 3    # headless matrix via claude -p
npm run cli -- benchmark run all --tag reference,daily --models sonnet,opus --repeat 3 \
  --sandbox 'K:\AosService\PackagesLocalDirectory\BenchmarkTestMcp' --mcp-config config/benchmark.mcp.json --mcp-servers d365fo-benchmark   # the sandbox suites
npm run cli -- benchmark ingest <main.jsonl> --prompt <id>          # a Copilot Chat session
npm run cli -- benchmark report --open                              # the report
```

Records hold derived numbers, the prompt id and hash, and (for headless runs) the
first 400 characters of the answer. **Never commit a raw host log** — see
docs/TESTING.md.
