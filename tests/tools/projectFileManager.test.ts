/**
 * ProjectFileManager Tests
 * Covers: BOM preservation, ItemGroup ordering, addToProject roundtrip
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectFileManager } from '../../src/workspace/projectFile';
import { _clearCreatedArtifactLedger } from '../../src/workspace/createdArtifactLedger';

// We need to mock fs/promises so addToProject reads/writes in-memory
const fileStore = new Map<string, string>();

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const content = fileStore.get(p);
    if (!content) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return content;
  }),
  writeFile: vi.fn(async (p: string, data: string) => {
    fileStore.set(p, data);
  }),
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: 100 })),
  mkdir: vi.fn(async () => {}),
}));

// Mock the lock to be pass-through (no real locking needed in tests)
vi.mock('../../src/utils/projectFileLock', () => ({
  withProjectFileLock: vi.fn(async (_path: string, fn: () => Promise<boolean>) => fn()),
}));

beforeEach(() => {
  fileStore.clear();
  _clearCreatedArtifactLedger();
});

// Realistic .rnrproj content as VS 2022 creates it (with BOM)
const REALISTIC_RNRPROJ_WITH_BOM = '\uFEFF' +
`<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration Condition="'$(Configuration)' == ''">Debug</Configuration>
    <Platform Condition="'$(Platform)' == ''">AnyCPU</Platform>
    <OutputPath>bin</OutputPath>
    <Model>TestModel</Model>
    <TargetFrameworkVersion>v4.6</TargetFrameworkVersion>
  </PropertyGroup>
  <ItemGroup>
    <Folder Include="Classes\\" />
  </ItemGroup>
  <ItemGroup>
    <Content Include="AxClass\\ExistingClass">
      <SubType>Content</SubType>
      <Name>ExistingClass</Name>
      <Link>Classes\\ExistingClass</Link>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Dynamics365\\Microsoft.Dynamics.Framework.Tools.BuildTasks.Xpp.targets" />
</Project>`;

// Same without BOM
const REALISTIC_RNRPROJ_NO_BOM = REALISTIC_RNRPROJ_WITH_BOM.slice(1);

// Minimal .rnrproj with no ItemGroups (brand new project)
const MINIMAL_RNRPROJ = '\uFEFF' +
`<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Model>TestModel</Model>
  </PropertyGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Dynamics365\\Microsoft.Dynamics.Framework.Tools.BuildTasks.Xpp.targets" />
</Project>`;

describe('ProjectFileManager', () => {
  describe('BOM preservation', () => {
    it('preserves UTF-8 BOM when file originally has BOM', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'class', 'NewClass', 'K:\\Pkg\\AxClass\\NewClass.xml');

      const result = fileStore.get(projectPath)!;
      expect(result.charCodeAt(0)).toBe(0xFEFF);
    });

    it('does NOT add BOM when file originally had no BOM', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_NO_BOM);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'class', 'NewClass', 'K:\\Pkg\\AxClass\\NewClass.xml');

      const result = fileStore.get(projectPath)!;
      expect(result.charCodeAt(0)).not.toBe(0xFEFF);
    });
  });

  describe('addToProject content entry', () => {
    it('adds Content Include with correct format (no .xml extension)', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      const wasAdded = await manager.addToProject(projectPath, 'table', 'NewTable', 'K:\\Pkg\\AxTable\\NewTable.xml');

      expect(wasAdded).toBe(true);
      const result = fileStore.get(projectPath)!;
      expect(result).toContain('AxTable\\NewTable');
      expect(result).toContain('Tables\\NewTable');
    });

    it('returns false for duplicate entries', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      // First add
      const first = await manager.addToProject(projectPath, 'class', 'ExistingClass', 'K:\\Pkg\\AxClass\\ExistingClass.xml');
      expect(first).toBe(false); // Already in project
    });

    it('handles all object types correctly', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();

      const types: Array<[string, string, string]> = [
        ['table', 'AxTable', 'Tables'],
        ['enum', 'AxEnum', 'Base Enums'],
        ['form', 'AxForm', 'Forms'],
        ['edt', 'AxEdt', 'Extended Data Types'],
        ['query', 'AxQuery', 'Queries'],
        ['view', 'AxView', 'Views'],
        ['data-entity', 'AxDataEntityView', 'Data Entities'],
        ['class-extension', 'AxClass', 'Classes'],
        ['table-extension', 'AxTableExtension', 'Table Extensions'],
        ['form-extension', 'AxFormExtension', 'Form Extensions'],
        ['data-entity-extension', 'AxDataEntityViewExtension', 'Data Entity Extensions'],
        ['edt-extension', 'AxEdtExtension', 'EDT Extensions'],
        ['enum-extension', 'AxEnumExtension', 'Base Enum Extensions'],
        ['report', 'AxReport', 'Reports'],
        ['menu-item-display', 'AxMenuItemDisplay', 'Display Menu Items'],
        ['menu-item-action', 'AxMenuItemAction', 'Action Menu Items'],
        ['menu-item-output', 'AxMenuItemOutput', 'Output Menu Items'],
        ['menu-item-display-extension', 'AxMenuItemDisplayExtension', 'Display Menu Item Extensions'],
        ['menu-item-action-extension', 'AxMenuItemActionExtension', 'Action Menu Item Extensions'],
        ['menu-item-output-extension', 'AxMenuItemOutputExtension', 'Output Menu Item Extensions'],
        ['menu', 'AxMenu', 'Menus'],
        ['menu-extension', 'AxMenuExtension', 'Menu Extensions'],
        ['security-privilege', 'AxSecurityPrivilege', 'Security Privileges'],
        ['security-duty', 'AxSecurityDuty', 'Security Duties'],
        ['security-role', 'AxSecurityRole', 'Security Roles'],
        // Extensions get their OWN project folder — VS groups them under
        // "Security Duty Extensions"/"Security Role Extensions", not under the
        // base "Security Duties"/"Security Roles" nodes.
        ['security-duty-extension', 'AxSecurityDutyExtension', 'Security Duty Extensions'],
        ['security-role-extension', 'AxSecurityRoleExtension', 'Security Role Extensions'],
        ['business-event', 'AxClass', 'Classes'],
        ['tile', 'AxTile', 'Tiles'],
        ['kpi', 'AxKPI', 'KPIs'],
      ];

      for (const [objType, axPrefix, displayFolder] of types) {
        fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);
        const result = await manager.addToProject(projectPath, objType, `TestObj_${objType}`, 'K:\\Pkg\\path.xml');
        expect(result).toBe(true);
        const xml = fileStore.get(projectPath)!;
        expect(xml).toContain(`${axPrefix}\\TestObj_${objType}`);
        expect(xml).toContain(`${displayFolder}\\TestObj_${objType}`);
      }
    });
  });

  describe('ItemGroup ordering (new project)', () => {
    it('places ItemGroup BEFORE Import elements', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, MINIMAL_RNRPROJ);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'class', 'FirstClass', 'K:\\Pkg\\AxClass\\FirstClass.xml');

      const result = fileStore.get(projectPath)!;
      const itemGroupPos = result.indexOf('<ItemGroup>');
      const importPos = result.indexOf('<Import');
      expect(itemGroupPos).toBeGreaterThan(-1);
      expect(importPos).toBeGreaterThan(-1);
      expect(itemGroupPos).toBeLessThan(importPos);
    });
  });

  describe('extractModelName', () => {
    it('extracts Model tag from .rnrproj', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      const modelName = await manager.extractModelName(projectPath);

      expect(modelName).toBe('TestModel');
    });

    it('handles BOM in extractModelName', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, MINIMAL_RNRPROJ);

      const manager = new ProjectFileManager();
      const modelName = await manager.extractModelName(projectPath);

      expect(modelName).toBe('TestModel');
    });
  });

  describe('xmlns preservation', () => {
    it('preserves xmlns attribute on Project element after roundtrip', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'class', 'NewClass', 'K:\\Pkg\\AxClass\\NewClass.xml');

      const result = fileStore.get(projectPath)!;
      expect(result).toContain('xmlns="http://schemas.microsoft.com/developer/msbuild/2003"');
    });
  });

  /**
   * Regression: eval/corpus/runs/2026-07-30T11__L3-dualwrite-entity-mapping__174ac13.json
   * — undo_last_modification pruned three <Folder Include> entries (Tables\,
   * Data Entities\, Security Privileges\) that were already in ContosoDemo.rnrproj as
   * orphans before the run, shrinking it 3384 B → 3268 B. The prune test was "no
   * remaining Content of this AOT type", which cannot tell our own entry from a
   * pre-existing one. It now also requires that THIS session added it.
   */
  describe('removeFromProject — folder-entry symmetry', () => {
    /** As the eval sandbox project is: a folder entry with no Content of that type. */
    const RNRPROJ_WITH_ORPHAN_FOLDER = '\uFEFF' +
`<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Model>TestModel</Model>
  </PropertyGroup>
  <ItemGroup>
    <Folder Include="Classes\\" />
    <Folder Include="Tables\\" />
  </ItemGroup>
  <ItemGroup>
    <Content Include="AxClass\\ExistingClass">
      <SubType>Content</SubType>
      <Name>ExistingClass</Name>
      <Link>Classes\\ExistingClass</Link>
    </Content>
  </ItemGroup>
  <Import Project="$(MSBuildExtensionsPath)\\Dynamics365\\Microsoft.Dynamics.Framework.Tools.BuildTasks.Xpp.targets" />
</Project>`;

    it('leaves a pre-existing orphan folder entry alone', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, RNRPROJ_WITH_ORPHAN_FOLDER);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'table', 'NewTable', 'K:\\Pkg\\AxTable\\NewTable.xml');
      const removed = await manager.removeFromProject(projectPath, 'table', 'NewTable');

      expect(removed).toBe(true);
      const xml = fileStore.get(projectPath)!;
      expect(xml).not.toContain('AxTable\\NewTable');
      expect(xml).toContain('Folder Include="Tables\\"');
    });

    it('add + remove is a byte-identical round trip', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, RNRPROJ_WITH_ORPHAN_FOLDER);

      const manager = new ProjectFileManager();
      // Normalise first: the xml2js round trip reformats whitespace, so compare
      // against a project that has already been through the builder once.
      await manager.addToProject(projectPath, 'class', 'Probe', 'K:\\Pkg\\AxClass\\Probe.xml');
      await manager.removeFromProject(projectPath, 'class', 'Probe');
      const baseline = fileStore.get(projectPath)!;

      await manager.addToProject(projectPath, 'data-entity', 'ProbeEntity', 'K:\\Pkg\\AxDataEntityView\\ProbeEntity.xml');
      await manager.removeFromProject(projectPath, 'data-entity', 'ProbeEntity');

      expect(fileStore.get(projectPath)).toBe(baseline);
    });

    it('removes the folder entry it added itself', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'data-entity', 'ProbeEntity', 'K:\\Pkg\\AxDataEntityView\\ProbeEntity.xml');
      expect(fileStore.get(projectPath)!).toContain('Folder Include="Data Entities\\"');

      await manager.removeFromProject(projectPath, 'data-entity', 'ProbeEntity');
      expect(fileStore.get(projectPath)!).not.toContain('Data Entities\\');
    });

    it('keeps a folder entry that still hosts a sibling object', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      await manager.addToProject(projectPath, 'table', 'TableOne', 'K:\\Pkg\\AxTable\\TableOne.xml');
      await manager.addToProject(projectPath, 'table', 'TableTwo', 'K:\\Pkg\\AxTable\\TableTwo.xml');
      await manager.removeFromProject(projectPath, 'table', 'TableOne');

      const xml = fileStore.get(projectPath)!;
      expect(xml).not.toContain('AxTable\\TableOne');
      expect(xml).toContain('AxTable\\TableTwo');
      expect(xml).toContain('Folder Include="Tables\\"');
    });

    it('returns false and rewrites nothing when the Content entry is absent', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      const removed = await manager.removeFromProject(projectPath, 'table', 'NeverExisted');

      expect(removed).toBe(false);
      expect(fileStore.get(projectPath)).toBe(REALISTIC_RNRPROJ_WITH_BOM);
    });
  });

  describe('addLabelToProject', () => {
    it('adds both descriptor and resource entries per language', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      const added = await manager.addLabelToProject(projectPath, 'TestLabels', ['en-US', 'de']);

      expect(added).toEqual(['TestLabels_en-US', 'TestLabels_de']);
      const xml = fileStore.get(projectPath)!;

      // Descriptor entries
      expect(xml).toContain('AxLabelFile\\TestLabels_en-US');
      expect(xml).toContain('Label Files\\TestLabels_en-US');
      expect(xml).toContain('AxLabelFile\\TestLabels_de');
      expect(xml).toContain('Label Files\\TestLabels_de');

      // Resource entries with DependentUpon
      expect(xml).toContain('TestLabels.en-US.label.txt');
      expect(xml).toContain('<DependentUpon>AxLabelFile\\TestLabels_en-US</DependentUpon>');
      expect(xml).toContain('TestLabels.de.label.txt');
      expect(xml).toContain('<DependentUpon>AxLabelFile\\TestLabels_de</DependentUpon>');

      // Folder entry
      expect(xml).toContain('Label Files\\');
    });

    it('returns empty array when all entries already exist', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      // First call adds
      await manager.addLabelToProject(projectPath, 'TestLabels', ['en-US']);
      // Second call should detect duplicates
      const added2 = await manager.addLabelToProject(projectPath, 'TestLabels', ['en-US']);
      expect(added2).toEqual([]);
    });

    it('writes resource entry even when descriptor already exists', async () => {
      const projectPath = 'K:\\Test\\Test.rnrproj';
      fileStore.set(projectPath, REALISTIC_RNRPROJ_WITH_BOM);

      const manager = new ProjectFileManager();
      // First call adds both descriptor + resource
      await manager.addLabelToProject(projectPath, 'TestLabels', ['en-US']);
      let xml = fileStore.get(projectPath)!;
      expect(xml).toContain('TestLabels.en-US.label.txt');

      // Simulate resource entry being manually removed (descriptor remains)
      xml = xml.replace(/<Content Include="TestLabels\.en-US\.label\.txt">[\s\S]*?<\/Content>/, '');
      fileStore.set(projectPath, xml);
      expect(fileStore.get(projectPath)).not.toContain('TestLabels.en-US.label.txt');

      // Second call: descriptor exists → added=[], but resource must still be written
      const added2 = await manager.addLabelToProject(projectPath, 'TestLabels', ['en-US']);
      expect(added2).toEqual([]); // no NEW descriptors
      const xml2 = fileStore.get(projectPath)!;
      // But resource entry must be restored
      expect(xml2).toContain('TestLabels.en-US.label.txt');
      expect(xml2).toContain('<DependentUpon>AxLabelFile\\TestLabels_en-US</DependentUpon>');
    });
  });
});
