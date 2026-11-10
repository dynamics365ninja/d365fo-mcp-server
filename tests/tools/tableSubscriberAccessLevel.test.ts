/**
 * AxTable SubscriberAccessLevel ("Subscriber access level" in Visual Studio),
 * issue #1073.
 *
 * Visual Studio writes `<SubscriberAccessLevel><Read>Allow</Read></SubscriberAccessLevel>`
 * on every new regular table. This server wrote none, and the property could not
 * be set at all: it holds child elements, which the scalar property writer cannot
 * express, and it was missing from the AxTable element order, so it was dropped.
 */

import { describe, it, expect, vi } from 'vitest';
import { bridgeSetProperty, tryBridgeTable } from '../../src/bridge/bridgeAdapter';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  parseSubscriberAccessLevel,
  readSubscriberAccessLevel,
  renderSubscriberAccessLevel,
  tableSubscriberAccessLevel,
} from '../../src/utils/subscriberAccessLevel';
import { renderAxTableProperties, upsertAxTableProperty, upsertAxTableSubscriberAccessLevel } from '../../src/utils/axTablePropertyOrder';
import { reconcileTableCreateProperties } from '../../src/tools/xml/createTablePropertyHonesty';
import { buildAxTableXml as generateAxTableXml } from '../../src/tools/xml/tableXml';
import { SmartXmlBuilder } from '../../src/utils/smartXmlBuilder';
import { directXmlModifyProperty } from '../../src/tools/write/directXmlWriters';

const READ_ALLOW = '\t<SubscriberAccessLevel>\n\t\t<Read>Allow</Read>\n\t</SubscriberAccessLevel>\n';

/** An AxTable as the bridge's CreateSmartTable wrote it before this change. */
const bridgeTable = (extra = '') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n' +
  '\t<Name>ConDemoNote</Name>\n' +
  '\t<SourceCode>\n\t\t<Methods />\n\t</SourceCode>\n' +
  '\t<Label>Note</Label>\n' +
  '\t<TableGroup>Main</TableGroup>\n' +
  extra +
  '\t<CacheLookup>Found</CacheLookup>\n' +
  '\t<DeleteActions />\n' +
  '\t<FieldGroups />\n' +
  '\t<Fields>\n' +
  '\t\t<AxTableField xmlns="" i:type="AxTableFieldString">\n\t\t\t<Name>NoteId</Name>\n\t\t</AxTableField>\n' +
  '\t</Fields>\n' +
  '\t<Indexes />\n' +
  '\t<Relations />\n' +
  '</AxTable>';

describe('parseSubscriberAccessLevel', () => {
  it('accepts an object, a permission string and a bare permission list', () => {
    expect(parseSubscriberAccessLevel({ read: 'Allow', create: 'deny' })).toEqual({ ok: true, level: { Read: 'Allow', Create: 'Deny' } });
    expect(parseSubscriberAccessLevel('Read=Allow,Update=Deny')).toEqual({ ok: true, level: { Read: 'Allow', Update: 'Deny' } });
    expect(parseSubscriberAccessLevel('Read, Update')).toEqual({ ok: true, level: { Read: 'Allow', Update: 'Allow' } });
    expect(parseSubscriberAccessLevel({ Read: true, Delete: false })).toEqual({ ok: true, level: { Read: 'Allow', Delete: 'Deny' } });
  });

  it('reads None / Unset as no access level', () => {
    expect(parseSubscriberAccessLevel('None')).toEqual({ ok: true, level: {} });
    expect(parseSubscriberAccessLevel({ read: 'Unset' })).toEqual({ ok: true, level: {} });
  });

  it('rejects an unknown permission or value, naming the legal ones', () => {
    const badKey = parseSubscriberAccessLevel({ write: 'Allow' });
    expect(badKey.ok).toBe(false);
    expect(!badKey.ok && badKey.error).toContain('Correct, Create, Delete, Invoke, Read, Update');
    expect(parseSubscriberAccessLevel({ read: 'Maybe' }).ok).toBe(false);
    expect(parseSubscriberAccessLevel(42).ok).toBe(false);
  });
});

