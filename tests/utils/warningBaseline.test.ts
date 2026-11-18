import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  updateWarningBaseline, describeWarningDelta, warningKey, WARNING_BASELINE_FILENAME,
} from '../../src/utils/warningBaseline.js';
import { dropKnownWarnings, parseXppcDiagnostics } from '../../src/tools/sdlc/buildProject.js';

const W = (object: string, message: string, line = 1) => ({
  severity: 'warning' as const, model: 'ContosoExt', kind: 'Class Method', object, member: 'run', line, message,
});

describe('warning baseline', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('first build has no baseline and says nothing', () => {
    const d = updateWarningBaseline(dir, 'ContosoExt', [W('A', 'unused')], false);
    expect(d.hadBaseline).toBe(false);
    expect(describeWarningDelta(d)).toBe('');
    expect(fs.existsSync(path.join(dir, WARNING_BASELINE_FILENAME))).toBe(true);
  });

  it('next build reports only new warnings and counts known ones, ignoring line shifts', () => {
    updateWarningBaseline(dir, 'ContosoExt', [W('A', 'unused', 10), W('B', 'dead')], true);
    const d = updateWarningBaseline(dir, 'ContosoExt', [W('A', 'unused', 42), W('B', 'dead'), W('C', 'fresh')], false);
    expect(d.knownCount).toBe(2);
    expect(d.newWarnings.map(w => w.object)).toEqual(['C']);
    const text = describeWarningDelta(d);
    expect(text).toContain('1 new, 2 known');
    expect(text).toContain('C.run');
    expect(text).not.toContain('A.run');
  });

  it('incremental build merges, full build replaces', () => {
    updateWarningBaseline(dir, 'ContosoExt', [W('A', 'x'), W('B', 'y')], true);
    updateWarningBaseline(dir, 'ContosoExt', [W('C', 'z')], false);
    expect(updateWarningBaseline(dir, 'ContosoExt', [W('A', 'x')], false).knownCount).toBe(1);
    updateWarningBaseline(dir, 'ContosoExt', [W('C', 'z')], true);
    expect(updateWarningBaseline(dir, 'ContosoExt', [W('A', 'x')], false).newWarnings).toHaveLength(1);
  });

  it('baselines are per model', () => {
    updateWarningBaseline(dir, 'ContosoExt', [W('A', 'x')], true);
    expect(updateWarningBaseline(dir, 'ContosoCore', [W('A', 'x')], false).hadBaseline).toBe(false);
  });

  it('dropKnownWarnings removes known warning lines from the excerpt only', () => {
    const line = (o: string) =>
      `Compile Warning: Class Method dynamics://ContosoExt/${o}/run: [(3,1),(3,5)]: unused`;
    const log = [line('A'), line('C'), 'Errors: 0'].join('\n');
    const known = parseXppcDiagnostics(line('A'))[0];
    const delta = updateWarningBaseline(dir, 'ContosoExt', [known], true);
    const next = updateWarningBaseline(dir, 'ContosoExt', parseXppcDiagnostics(log), false);
    expect(delta.hadBaseline).toBe(false);
    const out = dropKnownWarnings(log, next);
    expect(out).toContain('ContosoExt/C/run');
    expect(out).not.toContain('ContosoExt/A/run');
    expect(out).toContain('Errors: 0');
    expect(warningKey(known)).not.toContain('3');
  });
});
