/**
 * build_d365fo_project must never replay a finished build's result as the
 * result of a call that compiled nothing. VM-free.
 *
 * Regression, observed 2026-07-28 while capturing the L2-coc-inherited-method
 * golden. A first call hit its wait timeout and handed off ("call again to
 * collect"). The wrapper was then edited to a deliberately uncompilable
 * signature, and the next call returned:
 *
 *     ✅ Build succeeded (xppc.exe, full build (target), incremental (deps))
 *     Metadata Validation | 34,754 | 2022
 *     Compilation ended   | 122,906 | 2023
 *     Errors: 0
 *
 * — byte-identical phase timings from the PREVIOUS run. Two real builds never
 * share millisecond timings. Proof nothing ran: the poisoned XML was written
 * at 15:05:46 while the build log had last been touched at 15:05:04, 42 s
 * EARLIER. Only `force: true` produced the real answer (2 errors).
 *
 * This is the worst failure this tool can have. `pass@build` is the gate the
 * eval loop leans on, and a green describing a tree nobody compiled cannot be
 * told from a real one without checking log mtimes by hand.
 *
 * The fix keys the decision on the disk rather than on the caller's intent,
 * which is unknowable: a finished result may be reused only when no source
 * changed after it ended.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  hasSourceChangesSince,
  finishedResultStillDescribesDisk,
} from '../../src/tools/buildProject';

const MODEL = 'Contoso';

let packagesDir: string;
let modelDir: string;

/** Write a file with an explicit mtime, in seconds relative to `base`. */
async function writeAt(file: string, offsetSec: number, base: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '<AxClass/>', 'utf-8');
  const when = new Date(base + offsetSec * 1000);
  await fs.utimes(file, when, when);
}

/**
 * Backdate every directory under `root`.
 *
 * mkdir stamps directories with "now", and the scan reads directory mtimes on
 * purpose (that is how a deletion is detected), so a fixture built in the
 * present would otherwise look modified no matter what mtimes its FILES carry.
 * Real trees are not built a millisecond before the assertion; these are.
 */
async function backdateDirs(root: string, offsetSec: number, base: number): Promise<void> {
  const when = new Date(base + offsetSec * 1000);
  const stack = [root];
  const dirs: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    dirs.push(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  for (const dir of dirs) await fs.utimes(dir, when, when);
}

beforeEach(async () => {
  packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-stale-'));
  modelDir = path.join(packagesDir, MODEL);
  await fs.mkdir(modelDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(packagesDir, { recursive: true, force: true });
});

const state = (endTime: string | undefined) => ({
  pid: 1234,
  modelName: MODEL,
  targetModel: MODEL,
  tool: 'xppc',
  startTime: new Date(0).toISOString(),
  logFile: 'irrelevant.log',
  status: 'succeeded' as const,
  endTime,
});

describe('hasSourceChangesSince', () => {
  it('is false when every source predates the build', async () => {
    const ended = Date.now();
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), -120, ended);
    await writeAt(path.join(modelDir, 'Descriptor', `${MODEL}.xml`), -300, ended);
    await backdateDirs(modelDir, -300, ended);
    expect(await hasSourceChangesSince(modelDir, ended)).toBe(false);
  });

  it('is true when a source was edited after the build ended (the poisoned-wrapper case)', async () => {
    const ended = Date.now() - 60_000;
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), -120, ended);
    // Edited 42 s AFTER the build finished — the real timeline from the incident.
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'Poisoned.xml'), 42, ended);
    expect(await hasSourceChangesSince(modelDir, ended)).toBe(true);
  });

  it('finds a change nested several folders deep', async () => {
    const ended = Date.now() - 60_000;
    await writeAt(path.join(modelDir, MODEL, 'AxForm', 'Deep', 'Deeper', 'F.xml'), 30, ended);
    expect(await hasSourceChangesSince(modelDir, ended)).toBe(true);
  });

  it('ignores bin/ and XppMetadata/, which the build itself writes', async () => {
    // Without this exclusion every result looks stale and the tool rebuilds forever:
    // these are outputs, so they are ALWAYS newer than the build that produced them.
    const ended = Date.now() - 60_000;
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), -120, ended);
    await writeAt(path.join(modelDir, 'bin', 'Contoso.dll'), 5, ended);
    await writeAt(path.join(modelDir, 'XppMetadata', 'Contoso', 'x.md'), 5, ended);
    await backdateDirs(modelDir, -300, ended);
    expect(await hasSourceChangesSince(modelDir, ended)).toBe(false);
  });

  it('detects a DELETED source, which leaves no file to stat', async () => {
    // Caught by the directory's own mtime. Without that check a removed class
    // reads as "nothing changed" and the stale result is replayed — the same
    // failure as the poisoned wrapper, reached from the other direction.
    const dir = path.join(modelDir, MODEL, 'AxClass');
    await writeAt(path.join(dir, 'A.xml'), -300, Date.now());
    await writeAt(path.join(dir, 'Doomed.xml'), -300, Date.now());
    await backdateDirs(modelDir, -300, Date.now());
    const ended = Date.now();
    await new Promise(r => setTimeout(r, 20));
    await fs.rm(path.join(dir, 'Doomed.xml'));
    expect(await hasSourceChangesSince(modelDir, ended)).toBe(true);
  });

  it('reports "changed" when the tree cannot be read, rather than assuming unchanged', async () => {
    // The two error directions are not equal: a needless rebuild costs minutes,
    // a wrongly reused result reports a compile that never happened.
    expect(await hasSourceChangesSince(path.join(packagesDir, 'no-such-model'), Date.now()))
      .toBe(true);
  });
});

describe('finishedResultStillDescribesDisk', () => {
  it('allows collecting a finished result when nothing changed since', async () => {
    const ended = Date.now() - 10_000;
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), -120, ended);
    await backdateDirs(modelDir, -120, ended);
    expect(await finishedResultStillDescribesDisk(
      state(new Date(ended).toISOString()), MODEL, packagesDir,
    )).toBe(true);
  });

  it('refuses to replay it once a source changed — the incident', async () => {
    const ended = Date.now() - 60_000;
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), 42, ended);
    expect(await finishedResultStillDescribesDisk(
      state(new Date(ended).toISOString()), MODEL, packagesDir,
    )).toBe(false);
  });

  it('refuses a state with no endTime', async () => {
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), -120, Date.now());
    await backdateDirs(modelDir, -120, Date.now());
    expect(await finishedResultStillDescribesDisk(state(undefined), MODEL, packagesDir)).toBe(false);
  });

  it('refuses a state whose endTime is unparseable', async () => {
    await writeAt(path.join(modelDir, MODEL, 'AxClass', 'A.xml'), -120, Date.now());
    expect(await finishedResultStillDescribesDisk(state('not a date'), MODEL, packagesDir))
      .toBe(false);
  });
});
