/**
 * `d365fo-mcp config [section] [instance]` — revisit settings after setup.
 *
 * The setup wizard is scenario-shaped and asks a lot; this is the small door
 * for "I just need to change the prefix" or "the UDE was upgraded, repoint the
 * XPP config". Same registry, same descriptions, writes the same JSON.
 */
import { SECTIONS, settingByPath, settingsInSection, type SectionId, type Setting } from '../../config/settings.js';
import { askSecrets, askSetting, askSettings } from '../settingsPrompt.js';
import { readSetting, saveStore, writeSetting, type SettingsStore } from '../settingsStore.js';
import { pickTarget } from '../target.js';
import { askSelect, p } from '../ui.js';
import { listXppConfigs, xppConfigDir } from '../xppConfig.js';
import { readAosWebConfig } from '../aosWebConfig.js';
import { configureSql } from '../sqlSetup.js';

const xppConfigNameSetting = settingByPath('environment.xppConfigName')!;
const envTypeSetting = settingByPath('environment.type')!;

/** Pin an XPP config (UDE) — the `npm run select-config` flow. */
export async function selectXppConfig(store: SettingsStore): Promise<boolean> {
  const configs = listXppConfigs();
  if (configs.length === 0) {
    p.log.error(`No XPP config files found${xppConfigDir() ? ` in ${xppConfigDir()}` : ''}.\n` +
      '   This directory is created by Power Platform Tools in VS2022 (Windows only).');
    return false;
  }
  const current = String(readSetting(store, xppConfigNameSetting) ?? '');
  const pick = await askSelect(
    `${xppConfigNameSetting.label}\n  ${xppConfigNameSetting.description}`,
    [
      { value: '', label: '(auto — always use the newest)' },
      ...configs.map((cfg, i) => ({
        value: cfg.fullName,
        label: `${cfg.name}  v${cfg.version}${i === 0 ? ' (newest)' : ''}${cfg.fullName === current ? ' (current)' : ''}`,
        hint: cfg.modelStoreFolder,
      })),
    ],
    current,
  );
  writeSetting(store, xppConfigNameSetting, pick || undefined);
  saveStore(store);
  p.log.success(pick ? `Pinned XPP config: ${pick}` : 'XPP config set to auto (newest).');
  return true;
}

export async function configCommand(
  sectionArg: string | undefined,
  opts: { instance?: string; xppConfig?: boolean },
): Promise<void> {
  p.intro('d365fo-mcp config');

  const target = await pickTarget(opts.instance, 'Which configuration do you want to edit?');
  const store = target.store;
  p.log.info(`Editing ${target.label}: ${store.configPath}`);

  if (opts.xppConfig) {
    if (!await selectXppConfig(store)) process.exitCode = 1;
    p.outro('Rebuild the index afterwards: d365fo-mcp index');
    return;
  }

  const section = (sectionArg as SectionId | undefined) ?? await askSelect<SectionId>(
    'Which area?',
    SECTIONS.map(s => ({ value: s.id, label: s.title, hint: s.description })),
  );
  if (!SECTIONS.some(s => s.id === section)) {
    p.log.error(`Unknown section '${section}'. Available: ${SECTIONS.map(s => s.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const skip = new Set<Setting>();
  if (section === 'environment') {
    // The environment type drives the rest of the section, and the XPP config is
    // a picker rather than free text — both need more than the generic walk.
    await askSetting(store, envTypeSetting, {
      initial: listXppConfigs().length > 0 ? 'ude' : 'traditional',
    });
    skip.add(envTypeSetting);
    if (readSetting(store, envTypeSetting) === 'ude' && listXppConfigs().length > 0) {
      await selectXppConfig(store);
      skip.add(xppConfigNameSetting);
    }
  }

  if (section === 'sql') {
    // Asked for explicitly, so offered on UDE too — but only a classic VM's
    // own web.config can suggest the server and database.
    const packagesRoot = readSetting(store, settingByPath('environment.packagePath')!);
    await configureSql(store, readSetting(store, envTypeSetting) === 'ude'
      ? null
      : readAosWebConfig(typeof packagesRoot === 'string' ? packagesRoot : undefined));
    saveStore(store);
    p.log.success(`Saved ${store.configPath}`);
    p.outro('Restart the server for SQL configuration changes to take effect.');
    return;
  }
  await askSettings(store, [
    ...settingsInSection(section, 'basic').filter(s => !skip.has(s)),
    ...settingsInSection(section, 'advanced'),
  ]);
  await askSecrets(store, [section]);
  saveStore(store);

  p.log.success(`Saved ${store.configPath}`);
  p.outro('Restart the server (or Visual Studio) for the change to take effect.');
}
