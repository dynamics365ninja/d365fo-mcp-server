/**
 * What the SQL setup reads from a classic VM's AosService\WebRoot\web.config
 * instead of asking by hand: the AOS's own SQL server and database.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLocalSqlServer, parseAosWebConfig, readAosWebConfig } from '../../src/cli/aosWebConfig.js';

const WEB_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="DataAccess.DbServer" value="." />
    <add key="DataAccess.Database" value="AxDB" />
    <add key="DataAccess.SqlPwd" value="secret" />
    <add key="Infrastructure.HostUrl" value="https://usnconeboxax1aos.cloud.onebox.dynamics.com/" />
  </appSettings>
</configuration>`;

describe('parseAosWebConfig', () => {
  it('reads the server and database — and nothing else, not even the SQL password', () => {
    expect(parseAosWebConfig(WEB_CONFIG)).toEqual({
      dbServer: '.',
      database: 'AxDB',
    });
  });

  it('proposes the live server and database, not commented-out or reordered copies', () => {
    const xml = `<appSettings>
    <!-- <add key="DataAccess.DbServer" value="OLDSQL" /> -->
    <add key="DataAccess.DbServer" value="." />
    <add value="AxDB" key="DataAccess.Database" />
  </appSettings>`;
    expect(parseAosWebConfig(xml)).toEqual({ dbServer: '.', database: 'AxDB' });
  });

  it('leaves missing or empty keys undefined', () => {
    expect(parseAosWebConfig('<add key="DataAccess.DbServer" value="" />')).toEqual({
      dbServer: undefined, database: undefined,
    });
  });
});

describe('readAosWebConfig', () => {
  let root: string | undefined;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('reads WebRoot\\web.config next to PackagesLocalDirectory', () => {
    root = fs.mkdtempSync(join(tmpdir(), 'aos-webconfig-'));
    fs.mkdirSync(join(root, 'PackagesLocalDirectory'));
    fs.mkdirSync(join(root, 'WebRoot'));
    fs.writeFileSync(join(root, 'WebRoot', 'web.config'), WEB_CONFIG);
    expect(readAosWebConfig(join(root, 'PackagesLocalDirectory'))?.database).toBe('AxDB');
  });

  it('is null without a web.config (UDE) or without a packages root', () => {
    root = fs.mkdtempSync(join(tmpdir(), 'aos-webconfig-'));
    expect(readAosWebConfig(join(root, 'PackagesLocalDirectory'))).toBeNull();
    expect(readAosWebConfig(undefined)).toBeNull();
  });
});

describe('isLocalSqlServer', () => {
  it('recognises the ways a VM names its own SQL Server', () => {
    for (const server of ['.', '(local)', 'localhost', 'LOCALHOST\\MSSQLSERVER', '127.0.0.1,1433', 'tcp:localhost', 'DEVVM01', '(localdb)\\MSSQLLocalDB']) {
      expect(isLocalSqlServer(server, 'devvm01')).toBe(true);
    }
  });

  it('does not treat another machine as local', () => {
    for (const server of ['sql.contoso.com', 'OTHERVM\\SQL', '10.0.0.5']) {
      expect(isLocalSqlServer(server, 'devvm01')).toBe(false);
    }
  });
});
