/**
 * Pinning the bridge binary's location into a configuration.
 *
 * The server finds the bridge by searching inside its own installation. That
 * works for a checkout, where the binary is built into the project. An npm
 * install builds it into the data directory instead — the package is replaced
 * on every update, so anything inside it is temporary — and nothing in the
 * package-relative search would ever look there. The wizard therefore records
 * the path, for the root config and for each instance.
 *
 * Written only when the binary actually exists: an empty setting means "search
 * for it", which is the right answer for a read-only install and for a
 * checkout, and a stale absolute path would turn a missing bridge into a hard
 * error instead of a fallback.
 */
import * as fs from 'node:fs';
import { installMode, paths } from './context.js';
import { settingByPath } from '../config/settings.js';
import { writeSetting, type SettingsStore } from './settingsStore.js';

export function pinBridgeExe(store: SettingsStore): void {
  if (installMode === 'git') return;
  if (!fs.existsSync(paths.bridgeExe)) return;
  writeSetting(store, settingByPath('bridge.exePath')!, paths.bridgeExe);
}
