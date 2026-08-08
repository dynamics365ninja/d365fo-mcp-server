/**
 * generateMetadata.ts
 *
 * Regenerates D365FO runtime metadata manifests (.md files) from XML source
 * after an xppc compile, without requiring a full VS build.
 *
 * xppc.exe compiles X++ source into .netmodule files but does NOT update the
 * binary .md manifests that the AOS uses to resolve class names at runtime.
 * VS BuildTask does this as a post-compile step using the MetadataProviderFactory
 * + RuntimeMetadataWriter APIs from Microsoft.Dynamics.AX.Metadata.Storage.dll.
 *
 * This module replicates that step by:
 *  1. Compiling a small .NET Framework 4.x helper (GenerateMetadata.exe) on
 *     first use, referencing the DLLs from the D365FO framework directory.
 *  2. Running the compiled helper after each successful xppc build.
 *
 * The helper exe is cached in the framework `bin` directory (so .NET resolves
 * the referenced Dynamics DLLs via the application base) under a name that
 * embeds a short hash of its C# source. It therefore survives MCP server
 * restarts and is recompiled automatically both when D365FO is upgraded (new
 * framework directory) and when the helper source below changes (new hash).
 */

import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import crypto from 'crypto';
import { access, writeFile, unlink, cp } from 'fs/promises';

const execFileAsync = util.promisify(execFile);

// C# source for the helper — compiled on first use

const CS_SOURCE = `
using System;
using System.IO;
using Microsoft.Dynamics.AX.Metadata.Storage;
using Microsoft.Dynamics.AX.Metadata.Storage.Runtime;

class GenerateMetadata
{
    static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("Usage: GenerateMetadata.exe <metadataDir> <modelName> <outputDir>");
            return 1;
        }

        string metadataDir = args[0];
        string modelName   = args[1];
        string outputDir   = args[2];

        try
        {
            var factory  = new MetadataProviderFactory();
            var provider = factory.CreateDiskProvider(metadataDir);
            var version  = new Version(1, 0, 0, 0);
            RuntimeMetadataWriter.WriteAll(provider, modelName, outputDir, version, false, null);
            Console.WriteLine("OK: runtime metadata written for " + modelName);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("GenerateMetadata error: " + ex.Message);
            for (var inner = ex.InnerException; inner != null; inner = inner.InnerException)
                Console.Error.WriteLine("  -> " + inner.Message);
            return 1;
        }
    }
}
`.trim();

// Short hash of the helper source. Embedded in the cached exe name so that any
// edit to CS_SOURCE produces a new file name and the stale exe is never reused
// (editing the C# without this would silently keep running the old binary).
const HELPER_VERSION = crypto.createHash('sha256').update(CS_SOURCE).digest('hex').slice(0, 8);

// csc.exe locations (.NET Framework 4.x, built into Windows)

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

async function findCscExe(): Promise<string | null> {
  for (const c of CSC_CANDIDATES) {
    try { await access(c); return c; } catch { /* next */ }
  }
  return null;
}

// Compile helper (once per framework version)

function exeCachePath(frameworkBinDir: string): string {
  // Place the exe in the framework bin directory itself so .NET finds the
  // referenced Dynamics DLLs via the application base directory at runtime.
  // The source-hash suffix forces a rebuild whenever CS_SOURCE changes.
  return path.join(frameworkBinDir, `D365McpGenerateMetadata.${HELPER_VERSION}.exe`);
}

async function compileHelper(
  cscExe: string,
  frameworkBinDir: string,
  exePath: string,
): Promise<void> {
  const csFile = exePath.replace(/\.exe$/, '.cs');

  await writeFile(csFile, CS_SOURCE, 'utf-8');

  const refs = [
    'Microsoft.Dynamics.AX.Metadata.Core.dll',
    'Microsoft.Dynamics.AX.Metadata.dll',
    'Microsoft.Dynamics.AX.Metadata.Storage.dll',
  ].map(dll => `/reference:${path.join(frameworkBinDir, dll)}`);

  try {
    await execFileAsync(cscExe, [
      '/nologo',
      `/out:${exePath}`,
      '/target:exe',
      '/platform:x64',
      ...refs,
      csFile,
    ], { timeout: 30_000 });
  } finally {
    await unlink(csFile).catch(() => {});
  }
}

