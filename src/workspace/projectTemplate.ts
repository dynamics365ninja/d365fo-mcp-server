/**
 * The .rnrproj template a new D365FO project starts from: the one Visual Studio itself uses,
 * shipped by the Finance and Operations extension as
 * `Templates\Projects\FinanceOperations\FinanceOperations.zip`, so a new project imports the
 * build-task targets of the tools installed now. Without the extension (no Visual Studio, a
 * build box, tests), a built-in copy of that template is used instead.
 *
 * Existing projects of the model are deliberately not consulted: they record the tools that
 * were installed when they were created, which can be an older Visual Studio.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  compareVersions, findFinanceOperationsExtensions, type FinanceOperationsExtension,
} from '../utils/visualStudio.js';

export const DEFAULT_BUILD_TASKS_TARGETS = 'Microsoft.Dynamics.Framework.Tools.BuildTasks.17.0.targets';

const TEMPLATE_ZIP = path.join('Templates', 'Projects', 'FinanceOperations', 'FinanceOperations.zip');

export interface ProjectTemplate {
  /** The .rnrproj text with its `$placeholders$`. */
  text: string;
  source: 'visual-studio' | 'built-in';
  /** visual-studio: the template archive. */
  zipPath?: string;
  /** visual-studio: version of the Finance and Operations extension. */
  extensionVersion?: string;
  /** visual-studio: the Visual Studio installation folder. */
  install?: string;
  /** built-in: whether a Finance and Operations extension was found (its template was unusable). */
  extensionFound?: boolean;
  /** Problems that may stop the project from building or explain the fallback. */
  warnings: string[];
  /** How the template was chosen, for information. */
  info: string[];
}

// ── Zip ──────────────────────────────────────────────────────────────────────

/** Entries of a zip archive, by name. Only stored and deflated entries — what VS templates use. */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  // End of central directory: 22 bytes plus a comment of up to 64 KiB, at the end of the file.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xFFFF); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip local header for ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressedSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
    // Other methods: the entry is left out; the caller reports what is missing.
  }
  return out;
}

function decodeText(buf: Buffer): string {
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

/** The .rnrproj text of a VS project template archive: the file its .vstemplate names. */
export function rnrprojFromTemplateZip(zip: Buffer): string {
  const entries = readZipEntries(zip);
  const find = (name: string) => [...entries.keys()].find(k => k.toLowerCase() === name.toLowerCase());
  const vstemplate = [...entries.keys()].find(k => k.toLowerCase().endsWith('.vstemplate'));
  const named = vstemplate ? /<Project\b[^>]*\bFile="([^"]+)"/i.exec(decodeText(entries.get(vstemplate)!))?.[1] : undefined;
  const key = (named && find(named)) ?? [...entries.keys()].find(k => k.toLowerCase().endsWith('.rnrproj'));
  if (!key) throw new Error('the archive holds no .rnrproj');
  return decodeText(entries.get(key)!);
}

// ── Rendering ────────────────────────────────────────────────────────────────

export class ProjectTemplateError extends Error {}

/** The build-task targets file a project imports. */
export function buildTasksTargetsOf(rnrprojXml: string): string | null {
  const m = /<Import\s+Project="\$\(BuildTasksDirectory\)\\([^"]*BuildTasks[^"]*\.targets)"/i.exec(rnrprojXml);
  return m ? m[1] : null;
}

export interface RenderOptions {
  modelName: string;
  projectName: string;
  projectGuid: string;
}

/**
 * Fill a template the way VS's project wizard and first save do: replace the parameters with
 * the defaults of VS's Dynamics 365 options, and add the project's identity to the first
 * PropertyGroup. BOM + CRLF, like every project VS writes.
 */
