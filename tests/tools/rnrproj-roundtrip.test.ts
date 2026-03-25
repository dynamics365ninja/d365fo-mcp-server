/**
 * Investigative test: xml2js roundtrip for .rnrproj files
 * Tests the exact Parser/Builder config used by ProjectFileManager
 */
import { describe, it, expect } from 'vitest';
import { Parser, Builder } from 'xml2js';

// Exact config from ProjectFileManager in createD365File.ts (line 2775)
const parser = new Parser({
  explicitArray: false,
  mergeAttrs: false,
  trim: true,
});

const builder = new Builder({
  xmldec: { version: '1.0', encoding: 'utf-8' },
  renderOpts: { pretty: true, indent: '  ' },
});

// Realistic D365FO .rnrproj content (based on VS 2022 output)
const REAL_RNRPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration Condition="'$(Configuration)' == ''">Debug</Configuration>
    <Platform Condition="'$(Platform)' == ''">AnyCPU</Platform>
    <OutputPath>bin\\</OutputPath>
    <Model>ContosoCore</Model>
    <Name>ContosoCore</Name>
  </PropertyGroup>
  <ItemGroup>
    <Folder Include="Classes\\" />
    <Folder Include="Tables\\" />
  </ItemGroup>
  <ItemGroup>
    <Content Include="AxClass\\ContosoCoreHelper">
      <SubType>Content</SubType>
      <Name>ContosoCoreHelper</Name>
      <Link>Classes\\ContosoCoreHelper</Link>
    </Content>
    <Content Include="AxTable\\ContosoCoreTable">
      <SubType>Content</SubType>
      <Name>ContosoCoreTable</Name>
      <Link>Tables\\ContosoCoreTable</Link>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\GenerateCode.targets" />
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\Build.targets" />
</Project>`;

// Edge case: only ONE Content entry (explicitArray: false makes it an object)
const SINGLE_CONTENT_RNRPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration Condition="'$(Configuration)' == ''">Debug</Configuration>
    <Platform Condition="'$(Platform)' == ''">AnyCPU</Platform>
    <OutputPath>bin\\</OutputPath>
    <Model>ContosoCore</Model>
    <Name>ContosoCore</Name>
  </PropertyGroup>
  <ItemGroup>
    <Folder Include="Classes\\" />
  </ItemGroup>
  <ItemGroup>
    <Content Include="AxClass\\ContosoCoreHelper">
      <SubType>Content</SubType>
      <Name>ContosoCoreHelper</Name>
      <Link>Classes\\ContosoCoreHelper</Link>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\GenerateCode.targets" />
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\Build.targets" />
</Project>`;

