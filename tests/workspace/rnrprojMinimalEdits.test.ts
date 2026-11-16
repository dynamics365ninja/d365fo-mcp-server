/**
 * Adding or removing one object changes only that object's lines in the .rnrproj.
 *
 * The project used to be parsed with xml2js and written back whole with the
 * Builder. #1197 restored the BOM and CRLF, but everything else was serialised
 * again: `<TargetFrameworkProfile />` lost its space, so did every
 * `<Folder Include="…" />`, and a multi-line value came back with `&#xD;`
 * entities. A pull request that added one object showed the whole project file
 * as changed. These tests hold the file to byte-for-byte equality outside the
 * inserted or removed item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectFileManager } from '../../src/workspace/projectFile';
import { _clearCreatedArtifactLedger } from '../../src/workspace/createdArtifactLedger';
import { insertProjectItem, removeProjectItems } from '../../src/workspace/rnrprojText';

const fileStore = new Map<string, string>();

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const content = fileStore.get(p);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  }),
  writeFile: vi.fn(async (p: string, data: string) => {
    fileStore.set(p, data);
  }),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: 100 })),
  mkdir: vi.fn(async () => {}),
}));

beforeEach(() => {
  fileStore.clear();
  _clearCreatedArtifactLedger();
});

const PROJECT = 'K:\\Test\\ContosoExt.rnrproj';

/** As Visual Studio writes a project: BOM, CRLF, self-closing tags with a space. */
const VS_PROJECT_LF =
`<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">AnyCPU</Platform>
    <Model>ContosoExt</Model>
    <TargetFrameworkVersion>v4.6</TargetFrameworkVersion>
    <TargetFrameworkProfile />
    <Company>Contoso Ltd.
Second line of the company value</Company>
    <OutputPath>bin</OutputPath>
  </PropertyGroup>
  <ItemGroup>
    <Folder Include="Classes\\" />
    <Folder Include="Tables\\" />
  </ItemGroup>
  <ItemGroup>
    <Content Include="AxClass\\ContosoAlpha">
      <SubType>Content</SubType>
      <Name>ContosoAlpha</Name>
      <Link>Classes\\ContosoAlpha</Link>
    </Content>
    <Content Include="AxClass\\ContosoCharlie">
      <SubType>Content</SubType>
      <Name>ContosoCharlie</Name>
      <Link>Classes\\ContosoCharlie</Link>
    </Content>
    <Content Include="AxTable\\ContosoTable">
      <SubType>Content</SubType>
      <Name>ContosoTable</Name>
      <Link>Tables\\ContosoTable</Link>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Dynamics365\\Microsoft.Dynamics.Framework.Tools.BuildTasks.Xpp.targets" />
</Project>
`;
const VS_PROJECT = '\uFEFF' + VS_PROJECT_LF.replace(/\n/g, '\r\n');

/**
 * The lines of `after` that are not in `before`, after checking that every line
 * of `before` is still there, in order. A minimal line diff for insert-only edits.
 */
function insertedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const inserted: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && line === a[i]) i++;
    else inserted.push(line);
  }
  expect(i).toBe(a.length); // nothing of the original lost or changed
  return inserted;
}

