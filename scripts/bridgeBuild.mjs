#!/usr/bin/env node
/**
 * Builds the C# bridge and, on success, refreshes bridge/build-attestation.json.
 *
 * Two deliberate choices:
 *
 *  • `--no-incremental`. An incremental build can report "Build succeeded" without
 *    recompiling the file you just edited, which is exactly the false clean this gate
 *    exists to prevent.
 *  • Output goes to a scratch directory, never the repo's bin/. A bridge process
 *    started by an MCP client holds a lock on the deployed binary; building over it
 *    either fails or, worse, leaves the OLD binary in place while reporting success.
 *
 * The metamodel FileVersion is scraped from the csproj's own CaptureMetamodelBuildVersion
 * message so the attestation records WHICH D365FO build the sources compiled against.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROJECT = join(REPO_ROOT, 'bridge', 'D365MetadataBridge');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // No `shell: true` — dotnet/node are real executables, and shelling out with
    // concatenated args is both a quoting hazard and a deprecation warning (DEP0190).
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
    let stdout = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

const outDir = mkdtempSync(join(tmpdir(), 'd365fo-bridge-build-'));

try {
  const log = await run('dotnet', ['build', PROJECT, '-c', 'Release', '--no-incremental', '-o', outDir]);

  const metamodel = /compiles against metamodel (\S+)/.exec(log)?.[1] ?? '';
  if (!metamodel) {
    console.error(
      '\n[bridge:build] Build succeeded but no metamodel version was reported — the D365FO bin\n' +
      'directory was not found, so the project compiled without its references. That is not a\n' +
      'real compile check; refusing to attest it.\n',
    );
    process.exit(1);
  }

  await run(process.execPath, [join(REPO_ROOT, 'scripts', 'bridgeAttest.mjs'), 'write', `--metamodel=${metamodel}`], { shell: false });
  console.log(`[bridge:build] done — output in ${outDir} (scratch; the deployed binary was not touched).`);
} catch (err) {
  console.error(`[bridge:build] ${err.message}`);
  process.exit(1);
}