// Edge case: brand new project — empty ItemGroup
const EMPTY_PROJECT_RNRPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Model>ContosoCore</Model>
    <Name>ContosoCore</Name>
  </PropertyGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\GenerateCode.targets" />
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\Build.targets" />
</Project>`;

// With BOM
const BOM = '\uFEFF';

describe('rnrproj xml2js roundtrip investigation', () => {

  // ── BUG A: BOM handling ────────────────────────────────────────────────────

  it('BOM is stripped on parse but NOT restored on rebuild', async () => {
    const withBom = BOM + REAL_RNRPROJ;
    // Simulate the ProjectFileManager BOM stripping
    let projectXml = withBom;
    if (projectXml.charCodeAt(0) === 0xFEFF) {
      projectXml = projectXml.slice(1);
    }
    const parsed = await parser.parseStringPromise(projectXml);
    const rebuilt = builder.buildObject(parsed);

    // BOM is NOT present in rebuilt output
    expect(rebuilt.charCodeAt(0)).not.toBe(0xFEFF);
    // This means the written file will lack BOM that VS 2022 expects
    console.log('BOM test: rebuilt starts with:', rebuilt.substring(0, 50));
  });

  // ── BUG B: XML declaration ─────────────────────────────────────────────────

  it('XML declaration format matches D365FO expectation', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);
    const rebuilt = builder.buildObject(parsed);

    // Check the XML declaration
    const firstLine = rebuilt.split('\n')[0];
    console.log('XML declaration:', firstLine);

    // Should NOT have standalone="yes"
    expect(firstLine).not.toContain('standalone');
    // Should have utf-8 (lowercase)
    expect(firstLine).toContain('encoding="utf-8"');
    // Should match D365FO format
    expect(firstLine).toBe('<?xml version="1.0" encoding="utf-8"?>');
  });

  // ── BUG C: xmlns namespace preservation ────────────────────────────────────

  it('xmlns attribute is preserved on root element', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);
    const rebuilt = builder.buildObject(parsed);

    // xmlns should appear on root <Project> element
    expect(rebuilt).toContain('xmlns="http://schemas.microsoft.com/developer/msbuild/2003"');

    // Count how many times xmlns appears — should be exactly ONCE
    const xmlnsCount = (rebuilt.match(/xmlns=/g) || []).length;
    console.log(`xmlns appears ${xmlnsCount} time(s)`);
    // If xml2js/xmlbuilder propagates xmlns to children, this would be > 1
    expect(xmlnsCount).toBe(1);
  });

  // ── BUG D: explicitArray: false with single Content ────────────────────────

  it('single Content entry is correctly parsed and rebuilt', async () => {
    const parsed = await parser.parseStringPromise(SINGLE_CONTENT_RNRPROJ);

    // With explicitArray: false, single Content becomes object, not array
    const itemGroups = Array.isArray(parsed.Project.ItemGroup)
      ? parsed.Project.ItemGroup
      : [parsed.Project.ItemGroup];

    const contentGroup = itemGroups.find((g: any) => g.Content !== undefined);
    console.log('Content type with single entry:', typeof contentGroup?.Content, Array.isArray(contentGroup?.Content));

    // This is the key issue: with explicitArray: false, single Content is an OBJECT
    expect(Array.isArray(contentGroup?.Content)).toBe(false);
    expect(typeof contentGroup?.Content).toBe('object');

    // Simulate the fix from _addToProjectLocked
    if (!Array.isArray(contentGroup.Content)) {
      contentGroup.Content = contentGroup.Content ? [contentGroup.Content] : [];
    }

    // Add new entry
    contentGroup.Content.push({
      $: { Include: 'AxClass\\NewHelper' },
      SubType: 'Content',
      Name: 'NewHelper',
      Link: 'Classes\\NewHelper',
    });

    const rebuilt = builder.buildObject(parsed);
    console.log('Rebuilt with added Content:\n', rebuilt);

    // Both Content entries should be present
    expect(rebuilt).toContain('AxClass\\ContosoCoreHelper');
    expect(rebuilt).toContain('AxClass\\NewHelper');
  });

  // ── BUG E: single Folder entry ─────────────────────────────────────────────

  it('single Folder entry is correctly handled', async () => {
    const parsed = await parser.parseStringPromise(SINGLE_CONTENT_RNRPROJ);

    const itemGroups = Array.isArray(parsed.Project.ItemGroup)
      ? parsed.Project.ItemGroup
      : [parsed.Project.ItemGroup];

    const folderGroup = itemGroups.find((g: any) => g.Folder !== undefined);
    console.log('Folder type with single entry:', typeof folderGroup?.Folder, Array.isArray(folderGroup?.Folder));

    // Single Folder with explicitArray: false — is it object or string?
    // <Folder Include="Classes\" /> has ONLY attributes, no text content
    // So it becomes { "$": { "Include": "Classes\\" } } — an OBJECT
    expect(Array.isArray(folderGroup?.Folder)).toBe(false);
  });

  // ── BUG F: PropertyGroup structure preservation ────────────────────────────

  it('PropertyGroup with Condition attributes is preserved', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);
    const rebuilt = builder.buildObject(parsed);

    // Condition attribute on Configuration should survive roundtrip
    expect(rebuilt).toContain("Condition=\"'$(Configuration)' == ''\"");
    expect(rebuilt).toContain('>Debug<');
    expect(rebuilt).toContain('>AnyCPU<');

    // Model name should be preserved
    expect(rebuilt).toContain('<Model>ContosoCore</Model>');
  });

  // ── BUG G: Import elements preservation ────────────────────────────────────

  it('Import elements survive roundtrip', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);
    const rebuilt = builder.buildObject(parsed);

    expect(rebuilt).toContain('GenerateCode.targets');
    expect(rebuilt).toContain('Build.targets');

    // Import should be self-closing or properly formed
    const importCount = (rebuilt.match(/<Import /g) || []).length;
    console.log(`Import elements: ${importCount}`);
    expect(importCount).toBe(2);
  });

  // ── BUG H: empty project (no ItemGroup) ────────────────────────────────────

  it('empty project (no ItemGroup) gets correct structure', async () => {
    const parsed = await parser.parseStringPromise(EMPTY_PROJECT_RNRPROJ);

    console.log('Empty project parsed ItemGroup:', parsed.Project.ItemGroup);

    // No ItemGroup exists
    expect(parsed.Project.ItemGroup).toBeUndefined();

    // Simulate the _addToProjectLocked logic
    if (!parsed.Project.ItemGroup) {
      parsed.Project.ItemGroup = [{ Folder: [] }, { Content: [] }];
    }

    // Add entries
    parsed.Project.ItemGroup[0].Folder.push({ $: { Include: 'Classes\\' } });
    parsed.Project.ItemGroup[1].Content.push({
      $: { Include: 'AxClass\\NewClass' },
      SubType: 'Content',
      Name: 'NewClass',
      Link: 'Classes\\NewClass',
    });

    const rebuilt = builder.buildObject(parsed);
    console.log('Empty project after adding:\n', rebuilt);

    expect(rebuilt).toContain('AxClass\\NewClass');
    expect(rebuilt).toContain('Classes\\');

    // Check that Import elements are still present and AFTER ItemGroups
    // (element order matters for readability, though MSBuild tolerates any order)
    const itemGroupPos = rebuilt.indexOf('<ItemGroup>');
    const importPos = rebuilt.indexOf('<Import ');
    console.log(`ItemGroup at pos ${itemGroupPos}, Import at pos ${importPos}`);
  });

  // ── BUG I: full roundtrip diff check ───────────────────────────────────────

  it('full roundtrip produces structurally equivalent output', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);
    const rebuilt = builder.buildObject(parsed);

    console.log('=== ORIGINAL ===');
    console.log(REAL_RNRPROJ);
    console.log('=== REBUILT ===');
    console.log(rebuilt);

    // The rebuilt should contain all key structural elements
    expect(rebuilt).toContain('<Project');
    expect(rebuilt).toContain('</Project>');
    expect(rebuilt).toContain('<PropertyGroup>');
    expect(rebuilt).toContain('<ItemGroup>');
    expect(rebuilt).toContain('AxClass\\ContosoCoreHelper');
    expect(rebuilt).toContain('AxTable\\ContosoCoreTable');
    expect(rebuilt).toContain('<Model>ContosoCore</Model>');
  });

  // ── BUG J: element order within ItemGroup after modification ───────────────

  it('newly added ItemGroup goes BEFORE Import elements', async () => {
    // This tests the scenario where no Folder/Content ItemGroup exists
    // and new ones are added via push() to the ItemGroup array
    const parsed = await parser.parseStringPromise(EMPTY_PROJECT_RNRPROJ);

    // No ItemGroup — initialize
    if (!parsed.Project.ItemGroup) {
      parsed.Project.ItemGroup = [{ Folder: [] }, { Content: [] }];
    }

    parsed.Project.ItemGroup[0].Folder.push({ $: { Include: 'Classes\\' } });
    parsed.Project.ItemGroup[1].Content.push({
      $: { Include: 'AxClass\\NewClass' },
      SubType: 'Content',
      Name: 'NewClass',
      Link: 'Classes\\NewClass',
    });

    const rebuilt = builder.buildObject(parsed);

    // Check order: PropertyGroup → ItemGroup → Import
    const propGroupPos = rebuilt.indexOf('<PropertyGroup>');
    const itemGroupPos = rebuilt.indexOf('<ItemGroup>');
    const importPos = rebuilt.indexOf('<Import ');

    console.log(`PropertyGroup at ${propGroupPos}`);
    console.log(`ItemGroup at ${itemGroupPos}`);
    console.log(`Import at ${importPos}`);

    // In the empty project case, ItemGroup is added as a NEW key to Project
    // JavaScript objects maintain insertion order for string keys.
    // The key order would be: $, PropertyGroup, Import, ItemGroup
    // This means ItemGroup would appear AFTER Import in output!
    // This is a bug — MSBuild usually expects Import at the end.
    if (itemGroupPos > importPos) {
      console.warn('⚠️ BUG: ItemGroup appears AFTER Import elements!');
    }
  });

  // ── BUG K: trim: true effect on values ─────────────────────────────────────

  it('trim: true does not corrupt path values', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);

    // OutputPath should be preserved
    const pg = Array.isArray(parsed.Project.PropertyGroup)
      ? parsed.Project.PropertyGroup[0]
      : parsed.Project.PropertyGroup;
    console.log('OutputPath:', JSON.stringify(pg.OutputPath));
    expect(pg.OutputPath).toBe('bin\\');
  });

  // ── BUG L: single ItemGroup with both Folder and Content ───────────────────

  it('single ItemGroup containing both Folder and Content', async () => {
    const singleItemGroup = `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Model>Test</Model>
  </PropertyGroup>
  <ItemGroup>
    <Folder Include="Classes\\" />
    <Content Include="AxClass\\ExistingClass">
      <SubType>Content</SubType>
      <Name>ExistingClass</Name>
      <Link>Classes\\ExistingClass</Link>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\Build.targets" />
