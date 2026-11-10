/**
 * run_bp_check end to end with pipeline parity: xppbp is stubbed, the model store
 * is a real temporary folder. A UDE xppbp without the OperationalDomain /
 * SubscriberAccessLevel rules must still come back with the findings the
 * Azure DevOps build reports, labelled as reproduced, and counted in the verdict.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';

const { execFileMock, xppConfig } = vi.hoisted(() => ({
  execFileMock: vi.fn() as any,
  xppConfig: { customPackagesPath: '', microsoftPackagesPath: '' },
}));

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: async () => undefined,
    getModelName: () => 'Con',
    getProjectPath: async () => null,
    getPackagePath: () => null,
    getCustomPackagesPath: async () => null,
    getMicrosoftPackagesPath: async () => null,
    getActiveXppConfig: async () => xppConfig,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
}));

import { runBpCheckTool } from '../../src/tools/sdlc/runBpCheck.js';
import { resetPropertyRuleCache } from '../../src/tools/sdlc/bpPipelineParity.js';

let store: string;
let framework: string;

function xppbpSays(stdout: string) {
  execFileMock.mockImplementation((_f: string, _a: string[], _o: any, cb: Function) => cb(null, { stdout, stderr: '' }));
}

beforeEach(() => {
  resetPropertyRuleCache();
  store = mkdtempSync(path.join(os.tmpdir(), 'bpparity-e2e-store-'));
  framework = mkdtempSync(path.join(os.tmpdir(), 'bpparity-e2e-fw-'));
  xppConfig.customPackagesPath = store;
  xppConfig.microsoftPackagesPath = framework;
  mkdirSync(path.join(framework, 'Bin'), { recursive: true });
  writeFileSync(path.join(framework, 'Bin', 'xppbp.exe'), '');
  mkdirSync(path.join(framework, 'bin', 'BPExtensions'), { recursive: true });
  writeFileSync(path.join(framework, 'bin', 'BPExtensions', 'Old.dll'), 'MZ no property rules here');
  mkdirSync(path.join(store, 'Con', 'Con', 'AxTable'), { recursive: true });
  writeFileSync(path.join(store, 'Con', 'Con', 'AxTable', 'ConTicket.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n\t<Name>ConTicket</Name>\n\t<Fields />\n</AxTable>\n');
});

afterEach(() => {
  rmSync(store, { recursive: true, force: true });
  rmSync(framework, { recursive: true, force: true });
});

describe('run_bp_check — pipeline parity', () => {
  it('a clean UDE run reports the pipeline property findings, labelled as reproduced', async () => {
    xppbpSays('X++ Best Practice Check\nErrors: 0\nWarnings: 0\n');
    const result: any = await runBpCheckTool({}, {});
    const text = result.content[0].text;
    expect(text.split('\n')[0]).toBe('⚠️ BP Check completed with issues');
    expect(text).toContain('Reproduced pipeline rules (not reported by this xppbp)');
    expect(text).toContain('BPCheckTableOperationalDomainPropertyNotSpecified');
    expect(text).toContain('path: dynamics://Table/ConTicket');
  });

  it('a targeted run on a class gets nothing added', async () => {
    xppbpSays('X++ Best Practice Check\nErrors: 0\nWarnings: 0\n');
    const result: any = await runBpCheckTool({ objects: [{ objectType: 'class', objectName: 'ConA' }] }, {});
    expect(result.content[0].text).not.toContain('Reproduced pipeline rules');
  });

  it('when xppbp reports the rules itself, its answer stands', async () => {
    xppbpSays('BestPractices Warning: AxTable dynamics://Table/ConTicket: BPCheckTableOperationalDomainPropertyNotSpecified: The OperationalDomain property is not set.\nWarnings: 1\n');
    const result: any = await runBpCheckTool({}, {});
    const text = result.content[0].text;
    expect(text).not.toContain('Reproduced pipeline rules');
    expect(text.match(/BPCheckTableOperationalDomainPropertyNotSpecified/g)).toHaveLength(2); // raw line + findings section
  });
});
