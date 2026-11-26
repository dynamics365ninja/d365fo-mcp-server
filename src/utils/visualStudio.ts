/**
 * Locating Visual Studio installations and the extensions installed in them. VSIX extensions
 * live one level below `Common7\IDE\Extensions`, in a folder with a random name, so an
 * extension is recognised by a file it ships.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Installation folders from `vswhere -property installationPath`, one per line. */
export function parseVswhereOutput(stdout: string): string[] {
  return stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^[A-Za-z]:\\/.test(l));
}

/**
 * Visual Studio installation folders: every instance vswhere knows (2022, 2026, previews, any
 * edition), else the standard paths.
 */
export async function visualStudioInstallations(): Promise<string[]> {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const found = new Set<string>();
  if (existsSync(vswhere)) {
    try {
      const { stdout } = await execFileAsync(vswhere, ['-all', '-prerelease', '-products', '*', '-property', 'installationPath'],
        { timeout: 15_000, windowsHide: true });
      for (const p of parseVswhereOutput(stdout)) found.add(p);
    } catch { /* fall back to the standard paths */ }
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  for (const version of ['18', '2022']) {
    for (const edition of ['Enterprise', 'Professional', 'Community']) {
      const p = path.join(programFiles, 'Microsoft Visual Studio', version, edition);
      if (existsSync(p)) found.add(p);
    }
  }
  return [...found];
}

/** Extension folders of the given installations, in installation order. */
export async function extensionFolders(installations: string[]): Promise<Array<{ install: string; dir: string }>> {
  const out: Array<{ install: string; dir: string }> = [];
  for (const install of installations) {
    const extensions = path.join(install, 'Common7', 'IDE', 'Extensions');
    let entries: string[];
    try {
      entries = await readdir(extensions);
    } catch {
      continue;
    }
    for (const entry of entries) out.push({ install, dir: path.join(extensions, entry) });
  }
  return out;
}

/** Identity Id of the Finance and Operations developer tools in their `extension.vsixmanifest`. */
export const FINANCE_OPERATIONS_EXTENSION_ID = 'DynamicsFnO.DeveloperTools';

export interface VsixIdentity { id: string; version: string }

/** `<Identity Id=… Version=…>` of a vsixmanifest; null when it has none. */
export function parseVsixIdentity(manifestXml: string): VsixIdentity | null {
  // Comments in the manifest quote a sample Identity element; skip them.
  const xml = manifestXml.replace(/<!--[\s\S]*?-->/g, '');
  const tag = /<Identity\b([^>]*)>/i.exec(xml)?.[1];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
  const id = attr('Id');
  return id ? { id, version: attr('Version') ?? '' } : null;
}

export interface FinanceOperationsExtension {
  /** Visual Studio installation folder. */
  install: string;
  /** The extension's own folder. */
  dir: string;
  version: string;
}

/** Finance and Operations developer tools installed in the given (default: all) Visual Studio installations. */
export async function findFinanceOperationsExtensions(installations?: string[]): Promise<FinanceOperationsExtension[]> {
  const out: FinanceOperationsExtension[] = [];
  for (const { install, dir } of await extensionFolders(installations ?? await visualStudioInstallations())) {
    let manifest: string;
    try {
      manifest = await readFile(path.join(dir, 'extension.vsixmanifest'), 'utf-8');
    } catch {
      continue;
    }
    const identity = parseVsixIdentity(manifest);
    if (identity?.id === FINANCE_OPERATIONS_EXTENSION_ID) out.push({ install, dir, version: identity.version });
  }
  return out;
}

/** Compare dotted version numbers numerically ("7.0.10" > "7.0.9"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
