import { settingByPath } from '../config/settings.js';
import { isLocalSqlServer, type AosWebConfig } from './aosWebConfig.js';
import { askSetting } from './settingsPrompt.js';
import { readSetting, writeSetting, type SettingsStore } from './settingsStore.js';
import { askConfirm, p } from './ui.js';

const sqlSetting = (path: string) => settingByPath(`sql.${path}`)!;

function disableSql(store: SettingsStore): void {
  writeSetting(store, sqlSetting('enabled'), false);
  p.log.info('SQL is disabled. You can configure it later with d365fo-mcp config sql');
}

/**
 * A blank server intentionally skips the rest of this optional feature.
 *
 * `detected` is what the local AOS's web.config names as its database. It is
 * offered as the answer, but only after the user opts in: SQL stays off unless
 * chosen, exactly as with a blank server. A stored server wins over it, so
 * re-running setup never moves a configured installation.
 */
export async function configureSql(store: SettingsStore, detected?: AosWebConfig | null): Promise<void> {
  p.log.step('AxDB SQL — optional');
  let initialServer: string | undefined;
  if (detected?.dbServer && readSetting(store, sqlSetting('server')) === undefined) {
    const database = detected.database ?? 'AxDB';
    if (!await askConfirm(`Enable AxDB SQL on ${detected.dbServer} / ${database}? (the AOS's own database, from its web.config)`, false)) {
      disableSql(store);
      return;
    }
    initialServer = detected.dbServer;
  }
  const server = await askSetting(store, sqlSetting('server'), { initial: initialServer });
  const enabled = typeof server === 'string' && !!server.trim();
  if (!enabled) {
    disableSql(store);
    return;
  }
  writeSetting(store, sqlSetting('enabled'), true);
  p.log.info('Authentication uses the Windows account running MCP; no SQL password is needed.');
  await askSetting(store, sqlSetting('database'), { initial: detected?.database });
  // A developer VM's SQL Server presents a self-signed certificate; the
  // connection stays encrypted either way.
  await askSetting(store, sqlSetting('trustServerCertificate'), {
    initial: isLocalSqlServer(String(server)) ? 'true' : undefined,
  });
}
