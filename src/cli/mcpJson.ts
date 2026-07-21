/**
 * The `.mcp.json` block printed at the end of setup / instance add.
 *
 * Shared by both commands so a single-server install and an instance produce
 * the same shape — only the config path differs.
 */
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { paths, repoRoot } from './context.js';
import type { SettingsStore } from './settingsStore.js';
import { p } from './ui.js';

export const distEntryWin = (): string => resolve(repoRoot, 'dist', 'index.js');

/**
 * A stdio server entry.
 *
 * D365FO_CONFIG is passed explicitly rather than left to discovery: the IDE
 * spawns node from an arbitrary working directory, and one clone can serve
 * several configurations. Anything else added to this `env` block still wins
 * over the config file, which is how a per-solution override (a different
 * D365FO_MODEL_NAME, say) is expressed.
 */
export function stdioServer(store: SettingsStore, extraEnv?: Record<string, string>): Record<string, unknown> {
  return {
    command: 'node',
    args: [distEntryWin()],
    env: { D365FO_CONFIG: store.configPath, ...extraEnv },
  };
}

export function mcpJsonNote(servers: Record<string, unknown>, title = '.mcp.json'): void {
  const json = JSON.stringify({ servers }, null, 2);
  p.note(json, title);
  // Also write the raw JSON to a file so it can be copied without terminal box
  // characters. It goes to the data directory, not the package: an npm install
  // replaces the package on every update, and may not even be writable.
  const outPath = paths.mcpSuggestion;
  fs.mkdirSync(dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json + '\n', 'utf8');
  p.log.info(`Raw JSON written to: ${outPath}`);
}

export function placementNote(): void {
  p.note(
    'Place the block above in:\n' +
    '  %USERPROFILE%\\.mcp.json          — all solutions (recommended)\n' +
    '  next to the .sln                 — that solution only\n\n' +
    'Also copy .github\\copilot-instructions.md into a parent of your\n' +
    'solution folders (mandatory for Copilot — see docs/SETUP.md).\n' +
    'Restart Visual Studio after editing .mcp.json.',
    'Where it goes',
  );
}
