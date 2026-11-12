/**
 * Generated form data sources write their properties in the platform's element order.
 *
 * The order inside <AxFormDataSource> was measured on Microsoft standard forms
 * (13,234 data sources, no pair of elements in both orders). It is not alphabetical,
 * and the metadata deserializer drops an element it meets out of order, without a
 * word. The ListPage and Workspace templates and SmartXmlBuilder wrote AllowCreate,
 * AllowEdit, AllowDelete. The platform's order is AllowCreate, AllowDelete, AllowEdit.
 */

import { describe, it, expect } from 'vitest';
import { FormPatternTemplates, type FormPattern } from '../../src/utils/formPatternTemplates';
import { SmartXmlBuilder } from '../../src/utils/smartXmlBuilder';

/** The measured order of the children of an AxFormDataSource. */
const PLATFORM_ORDER = [
  'Name', 'Table', 'Fields', 'ReferencedDataSources', 'AutoNotify', 'AutoQuery', 'AutoSearch',
  'CrossCompanyAutoQuery', 'DelayActive', 'JoinSource', 'LinkType', 'OnlyFetchActive', 'AllowCheck',
  'AllowCreate', 'AllowDelete', 'AllowEdit', 'Index', 'InsertAtEnd', 'InsertIfEmpty', 'MaxAccessRight',
  'StartPosition', 'DataSourceLinks', 'DerivedDataSources',
];

/** Direct children of every <AxFormDataSource> in `xml`, one list per data source. */
function dataSourceChildren(xml: string): string[][] {
  const out: string[][] = [];
  const re = /^([\t ]*)<AxFormDataSource xmlns="">\r?\n([\s\S]*?)^\1<\/AxFormDataSource>/gm;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const child = new RegExp(`^${m[1]}\\t<([A-Za-z]\\w*)`, 'gm');
    out.push([...m[2].matchAll(child)].map(c => c[1]));
  }
  return out;
}

const inPlatformOrder = (children: string[]): boolean => {
  const ranks = children.map(c => PLATFORM_ORDER.indexOf(c));
  return ranks.every((r, i) => r >= 0 && (i === 0 || r > ranks[i - 1]));
};

describe('form data source element order in generated forms', () => {
  const ALL: FormPattern[] = [
    'SimpleList', 'SimpleListDetails', 'DetailsMaster', 'DetailsTransaction',
    'Dialog', 'TableOfContents', 'Lookup', 'ListPage', 'Workspace',
  ];

  it.each(ALL)('%s: every data source follows the platform order', (pattern) => {
    const xml = FormPatternTemplates.build(pattern, {
      formName: 'ContosoRentForm',
      dsName: 'ContosoRentHeader',
      dsTable: 'ContosoRentHeader',
      caption: '@SYS1',
      gridFields: ['RentId', 'Description'],
      linesDsName: 'ContosoRentLine',
      linesDsTable: 'ContosoRentLine',
      linesFields: ['LineNum'],
      titleField: 'RentId',
    });
    const sources = dataSourceChildren(xml);
    expect(sources.length).toBeGreaterThan(0);
    for (const children of sources) {
      expect(inPlatformOrder(children), children.join(' ')).toBe(true);
    }
  });

  it.each(['ListPage', 'Workspace'] as FormPattern[])(
    '%s: the read-only data source writes AllowCreate, AllowDelete, AllowEdit',
    (pattern) => {
      const xml = FormPatternTemplates.build(pattern, {
        formName: 'ContosoRentForm', dsName: 'ContosoRentHeader', dsTable: 'ContosoRentHeader',
        caption: '@SYS1', gridFields: ['RentId'],
      });
      expect(xml).toContain(
        '\t\t\t<ReferencedDataSources />\n\t\t\t<AllowCreate>No</AllowCreate>\n\t\t\t<AllowDelete>No</AllowDelete>\n' +
          '\t\t\t<AllowEdit>No</AllowEdit>\n\t\t\t<InsertIfEmpty>No</InsertIfEmpty>\n\t\t\t<DataSourceLinks />');
    },
  );

  it('SmartXmlBuilder.buildFormDataSource writes AllowCreate, AllowDelete, AllowEdit', () => {
    const xml = new SmartXmlBuilder().buildFormDataSource({
      name: 'ContosoRentHeader', table: 'ContosoRentHeader',
      allowEdit: false, allowCreate: false, allowDelete: false,
    });
    expect(dataSourceChildren(xml)).toEqual([[
      'Name', 'Table', 'Fields', 'ReferencedDataSources', 'AllowCreate', 'AllowDelete', 'AllowEdit',
      'DataSourceLinks', 'DerivedDataSources',
    ]]);
  });

  it('the order check itself rejects the old order', () => {
    expect(inPlatformOrder(['Name', 'Table', 'AllowCreate', 'AllowEdit', 'AllowDelete'])).toBe(false);
    expect(inPlatformOrder(['Name', 'Table', 'Fields', 'Index', 'ReferencedDataSources'])).toBe(false);
  });
});
