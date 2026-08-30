/**
 * Valid-time-state key index properties — the gap Phase F (L2-date-effective-table)
 * hit on the VM: `d365fo_file(modify, add-index)` had no way to stamp
 * `<ValidTimeStateKey>` / `<ValidTimeStateMode>` (the C# bridge's AddIndex knows
 * only allowDuplicates/alternateKey and its SetAxTableProperty rejects
 * "BonusRateIdx.ValidTimeStateKey" as an unknown table property), so a
 * date-effective table could be created but never completed through the tool path.
 *
 * `directXmlSetIndexValidTimeState` is the on-disk post-write both `add-index` and
 * `create(properties.indexes[])` now run. These tests pin its element placement
 * (before <Fields>, after the alphabetical simple properties — the SDK order seen in
 * PersonnelCore/AxTable/HcmPositionDetail.xml), its idempotency and its refusals.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { directXmlSetIndexValidTimeState } from '../../src/tools/write/directXmlWriters';

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoWorkerBonusRate</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ConDemoWorkerBonusRate extends common
{
}
]]></Declaration>
\t\t<Methods />
\t</SourceCode>
\t<Label>@SYS32359</Label>
\t<TableGroup>Main</TableGroup>
\t<ValidTimeStateFieldType>Date</ValidTimeStateFieldType>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields>
\t\t<AxTableField xmlns="" i:type="AxTableFieldString">
\t\t\t<Name>WorkerId</Name>
\t\t\t<ExtendedDataType>Num</ExtendedDataType>
\t\t</AxTableField>
\t</Fields>
\t<FullTextIndexes />
\t<Indexes>
\t\t<AxTableIndex>
\t\t\t<Name>BonusRateIdx</Name>
\t\t\t<AlternateKey>Yes</AlternateKey>
\t\t\t<Fields>
\t\t\t\t<AxTableIndexField>
\t\t\t\t\t<DataField>WorkerId</DataField>
\t\t\t\t</AxTableIndexField>
\t\t\t\t<AxTableIndexField>
\t\t\t\t\t<DataField>ValidFrom</DataField>
\t\t\t\t</AxTableIndexField>
\t\t\t</Fields>
\t\t</AxTableIndex>
\t\t<AxTableIndex>
\t\t\t<Name>WorkerIdx</Name>
\t\t\t<AllowDuplicates>Yes</AllowDuplicates>
\t\t\t<Fields>
\t\t\t\t<AxTableIndexField>
\t\t\t\t\t<DataField>WorkerId</DataField>
\t\t\t\t</AxTableIndexField>
\t\t\t</Fields>
\t\t</AxTableIndex>
\t</Indexes>
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>
`;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vts-index-'));
  file = path.join(dir, 'ConDemoWorkerBonusRate.xml');
  await fs.writeFile(file, TABLE_XML, 'utf-8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function indexBlock(name: string): Promise<string> {
  const content = (await fs.readFile(file, 'utf-8')).replace(/\r\n/g, '\n');
  const m = content.match(new RegExp(`<AxTableIndex>\\s*<Name>${name}</Name>[\\s\\S]*?</AxTableIndex>`));
  if (!m) throw new Error(`index ${name} missing`);
  return m[0];
}

describe('directXmlSetIndexValidTimeState', () => {
  it('writes ValidTimeStateKey + ValidTimeStateMode after AlternateKey and before <Fields>, touching only that index', async () => {
    const r = await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', true, 'Gap');
    expect(r?.success).toBe(true);
    expect(r?.message).toContain('ValidTimeStateKey=Yes');
    expect(r?.message).toContain('ValidTimeStateMode=Gap');

    const block = await indexBlock('BonusRateIdx');
    const order = ['<Name>BonusRateIdx</Name>', '<AlternateKey>Yes</AlternateKey>', '<ValidTimeStateKey>Yes</ValidTimeStateKey>', '<ValidTimeStateMode>Gap</ValidTimeStateMode>', '<Fields>']
      .map(tag => block.indexOf(tag));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // The sibling index is untouched.
    const other = await indexBlock('WorkerIdx');
    expect(other).not.toContain('ValidTimeState');
    // The DataFields inside the target index survive intact.
    expect(block).toContain('<DataField>ValidFrom</DataField>');
  });

  it('is idempotent and rewrites an existing value instead of duplicating the element', async () => {
    await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', true, 'Gap');
    const again = await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', true, 'Gap');
    expect(again?.success).toBe(true);
    expect(again?.message).toMatch(/idempotent/);

    // NoGap is the SDK default (the serializer omits it; shipped indexes only ever
    // spell out Gap) — switching back to it REMOVES the element rather than writing it.
    const changed = await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', true, 'NoGap');
    expect(changed?.success).toBe(true);
    expect(changed?.message).toMatch(/NoGap \(the SDK default/);
    const block = await indexBlock('BonusRateIdx');
    expect((block.match(/<ValidTimeStateKey>/g) ?? []).length).toBe(1);
    expect(block).not.toContain('<ValidTimeStateMode>');
  });

  it('writes the key flag alone when no mode is given', async () => {
    const r = await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', true, undefined);
    expect(r?.success).toBe(true);
    const block = await indexBlock('BonusRateIdx');
    expect(block).toContain('<ValidTimeStateKey>Yes</ValidTimeStateKey>');
    expect(block).not.toContain('<ValidTimeStateMode>');
  });

  it('is a no-op when neither property is requested', async () => {
    const r = await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', undefined, undefined);
    expect(r).toBeNull();
    expect(await fs.readFile(file, 'utf-8')).toBe(TABLE_XML);
  });

  it('refuses an unknown mode and a missing index without writing', async () => {
    const badMode = await directXmlSetIndexValidTimeState(file, 'BonusRateIdx', true, 'Sometimes');
    expect(badMode?.success).toBe(false);
    expect(badMode?.message).toMatch(/"Gap" or "NoGap"/);

    const missing = await directXmlSetIndexValidTimeState(file, 'NoSuchIdx', true, 'NoGap');
    expect(missing?.success).toBe(false);
    expect(missing?.message).toMatch(/not found/);

    expect(await fs.readFile(file, 'utf-8')).toBe(TABLE_XML);
  });
});