describe('rendering and placement', () => {
  it('writes child elements in the serializer\'s alphabetical order', () => {
    expect(renderSubscriberAccessLevel({ Update: 'Allow', Create: 'Deny', Read: 'Allow' })).toBe(
      '\t<SubscriberAccessLevel>\n\t\t<Create>Deny</Create>\n\t\t<Read>Allow</Read>\n\t\t<Update>Allow</Update>\n\t</SubscriberAccessLevel>',
    );
    expect(renderSubscriberAccessLevel({})).toBe('');
  });

  it('sits after Label and before TableGroup in the property block', () => {
    const xml = renderAxTableProperties({ TableGroup: 'Main', SubscriberAccessLevel: { Read: 'Allow' }, Label: 'Note' });
    expect(xml).toBe(`\t<Label>Note</Label>\n${READ_ALLOW}\t<TableGroup>Main</TableGroup>\n`);
  });

  it('is refused by the scalar upsert, which would write a broken element', () => {
    expect(upsertAxTableProperty(bridgeTable(), 'SubscriberAccessLevel', 'Read=Allow')).toBeNull();
  });

  it('replaces only the table-level element, never one further down', () => {
    const withValue = bridgeTable().replace('\t<TableGroup>', `${READ_ALLOW}\t<TableGroup>`);
    const changed = upsertAxTableSubscriberAccessLevel(withValue, { Read: 'Deny' })!;
    expect(readSubscriberAccessLevel(changed)).toEqual({ Read: 'Deny' });
    expect(changed.match(/<SubscriberAccessLevel>/g)).toHaveLength(1);
    expect(upsertAxTableSubscriberAccessLevel(withValue, {})).toBe(bridgeTable());
  });
});

// Cases from a read-only round trip over 3,670 shipped tables (remove the element,
// write it back): anchoring before the first KNOWN successor misplaced 279.
describe('placement on real table shapes', () => {
  const doc = (body: string, indent = '\t') =>
    `<?xml version="1.0" encoding="utf-8"?>\n<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n${body
      .split('\n')
      .map(l => l.replace(/^\t+/, t => indent.repeat(t.length)))
      .join('\n')}\n</AxTable>`;

  it('goes after its predecessors, ahead of an element the order list does not know', () => {
    const before = doc('\t<Name>ContosoTmp</Name>\n\t<Label>Tmp</Label>\n\t<Visible>No</Visible>\n\t<TableGroup>Main</TableGroup>\n\t<Fields />');
    expect(upsertAxTableSubscriberAccessLevel(before, { Read: 'Allow' })).toBe(
      doc(`\t<Name>ContosoTmp</Name>\n\t<Label>Tmp</Label>\n${READ_ALLOW}\t<Visible>No</Visible>\n\t<TableGroup>Main</TableGroup>\n\t<Fields />`),
    );
  });

  it('never lands inside a field, even with no TableGroup to anchor on', () => {
    // The shape createObject writes: Label, then the collections.
    const before = doc(
      '\t<Name>ContosoNote</Name>\n\t<Label>Note</Label>\n\t<DeleteActions />\n\t<Fields>\n\t\t<AxTableField>\n\t\t\t<Name>NoteId</Name>\n\t\t\t<Visible>No</Visible>\n\t\t</AxTableField>\n\t</Fields>',
    );
    const after = upsertAxTableSubscriberAccessLevel(before, { Read: 'Allow' })!;
    expect(after).toContain(`\t<Label>Note</Label>\n${READ_ALLOW}\t<DeleteActions />`);
    expect(after.match(/SubscriberAccessLevel>/g)).toHaveLength(2);
  });

  it('follows a multi-line SourceCode when nothing later precedes it', () => {
    const before = doc('\t<Name>ContosoNote</Name>\n\t<SourceCode>\n\t\t<Methods />\n\t</SourceCode>\n\t<TableGroup>Main</TableGroup>');
    expect(upsertAxTableSubscriberAccessLevel(before, { Read: 'Allow' })).toContain(
      `\t</SourceCode>\n${READ_ALLOW}\t<TableGroup>Main</TableGroup>`,
    );
  });

  it('keeps a space-indented file\'s indentation, and setting the same level changes nothing', () => {
    const spaced = doc('\t<Name>ContosoNote</Name>\n\t<Label>Note</Label>\n\t<TableGroup>Main</TableGroup>', '  ');
    const set = upsertAxTableSubscriberAccessLevel(spaced, { Read: 'Allow' })!;
    expect(set).toContain('  <Label>Note</Label>\n  <SubscriberAccessLevel>\n    <Read>Allow</Read>\n  </SubscriberAccessLevel>\n  <TableGroup>');
    expect(upsertAxTableSubscriberAccessLevel(set, readSubscriberAccessLevel(set))).toBe(set);
  });
});

