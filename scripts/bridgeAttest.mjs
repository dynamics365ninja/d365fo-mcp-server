/**
 * Bridge build attestation — the only gate that can prove a C# change was compiled.
 *
 * No shebang: this module is imported by tests, and vitest's transform chokes on one.
 * It is always invoked as `node scripts/bridgeAttest.mjs …`, so nothing needs it.
 *
 * The bridge references Microsoft.Dynamics.AX.Metadata assemblies that exist ONLY on a
 * D365FO development machine. GitHub-hosted runners do not have them, the repo is public
 * so they cannot be vendored, and there are no self-hosted runners — so no CI job can
 * compile `bridge/**`. That is easy to miss, because the repo's CodeQL setup contributes
 * a green `Analyze (csharp)` check that runs with `build-mode: none` (buildless
 * extraction) and compiles nothing. A C# mistake therefore reaches a VM as a
 * RuntimeBinderException or TypeLoadException, far from its cause.
 *
 * What this closes: `npm run bridge:build` writes bridge/build-attestation.json AFTER a
 * successful compile, recording a hash of the exact sources that compiled plus the
 * metamodel build they compiled against. CI re-hashes the sources and fails when they
 * moved without the attestation moving with them.
 *
 * What it proves: these sources compiled on a machine that has the D365FO assemblies.
 * The file cannot be produced without a successful build — that is the whole point.
 *
 * What it does NOT prove: that the code is correct, or that the metamodel on the
 * author's VM matches production. It is a compile gate, not a test.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BRIDGE_DIR = join(REPO_ROOT, 'bridge', 'D365MetadataBridge');
const ATTESTATION = join(REPO_ROOT, 'bridge', 'build-attestation.json');

/** Everything that feeds the compiler. obj/ and bin/ are build output, not input. */
const SOURCE_EXTENSIONS = ['.cs', '.csproj'];
const SKIP_DIRS = new Set(['obj', 'bin']);

export function collectSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collectSources(join(dir, entry.name)));
    } else if (SOURCE_EXTENSIONS.some(e => entry.name.endsWith(e))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Hash of the compiler's inputs.
 *
 * Paths are normalised to forward slashes and sorted so the digest is identical on the
 * Windows VM that writes it and the Linux runner that checks it. Line endings are
 * normalised too: git may hand out CRLF on one and LF on the other, which would
 * otherwise fail every check for a reason that has nothing to do with the code.
 */
export function hashSources(dir = BRIDGE_DIR, root = REPO_ROOT) {
  const files = collectSources(dir).sort();
  const digest = createHash('sha256');
  const manifest = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const content = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
    const fileHash = createHash('sha256').update(content).digest('hex');
    digest.update(`${rel}:${fileHash}\n`);
    manifest.push(rel);
  }
  return { hash: digest.digest('hex'), fileCount: manifest.length };
}

function write() {
  const { hash, fileCount } = hashSources();
  const metamodel = process.argv.find(a => a.startsWith('--metamodel='))?.slice('--metamodel='.length) ?? '';
  const payload = {
    _comment:
      'Written by `npm run bridge:build` after a SUCCESSFUL compile. Proves these bridge ' +
      'sources compiled against the D365FO metadata assemblies, which no CI runner has. ' +
      'Do not hand-edit — regenerate by building.',
    sourceHash: hash,
    sourceFileCount: fileCount,
    metamodelFileVersion: metamodel,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(ATTESTATION, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(`[bridge-attest] wrote ${relative(REPO_ROOT, ATTESTATION)} (${fileCount} sources, metamodel ${metamodel || 'unknown'})`);
}

function check() {
  if (!existsSync(ATTESTATION)) {
    fail('bridge/build-attestation.json is missing entirely.');
  }
  const recorded = JSON.parse(readFileSync(ATTESTATION, 'utf-8'));
  const { hash, fileCount } = hashSources();
  if (recorded.sourceHash === hash) {
    console.log(
      `[bridge-attest] OK — ${fileCount} bridge sources match the attested build ` +
      `(metamodel ${recorded.metamodelFileVersion || 'unknown'}, built ${recorded.builtAt}).`,
    );
    return;
  }
  fail(
    `bridge sources changed but the attestation did not.\n` +
    `  attested: ${recorded.sourceHash}\n` +
    `  current:  ${hash}`,
  );
}

function fail(reason) {
  console.error(
    `\n[bridge-attest] FAILED — ${reason}\n\n` +
    `A change under bridge/ was not compiled. No CI job can compile it: the D365FO\n` +
    `metadata assemblies exist only on a D365FO development machine, and the green\n` +
    `"Analyze (csharp)" check is CodeQL running build-mode:none, which compiles nothing.\n\n` +
    `On a machine with K:\\AosService\\PackagesLocalDirectory (or wherever the D365 bin\n` +
    `directory lives), run:\n\n` +
    `    npm run bridge:build\n\n` +
    `then commit the refreshed bridge/build-attestation.json together with your change.\n`,
  );
  process.exit(1);
}

// CLI only when run directly — hashSources is imported by tests, and an unguarded
// argv switch would process.exit(2) the moment the test file imports this module.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const mode = process.argv[2];
  if (mode === 'write') write();
  else if (mode === 'check') check();
  else {
    console.error('usage: node scripts/bridgeAttest.mjs <write|check> [--metamodel=<version>]');
    process.exit(2);
  }
}
