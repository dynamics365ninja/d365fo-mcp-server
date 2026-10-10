/**
 * The optional AxDB SQL step of setup, asked after the environment type because
 * it depends on it. SQL is only offered where it can work: a classic AOSService
 * VM whose WebRoot\web.config names the database its own AOS uses. A UDE machine
 * has no local AOS and no local AxDB reachable with Windows authentication, and
 * a packages folder with no AOS beside it has nothing to connect to — both skip
 * the question. `config sql` still configures it by hand on any machine.
 */
import { readAosWebConfig } from './aosWebConfig.js';
import type { SettingsStore } from './settingsStore.js';
import { configureSql } from './sqlSetup.js';
import { p } from './ui.js';

export async function configureSqlForEnvironment(
  store: SettingsStore,
  envType: string,
  packagesRoot?: string,
): Promise<void> {
  const aos = envType === 'ude' ? null : readAosWebConfig(packagesRoot);
  if (!aos?.dbServer) {
    p.log.info(
      (envType === 'ude'
        ? 'AxDB SQL skipped — it needs a local AxDB reached with Windows authentication, which a UDE machine does not have.'
        : 'AxDB SQL skipped — no local AOS web.config names a database beside this packages folder.') +
      '\n   If this machine does reach one: d365fo-mcp config sql',
    );
    return;
  }
  await configureSql(store, aos);
}
