/**
 * get_object_info(form) on a host with only the database: no AOT file, no bridge.
 *
 * The form reader and the include="xml" path both answer from the copy the index
 * stored (form_source), label it as a stored copy, and still answer "not found" when
 * there is no copy — and never from another model's copy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

// A remap onto a configured packages root would make the file "reachable" on a dev box.
vi.mock('../../src/utils/metadataResolver', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/metadataResolver')>()),
  resolveDbPathLocally: async () => null,
  remapDbPathLocally: async () => null,
}));

// The configured model's folder is probed first; keep the test off the developer's config.
vi.mock('../../src/utils/objectFileLookup', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/objectFileLookup')>()),
  findD365FileOnDisk: async () => null,
}));

import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { getFormInfoTool } from '../../src/tools/readers/formInfo';
import { readObjectXml } from '../../src/tools/readers/objectXml';

const AGENT_PATH = '/home/vsts/work/1/s/PackagesLocalDirectory/Pkg/Model/AxForm/DbOnlyDemoForm.xml';
const STORED_AT = '2026-10-01T10:00:00.000Z';
const XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="AxForm">
\t<Name>DbOnlyDemoForm</Name>
\t<SourceCode>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>classDeclaration</Name>
\t\t\t\t<Source><![CDATA[public class FormRun extends FormRun {}]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
\t<DataSources>
\t\t<AxFormDataSource xmlns="">
\t\t\t<Name>DemoTable</Name>
\t\t\t<Table>DemoTable</Table>
\t\t</AxFormDataSource>
\t</DataSources>
\t<Design>
\t\t<Caption>Demo</Caption>
\t\t<Controls />
\t</Design>
</AxForm>`;

let index: XppSymbolIndex;

beforeEach(() => {
  index = new XppSymbolIndex(':memory:', ':memory:');
  index.addSymbol({ name: 'DbOnlyDemoForm', type: 'form', filePath: AGENT_PATH, model: 'Model' } as any);
});
afterEach(() => index.close());

const store = (model = 'Model', xml = XML) =>
  index.db.prepare('INSERT OR REPLACE INTO form_source (form_name, model, xml_gz, indexed_at) VALUES (?, ?, ?, ?)')
    .run('DbOnlyDemoForm', model, gzipSync(Buffer.from(xml)), STORED_AT);

const formInfo = async (args: Record<string, unknown> = {}) =>
  await getFormInfoTool(
    { method: 'tools/call', params: { name: 'get_object_info', arguments: { formName: 'DbOnlyDemoForm', ...args } } } as any,
    { symbolIndex: index } as any,
  );

describe('get_object_info(form) from the stored copy', () => {
  it('renders the form and labels it a stored copy with its write time', async () => {
    store();

    const res: any = await formInfo();
    const text = res.content[0].text as string;

    expect(res.isError).toBeFalsy();
    expect(text).toContain('DbOnlyDemoForm');
    expect(text).toContain('DemoTable');
    expect(text).toContain("the index's stored copy");
    expect(text).toContain(STORED_AT);
  });

  it('without a stored copy it is an error, not a render', async () => {
    const res: any = await formInfo();
    expect(res.isError).toBe(true);
  });
});

describe('include="xml" from the stored copy', () => {
  it('returns the whole stored XML under a stored-copy header, not a file path', async () => {
    store();

    const res = await readObjectXml('form', 'DbOnlyDemoForm', { index });

    expect(res.isError).toBe(false);
    expect(res.text).toContain('stored copy in the index');
    expect(res.text).toContain(STORED_AT);
    expect(res.text).toContain('<Name>DbOnlyDemoForm</Name>');
    expect(res.text).toContain('public class FormRun extends FormRun {}');
    expect(res.text).not.toContain('**File:**');
    expect(res.text).not.toContain('index row is stale');
  });

  it('still pages: a line range returns only those lines', async () => {
    store();
    const res = await readObjectXml('form', 'DbOnlyDemoForm', { index, startLine: 3, endLine: 3 });
    expect(res.text).toContain('**Lines:** 3-3');
    expect(res.text).toContain('<Name>DbOnlyDemoForm</Name>');
    expect(res.text).not.toContain('<Design>');
  });

  it('honours options.modelName: another model\'s copy is not served', async () => {
    store('Model');
    const res = await readObjectXml('form', 'DbOnlyDemoForm', { index, modelName: 'SomeOtherModel' });
    expect(res.isError).toBe(true);
  });

  it('accepts the model when it matches in another case', async () => {
    store('Model');
    const res = await readObjectXml('form', 'DbOnlyDemoForm', { index, modelName: 'MODEL' });
    expect(res.isError).toBe(false);
  });

  it('is not found when no copy was stored', async () => {
    const res = await readObjectXml('form', 'DbOnlyDemoForm', { index });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no file on disk');
  });

  it('does not use form_source for any other object type', async () => {
    store();
    index.addSymbol({ name: 'DbOnlyDemoForm', type: 'class', filePath: AGENT_PATH.replace('AxForm', 'AxClass'), model: 'Model' } as any);
    const res = await readObjectXml('class', 'DbOnlyDemoForm', { index });
    expect(res.isError).toBe(true);
  });
});