</Project>`;

    const parsed = await parser.parseStringPromise(singleItemGroup);

    // With explicitArray: false, single ItemGroup becomes an OBJECT not array
    console.log('Single ItemGroup type:', typeof parsed.Project.ItemGroup, Array.isArray(parsed.Project.ItemGroup));

    // Simulate _addToProjectLocked logic
    if (!Array.isArray(parsed.Project.ItemGroup)) {
      parsed.Project.ItemGroup = [parsed.Project.ItemGroup];
    }

    // Both folderGroup and contentGroup point to SAME ItemGroup
    let folderGroup = parsed.Project.ItemGroup.find((g: any) => g.Folder !== undefined);
    let contentGroup = parsed.Project.ItemGroup.find((g: any) => g.Content !== undefined);
    console.log('folderGroup === contentGroup:', folderGroup === contentGroup);
    expect(folderGroup).toBe(contentGroup); // Same object!

    // Convert to arrays
    if (!Array.isArray(folderGroup!.Folder)) {
      folderGroup!.Folder = folderGroup!.Folder ? [folderGroup!.Folder] : [];
    }
    if (!Array.isArray(contentGroup!.Content)) {
      contentGroup!.Content = contentGroup!.Content ? [contentGroup!.Content] : [];
    }

    // Add new content
    contentGroup!.Content.push({
      $: { Include: 'AxTable\\NewTable' },
      SubType: 'Content',
      Name: 'NewTable',
      Link: 'Tables\\NewTable',
    });

    // Add new folder
    const tablesExists = folderGroup!.Folder.some((f: any) => f.$ && f.$.Include === 'Tables\\');
    if (!tablesExists) {
      folderGroup!.Folder.push({ $: { Include: 'Tables\\' } });
    }

    const rebuilt = builder.buildObject(parsed);
    console.log('Single ItemGroup rebuilt:\n', rebuilt);

    // Content and Folders are now in the SAME ItemGroup
    // This is functionally OK for MSBuild but differs from VS convention
    // (VS typically separates Folder and Content into different ItemGroups)
    expect(rebuilt).toContain('AxTable\\NewTable');
    expect(rebuilt).toContain('Tables\\');
  });

  // ── BUG M: what happens to Import with single entry ────────────────────────

  it('single Import element handling', async () => {
    const singleImport = `<?xml version="1.0" encoding="utf-8"?>
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Model>Test</Model>
  </PropertyGroup>
  <ItemGroup>
    <Content Include="AxClass\\Existing">
      <SubType>Content</SubType>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Microsoft\\Dynamics\\AX\\Build.targets" />
