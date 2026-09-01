/**
 * `get_object_info(objectType="form")` warns about controls the platform cannot
 * see (issue #985).
 *
 * #979 established the failure: a form whose XML writes `<DataGroup>`/`<DataSource>`
 * above `<Controls>` loses that `<Controls>` element to the metadata deserializer,
 * silently. The scaffold that produced that shape is fixed — but nothing told a
 * reader about a form written by an older build, by hand, or by another tool.
 *
 * The two paths are asymmetric, and the tests below pin both:
 *   XML path    — reads the file, sees all 16 controls, and CAN spot the disagreement.
 *   bridge path — reads through IMetadataProvider, which already dropped them; it
 *                 can only notice by cross-checking the file, and only bothers for
 *                 custom models.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/pathContainment.js', () => ({
  assertWritePathAllowed: vi.fn(async () => ({ ok: true })),
}));

// `vi.mock` factories are hoisted above every top-level binding, so the spies
// they close over have to live in `vi.hoisted`.
const h = vi.hoisted(() => ({
  tryBridgeForm: vi.fn(),
  resolveIndexedObject: vi.fn(),
  isCustomModel: vi.fn(() => true),
}));

vi.mock('../../src/bridge/bridgeAdapter.js', () => ({ tryBridgeForm: h.tryBridgeForm }));
vi.mock('../../src/utils/indexedXmlLookup.js', () => ({
  readIndexedXml: vi.fn(async () => null),
  resolveIndexedObject: h.resolveIndexedObject,
}));
vi.mock('../../src/utils/modelClassifier.js', () => ({ isCustomModel: h.isCustomModel }));

const mockTryBridgeForm = h.tryBridgeForm;
const mockResolveIndexedObject = h.resolveIndexedObject;
const mockIsCustomModel = h.isCustomModel;

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } };
});

import { promises as fs } from 'fs';
import { getFormInfoTool } from '../../src/tools/readers/formInfo';

/** A group control with `n` children; `broken` puts <DataGroup>/<DataSource> above <Controls>. */
const groupForm = (broken: boolean) => `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoProbe</Name>
  <Design>
    <Controls>
      <AxFormControl i:type="AxFormGroupControl">
        <Name>Overview</Name>
        <Type>Group</Type>
${broken ? '        <DataGroup>Overview</DataGroup>\n        <DataSource>ConDemoTable</DataSource>\n' : ''}        <FormControlExtension i:nil="true" />
        <Controls>
          <AxFormControl i:type="AxFormStringControl">
            <Name>Overview_NoteId</Name>
            <Type>String</Type>
            <DataField>NoteId</DataField>
            <DataSource>ConDemoTable</DataSource>
          </AxFormControl>
          <AxFormControl i:type="AxFormStringControl">
            <Name>Overview_Subject</Name>
            <Type>String</Type>
            <DataField>Subject</DataField>
            <DataSource>ConDemoTable</DataSource>
          </AxFormControl>
        </Controls>
${broken ? '' : '        <DataGroup>Overview</DataGroup>\n        <DataSource>ConDemoTable</DataSource>\n'}      </AxFormControl>
    </Controls>
  </Design>
</AxForm>`;

const ctx = () => ({
  symbolIndex: { getReadDb: () => ({}) },
  bridge: { isReady: true, metadataAvailable: true },
} as any);

const readForm = (args: Record<string, unknown>) =>
  getFormInfoTool({ params: { arguments: { formName: 'ConDemoProbe', ...args } } } as any, ctx());

beforeEach(() => {
  vi.clearAllMocks();
  mockTryBridgeForm.mockResolvedValue(null);
  mockResolveIndexedObject.mockResolvedValue(null);
  mockIsCustomModel.mockReturnValue(true);
});

