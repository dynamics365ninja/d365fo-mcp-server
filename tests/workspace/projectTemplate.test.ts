import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { deflateRawSync } from 'zlib';
import {
  readZipEntries, rnrprojFromTemplateZip, renderRnrprojFromTemplate, resolveProjectTemplate,
  newestBuildTasksTargets, builtInTemplateText, buildTasksTargetsOf, describeProjectTemplate,
} from '../../src/workspace/projectTemplate.js';
import { parseVsixIdentity, compareVersions } from '../../src/utils/visualStudio.js';

interface ZipOptions {
  stored?: boolean;
  /** Sizes only in a data descriptor after the data and in the central directory (flag bit 3). */
  dataDescriptor?: boolean;
  /** Archive comment after the end-of-central-directory record. */
  comment?: string;
}

/** A minimal zip writer: one deflated (or stored) entry per name; a name ending in / is a folder. */
function makeZip(files: Record<string, string>, opts: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const method = opts.stored || name.endsWith('/') ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const flags = opts.dataDescriptor ? 0x08 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(opts.dataDescriptor ? 0 : data.length, 18);
    local.writeUInt32LE(opts.dataDescriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const descriptor = Buffer.alloc(opts.dataDescriptor ? 16 : 0);
    if (opts.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(data.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data, descriptor);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length + descriptor.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, eocd, comment]);
}

const VSTEMPLATE = `<?xml version="1.0" encoding="utf-8"?>
<VSTemplate Version="3.0.0" Type="Project" xmlns="http://schemas.microsoft.com/developer/vstemplate/2005">
  <TemplateContent>
    <Project File="FinanceOperations.rnrproj" ReplaceParameters="true">
    </Project>
  </TemplateContent>
</VSTemplate>`;

const manifest = (id: string, version: string) => `<PackageManifest Version="2.0.0">
  <Metadata>
    <!-- <Identity Id="<vsixIdentifier>" Version="|x|" /> -->
    <Identity Id="${id}" Version="${version}" Language="en-US" Publisher="Microsoft Corporation" />
  </Metadata>
</PackageManifest>`;

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'projtpl-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** A VS installation with one F&O extension (folder `extFolder`) whose template imports `targets`. */
async function fakeInstall(name: string, version: string, targets: string, rnrproj?: string, extFolder = 'abc' + name): Promise<string> {
  const install = path.join(root, name);
  const ext = path.join(install, 'Common7', 'IDE', 'Extensions', extFolder);
  const tplDir = path.join(ext, 'Templates', 'Projects', 'FinanceOperations');
  await fs.mkdir(tplDir, { recursive: true });
  await fs.writeFile(path.join(ext, 'extension.vsixmanifest'), manifest('DynamicsFnO.DeveloperTools', version));
  await fs.writeFile(path.join(tplDir, 'FinanceOperations.zip'), makeZip({
    'FinanceOperations.vstemplate': VSTEMPLATE,
    'FinanceOperations.rnrproj': rnrproj ?? builtInTemplateText(targets).replace(/\n/g, '\r\n'),
  }));
  return install;
}

async function buildTasksDir(...names: string[]): Promise<string> {
  const dir = path.join(root, 'AX');
  await fs.mkdir(dir, { recursive: true });
  for (const n of names) await fs.writeFile(path.join(dir, n), '<Project/>');
  return dir;
}

const T17 = 'Microsoft.Dynamics.Framework.Tools.BuildTasks.17.0.targets';
const T18 = 'Microsoft.Dynamics.Framework.Tools.BuildTasks.18.0.targets';
const PLAIN = 'Microsoft.Dynamics.Framework.Tools.BuildTasks.targets';

