/**
 * extract-metadata end-to-end smoke test — the write path, actually executed.
 *
 * Why a spawned run and not another unit test: the orphan sweep landed with unit
 * coverage for pruneOrphanedMetadata and none at all for the function that feeds it,
 * writeMetadataJson. A search-and-replace that rewrote the 17 `fs.writeFile` call
 * sites also rewrote the helper's OWN body, so writeMetadataJson called itself —
 * every file died with "RangeError: Maximum call stack size exceeded", extraction
 * wrote zero JSON, and 3356 green tests said nothing, because none of them runs the
 * script. Only the error guard ("a model with errors is not swept") stopped an empty
 * write set from being read as "every object was deleted".
 *
 * So this test asserts the two things unit tests structurally cannot:
 *   - the script runs to completion over a real directory tree and writes JSON
 *   - a genuinely orphaned JSON is swept, and live ones are not
 *
 * Regression guards:
 *   - stderr MUST NOT contain a stack-overflow / unhandled rejection
 *   - extraction MUST report zero errors on well-formed input
 *   - a model that read XML but wrote nothing MUST NOT be swept (the blast radius
 *     of exactly the bug above)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmp: string;
const p = (...seg: string[]) => path.join(tmp, ...seg);

async function write(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

const exists = async (f: string) => fs.access(f).then(() => true, () => false);

/** Run the script over the sandbox tree and return its combined output. */
async function runExtract(): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx/esm', path.join(REPO, 'scripts', 'extract-metadata.ts')],
    {
      cwd: REPO,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        METADATA_PATH: p('out'),
        D365FO_PACKAGE_PATH: p('pkg'),
        EXTRACT_MODE: 'custom',
        DEV_ENVIRONMENT_TYPE: 'traditional',
        CUSTOM_MODELS: 'MyModel',
      },
    },
  );
  return stdout + stderr;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-run-'));
  await write(
    p('pkg', 'MyModel', 'MyModel', 'AxEnum', 'MyEnum.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>MyEnum</Name>' +
    '<EnumValues><AxEnumValue><Name>A</Name></AxEnumValue></EnumValues></AxEnum>\n',
  );
  await write(
    p('pkg', 'MyModel', 'MyModel', 'AxClass', 'MyClass.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<AxClass><Name>MyClass</Name>' +
    '<SourceCode><Declaration>class MyClass {}</Declaration></SourceCode></AxClass>\n',
  );
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('extract-metadata (spawned)', () => {
  it('writes JSON for every source file without blowing the stack', async () => {
    const out = await runExtract();

    expect(out).not.toMatch(/Maximum call stack size exceeded/);
    expect(out).not.toMatch(/Exception in PromiseRejectCallback/);
    expect(out).toMatch(/No errors/);

    expect(await exists(p('out', 'MyModel', 'enums', 'MyEnum.json'))).toBe(true);
    expect(await exists(p('out', 'MyModel', 'classes', 'MyClass.json'))).toBe(true);
  }, 60_000);

  it('sweeps an orphan and keeps the live files beside it', async () => {
    await write(p('out', 'MyModel', 'enums', 'GhostEnum.json'), '{"raw":"<AxEnum/>"}');

    const out = await runExtract();

    expect(out).toMatch(/Pruned 1 orphaned JSON file/);
    expect(await exists(p('out', 'MyModel', 'enums', 'GhostEnum.json'))).toBe(false);
    expect(await exists(p('out', 'MyModel', 'enums', 'MyEnum.json'))).toBe(true);
    expect(await exists(p('out', 'MyModel', 'classes', 'MyClass.json'))).toBe(true);
  }, 60_000);

  it('refuses to sweep a model that read XML but wrote nothing', async () => {
    // The blast radius of a broken writer: an empty write set otherwise reads as
    // "every object under this model was deleted". Simulated by making every source
    // file unparseable, which is the same observable state.
    await fs.rm(p('pkg', 'MyModel', 'MyModel', 'AxEnum', 'MyEnum.xml'));
    await fs.rm(p('pkg', 'MyModel', 'MyModel', 'AxClass', 'MyClass.xml'));
    await write(p('pkg', 'MyModel', 'MyModel', 'AxClass', 'Broken.xml'), '<<<not xml at all');
    await write(p('out', 'MyModel', 'enums', 'Existing.json'), '{"raw":"<AxEnum/>"}');

    const out = await runExtract();

    expect(out).toMatch(/Orphan sweep skipped/);
    expect(await exists(p('out', 'MyModel', 'enums', 'Existing.json'))).toBe(true);
  }, 60_000);
});