describe('rnrproj edits keep the rest of the file byte for byte', () => {
  it('adding one object inserts only its Content block, in sorted position', async () => {
    fileStore.set(PROJECT, VS_PROJECT);

    const added = await new ProjectFileManager().addToProject(PROJECT, 'class', 'ContosoBravo', '');

    expect(added).toBe(true);
    const after = fileStore.get(PROJECT)!;
    expect(insertedLines(VS_PROJECT, after)).toEqual([
      '    <Content Include="AxClass\\ContosoBravo">\r',
      '      <SubType>Content</SubType>\r',
      '      <Name>ContosoBravo</Name>\r',
      '      <Link>Classes\\ContosoBravo</Link>\r',
      '    </Content>\r',
    ]);
    // MSBuild's AddItem orders by Include: Bravo lands between Alpha and Charlie.
    expect(after.indexOf('ContosoAlpha')).toBeLessThan(after.indexOf('ContosoBravo'));
    expect(after.indexOf('ContosoBravo')).toBeLessThan(after.indexOf('ContosoCharlie'));
  });

  it('keeps the BOM, CRLF, `<TargetFrameworkProfile />` and the multi-line value', async () => {
    fileStore.set(PROJECT, VS_PROJECT);

    await new ProjectFileManager().addToProject(PROJECT, 'class', 'ContosoBravo', '');

    const after = fileStore.get(PROJECT)!;
    expect(after.startsWith('\uFEFF<?xml')).toBe(true);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after).toContain('<TargetFrameworkProfile />');
    expect(after).toContain('<Folder Include="Classes\\" />');
    expect(after).toContain('<Company>Contoso Ltd.\r\nSecond line of the company value</Company>');
    expect(after).not.toContain('&#xD;');
  });

  it('a new folder item is self-closing with a space, sorted among the folders', async () => {
    fileStore.set(PROJECT, VS_PROJECT);

    await new ProjectFileManager().addToProject(PROJECT, 'form', 'ContosoForm', '');

    const inserted = insertedLines(VS_PROJECT, fileStore.get(PROJECT)!);
    expect(inserted[0]).toBe('    <Folder Include="Forms\\" />\r');
    const after = fileStore.get(PROJECT)!;
    expect(after.indexOf('Folder Include="Classes')).toBeLessThan(after.indexOf('Folder Include="Forms'));
    expect(after.indexOf('Folder Include="Forms')).toBeLessThan(after.indexOf('Folder Include="Tables'));
  });

  it('remove after add returns the original bytes', async () => {
    fileStore.set(PROJECT, VS_PROJECT);
    const manager = new ProjectFileManager();

    await manager.addToProject(PROJECT, 'class', 'ContosoBravo', '');
    await manager.addToProject(PROJECT, 'form', 'ContosoForm', '');
    await manager.removeFromProject(PROJECT, 'form', 'ContosoForm');
    await manager.removeFromProject(PROJECT, 'class', 'ContosoBravo');

    expect(fileStore.get(PROJECT)).toBe(VS_PROJECT);
  });

  it('removing an existing object removes exactly its lines', async () => {
    fileStore.set(PROJECT, VS_PROJECT);

    await new ProjectFileManager().removeFromProject(PROJECT, 'class', 'ContosoCharlie');

    const removed = insertedLines(fileStore.get(PROJECT)!, VS_PROJECT);
    expect(removed).toHaveLength(5);
    expect(removed[0]).toBe('    <Content Include="AxClass\\ContosoCharlie">\r');
  });

  it('adding an object already present changes nothing', async () => {
    fileStore.set(PROJECT, VS_PROJECT);
    const manager = new ProjectFileManager();

    await manager.addToProject(PROJECT, 'class', 'ContosoBravo', '');
    const once = fileStore.get(PROJECT)!;
    const again = await manager.addToProject(PROJECT, 'class', 'ContosoBravo', '');

    expect(again).toBe(false);
    expect(fileStore.get(PROJECT)).toBe(once);
  });

  it('a project with `Classes` written without its backslash gets no second Classes folder', async () => {
    const handEdited = VS_PROJECT.replace('<Folder Include="Classes\\" />', '<Folder Include="Classes" />');
    fileStore.set(PROJECT, handEdited);
    const manager = new ProjectFileManager();

    await manager.addToProject(PROJECT, 'class', 'ContosoBravo', '');

    const after = fileStore.get(PROJECT)!;
    expect(after.match(/<Folder Include="Classes/g) ?? []).toHaveLength(1);
    expect(insertedLines(handEdited, after)).toHaveLength(5); // the Content block only

    // Not recorded as ours either, so undo leaves the hand-written folder in place.
    await manager.removeFromProject(PROJECT, 'class', 'ContosoBravo');
    expect(fileStore.get(PROJECT)).toBe(handEdited);
  });

  it('an LF project stays LF', async () => {
    fileStore.set(PROJECT, VS_PROJECT_LF);

    await new ProjectFileManager().addToProject(PROJECT, 'table', 'ContosoOther', '');

    const after = fileStore.get(PROJECT)!;
    expect(after).not.toContain('\r');
    expect(insertedLines(VS_PROJECT_LF, after)).toHaveLength(5);
  });

  it('label entries are inserted without touching the rest', async () => {
    fileStore.set(PROJECT, VS_PROJECT);

    await new ProjectFileManager().addLabelToProject(PROJECT, 'ContosoExt', ['en-US']);

    const inserted = insertedLines(VS_PROJECT, fileStore.get(PROJECT)!);
    expect(inserted).toEqual([
      '    <Folder Include="Label Files\\" />\r',
      '    <Content Include="AxLabelFile\\ContosoExt_en-US">\r',
      '      <SubType>Content</SubType>\r',
      '      <Name>ContosoExt_en-US</Name>\r',
      '      <Link>Label Files\\ContosoExt_en-US</Link>\r',
      '    </Content>\r',
      '    <Content Include="ContosoExt.en-US.label.txt">\r',
      '      <SubType>Content</SubType>\r',
      '      <Name>ContosoExt.en-US.label.txt</Name>\r',
      '      <DependentUpon>AxLabelFile\\ContosoExt_en-US</DependentUpon>\r',
      '    </Content>\r',
    ]);
  });

  it('a project without item groups gets them after the property group, and loses them again on remove', async () => {
    const bare = '\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n' +
      '<Project ToolsVersion="14.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">\r\n' +
      '  <PropertyGroup>\r\n    <Model>ContosoExt</Model>\r\n  </PropertyGroup>\r\n' +
      '  <Import Project="$(MSBuildExtensionsPath)\\Contoso.targets" />\r\n</Project>\r\n';
    fileStore.set(PROJECT, bare);
    const manager = new ProjectFileManager();

    await manager.addToProject(PROJECT, 'class', 'ContosoFirst', '');
    const after = fileStore.get(PROJECT)!;
    expect(insertedLines(bare, after)).toEqual([
      '  <ItemGroup>\r',
      '    <Folder Include="Classes\\" />\r',
      '  </ItemGroup>\r',
      '  <ItemGroup>\r',
      '    <Content Include="AxClass\\ContosoFirst">\r',
      '      <SubType>Content</SubType>\r',
      '      <Name>ContosoFirst</Name>\r',
      '      <Link>Classes\\ContosoFirst</Link>\r',
      '    </Content>\r',
      '  </ItemGroup>\r',
    ]);

    await manager.removeFromProject(PROJECT, 'class', 'ContosoFirst');
    expect(fileStore.get(PROJECT)).toBe(bare);
  });
});

describe('rnrprojText helpers', () => {
  it('escapes an Include and metadata that need it', () => {
    const out = insertProjectItem(VS_PROJECT_LF, {
      type: 'Content', include: 'AxClass\\A&B', metadata: [['Name', 'A<B']],
    }, '\n');
    expect(out).toContain('<Content Include="AxClass\\A&amp;B">');
    expect(out).toContain('<Name>A&lt;B</Name>');
  });

  it('keeps an item group that still holds other items or a comment', () => {
    const text = '<Project>\n  <ItemGroup>\n    <!-- kept -->\n    <Folder Include="A\\" />\n  </ItemGroup>\n</Project>\n';
    const result = removeProjectItems(text, 'Folder', inc => inc === 'a\\');
    expect(result.removed).toBe(1);
    expect(result.text).toBe('<Project>\n  <ItemGroup>\n    <!-- kept -->\n  </ItemGroup>\n</Project>\n');
  });

  it('ignores tags inside comments when finding items', () => {
    const text = '<Project>\n  <!-- <ItemGroup><Folder Include="X\\" /></ItemGroup> -->\n</Project>\n';
    expect(removeProjectItems(text, 'Folder', () => true)).toEqual({ text, removed: 0 });
  });
});
