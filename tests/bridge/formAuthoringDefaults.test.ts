/**
 * Regression tests — C# bridge form-authoring defaults
 *
 * Corpus evidence:
 *   eval/corpus/runs/2026-07-21T18__L2-form-modify-controls__c262b19.json
 *
 * Defects pinned here (all on bridge/D365MetadataBridge/Services/MetadataWriteService.cs):
 *
 *  (#8)  AddControl resolved its parent with FindControlRecursive(design, parentControl),
 *        which only walks design.Controls and can never return the design ROOT. A form
 *        whose design has no controls could never receive its FIRST top-level control —
 *        every parentControl value failed by construction, blocking the whole
 *        form-lifecycle coverage leaf.
 *  (#9)  CreateForm accepted properties.dataSource and silently dropped it.
 *  (#10) CreateForm emitted no classDeclaration, so xppc rejected every bridge-created
 *        form with "The 'classDeclaration' is missing from element '<Form>'".
 *
 * The behavioural half of #8/#10 is exercised for real: FormAuthoringDefaults.cs is
 * deliberately free of any Microsoft.Dynamics.* reference, so this test compiles it with
 * the plain .NET SDK and runs it — no AOS, no metadata model, no VM. If `dotnet` is not
 * on PATH the behavioural block skips and the structural assertions still run.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE_SERVICES = path.join(REPO_ROOT, 'bridge', 'D365MetadataBridge', 'Services');
const HELPER_CS = path.join(BRIDGE_SERVICES, 'FormAuthoringDefaults.cs');
const WRITE_SERVICE_CS = path.join(BRIDGE_SERVICES, 'MetadataWriteService.cs');

const hasDotnet = (): boolean => {
  const r = spawnSync('dotnet', ['--version'], { stdio: 'ignore', shell: true });
  return r.status === 0;
};

// ─── Structural assertions (always run — no toolchain required) ───────────────

describe('MetadataWriteService form-authoring wiring (structural)', () => {
  let src = '';
  beforeAll(() => {
    src = fs.readFileSync(WRITE_SERVICE_CS, 'utf-8');
  });

  it('AddControl falls back to the design root when parentControl is a sentinel', () => {
    const addControl = src.slice(
      src.indexOf('public object AddControl('),
      src.indexOf('public object AddDataSource('),
    );
    expect(addControl).not.toBe('');
    expect(addControl).toContain('FormAuthoringDefaults.IsDesignRootSentinel(parentControl, formName)');
    // The recursive lookup must still be tried FIRST, so a control genuinely named
    // "Design" keeps resolving to itself rather than to the design container.
    expect(addControl.indexOf('FindControlRecursive(design, parentControl)'))
      .toBeLessThan(addControl.indexOf('IsDesignRootSentinel'));
  });

  it('CreateForm supplies a classDeclaration when the caller did not', () => {
    const createForm = src.slice(
      src.indexOf('public object CreateForm('),
      src.indexOf('public object CreateMenu('),
    );
    expect(createForm).not.toBe('');
    expect(createForm).toContain('FormAuthoringDefaults.IsClassDeclarationMethod');
    expect(createForm).toContain('FormAuthoringDefaults.DefaultFormClassDeclaration(name)');
  });

  it('CreateForm honours properties.dataSource instead of dropping it', () => {
    const createForm = src.slice(
      src.indexOf('public object CreateForm('),
      src.indexOf('public object CreateMenu('),
    );
    expect(createForm).toContain('case "datasource":');
    expect(createForm).toContain('CreateFormDataSourceRoot');
  });

  it('CreateForm reports any property key it could not apply (no silent drop)', () => {
    const createForm = src.slice(
      src.indexOf('public object CreateForm('),
      src.indexOf('public object CreateMenu('),
    );
    expect(createForm).toContain('unknownProperties');
    expect(createForm).toContain('warnings');
  });
});

// ─── Behavioural assertions (compile + run the pure helper with the .NET SDK) ─

const HARNESS_MAIN = `
using System;
using System.Collections.Generic;
using D365MetadataBridge.Services;

public static class Harness
{
    public static void Main()
    {
        // parentControl values that MUST resolve to the form design root
        string[] sentinels = { "Design", "design", "  Design  ", "FormDesign", "Root", "", "   ", "MyForm", "MyFormDesign" };
        foreach (var s in sentinels)
            Console.WriteLine("sentinel|" + s + "|" + FormAuthoringDefaults.IsDesignRootSentinel(s, "MyForm"));

        Console.WriteLine("sentinel|<null>|" + FormAuthoringDefaults.IsDesignRootSentinel(null, "MyForm"));

        // values that must NOT be treated as the design root
        string[] nonSentinels = { "TabGeneral", "HeaderGroup", "Grid", "DesignTab", "MyFormGrid" };
        foreach (var s in nonSentinels)
            Console.WriteLine("nonsentinel|" + s + "|" + FormAuthoringDefaults.IsDesignRootSentinel(s, "MyForm"));

        Console.WriteLine("decl|" + FormAuthoringDefaults.IsClassDeclarationMethod("classDeclaration"));
        Console.WriteLine("decl|" + FormAuthoringDefaults.IsClassDeclarationMethod("ClassDeclaration"));
        Console.WriteLine("decl|" + FormAuthoringDefaults.IsClassDeclarationMethod("init"));
        Console.WriteLine("decl|" + FormAuthoringDefaults.IsClassDeclarationMethod(null));

        Console.WriteLine("source|" + FormAuthoringDefaults.DefaultFormClassDeclaration("MyForm").Replace("\\n", "\\\\n"));
    }
}
`;

const HARNESS_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <LangVersion>12.0</LangVersion>
    <AssemblyName>FormAuthoringDefaultsHarness</AssemblyName>
    <RootNamespace>Harness</RootNamespace>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <StartupObject>Harness</StartupObject>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
    <Compile Include="FormAuthoringDefaults.cs" />
  </ItemGroup>
</Project>
`;

describe.runIf(hasDotnet())('FormAuthoringDefaults (compiled + executed)', () => {
  let output = '';

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fad-harness-'));
    fs.copyFileSync(HELPER_CS, path.join(dir, 'FormAuthoringDefaults.cs'));
    // internal → public so the harness in another assembly can call it
    const helper = fs.readFileSync(path.join(dir, 'FormAuthoringDefaults.cs'), 'utf-8')
      .replace('internal static class FormAuthoringDefaults', 'public static class FormAuthoringDefaults');
    fs.writeFileSync(path.join(dir, 'FormAuthoringDefaults.cs'), helper, 'utf-8');
    fs.writeFileSync(path.join(dir, 'Program.cs'), HARNESS_MAIN, 'utf-8');
    fs.writeFileSync(path.join(dir, 'Harness.csproj'), HARNESS_CSPROJ, 'utf-8');

    output = execFileSync('dotnet', ['run', '--project', path.join(dir, 'Harness.csproj'), '-v', 'q', '--nologo'], {
      encoding: 'utf-8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, 300_000);

  const lines = () => output.split(/\r?\n/).filter(Boolean);

  it('treats every design-root spelling as the design container', () => {
    const results = lines().filter((l) => l.startsWith('sentinel|'));
    expect(results.length).toBeGreaterThanOrEqual(10);
    for (const r of results) {
      expect(r, `expected design-root sentinel: ${r}`).toMatch(/\|True$/);
    }
  });

  it('does not swallow a real container name as a design-root sentinel', () => {
    const results = lines().filter((l) => l.startsWith('nonsentinel|'));
    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r, `expected NOT a sentinel: ${r}`).toMatch(/\|False$/);
    }
  });

  it('recognises classDeclaration case-insensitively and nothing else', () => {
    const results = lines().filter((l) => l.startsWith('decl|'));
    expect(results).toEqual(['decl|True', 'decl|True', 'decl|False', 'decl|False']);
  });

  it('emits a compilable form class declaration', () => {
    const src = lines().find((l) => l.startsWith('source|'))!.slice('source|'.length);
    expect(src).toContain('[Form]');
    expect(src).toContain('public class MyForm extends FormRun');
  });
});
