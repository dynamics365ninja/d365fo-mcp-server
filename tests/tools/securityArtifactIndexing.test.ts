/**
 * Finding #34 (2026-07-21 sweep), second half:
 *   `security_info(mode=artifact)` reported "Duties: none indexed" for a freshly
 *   indexed role — its own index table is not fed by update_symbol_index — so it
 *   could not serve as a verification oracle (xppbp had to).
 *
 * Root cause (VM-free, in the parser): `parseSecurityRoleFile` read the duty
 * list from `<AxSecurityRoleDutyPermission>` / `<AxSecurityDutyPermission>`
 * only. A STANDARD AxSecurityRole lists duties as `<AxSecurityDutyReference>`
 * (see finding #31, where the same element-name confusion made the created
 * chain dead), so a correctly shaped role parsed as ZERO duties and
 * security_role_duties stayed empty. Same for AxSecurityDuty →
 * `<AxSecurityPrivilegeReference>`.
 *
 * Second defect, same finding: "none indexed" reads as "this role has no
 * duties", which the tool cannot know. Absence of rows must be reported as
 * absence of data.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../../src/database/sqlite.js';
import { XppMetadataParser } from '../../src/metadata/xmlParser';
import { securityArtifactInfoTool } from '../../src/tools/securityArtifactInfo';

function writeTmp(name: string, xml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secparse-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, xml, 'utf-8');
  return file;
}

const ROLE_STANDARD_SHAPE = `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityRole xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoNoteReaderRole</Name>
  <Label>Note reader</Label>
  <Duties>
    <AxSecurityDutyReference>
      <Name>ConDemoNoteMaintainDuty</Name>
    </AxSecurityDutyReference>
    <AxSecurityDutyReference>
      <Name>ConDemoNoteViewDuty</Name>
    </AxSecurityDutyReference>
  </Duties>
</AxSecurityRole>`;

const DUTY_STANDARD_SHAPE = `<?xml version="1.0" encoding="utf-8"?>
<AxSecurityDuty xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoNoteMaintainDuty</Name>
  <Privileges>
    <AxSecurityPrivilegeReference>
      <Name>ConDemoNoteMaintainPrivilege</Name>
    </AxSecurityPrivilegeReference>
  </Privileges>
</AxSecurityDuty>`;

describe('security artifact parsing feeds the index (#34)', () => {
  it('reads role duties from the standard <AxSecurityDutyReference> shape', async () => {
    const file = writeTmp('ConDemoNoteReaderRole.xml', ROLE_STANDARD_SHAPE);
    const result = await new XppMetadataParser().parseSecurityRoleFile(file);

    expect(result.success).toBe(true);
    expect(result.data!.duties).toEqual(['ConDemoNoteMaintainDuty', 'ConDemoNoteViewDuty']);
  });

  it('reads duty privileges from the standard <AxSecurityPrivilegeReference> shape', async () => {
    const file = writeTmp('ConDemoNoteMaintainDuty.xml', DUTY_STANDARD_SHAPE);
    const result = await new XppMetadataParser().parseSecurityDutyFile(file);

    expect(result.success).toBe(true);
    expect(result.data!.privileges).toEqual(['ConDemoNoteMaintainPrivilege']);
  });

  it('still reads the legacy permission-set element names', async () => {
    const legacy = ROLE_STANDARD_SHAPE.replace(/AxSecurityDutyReference/g, 'AxSecurityRoleDutyPermission');
    const file = writeTmp('Legacy.xml', legacy);
    const result = await new XppMetadataParser().parseSecurityRoleFile(file);

    expect(result.data!.duties).toHaveLength(2);
  });
});

// ── honest "no data" reporting ───────────────────────────────────────────────

function makeSecurityDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT NOT NULL, parent_name TEXT,
      signature TEXT, file_path TEXT, model TEXT, description TEXT, extends_class TEXT
    );
    CREATE INDEX idx_name_type ON symbols(name, type);
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, type, parent_name, signature, description, tags);
    CREATE TABLE security_role_duties (role_name TEXT, duty_name TEXT, model TEXT);
    CREATE TABLE security_duty_privileges (duty_name TEXT, privilege_name TEXT, model TEXT);
    CREATE TABLE security_privilege_entries (
      privilege_name TEXT, entry_point_name TEXT, object_type TEXT, access_level TEXT, model TEXT
    );
    INSERT INTO symbols (name, type, model) VALUES ('ConDemoNoteReaderRole', 'security-role', 'Contoso');
    INSERT INTO symbols (name, type, model) VALUES ('ConDemoNoteMaintainDuty', 'security-duty', 'Contoso');
    INSERT INTO symbols_fts (rowid, name, type) VALUES (1, 'ConDemoNoteReaderRole', 'security-role');
    INSERT INTO symbols_fts (rowid, name, type) VALUES (2, 'ConDemoNoteMaintainDuty', 'security-duty');
  `);
  return db;
}

const artifactReq = (name: string, artifactType: string) => ({
  method: 'tools/call' as const,
  params: { name: 'get_security_artifact_info', arguments: { name, artifactType } },
});

describe('security_info(mode=artifact) reports missing data as missing (#34)', () => {
  it('does not imply a role has no duties when it simply has no rows', async () => {
    const db = makeSecurityDb();
    const context = { symbolIndex: { getReadDb: () => db }, bridge: undefined } as any;

    const result = await securityArtifactInfoTool(artifactReq('ConDemoNoteReaderRole', 'role'), context);
    const text = result.content[0].text as string;

    expect(text).toContain('NO DATA');
    expect(text).not.toContain('Duties: none indexed');
    // It must name the way to actually populate the table.
    expect(text).toContain('update_symbol_index');
  });

  it('applies the same honesty to a duty with no privilege rows', async () => {
    const db = makeSecurityDb();
    const context = { symbolIndex: { getReadDb: () => db }, bridge: undefined } as any;

    const result = await securityArtifactInfoTool(artifactReq('ConDemoNoteMaintainDuty', 'duty'), context);
    const text = result.content[0].text as string;

    expect(text).toContain('NO DATA');
    expect(text).toContain('update_symbol_index');
  });

  it('still lists duties normally when the table IS fed', async () => {
    const db = makeSecurityDb();
    db.prepare(`INSERT INTO security_role_duties VALUES ('ConDemoNoteReaderRole', 'ConDemoNoteMaintainDuty', 'Contoso')`).run();
    const context = { symbolIndex: { getReadDb: () => db }, bridge: undefined } as any;

    const result = await securityArtifactInfoTool(artifactReq('ConDemoNoteReaderRole', 'role'), context);
    const text = result.content[0].text as string;

    expect(text).toContain('Duties (1)');
    expect(text).toContain('ConDemoNoteMaintainDuty');
    expect(text).not.toContain('NO DATA');
  });
});