// Compiler-metadata sync: xppc writes compiled X++ compiler metadata (XppMetadata tree) to the
// -compilermetadata root, which can differ from the -metadata source root in an MCP-only build.
// RuntimeMetadataWriter needs both source and compiler metadata under one root, so we overlay the
// freshly written XppMetadata onto the source root before generating runtime manifests. Overlay
// (not mirror) is safe — orphan compiler metadata with no matching source is harmless since the
// provider enumerates classes from the source XML.

async function syncCompilerMetadata(
  compilerMetadataRoot: string,
  metadataRoot: string,
  modelName: string,
): Promise<string> {
  const src  = path.join(compilerMetadataRoot, modelName, 'XppMetadata');
  const dest = path.join(metadataRoot, modelName, 'XppMetadata');

  // Same root (e.g. CHE where -metadata == -compilermetadata) — nothing to do.
  if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) {
    return 'compiler metadata already co-located with source';
  }

  try {
    await access(src);
  } catch {
    return `no compiler metadata to sync (not found at ${src})`;
  }

  await cp(src, dest, { recursive: true, force: true });
  return `compiler metadata synced from ${src}`;
}

// Public API

export interface GenerateMetadataResult {
  skipped: boolean;
  success: boolean;
  message: string;
}

/**
 * Regenerate the .md runtime metadata manifests for `modelName` from its XML
 * source. Called after a successful xppc build.
 *
 * @param microsoftPackagesPath  Framework directory (FrameworkDirectory / PackagesLocalDirectory for CHE)
 * @param customPackagesPath     Model store root — the directory that contains the model folder
 * @param modelName              Model to regenerate manifests for
 */
export async function generateRuntimeMetadata(
  microsoftPackagesPath: string,
  customPackagesPath: string,
  modelName: string,
): Promise<GenerateMetadataResult> {
  const frameworkBinDir = path.join(microsoftPackagesPath, 'bin');
  const outputDir       = path.join(customPackagesPath, modelName, 'bin');

  // Verify at least one of the required DLLs exists before attempting anything
  const storageDll = path.join(frameworkBinDir, 'Microsoft.Dynamics.AX.Metadata.Storage.dll');
  try {
    await access(storageDll);
  } catch {
    return {
      skipped: true,
      success: false,
      message: `Skipped metadata regeneration — Microsoft.Dynamics.AX.Metadata.Storage.dll not found at ${frameworkBinDir}`,
    };
  }

  const cscExe = await findCscExe();
  if (!cscExe) {
    return {
      skipped: true,
      success: false,
      message: 'Skipped metadata regeneration — csc.exe not found (expected at C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe)',
    };
  }

  const exePath = exeCachePath(frameworkBinDir);

  // Compile helper if not yet cached for this framework version
  try {
    await access(exePath);
  } catch {
    try {
      await compileHelper(cscExe, frameworkBinDir, exePath);
    } catch (compileErr: any) {
      return {
        skipped: false,
        success: false,
        message: `Failed to compile GenerateMetadata helper: ${compileErr.message}`,
      };
    }
  }

  // Co-locate the freshly compiled compiler metadata with the source before the
  // runtime writer reads it (see syncCompilerMetadata for why this is required
  // for newly added classes in an MCP-only build).
  let syncMessage: string;
  try {
    syncMessage = await syncCompilerMetadata(microsoftPackagesPath, customPackagesPath, modelName);
  } catch (syncErr: any) {
    return {
      skipped: false,
      success: false,
      message: `Failed to sync compiler metadata: ${syncErr.message}`,
    };
  }

  // Run the helper
  try {
    const { stdout, stderr } = await execFileAsync(
      exePath,
      [customPackagesPath, modelName, outputDir],
      { timeout: 60_000 },
    );
    const output = [stdout, stderr].filter(Boolean).join('\n').trim();
    const message = [syncMessage, output].filter(Boolean).join(' | ') || 'Runtime metadata regenerated';
    return { skipped: false, success: true, message };
  } catch (runErr: any) {
    const output = [runErr.stdout, runErr.stderr, runErr.message].filter(Boolean).join('\n');
    return { skipped: false, success: false, message: `GenerateMetadata.exe failed: ${output}` };
  }
}
