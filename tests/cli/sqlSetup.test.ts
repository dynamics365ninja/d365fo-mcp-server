import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStore, readSetting, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';
import { configureSql } from '../../src/cli/sqlSetup.js';
const { askSetting, askConfirm, info } = vi.hoisted(() => ({ askSetting: vi.fn(), askConfirm: vi.fn(), info: vi.fn() }));
vi.mock('../../src/cli/settingsPrompt.js', () => ({ askSetting }));
vi.mock('../../src/cli/ui.js', () => ({ askConfirm, p: { log: { step: vi.fn(), info } } }));
afterEach(() => vi.clearAllMocks());

function withStore(run: (store: ReturnType<typeof openStore>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'sql-setup-'));
  return run(openStore(dir, null)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

it('blank server disables SQL and skips all remaining questions', () => withStore(async store => {
  writeSetting(store, settingByPath('sql.enabled')!, true);
  askSetting.mockResolvedValueOnce(undefined);
  await configureSql(store);
  expect(askSetting).toHaveBeenCalledTimes(1);
  expect(readSetting(store, settingByPath('sql.enabled')!)).toBe(false);
  // The checkout's own CLI, not a `d365fo-mcp` that may be upstream's or absent.
  expect(info.mock.calls.flat().join(' ')).toContain('config sql');
}));

it('asks server then database and certificate only when chosen — never about writes', () => withStore(async store => {
  askSetting.mockResolvedValueOnce('localhost').mockResolvedValueOnce('AxDB').mockResolvedValueOnce(true);
  await configureSql(store);
  expect(askSetting.mock.calls.map(c => c[1].path)).toEqual(['sql.server', 'sql.database', 'sql.trustServerCertificate']);
  expect(readSetting(store, settingByPath('sql.enabled')!)).toBe(true);
  expect(info.mock.calls.flat().join(' ')).toContain('Windows');
  expect(askConfirm).not.toHaveBeenCalled();
}));

it('suggests trusting the certificate for a local server only', () => withStore(async store => {
  askSetting.mockResolvedValueOnce('.').mockResolvedValueOnce('AxDB').mockResolvedValueOnce(true);
  await configureSql(store);
  expect(askSetting.mock.calls[2][2]).toEqual({ initial: 'true' });

  vi.clearAllMocks();
  askSetting.mockResolvedValueOnce('sql.contoso.com').mockResolvedValueOnce('AxDB').mockResolvedValueOnce(false);
  await configureSql(store);
  expect(askSetting.mock.calls[2][2]).toEqual({ initial: undefined });
}));

it('offers the AOS web.config database only after the user opts in', () => withStore(async store => {
  askConfirm.mockResolvedValueOnce(false);
  await configureSql(store, { dbServer: '.', database: 'AxDB' });
  expect(askConfirm).toHaveBeenCalledTimes(1);
  expect(askSetting).not.toHaveBeenCalled();
  expect(readSetting(store, settingByPath('sql.enabled')!)).toBe(false);
}));

it('prefills server and database from the AOS web.config when accepted', () => withStore(async store => {
  askConfirm.mockResolvedValueOnce(true);
  askSetting.mockResolvedValueOnce('.').mockResolvedValueOnce('AxDB_Dev').mockResolvedValueOnce(true);
  await configureSql(store, { dbServer: '.', database: 'AxDB_Dev' });
  expect(askSetting.mock.calls[0][2]).toEqual({ initial: '.' });
  expect(askSetting.mock.calls[1][2]).toEqual({ initial: 'AxDB_Dev' });
  expect(readSetting(store, settingByPath('sql.enabled')!)).toBe(true);
}));

it('does not ask to switch a configured server to the detected one', () => withStore(async store => {
  writeSetting(store, settingByPath('sql.server')!, 'sql.contoso.com');
  askSetting.mockResolvedValueOnce('sql.contoso.com').mockResolvedValueOnce('AxDB').mockResolvedValueOnce(false);
  await configureSql(store, { dbServer: '.', database: 'AxDB' });
  expect(askConfirm).not.toHaveBeenCalled();
  expect(askSetting.mock.calls[0][2]).toEqual({ initial: undefined });
}));
