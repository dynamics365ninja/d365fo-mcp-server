/**
 * index.bpCatalogPath must NOT carry a registry default.
 *
 * defaultPathEnv() projects every `path`-typed setting that has a string
 * default onto process.env at the bottom of loadEnv(). A default here would
 * therefore make BP_CATALOG_PATH permanently set, which breaks the feature in
 * both directions:
 *
 *   • bpMonikers/loadCatalog()'s "unset → compiled-in catalog" branch becomes
 *     unreachable, so every install that has never regenerated a catalog — all
 *     existing ones, every Linux/Azure deployment, every dev checkout — hits
 *     ENOENT and prints a warning on each process start;
 *   • the setting's own documented contract ("only written once an instance has
 *     regenerated its own catalog") stops being true.
 *
 * ensureBpCatalogFresh writes the value after a successful extraction instead.
 * This is a one-line property that is easy to "tidy up" back into a default, so
 * it is asserted rather than left to the comment in settings.ts.
 */
import { describe, it, expect } from 'vitest';
import { defaultPathEnv } from '../../src/config/configFile.js';
import { settingByPath } from '../../src/config/settings.js';

describe('index.bpCatalogPath', () => {
  it('has no registry default', () => {
    expect(settingByPath('index.bpCatalogPath')!.default).toBeUndefined();
  });

  it('is not projected onto the environment by defaultPathEnv', () => {
    const env = defaultPathEnv('/install-root');

    expect(env.BP_CATALOG_PATH).toBeUndefined();
    // The settings that DO want a default anchored to the install directory are
    // unaffected — this is a property of one setting, not a change to the rule.
    expect(env.DB_PATH).toBeDefined();
    expect(env.METADATA_PATH).toBeDefined();
  });
});