// What xppbp expects (src/utils/bpCreateDefaults.ts): Read=Allow on a regular
// table, No Access (every permission denied) on TempDB, InMemory and Staging.
const NO_ACCESS = { Correct: 'Deny', Create: 'Deny', Delete: 'Deny', Invoke: 'Deny', Read: 'Deny', Update: 'Deny' };

describe('new tables get what xppbp expects', () => {
  it('Read=Allow on a regular table, No Access on TempDB/InMemory/Staging, the caller\'s value otherwise', () => {
    expect(tableSubscriberAccessLevel(undefined, undefined)).toEqual({ Read: 'Allow' });
    expect(tableSubscriberAccessLevel(undefined, 'TempDB')).toEqual(NO_ACCESS);
    expect(tableSubscriberAccessLevel(undefined, 'InMemory')).toEqual(NO_ACCESS);
    expect(tableSubscriberAccessLevel(undefined, undefined, 'Staging')).toEqual(NO_ACCESS);
    expect(tableSubscriberAccessLevel({ read: 'Allow', update: 'Allow' }, 'TempDB')).toEqual({ Read: 'Allow', Update: 'Allow' });
    expect(tableSubscriberAccessLevel('None', undefined)).toEqual({});
  });

  it('the XML template writes it', () => {
    const xml = generateAxTableXml('ConDemoNote', { label: 'Note' });
    expect(xml).toContain(READ_ALLOW + '\t<TableGroup>');
    expect(readSubscriberAccessLevel(generateAxTableXml('ConDemoNoteTmp', { tableType: 'TempDB' }))).toEqual(NO_ACCESS);
    expect(generateAxTableXml('ConDemoNote', { subscriberAccessLevel: 'Read=Allow,Create=Deny' })).toContain(
      '\t<SubscriberAccessLevel>\n\t\t<Create>Deny</Create>\n\t\t<Read>Allow</Read>\n\t</SubscriberAccessLevel>',
    );
  });

  it('the smart XML builder writes it', () => {
    const builder = new SmartXmlBuilder();
    const regular = builder.buildTableXml({ name: 'ConDemoNote', label: 'Note', fields: [{ name: 'NoteId', edt: 'Name' }] } as any);
    expect(regular).toContain(READ_ALLOW);
    const temp = builder.buildTableXml({ name: 'ConDemoNoteTmp', tableType: 'TempDB', fields: [{ name: 'NoteId', edt: 'Name' }] } as any);
    expect(readSubscriberAccessLevel(temp)).toEqual(NO_ACCESS);
  });
});

describe('create reconcile — tables a bridge wrote', () => {
  it('adds Read=Allow to a regular table the bridge wrote without it, and lists it as a BP default', () => {
    const r = reconcileTableCreateProperties(bridgeTable(), undefined);
    expect(r.xml).toContain(`${READ_ALLOW}\t<TableGroup>`);
    expect(r.patched).toEqual([]);
    expect(r.unhonoured).toEqual([]);
    expect(r.bpDefaults).toContain('SubscriberAccessLevel=Read=Allow (xppbp expects it because SaveDataPerCompany is Yes)');
  });

  it('gives a TempDB table No Access and leaves an existing non-default value alone', () => {
    const temp = bridgeTable('\t<TableType>TempDB</TableType>\n');
    expect(readSubscriberAccessLevel(reconcileTableCreateProperties(temp, undefined).xml)).toEqual(NO_ACCESS);
    const denied = bridgeTable().replace(
      '\t<TableGroup>',
      '\t<SubscriberAccessLevel>\n\t\t<Read>Deny</Read>\n\t</SubscriberAccessLevel>\n\t<TableGroup>',
    );
    expect(readSubscriberAccessLevel(reconcileTableCreateProperties(denied, { label: 'Note' }).xml)).toEqual({ Read: 'Deny' });
  });

  it('writes a requested value and says so', () => {
    const r = reconcileTableCreateProperties(bridgeTable(), { subscriberAccessLevel: { read: 'Allow', create: 'Deny' } });
    expect(readSubscriberAccessLevel(r.xml)).toEqual({ Read: 'Allow', Create: 'Deny' });
    expect(r.patched).toEqual([{ name: 'subscriberAccessLevel', element: 'SubscriberAccessLevel', value: 'Create=Deny, Read=Allow' }]);
  });

  it('"None" leaves the table without one', () => {
    const r = reconcileTableCreateProperties(bridgeTable(), { subscriberAccessLevel: 'None' });
    expect(r.xml).not.toContain('SubscriberAccessLevel');
  });

  it('reports an invalid value instead of writing it', () => {
    const r = reconcileTableCreateProperties(bridgeTable(), { subscriberAccessLevel: { write: 'Allow' } });
    expect(r.unhonoured[0].name).toBe('subscriberAccessLevel');
    expect(r.unhonoured[0].detail).toContain('Unknown subscriber permission');
    expect(r.xml).not.toContain('SubscriberAccessLevel');
  });
});

