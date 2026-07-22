/**
 * property_stats Purge Script
 *
 * Removes mined property statistics that came from models Microsoft did not author.
 *
 * `property_stats` answers "what does the standard platform do" — prepare, generate_object
 * and validate_code present its majority values as platform convention. Its counts are
 * cumulative, so gating the miners (see XppSymbolIndex.setNonMicrosoftModels) only stops
 * NEW pollution: rows an earlier build wrote for your own model or a third-party ISV model
 * survive until deleted. This script deletes them in place — no reindex, no VACUUM, and it
 * touches nothing but the property_stats table.
 *
 * `npm run build-database` performs the same purge automatically. Use this script to clean
 * an existing database without waiting for the next build.
 *
 * Usage:
 *   npm run purge-property-stats            # report, then purge
 *   npm run purge-property-stats -- --dry-run
 *
 * Relevant env vars:
 *   DB_PATH        Path to the SQLite database   (default: ./data/xpp-metadata.db)
 *   METADATA_PATH  Extracted-metadata dir, read for the extract manifest's custom-model
 *                  list — the only source of truth on UDE  (default: ./extracted-metadata)
 *   CUSTOM_MODELS / EXTENSION_PREFIX / D365FO_MODEL_NAME
 *                  The name-based classification applied to every other model.
 *
 * Note: the purge is only as good as the current notion of "non-Microsoft". An ISV model
 * that neither the extract manifest nor isCustomModel() knows about is NOT removed — add
 * it to CUSTOM_MODELS and re-run.
 */

import { loadEnv } from '../src/utils/loadEnv.js';
loadEnv(import.meta.url);
import { XppSymbolIndex } from '../src/metadata/symbolIndex.js';
import { readExtractedCustomModels } from '../src/utils/extractManifest.js';
import { c, log, kv, shortPath } from '../src/utils/terminalUi.js';

const DB = process.env.DB_PATH || './data/xpp-metadata.db';
const LABELS_DB = process.env.LABELS_DB_PATH || './data/xpp-metadata-labels.db';
const METADATA_PATH = process.env.METADATA_PATH || './extracted-metadata';
const DRY_RUN = process.argv.includes('--dry-run');

function observations(index: XppSymbolIndex): number {
  const row = index.db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM property_stats').get() as { n: number };
  return row.n;
}

async function main(): Promise<void> {
  console.log('');
  console.log(kv('Database', shortPath(DB)));
  console.log(kv('Mode', DRY_RUN ? c.yellow('dry run (nothing deleted)') : c.dim('purge')));

  const index = new XppSymbolIndex(DB, LABELS_DB);
  try {
    const manifestModels = readExtractedCustomModels(METADATA_PATH);
    if (manifestModels !== undefined) {
      index.setNonMicrosoftModels(manifestModels);
      console.log(kv('Manifest',c.dim(`${manifestModels.length} non-Microsoft model(s)`)));
    } else {
      console.log(kv('Manifest',c.dim('not found — falling back to name-based classification only')));
    }
    console.log('');

    const before = observations(index);

    if (DRY_RUN) {
      const doomed = index.purgeNonMineableStats({ dryRun: true });
      if (doomed.length === 0) {
        log.ok('property_stats corpus is already clean — nothing to purge');
        return;
      }
      const placeholders = doomed.map(() => '?').join(',');
      const row = index.db.prepare(
        `SELECT COALESCE(SUM(count), 0) AS n FROM property_stats WHERE model IN (${placeholders})`,
      ).get(...doomed) as { n: number };
      log.warn(`Would purge ${doomed.length} model(s), ${row.n.toLocaleString('en-US')} of ${before.toLocaleString('en-US')} observations (${(100 * row.n / (before || 1)).toFixed(1)}%)`);
      for (const m of doomed) log.detail(m);
      return;
    }

    const purged = index.purgeNonMineableStats();
    const after = observations(index);

    if (purged.length === 0) {
      log.ok('property_stats corpus is already clean — nothing to purge');
      return;
    }
    log.ok(`Purged ${purged.length} model(s): ${(before - after).toLocaleString('en-US')} of ${before.toLocaleString('en-US')} observations removed`);
    for (const m of purged) log.detail(m);
  } finally {
    index.close();
  }
}

main().catch(err => {
  log.err(`Purge failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