describe('zip reading', () => {
  it('reads deflated and stored entries and picks the .rnrproj the .vstemplate names', () => {
    for (const stored of [false, true]) {
      const zip = makeZip({ 'a.vstemplate': VSTEMPLATE, 'Other.rnrproj': 'no', 'FinanceOperations.rnrproj': '﻿<Project>yes</Project>' }, { stored });
      expect(readZipEntries(zip).size).toBe(3);
      expect(rnrprojFromTemplateZip(zip)).toBe('<Project>yes</Project>');
    }
  });
  it('reads an archive with data descriptors, a folder entry and a comment', () => {
    const zip = makeZip(
      { 'sub/': '', 'a.vstemplate': VSTEMPLATE, 'FinanceOperations.rnrproj': '<Project>yes</Project>' },
      { dataDescriptor: true, comment: 'written by some zip tool' },
    );
    expect(rnrprojFromTemplateZip(zip)).toBe('<Project>yes</Project>');
  });
  it('rejects something that is not a zip', () => {
    expect(() => readZipEntries(Buffer.from('not a zip at all, definitely not'))).toThrow();
  });
});

describe('renderRnrprojFromTemplate', () => {
  const guid = '{AAAAAAAA-0000-0000-0000-000000000001}';
  const xml = renderRnrprojFromTemplate(builtInTemplateText(T17), { modelName: 'ContosoExt', projectName: 'C-1', projectGuid: guid });

  it('fills the parameters and adds the identity where VS writes it', () => {
    expect(xml.charCodeAt(0)).toBe(0xFEFF);
    expect(xml).not.toMatch(/[^\r]\n/);
    expect(xml).not.toMatch(/\$[A-Za-z]+\$/);
    expect(xml).toContain('<Model>ContosoExt</Model>');
    expect(xml).toContain('<TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>');
    expect(xml).toContain('<DBSyncInBuild>False</DBSyncInBuild>');
    expect(xml).toContain('<Partition>initial</Partition>');
    expect(xml).toContain('    <Company>\r\n    </Company>\r\n');
    expect(xml).toContain(
      '    <DeployOnline>False</DeployOnline>\r\n' +
      '    <ProjectGuid>{aaaaaaaa-0000-0000-0000-000000000001}</ProjectGuid>\r\n' +
      '    <Name>C-1</Name>\r\n' +
      '    <RootNamespace>C-1</RootNamespace>\r\n' +
      '  </PropertyGroup>\r\n');
    expect(buildTasksTargetsOf(xml)).toBe(T17);
  });

  it('refuses a parameter it does not know', () => {
    expect(() => renderRnrprojFromTemplate('<Project><PropertyGroup><X>$NewThing$</X>\n</PropertyGroup></Project>',
      { modelName: 'M', projectName: 'P', projectGuid: '{X}' })).toThrow(/\$NewThing\$/);
  });
});

describe('helpers', () => {
  it('parseVsixIdentity skips the commented sample', () => {
    expect(parseVsixIdentity(manifest('DynamicsFnO.DeveloperTools', '7.0.1.2'))).toEqual({ id: 'DynamicsFnO.DeveloperTools', version: '7.0.1.2' });
  });
  it('compareVersions is numeric', () => {
    expect(compareVersions('7.0.10', '7.0.9')).toBeGreaterThan(0);
    expect(compareVersions('17.0', '17')).toBe(0);
  });
  it('newestBuildTasksTargets prefers the highest version over the plain name', () => {
    expect(newestBuildTasksTargets([PLAIN, T18, T17, 'other.targets'].map(s => s.toLowerCase()))).toBe(T18);
    expect(newestBuildTasksTargets(['microsoft.dynamics.framework.tools.extensibility.17.0.targets'])).toBeNull();
  });
});