describe('XML path — the reader holds the evidence', () => {
  it('warns, and names the misplaced element, for the #979 shape', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(groupForm(true) as never);
    const res: any = await readForm({ filePath: 'K:/pkg/fm-mcp/fm-mcp/AxForm/ConDemoProbe.xml' });
    const text = res.content[0].text as string;

    expect(text).toMatch(/written out of order/);
    expect(text).toMatch(/<Controls> is written after <DataSource>, but must come BEFORE it/);
    expect(text).toMatch(/Overview/);
    // It must point at the fix, not just at the problem.
    expect(text).toMatch(/formControlElementOrder\.generated/);
    // The warning comes FIRST — an agent that stops reading still sees it.
    expect(text.indexOf('out of order')).toBeLessThan(text.indexOf('# Form:'));
  });

  it('says nothing for a well-ordered form', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(groupForm(false) as never);
    const res: any = await readForm({ filePath: 'K:/pkg/fm-mcp/fm-mcp/AxForm/ConDemoProbe.xml' });
    expect(res.content[0].text).not.toMatch(/out of order/);
  });

  it('warns on the searchControl branch too — that name is about to be written against', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(groupForm(true) as never);
    const res: any = await readForm({
      filePath: 'K:/pkg/fm-mcp/fm-mcp/AxForm/ConDemoProbe.xml',
      searchControl: 'Overview',
    });
    expect(res.content[0].text).toMatch(/written out of order/);
  });
});

describe('bridge path — cross-checked against the file', () => {
  const bridgeAnswer = (controls: number) => ({
    content: [{
      type: 'text',
      text: `# Form: ConDemoProbe\n\n## 📈 Summary\nData Sources: 1 | Controls: ${controls} | Methods: 0\n`,
    }],
  });

  it('reports the disagreement between the file and the provider', async () => {
    mockTryBridgeForm.mockResolvedValue(bridgeAnswer(1)); // the group, minus its two children
    mockResolveIndexedObject.mockResolvedValue({
      name: 'ConDemoProbe', model: 'fm-mcp', localPath: 'K:/pkg/ConDemoProbe.xml',
      indexedPath: 'K:/pkg/ConDemoProbe.xml', sourceFileMissing: false,
    });
    vi.mocked(fs.readFile).mockResolvedValue(groupForm(true) as never);

    const res: any = await readForm({});
    const text = res.content[0].text as string;
    expect(text).toMatch(/holds 3 controls; the metadata provider reports 1/);
    expect(text).toMatch(/invisible to the platform/);
    expect(text).toMatch(/<Controls> is written after <DataSource>, but must come BEFORE it/);
  });

  it('stays quiet when the two agree', async () => {
    mockTryBridgeForm.mockResolvedValue(bridgeAnswer(3));
    mockResolveIndexedObject.mockResolvedValue({
      name: 'ConDemoProbe', model: 'fm-mcp', localPath: 'K:/pkg/ConDemoProbe.xml',
      indexedPath: 'K:/pkg/ConDemoProbe.xml', sourceFileMissing: false,
    });
    vi.mocked(fs.readFile).mockResolvedValue(groupForm(false) as never);

    const res: any = await readForm({});
    expect(res.content[0].text).not.toMatch(/invisible to the platform/);
  });

  it('does not read Microsoft form XML off disk for a warning that cannot apply', async () => {
    mockTryBridgeForm.mockResolvedValue(bridgeAnswer(600));
    mockResolveIndexedObject.mockResolvedValue({
      name: 'SalesTable', model: 'ApplicationSuite', localPath: 'K:/pkg/SalesTable.xml',
      indexedPath: 'K:/pkg/SalesTable.xml', sourceFileMissing: false,
    });
    mockIsCustomModel.mockReturnValue(false);

    const res: any = await readForm({});
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(res.content[0].text).not.toMatch(/invisible to the platform/);
  });

  it('lets the bridge answer stand when the cross-check cannot run', async () => {
    mockTryBridgeForm.mockResolvedValue(bridgeAnswer(1));
    mockResolveIndexedObject.mockRejectedValue(new Error('index unavailable'));

    const res: any = await readForm({});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/# Form: ConDemoProbe/);
    expect(res.content[0].text).not.toMatch(/invisible to the platform/);
  });
});
