/**
 * SQL is offered only where it can work: a classic VM whose AOS web.config
 * names its database. UDE, or a packages folder with no local AOS, skips it.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openStore } from '../../src/cli/settingsStore.js';

const { configureSql, info } = vi.hoisted(() => ({ configureSql: vi.fn(), info: vi.fn() }));
vi.mock('../../src/cli/sqlSetup.js', () => ({ configureSql }));
vi.mock('../../src/cli/ui.js', () => ({ p: { log: { step: vi.fn(), info } } }));
const { configureSqlForEnvironment } = await import('../../src/cli/sqlEnvironmentSetup.js');

let root: string | undefined;
afterEach(() => {
  vi.clearAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function store() {
  root = fs.mkdtempSync(join(tmpdir(), 'sql-environment-setup-'));
  return openStore(root, null);
}

it('hands the web.config database to the SQL step on a classic VM', async () => {
  const target = store();
  const packages = join(root!, 'AosService', 'PackagesLocalDirectory');
  fs.mkdirSync(packages, { recursive: true });
  fs.mkdirSync(join(root!, 'AosService', 'WebRoot'));
  fs.writeFileSync(join(root!, 'AosService', 'WebRoot', 'web.config'),
    '<add key="Infrastructure.HostUrl" value="https://usnconeboxax1aos.cloud.onebox.dynamics.com/" />' +
    '<add key="DataAccess.DbServer" value="." /><add key="DataAccess.Database" value="AxDB" />');

  await configureSqlForEnvironment(target, 'traditional', packages);

  expect(configureSql).toHaveBeenCalledWith(target, expect.objectContaining({ dbServer: '.', database: 'AxDB' }));
});

it('does not offer SQL on a classic VM with no local AOS web.config', async () => {
  await configureSqlForEnvironment(store(), 'traditional', undefined);
  expect(configureSql).not.toHaveBeenCalled();
  expect(info.mock.calls.flat().join(' ')).toContain('config sql');
});

it('does not offer SQL when the web.config names no database server', async () => {
  const target = store();
  const packages = join(root!, 'AosService', 'PackagesLocalDirectory');
  fs.mkdirSync(packages, { recursive: true });
  fs.mkdirSync(join(root!, 'AosService', 'WebRoot'));
  fs.writeFileSync(join(root!, 'AosService', 'WebRoot', 'web.config'),
    '<add key="Infrastructure.HostUrl" value="https://usnconeboxax1aos.cloud.onebox.dynamics.com/" />');
  await configureSqlForEnvironment(target, 'traditional', packages);
  expect(configureSql).not.toHaveBeenCalled();
});

it('skips SQL on UDE and says how to configure it later', async () => {
  await configureSqlForEnvironment(store(), 'ude');
  expect(configureSql).not.toHaveBeenCalled();
  expect(info.mock.calls.flat().join(' ')).toContain('config sql');
});
