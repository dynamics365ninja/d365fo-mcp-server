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

const distEntryWin = (): string => resolve(repoRoot, 'dist', 'index.js');

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
  // Also write the JSON to a file so it can be copied as-is into VS.
  // It goes to the data directory, not the package: npm updates replace the
  // package directory and may not be writable.
  const outPath = paths.mcpSuggestion;
  fs.mkdirSync(dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json + '\n', 'utf8');
  p.log.info(`.mcp.json prepared at: ${outPath}`);
}

export function placementNote(): void {
  p.note(
    'Copy the generated .mcp.json to one of these locations:\n' +
    '  %USERPROFILE%\\.mcp.json          — all solutions (recommended)\n' +
    '  next to the .sln                 — that solution only\n\n' +
    'Make sure .github\\copilot-instructions.md exists in a parent folder\n' +
    'of your solutions (mandatory for Copilot — see docs/SETUP.md).\n' +
    'Restart Visual Studio after copying .mcp.json.',
    'Where it goes',
  );
}
