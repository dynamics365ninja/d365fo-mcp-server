/**
 * A new Display menu item on a form whose data sources are all Local (TempDB)
 * tables gets OperationalDomain Local and SubscriberAccessLevel No Access, as xppbp
 * expects ("…because the OperationalDomain property on all data sources is Local").
 * Any other form keeps Shared + Read, and an unreadable form or table keeps them too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { objects } = vi.hoisted(() => ({ objects: new Map<string, string>() }));

vi.mock('../../src/utils/indexedXmlLookup', async orig => ({
  ...(await orig<typeof import('../../src/utils/indexedXmlLookup')>()),
  readIndexedXml: vi.fn(async (_db: unknown, name: string, types: string[]) => {
    const xml = objects.get(`${types[0]}:${name}`);
    return xml ? { ref: { name }, xml, source: 'file' } : null;
  }),
}));

import {
  formDataSourceTables,
  formDataSourcesAllLocal,
  menuItemFormAllLocal,
  tableOperationalDomain,
} from '../../src/tools/xml/formDataSourceDomain';
import { applyMenuItemBpDefaults, renderMenuItemBpNote } from '../../src/tools/xml/menuItemBpDefaults';
import { expectedMenuItemBpDefaults, NO_ACCESS, READ_ACCESS } from '../../src/utils/bpCreateDefaults';

const FORM = (...tables: string[]) =>
  '<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n' +
  '\t<Name>ContosoClaimMatchDialog</Name>\n\t<DataSources>\n' +
  tables
    .map(t => `\t\t<AxFormDataSource xmlns="">\n\t\t\t<Name>${t}</Name>\n\t\t\t<Table>${t}</Table>\n\t\t\t<Fields>\n\t\t\t\t<AxFormDataSourceField>\n\t\t\t\t\t<DataField>RecId</DataField>\n\t\t\t\t</AxFormDataSourceField>\n\t\t\t</Fields>\n\t\t</AxFormDataSource>\n`)
    .join('') +
  '\t</DataSources>\n</AxForm>';

const TABLE = (props: string) =>
  `<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n\t<Name>T</Name>\n${props}\t<Fields />\n</AxTable>`;

const MENU = (objectType: string, object = 'ContosoClaimMatchDialog') =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<AxMenuItemDisplay xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V1">\n' +
  '\t<Name>ContosoClaimMatchDialog</Name>\n' +
  '\t<Label>@ContosoExt:ClaimMatch</Label>\n' +
  `\t<Object>${object}</Object>\n` +
  (objectType ? `\t<ObjectType>${objectType}</ObjectType>\n` : '') +
  '</AxMenuItemDisplay>';

beforeEach(() => {
  objects.clear();
  objects.set('table:ContosoClaimTmp', TABLE('\t<TableType>TempDB</TableType>\n'));
  objects.set('table:ContosoMatchTmp', TABLE('\t<OperationalDomain>Local</OperationalDomain>\n'));
  objects.set('table:ContosoClaim', TABLE('\t<TableGroup>Main</TableGroup>\n'));
});

describe('reading the form', () => {
  it('lists the tables of its data sources, once each', () => {
    expect(formDataSourceTables(FORM('ContosoClaimTmp', 'ContosoMatchTmp', 'ContosoClaimTmp'))).toEqual(['ContosoClaimTmp', 'ContosoMatchTmp']);
  });

  it("takes a table's own OperationalDomain, else the BP rule's", () => {
    expect(tableOperationalDomain(TABLE('\t<OperationalDomain>Shared</OperationalDomain>\n\t<TableType>TempDB</TableType>\n'))).toBe('Shared');
    expect(tableOperationalDomain(TABLE('\t<TableType>InMemory</TableType>\n'))).toBe('Local');
    expect(tableOperationalDomain(TABLE('\t<SaveDataPerCompany>No</SaveDataPerCompany>\n'))).toBe('Shared');
    expect(tableOperationalDomain(TABLE(''))).toBe('Company');
  });

  it('is true only when every data source is Local, undefined when something cannot be read', async () => {
    objects.set('form:Local', FORM('ContosoClaimTmp', 'ContosoMatchTmp'));
    objects.set('form:Mixed', FORM('ContosoClaimTmp', 'ContosoClaim'));
    objects.set('form:Unknown', FORM('ContosoClaimTmp', 'ContosoMissing'));
    objects.set('form:Empty', FORM());
    const db = {};
    expect(await formDataSourcesAllLocal('Local', db)).toBe(true);
    expect(await formDataSourcesAllLocal('Mixed', db)).toBe(false);
    expect(await formDataSourcesAllLocal('Unknown', db)).toBeUndefined();
    expect(await formDataSourcesAllLocal('Empty', db)).toBeUndefined();
    expect(await formDataSourcesAllLocal('NoSuchForm', db)).toBeUndefined();
    expect(await formDataSourcesAllLocal('Local', undefined)).toBeUndefined();
  });

  it('applies to Display items on a form only (ObjectType absent means Form)', async () => {
    objects.set('form:ContosoClaimMatchDialog', FORM('ContosoClaimTmp'));
    expect(await menuItemFormAllLocal(MENU('Form'), {})).toBe(true);
    expect(await menuItemFormAllLocal(MENU(''), {})).toBe(true);
    expect(await menuItemFormAllLocal(MENU('Class'), {})).toBeUndefined();
    expect(await menuItemFormAllLocal(MENU('Form').replace(/AxMenuItemDisplay/g, 'AxMenuItemAction'), {})).toBeUndefined();
  });
});

describe('the defaults a new Display menu item gets', () => {
  it('Local + No Access on a form whose data sources are all Local', () => {
    const d = expectedMenuItemBpDefaults('Display', 'Form', { allDataSourcesLocal: true });
    expect(d).toMatchObject({ operationalDomain: 'Local', subscriberAccessLevel: NO_ACCESS });
    expect(expectedMenuItemBpDefaults('Display', 'Form', { allDataSourcesLocal: false })).toMatchObject({
      operationalDomain: 'Shared', subscriberAccessLevel: READ_ACCESS,
    });
    expect(expectedMenuItemBpDefaults('Display', 'Form')).toMatchObject({ operationalDomain: 'Shared' });
  });

  it('writes them, and the note says xppbp expects both', () => {
    const r = applyMenuItemBpDefaults(MENU('Form'), undefined, { allDataSourcesLocal: true });
    expect(r.xml).toContain('\t<OperationalDomain>Local</OperationalDomain>\n');
    expect(r.xml).toContain('<Read xmlns="">Deny</Read>');
    expect(r.xml.match(/>Deny</g)).toHaveLength(6);
    const note = renderMenuItemBpNote(r);
    expect(note).toContain('xppbp expects this SubscriberAccessLevel because the OperationalDomain property on all data sources of the form is Local');
    expect(note).toContain('xppbp expects this OperationalDomain because');
    expect(note).not.toContain('names no value');
  });

  it('a caller value still wins', () => {
    const r = applyMenuItemBpDefaults(MENU('Form'), { subscriberAccessLevel: 'Read' }, { allDataSourcesLocal: true });
    expect(r.xml).toContain('<Read xmlns="">Allow</Read>');
    expect(r.xml).toContain('<OperationalDomain>Local</OperationalDomain>');
  });
});
