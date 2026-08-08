/**
 * get_object_info(objectType="form") — formInfo.ts had ZERO coverage.
 *
 * 561 lines with no test, on a path the agent depends on before every form
 * extension: it is how the model learns the EXACT control name to pass as
 * `parent=` / `after=` when adding a control. A wrong name there produces a
 * form extension that writes successfully and does nothing visible, which is
 * the most expensive failure shape this server has.
 *
 * The helpers (extractControls / extractDataSources / extractMethods /
 * searchControlsInHierarchy / the formatters) are module-private, so they are
 * driven through the tool's explicit-`filePath` bypass — the same path the
 * retry guidance tells the agent to use for a form the bridge cannot see yet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// pathContainment guards the explicit filePath against prompt-injection reads of
// arbitrary local files. That behaviour has its own suites; here it would only
// force every fixture path to sit under a real package root.
vi.mock('../../src/utils/pathContainment.js', () => ({
  assertWritePathAllowed: vi.fn(async (p: string) =>
    p.includes('outside-roots') ? { ok: false, reason: 'Refusing to read outside roots' } : { ok: true },
  ),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } };
});

import { promises as fs } from 'fs';
import { getFormInfoTool } from '../../src/tools/readers/formInfo';
import type { XppServerContext } from '../../src/types/context';

const FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyFleetVehicleForm</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>init</Name>
        <Source>public void init()
{
    super();
}</Source>
      </Method>
      <Method>
        <Name>close</Name>
        <Source>public void close()
{
    super();
}</Source>
      </Method>
    </Methods>
  </SourceCode>
  <DataSources>
    <AxFormDataSource>
      <Name>MyVehicleTable</Name>
      <Table>MyVehicleTable</Table>
      <AllowCreate>Yes</AllowCreate>
      <AllowEdit>Yes</AllowEdit>
      <Fields>
        <AxFormDataSourceField>
          <DataField>VehicleId</DataField>
        </AxFormDataSourceField>
        <AxFormDataSourceField>
          <DataField>Description</DataField>
        </AxFormDataSourceField>
      </Fields>
    </AxFormDataSource>
  </DataSources>
  <Design>
    <AxFormDesign>
      <Controls>
        <AxFormControl>
          <Name>MainTab</Name>
          <Type>Tab</Type>
          <Controls>
            <AxFormControl>
              <Name>TabPageGeneral</Name>
              <Type>TabPage</Type>
              <Caption>@SYS12345</Caption>
              <Controls>
                <AxFormControl>
                  <Name>GeneralGroup</Name>
                  <Type>Group</Type>
                  <Controls>
                    <AxFormControl>
                      <Name>VehicleId</Name>
                      <Type>String</Type>
                      <DataSource>MyVehicleTable</DataSource>
                      <DataField>VehicleId</DataField>
                    </AxFormControl>
                  </Controls>
                </AxFormControl>
              </Controls>
            </AxFormControl>
            <AxFormControl>
              <Name>TabPageDetails</Name>
              <Type>TabPage</Type>
            </AxFormControl>
          </Controls>
        </AxFormControl>
      </Controls>
    </AxFormDesign>
  </Design>
</AxForm>`;

const FIXTURE_PATH = 'K:\\AosService\\PackagesLocalDirectory\\MyPkg\\MyModel\\AxForm\\MyFleetVehicleForm.xml';

function ctx(): XppServerContext {
  // The explicit-filePath branch returns before touching the bridge or the index.
  return {} as XppServerContext;
}

function req(args: Record<string, unknown>) {
  return { params: { name: 'get_object_info', arguments: args } } as never;
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe('getFormInfoTool — explicit filePath bypass', () => {
  beforeEach(() => {
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.readFile).mockResolvedValue(FORM_XML as never);
  });

  it('renders datasources, controls and methods from the form XML', async () => {
    const out = textOf(await getFormInfoTool(req({ formName: 'MyFleetVehicleForm', filePath: FIXTURE_PATH }), ctx()));

    expect(out).toContain('MyFleetVehicleForm');
    expect(out).toContain('MyVehicleTable');
    // Datasource field list — what the agent needs to bind a new control.
    expect(out).toContain('VehicleId');
    expect(out).toContain('Description');
    // Methods come from SourceCode/Methods, with the first source line as signature.
    expect(out).toContain('init');
    expect(out).toContain('close');
    // Control hierarchy, nested three deep.
    expect(out).toContain('MainTab');
    expect(out).toContain('TabPageGeneral');
    expect(out).toContain('GeneralGroup');
  });

  it('honours the include* flags independently', async () => {
    const noControls = textOf(await getFormInfoTool(
      req({ formName: 'MyFleetVehicleForm', filePath: FIXTURE_PATH, includeControls: false }), ctx(),
    ));
    expect(noControls).not.toContain('TabPageGeneral');
    expect(noControls).toContain('MyVehicleTable');

    const noDataSources = textOf(await getFormInfoTool(
      req({ formName: 'MyFleetVehicleForm', filePath: FIXTURE_PATH, includeDataSources: false }), ctx(),
    ));
    expect(noDataSources).toContain('TabPageGeneral');

    const noMethods = textOf(await getFormInfoTool(
      req({ formName: 'MyFleetVehicleForm', filePath: FIXTURE_PATH, includeMethods: false }), ctx(),
    ));
    expect(noMethods).toContain('TabPageGeneral');
  });

  it('reports a parse failure instead of pretending the form is empty', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('<NotAForm/>' as never);
    const result = await getFormInfoTool(req({ formName: 'X', filePath: FIXTURE_PATH }), ctx());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid AxForm XML structure');
  });

  it('returns an actionable error when the file cannot be read', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT: no such file') as never);
    const result = await getFormInfoTool(req({ formName: 'X', filePath: FIXTURE_PATH }), ctx());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('ENOENT');
    // The prohibition matters: the observed failure mode is the agent giving up
    // on the tool and shelling out to Get-Content / Select-String.
    expect(textOf(result)).toContain('DO NOT use PowerShell');
  });

  it('refuses a filePath outside the configured package roots', async () => {
    const result = await getFormInfoTool(
      req({ formName: 'X', filePath: 'C:\\outside-roots\\secrets.xml' }), ctx(),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('filePath rejected');
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});

describe('getFormInfoTool — searchControl', () => {
  beforeEach(() => {
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.readFile).mockResolvedValue(FORM_XML as never);
  });

  const search = async (q: string) =>
    textOf(await getFormInfoTool(
      req({ formName: 'MyFleetVehicleForm', filePath: FIXTURE_PATH, searchControl: q }), ctx(),
    ));

  it('matches case-insensitively on a substring', async () => {
    const out = await search('general');
    expect(out).toContain('TabPageGeneral');
    expect(out).toContain('GeneralGroup');
  });

  it('reports the full path and the parent — the two names an extension needs', async () => {
    const out = await search('GeneralGroup');
    expect(out).toContain('MainTab › TabPageGeneral › GeneralGroup');
    expect(out).toContain('Parent: `TabPageGeneral`');
    // Both add-control placements, spelled as the parameters d365fo_file takes.
    expect(out).toContain('parent="GeneralGroup"');
    expect(out).toContain('parent="TabPageGeneral", after="GeneralGroup"');
  });

  it('keeps recursing past a match, so a matching ancestor does not hide descendants', async () => {
    // searchControlsInHierarchy pushes the match AND recurses into its children.
    // Stopping at the first hit would be the easy refactor and would silently
    // drop nested results.
    const out = await search('Tab');
    expect(out).toContain('MainTab');
    expect(out).toContain('TabPageGeneral');
    expect(out).toContain('TabPageDetails');
    expect(out).toContain('Found **3** control(s)');
  });

  it('lists a match\'s immediate children with their datasource binding', async () => {
    const out = await search('GeneralGroup');
    expect(out).toContain('`VehicleId` (String)');
    expect(out).toContain('DS: MyVehicleTable');
    expect(out).toContain('Field: VehicleId');
  });

  it('says so plainly, and points at the browse call, when nothing matches', async () => {
    const out = await search('NoSuchControl');
    expect(out).toContain('No controls found matching "NoSuchControl"');
    expect(out).toContain('without searchControl');
  });
});

describe('getFormInfoTool — older Design/Controls layout', () => {
  it('reads controls when Design has no AxFormDesign wrapper', async () => {
    // extractControls supports both shapes; the older one is what several
    // shipped forms and every hand-written scaffold still use.
    const older = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyFleetVehicleForm</Name>
  <Design>
    <Controls>
      <AxFormControl>
        <Name>MainTab</Name>
        <Type>Tab</Type>
        <Controls>
          <AxFormControl>
            <Name>TabPageGeneral</Name>
            <Type>TabPage</Type>
          </AxFormControl>
        </Controls>
      </AxFormControl>
    </Controls>
  </Design>
</AxForm>`;
    vi.mocked(fs.readFile).mockResolvedValue(older as never);

    const out = textOf(await getFormInfoTool(
      req({ formName: 'MyFleetVehicleForm', filePath: FIXTURE_PATH }), ctx(),
    ));
    expect(out).toContain('MainTab');
    expect(out).toContain('TabPageGeneral');
  });
});
