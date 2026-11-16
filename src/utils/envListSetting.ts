/**
 * Add or remove one entry of a comma-separated setting in a .env file
 * (CUSTOM_MODELS, D365FO_CROSS_MODEL_WRITE_MODELS), and mirror it into
 * process.env so the running server sees it without a restart.
 *
 * Used by the model lifecycle only: a model this server created is not known to
 * any configuration yet, and one it deleted should not stay listed. Everything
 * else in the file — comments, order, line ends, other keys — is left as it is.
 */

import * as fs from 'fs/promises';
import { withFileLock } from './atomicFileWrite.js';

const eqi = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function splitList(value: string | undefined | null): string[] {
  return (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
}

export interface ListEdit {
  /** The file text after the edit (unchanged when `changed` is false). */
  text: string;
  changed: boolean;
  /** The setting's value after the edit, or null when the key is not in the file. */
  value: string | null;
}

/**
 * Edit `KEY=a,b,c` in .env text. The LAST uncommented assignment is the one
 * dotenv honours, so that is the one edited. An absent key is appended on add
 * and left absent on remove. Quotes around the value are kept.
 */
export function editEnvList(text: string, key: string, edit: { add?: string; remove?: string }): ListEdit {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const lineRe = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=\\s*)(.*)$`);
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (lineRe.test(lines[i])) at = i;

  if (at < 0) {
    if (!edit.add) return { text, changed: false, value: null };
    const body = text.length === 0 || /\r?\n$/.test(text) ? text : text + eol;
    return { text: `${body}${key}=${edit.add}${eol}`, changed: true, value: edit.add };
  }

  const [, head, rawValue] = lineRe.exec(lines[at])!;
  const quote = /^(["']).*\1\s*$/.test(rawValue.trim()) ? rawValue.trim()[0] : '';
  const inner = quote ? rawValue.trim().slice(1, -1) : rawValue.replace(/\s+#.*$/, '');
  let entries = splitList(inner);
  const before = entries.join(',');
  if (edit.remove) entries = entries.filter(e => !eqi(e, edit.remove!));
  if (edit.add && !entries.some(e => eqi(e, edit.add!))) entries.push(edit.add);
  const value = entries.join(',');
  if (value === before) return { text, changed: false, value };
  lines[at] = `${head}${quote}${value}${quote}`;
  return { text: lines.join(eol), changed: true, value };
}

export interface ListSettingOutcome {
  key: string;
  /** The file was rewritten. */
  persisted: boolean;
  /** process.env now holds the edited list. */
  appliedToProcess: boolean;
  value: string;
  /** Why the file was not (or need not be) written, when it was not. */
  note?: string;
}

/**
 * Apply one add/remove to `key`, in the file and in process.env.
 *
 * `envFile` null (no .env was loaded — tests, scripts) edits process.env only.
 * A key the real environment owns is edited in process.env only too: the file
 * cannot outrank it at the next start, so writing it there would report a
 * setting as saved that the next session does not see.
 */
export async function updateListSetting(
  envFile: { envPath: string; ownedByRealEnv(key: string): boolean } | null,
  key: string,
  edit: { add?: string; remove?: string },
): Promise<ListSettingOutcome> {
  let entries = splitList(process.env[key]);
  const beforeProcess = entries.join(',');
  if (edit.remove) entries = entries.filter(e => !eqi(e, edit.remove!));
  if (edit.add && !entries.some(e => eqi(e, edit.add!))) entries.push(edit.add);
  const value = entries.join(',');
  const appliedToProcess = value !== beforeProcess;
  if (appliedToProcess) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }

  if (!envFile) return { key, persisted: false, appliedToProcess, value, note: 'no .env file is loaded' };
  if (envFile.ownedByRealEnv(key)) {
    return {
      key, persisted: false, appliedToProcess, value,
      note: `${key} is set by the server's real environment (shell or the MCP client's env block), which outranks .env`,
    };
  }

  return withFileLock(envFile.envPath, () => persist(envFile.envPath, key, edit, value, appliedToProcess));
}

async function persist(
  envPath: string, key: string, edit: { add?: string; remove?: string }, value: string, appliedToProcess: boolean,
): Promise<ListSettingOutcome> {
  const envFile = { envPath };
  let text = '';
  try {
    text = await fs.readFile(envFile.envPath, 'utf-8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      return { key, persisted: false, appliedToProcess, value, note: `could not read ${envFile.envPath}: ${e?.message ?? e}` };
    }
  }
  // The file is the source for the next start, so it is edited from ITS list,
  // not from process.env (config/d365fo-mcp.json may have supplied that one).
  // A key the file does not carry yet is written with the WHOLE current list: an
  // explicit ENV_FILE outranks the JSON config, so a line holding only the new
  // entry would drop every model that config supplied at the next start.
  const absent = editEnvList(text, key, {}).value === null;
  const edited = absent && edit.add && value
    ? editEnvList(text, key, { add: value })
    : editEnvList(text, key, edit);
  if (!edited.changed) return { key, persisted: false, appliedToProcess, value, note: 'already as wanted in .env' };
  try {
    await fs.writeFile(envFile.envPath, edited.text, 'utf-8');
  } catch (e: any) {
    return { key, persisted: false, appliedToProcess, value, note: `could not write ${envFile.envPath}: ${e?.message ?? e}` };
  }
  return { key, persisted: true, appliedToProcess, value };
}