describe('modify-property SubscriberAccessLevel (direct XML)', () => {
  const withFile = async (xml: string, fn: (file: string) => Promise<void>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sal-'));
    const file = path.join(dir, 'ConDemoNote.xml');
    writeFileSync(file, xml);
    try { await fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('sets, changes and removes it in canonical position', async () => {
    await withFile(bridgeTable(), async file => {
      const set = await directXmlModifyProperty(file, 'SubscriberAccessLevel', 'Read=Allow', 'test');
      expect(set?.success).toBe(true);
      // Written through normalizeD365Xml, which stores D365 metadata with CRLF.
      expect(readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')).toContain(`\t<Label>Note</Label>\n${READ_ALLOW}\t<TableGroup>`);

      const json = await directXmlModifyProperty(file, 'SubscriberAccessLevel', '{"read":"Allow","update":"Deny"}', 'test');
      expect(json?.success).toBe(true);
      expect(readSubscriberAccessLevel(readFileSync(file, 'utf-8'))).toEqual({ Read: 'Allow', Update: 'Deny' });

      const none = await directXmlModifyProperty(file, 'SubscriberAccessLevel', 'None', 'test');
      expect(none?.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).not.toContain('SubscriberAccessLevel');
    });
  });

  it('refuses an invalid value without writing', async () => {
    await withFile(bridgeTable(), async file => {
      const r = await directXmlModifyProperty(file, 'SubscriberAccessLevel', 'Read=Maybe', 'test');
      expect(r?.success).toBe(false);
      expect(r?.message).toContain('Nothing was written');
      expect(readFileSync(file, 'utf-8')).not.toContain('SubscriberAccessLevel');
    });
  });
});

describe('bridge: read and set', () => {
  it('shows the access level and change tracking of a table the bridge read', async () => {
    const bridge: any = {
      isReady: true,
      metadataAvailable: true,
      readTable: async () => ({
        name: 'ConDemoNote', tableGroup: 'Main', subscriberAccessLevel: 'Read=Allow', allowRowVersionChangeTracking: 'Yes',
        fields: [], indexes: [], relations: [], methods: [],
      }),
    };
    const text = (await tryBridgeTable(bridge, 'ConDemoNote'))!.content[0].text;
    expect(text).toContain('**SubscriberAccessLevel:** Read=Allow');
    expect(text).toContain('**AllowRowVersionChangeTracking:** Yes');
  });

  it('passes a JSON value to setProperty in the text form the bridge reads', async () => {
    const setProperty = vi.fn(async () => ({ success: true, api: 'test' }));
    const bridge: any = { isReady: true, metadataAvailable: true, setProperty };
    await bridgeSetProperty(bridge, 'table', 'ConDemoNote', 'SubscriberAccessLevel', '{"update":"Deny","read":"Allow"}');
    expect(setProperty).toHaveBeenCalledWith('table', 'ConDemoNote', 'SubscriberAccessLevel', 'Read=Allow,Update=Deny');
    await bridgeSetProperty(bridge, 'table', 'ConDemoNote', 'SubscriberAccessLevel', 'none');
    expect(setProperty).toHaveBeenLastCalledWith('table', 'ConDemoNote', 'SubscriberAccessLevel', 'None');
  });

  it('does not send an invalid value to the bridge', async () => {
    const setProperty = vi.fn();
    const bridge: any = { isReady: true, metadataAvailable: true, setProperty };
    expect(await bridgeSetProperty(bridge, 'table', 'ConDemoNote', 'SubscriberAccessLevel', 'Read=Maybe')).toBeNull();
    expect(setProperty).not.toHaveBeenCalled();
  });
});
