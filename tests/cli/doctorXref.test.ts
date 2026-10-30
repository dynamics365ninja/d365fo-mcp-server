/**
 * `doctor` on a traditional VM with no cross-reference database configured.
 *
 * Only UDE's XPP config names DYNAMICSXREFDB. On a traditional VM nothing else
 * did, so the bridge started without cross-references and find_references
 * answered from a name-based search — silently, which is what made it look like
 * the xref simply had no metadata references.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkXrefConfigured } from '../../src/cli/commands/doctor.js';
import { openStore, writeSetting } from '../../src/cli/settingsStore.js';
import { settingByPath } from '../../src/config/settings.js';

describe('doctor — cross-reference database', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'doctor-xref-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.D365FO_XREF_DB_NAME;
    delete process.env.D365FO_XREF_DB_NAME;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.D365FO_XREF_DB_NAME;
    else process.env.D365FO_XREF_DB_NAME = saved;
  });

  it('names the setting to configure when no database is set', () => {
    const result = checkXrefConfigured(openStore(dir, null));
    expect(result?.severity).toBe('info');
    expect(result?.message).toContain('name-based search');
    expect(result?.fix).toContain('bridge.xrefDbName');
    expect(result?.fix).toContain('DYNAMICSXREFDB');
    // The environment outranks the config file, so the fix must name both places.
    expect(result?.fix).toContain('D365FO_XREF_DB_NAME');
    expect(result?.fix).toContain('.mcp.json');
    // Plain terminal output, not Markdown.
    expect(result?.fix).not.toContain('`');
  });

  // The server reads the real environment first (an .mcp.json `env` block), so
  // doctor must not report a database the server does use as unconfigured.
  it('is quiet when only the environment names the database', () => {
    process.env.D365FO_XREF_DB_NAME = 'DYNAMICSXREFDB';
    expect(checkXrefConfigured(openStore(dir, null))).toBeNull();
  });

  it('is quiet once the database name is configured', () => {
    const store = openStore(dir, null);
    writeSetting(store, settingByPath('bridge.xrefDbName')!, 'DYNAMICSXREFDB');
    expect(checkXrefConfigured(store)).toBeNull();
  });
});
