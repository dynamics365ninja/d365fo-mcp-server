/**
 * modify-property with propertyValue="" means "back to the default". The bridge's
 * SetProperty writes `<PrimaryIndex></PrimaryIndex>` for that — an element no shipped
 * table carries (absence is the default: a table without <PrimaryIndex> has the
 * surrogate-key primary index, which is what every date-effective table uses).
 * Phase F (L2-date-effective-table) hit this on the VM; `directXmlClearEmptyProperty`
 * is the post-write that drops the empty element again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { directXmlClearEmptyProperty } from '../../src/tools/write/directXmlWriters';

const XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>ConDemoWorkerBonusRate</Name>
\t<Label>@SYS32359</Label>
\t<TableGroup>Main</TableGroup>
\t<ClusteredIndex>BonusRateIdx</ClusteredIndex>
\t<PrimaryIndex></PrimaryIndex>
\t<ReplacementKey>BonusRateIdx</ReplacementKey>
\t<ValidTimeStateFieldType>Date</ValidTimeStateFieldType>
\t<DeleteActions />
\t<FieldGroups />
\t<Fields />
\t<FullTextIndexes />
\t<Indexes />
\t<Mappings />
\t<Relations />
\t<StateMachines />
</AxTable>
`;

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clear-prop-'));
  file = path.join(dir, 'ConDemoWorkerBonusRate.xml');
  await fs.writeFile(file, XML, 'utf-8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('directXmlClearEmptyProperty', () => {
  it('removes an empty <PrimaryIndex></PrimaryIndex> line and nothing else', async () => {
    const r = await directXmlClearEmptyProperty(file, 'PrimaryIndex');
    expect(r?.success).toBe(true);
    const after = (await fs.readFile(file, 'utf-8')).replace(/\r\n/g, '\n');
    expect(after).not.toContain('<PrimaryIndex');
    expect(after).toContain('\t<ClusteredIndex>BonusRateIdx</ClusteredIndex>\n\t<ReplacementKey>BonusRateIdx</ReplacementKey>');
    expect(after).toContain('<ValidTimeStateFieldType>Date</ValidTimeStateFieldType>');
  });

  it('leaves a populated property alone and reports nothing', async () => {
    const r = await directXmlClearEmptyProperty(file, 'ReplacementKey');
    expect(r).toBeNull();
    expect((await fs.readFile(file, 'utf-8')).replace(/\r\n/g, '\n')).toBe(XML);
  });

  it('does not touch empty COLLECTION elements written as self-closing tags of a different name', async () => {
    const r = await directXmlClearEmptyProperty(file, 'PrimaryIndex');
    expect(r?.success).toBe(true);
    const after = await fs.readFile(file, 'utf-8');
    expect(after).toContain('<DeleteActions />');
    expect(after).toContain('<Indexes />');
  });

  it('refuses a property name that is not a bare element name', async () => {
    expect(await directXmlClearEmptyProperty(file, 'Indexes/BonusRateIdx')).toBeNull();
    expect((await fs.readFile(file, 'utf-8')).replace(/\r\n/g, '\n')).toBe(XML);
  });
});
