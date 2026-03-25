/**
 * ProjectFileManager Tests
 * Covers: BOM preservation, ItemGroup ordering, addToProject roundtrip
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectFileManager } from '../../src/tools/createD365File';

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
        ['table-extension', 'AxTableExtension', 'Table Extensions'],
        ['form-extension', 'AxFormExtension', 'Form Extensions'],
        ['report', 'AxReport', 'Reports'],
        ['menu-item-display', 'AxMenuItemDisplay', 'Menu Items Display'],
        ['security-privilege', 'AxSecurityPrivilege', 'Security Privileges'],
        ['security-duty', 'AxSecurityDuty', 'Security Duties'],
        ['security-role', 'AxSecurityRole', 'Security Roles'],
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
});
