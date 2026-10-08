/**
 * Shared corpus-record loading for the improver CLIs (docs/AGENT_EVAL_LOOP.md
 * §10). VM-free — reads `eval/corpus/runs/*.json` from disk.
 *
 * The implementation moved to src/utils/jsonRecords.ts when the benchmark CLI
 * (published) started sharing it: src/eval is excluded from the npm package,
 * and a published module must not import an unpublished one. This file keeps
 * the eval-side import path stable.
 */

export { loadJsonRecords, readJsonLenient, stripBom } from '../../utils/jsonRecords.js';