export function renderRnrprojFromTemplate(template: string, opts: RenderOptions): string {
  const values: Record<string, string> = {
    model: opts.modelName,
    targetframeworkversion: '4.7.2',
    dbsyncinbuild: 'False',
    company: '',
    partition: 'initial',
    expandparentchildrelations: 'False',
    uselabeltextasfieldname: 'False',
    projectname: opts.projectName,
    safeprojectname: opts.projectName,
  };
  let text = template.replace(/\r\n?/g, '\n').replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name: string) => {
    const v = values[name.toLowerCase()];
    if (v === undefined) throw new ProjectTemplateError(`the template has a parameter this server does not know: ${whole}`);
    return v;
  });
  // An empty element is written over two lines by VS (MSBuild's serializer).
  text = text.replace(/^([ \t]*)<Company><\/Company>/m, '$1<Company>\n$1</Company>');

  const close = /^([ \t]*)<\/PropertyGroup>/m.exec(text);
  if (!close || !/<Project\b/.test(text)) throw new ProjectTemplateError('the template has no PropertyGroup');
  const indent = close[1] + '  ';
  const identity = [
    `${indent}<ProjectGuid>${opts.projectGuid.toLowerCase()}</ProjectGuid>`,
    `${indent}<Name>${opts.projectName}</Name>`,
    `${indent}<RootNamespace>${opts.projectName}</RootNamespace>`,
  ].join('\n') + '\n';
  text = text.slice(0, close.index) + identity + text.slice(close.index);

  text = text.replace(/\s*$/, '\n');
  return '\uFEFF' + text.replace(/\n/g, '\r\n');
}

/**
 * The built-in copy of VS's template, for machines without the extension. Only the build-tasks
 * targets differ. The extension's template (7.0.7996.33) has `v4.6` as a literal, not
 * `$targetframeworkversion$`, and so do the projects VS creates from it.
 */
export function builtInTemplateText(buildTasksTargets: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project ToolsVersion="14.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    `    <Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>`,
    `    <Platform Condition=" '$(Platform)' == '' ">AnyCPU</Platform>`,
    `    <BuildTasksDirectory Condition=" '$(BuildTasksDirectory)' == ''">$(MSBuildProgramFiles32)\\MSBuild\\Microsoft\\Dynamics\\AX</BuildTasksDirectory>`,
    '    <Model>$Model$</Model>',
    '    <TargetFrameworkVersion>v4.6</TargetFrameworkVersion>',
    '    <OutputPath>bin</OutputPath>',
    '    <SchemaVersion>2.0</SchemaVersion>',
    '    <GenerateCrossReferences>True</GenerateCrossReferences>',
    '    <RunAppCheckerRules>False</RunAppCheckerRules>',
    '    <LogAppcheckerDiagsAsErrors>False</LogAppcheckerDiagsAsErrors>',
    '    <DeployOnline>False</DeployOnline>',
    '  </PropertyGroup>',
    `  <PropertyGroup Condition="'$(Configuration)|$(Platform)' == 'Debug|AnyCPU'">`,
    '    <Configuration>Debug</Configuration>',
    '    <DBSyncInBuild>$DBSyncInBuild$</DBSyncInBuild>',
    '    <GenerateFormAdaptors>False</GenerateFormAdaptors>',
    '    <Company>$Company$</Company>',
    '    <Partition>$Partition$</Partition>',
    '    <PlatformTarget>AnyCPU</PlatformTarget>',
    '    <DataEntityExpandParentChildRelations>$ExpandParentChildRelations$</DataEntityExpandParentChildRelations>',
    '    <DataEntityUseLabelTextAsFieldName>$UseLabelTextAsFieldName$</DataEntityUseLabelTextAsFieldName>',
    '  </PropertyGroup>',
    `  <PropertyGroup Condition=" '$(Configuration)' == 'Debug' ">`,
    '    <DebugSymbols>true</DebugSymbols>',
    '    <EnableUnmanagedDebugging>false</EnableUnmanagedDebugging>',
    '  </PropertyGroup>',
    '  <Import Project="$(MSBuildBinPath)\\Microsoft.Common.targets" />',
    `  <Import Project="$(BuildTasksDirectory)\\${buildTasksTargets}" />`,
    '</Project>',
    '',
  ].join('\n');
}

// ── Choosing ─────────────────────────────────────────────────────────────────

/** Where `$(BuildTasksDirectory)` points by default: `$(MSBuildProgramFiles32)\MSBuild\Microsoft\Dynamics\AX`. */
export function defaultBuildTasksDirectory(): string {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return path.join(programFilesX86, 'MSBuild', 'Microsoft', 'Dynamics', 'AX');
}

/** Names of the .targets files in the build-tasks folder, lowercased; null when it can't be listed. */
async function listTargets(dir: string): Promise<Set<string> | null> {
  try {
    return new Set((await readdir(dir)).filter(n => n.toLowerCase().endsWith('.targets')).map(n => n.toLowerCase()));
  } catch {
    return null;
  }
}