describe('resolveProjectTemplate', () => {
  it('uses the template of the installed extension', async () => {
    const install = await fakeInstall('vs1', '7.0.1', T17);
    const t = await resolveProjectTemplate({ installations: [install], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.source).toBe('visual-studio');
    expect(t.extensionVersion).toBe('7.0.1');
    expect(buildTasksTargetsOf(t.text)).toBe(T17);
    expect(describeProjectTemplate(t)).toContain('FinanceOperations.zip');
  });

  it('prefers an extension whose targets file is installed over a newer one whose is not', async () => {
    const a = await fakeInstall('vs1', '7.0.1', T17);
    const b = await fakeInstall('vs2', '8.0.0', T18);
    const t = await resolveProjectTemplate({ installations: [b, a], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.extensionVersion).toBe('7.0.1');
    expect(t.info.join(' ')).toContain('8.0.0');
    expect(t.warnings).toEqual([]);
  });

  it('picks the newer of two extension folders in one installation', async () => {
    await fakeInstall('vs1', '7.0.1', T17, undefined, 'old');
    const install = await fakeInstall('vs1', '7.0.2', T17, undefined, 'new');
    const t = await resolveProjectTemplate({ installations: [install], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.extensionVersion).toBe('7.0.2');
    expect(t.zipPath).toContain(path.join('Extensions', 'new'));
  });

  it('warns when no template imports an installed targets file, and still uses one', async () => {
    const install = await fakeInstall('vs1', '7.0.1', T18);
    const t = await resolveProjectTemplate({ installations: [install], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.source).toBe('visual-studio');
    expect(t.warnings.join(' ')).toContain('may not build');
  });

  it('without a build-tasks folder, takes the highest extension version and warns', async () => {
    const a = await fakeInstall('vs1', '7.0.1', T17);
    const b = await fakeInstall('vs2', '7.0.2', T18);
    const t = await resolveProjectTemplate({ installations: [a, b], buildTasksDirectory: path.join(root, 'missing') });
    expect(t.extensionVersion).toBe('7.0.2');
    expect(t.warnings.join(' ')).toContain('cannot be built on this machine');
  });

  it('then the highest extension version', async () => {
    const a = await fakeInstall('vs1', '7.0.9', T17);
    const b = await fakeInstall('vs2', '7.0.10', T17);
    const t = await resolveProjectTemplate({ installations: [a, b], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.extensionVersion).toBe('7.0.10');
  });

  it('ignores extensions that are not the Finance and Operations tools', async () => {
    const install = await fakeInstall('vs1', '7.0.1', T17);
    const ext = path.join(install, 'Common7', 'IDE', 'Extensions', 'abcvs1');
    await fs.writeFile(path.join(ext, 'extension.vsixmanifest'), manifest('Some.Other.Extension', '1.0'));
    const t = await resolveProjectTemplate({ installations: [install], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.source).toBe('built-in');
  });

  it('skips a template with a parameter it cannot fill', async () => {
    const install = await fakeInstall('vs1', '7.0.1', T17, '<Project>\n<PropertyGroup><X>$Unknown$</X>\n</PropertyGroup>\n</Project>');
    const t = await resolveProjectTemplate({ installations: [install], buildTasksDirectory: await buildTasksDir(T17) });
    expect(t.source).toBe('built-in');
    expect(t.warnings.join(' ')).toContain('$Unknown$');
    expect(t.warnings.join(' ')).not.toContain('..');
    expect(describeProjectTemplate(t)).toContain('could not be used');
  });

  it('without the extension, uses the built-in template with the newest installed targets', async () => {
    const t = await resolveProjectTemplate({ installations: [path.join(root, 'none')], buildTasksDirectory: await buildTasksDir(PLAIN, T18) });
    expect(t.source).toBe('built-in');
    expect(buildTasksTargetsOf(t.text)).toBe(T18);
    expect(describeProjectTemplate(t)).toContain('no Finance and Operations extension found');
    expect(t.warnings).toEqual([]);
  });

  it('without the extension or the build-tasks folder, uses the default targets', async () => {
    const t = await resolveProjectTemplate({ installations: [], buildTasksDirectory: path.join(root, 'missing') });
    expect(buildTasksTargetsOf(t.text)).toBe(T17);
  });
});