</Project>`;

    const parsed = await parser.parseStringPromise(singleImport);
    console.log('Single Import type:', typeof parsed.Project.Import, Array.isArray(parsed.Project.Import));

    // Single Import becomes an OBJECT, not array
    // When Builder reconstructs, it should produce one <Import> element
    const rebuilt = builder.buildObject(parsed);
    console.log('Single Import rebuilt:\n', rebuilt);
    expect(rebuilt).toContain('Build.targets');

    // Verify it's still correctly formed
    const importCount = (rebuilt.match(/<Import /g) || []).length;
    expect(importCount).toBe(1);
  });

  // ── BUG N: verify roundtrip output is loadable by VS ───────────────────────

  it('roundtrip preserves self-closing element format differences', async () => {
    const parsed = await parser.parseStringPromise(REAL_RNRPROJ);
    const rebuilt = builder.buildObject(parsed);

    // Original: <Folder Include="Classes\" />  (space before />)
    // Rebuilt:  <Folder Include="Classes\"/>    (no space before />)
    // Both are valid XML — xmlbuilder just uses a different convention
    const hasSpaceBefore = rebuilt.includes('" />');
    const hasNoSpace = rebuilt.includes('"/>');
    console.log(`Self-closing with space: ${hasSpaceBefore}, without space: ${hasNoSpace}`);
    // xmlbuilder produces no-space version
    expect(hasNoSpace).toBe(true);
  });
});