/** The highest-versioned build-tasks targets file of a folder listing ("…BuildTasks.17.0.targets" > "…BuildTasks.targets"). */
export function newestBuildTasksTargets(names: Iterable<string>): string | null {
  let best: { name: string; version: string } | null = null;
  for (const name of names) {
    const m = /^microsoft\.dynamics\.framework\.tools\.buildtasks(?:\.(\d+(?:\.\d+)*))?\.targets$/i.exec(name);
    if (!m) continue;
    const version = m[1] ?? '';
    if (!best || compareVersions(version, best.version) > 0) best = { name, version };
  }
  if (!best) return null;
  // The listing is lowercased; give the name in VS's casing.
  return `Microsoft.Dynamics.Framework.Tools.BuildTasks${best.version ? '.' + best.version : ''}.targets`;
}

interface Candidate { ext: FinanceOperationsExtension; zipPath: string; text: string; targets: string | null }

export interface ResolveOptions {
  /** Visual Studio installations to search; default: all. */
  installations?: string[];
  /** Folder `$(BuildTasksDirectory)` resolves to; default: defaultBuildTasksDirectory(). */
  buildTasksDirectory?: string;
}

/**
 * The template VS would use: the Finance and Operations extension's own, preferring an
 * extension whose build-task targets file is installed (that is what MSBuild loads), then the
 * highest extension version. Falls back to the built-in template.
 */
export async function resolveProjectTemplate(opts: ResolveOptions = {}): Promise<ProjectTemplate> {
  const warnings: string[] = [];
  const info: string[] = [];
  const buildTasksDirectory = opts.buildTasksDirectory ?? defaultBuildTasksDirectory();
  const installed = await listTargets(buildTasksDirectory);
  if (!installed) {
    warnings.push(`The build-tasks folder ${buildTasksDirectory} does not exist or cannot be read; the project cannot be built on this machine.`);
  }

  const extensions = await findFinanceOperationsExtensions(opts.installations);
  const candidates: Candidate[] = [];
  for (const ext of extensions) {
    const zipPath = path.join(ext.dir, TEMPLATE_ZIP);
    try {
      const text = rnrprojFromTemplateZip(await readFile(zipPath));
      // A template this server can't fill completely is not used.
      renderRnrprojFromTemplate(text, { modelName: 'M', projectName: 'P', projectGuid: '{00000000-0000-0000-0000-000000000000}' });
      candidates.push({ ext, zipPath, text, targets: buildTasksTargetsOf(text) });
    } catch (e) {
      const reason = (e as Error).message.replace(/\.$/, '');
      warnings.push(`Skipped the project template of the Finance and Operations extension ${ext.version} in ${ext.dir}: ${reason}.`);
    }
  }

  if (candidates.length) {
    let pool = candidates;
    if (installed) {
      const usable = candidates.filter(c => c.targets && installed.has(c.targets.toLowerCase()));
      if (usable.length) pool = usable;
      else warnings.push(`No Visual Studio project template imports a build-tasks targets file that exists in ${buildTasksDirectory}; the project may not build.`);
    }
    const chosen = [...pool].sort((a, b) => compareVersions(b.ext.version, a.ext.version))[0];
    const others = candidates.filter(c => c !== chosen);
    if (others.length) {
      info.push(`Other Finance and Operations extensions found: ${others.map(c => `${c.ext.version} in ${c.ext.dir}`).join('; ')}.`);
    }
    return {
      text: chosen.text, source: 'visual-studio', zipPath: chosen.zipPath,
      extensionVersion: chosen.ext.version, install: chosen.ext.install, warnings, info,
    };
  }

  const targets = (installed && newestBuildTasksTargets(installed)) || DEFAULT_BUILD_TASKS_TARGETS;
  return { text: builtInTemplateText(targets), source: 'built-in', extensionFound: extensions.length > 0, warnings, info };
}

/**
 * resolveProjectTemplate() with the default options. Not cached: creating a project is rare,
 * and a long-running server must pick up a Visual Studio update.
 */
export function defaultProjectTemplate(): Promise<ProjectTemplate> {
  return resolveProjectTemplate();
}

/** One line for a tool result saying where the project's template came from. */
export function describeProjectTemplate(t: ProjectTemplate): string {
  if (t.source === 'visual-studio') {
    return `template: ${t.zipPath} (Finance and Operations extension ${t.extensionVersion}, ${t.install})`;
  }
  return t.extensionFound
    ? 'template: built-in (the Finance and Operations extension\'s template could not be used)'
    : 'template: built-in (no Finance and Operations extension found in Visual Studio)';
}
