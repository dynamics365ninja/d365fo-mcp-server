import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDeployPrerequisites,
  classifyDeployOutcome,
  type DeployLine,
  deployPowerShellArgs,
  deployStdin,
  findModelPackage,
  findPowerPlatformToolsDirs,
  isPlainName,
  parseDeployLine,
  parseVswhereOutput,
  sweepStaleStaging,
} from '../../src/tools/sdlc/udeDeploy';
import { UDE_DEPLOY_LOADER, UDE_DEPLOY_POWERSHELL } from '../../src/tools/sdlc/udeDeployPowerShell';

const status = (message: string): DeployLine => ({ type: 'status', message });
const UPLOAD = 'Upload Finance and Operations Module ContosoExt_1_0_0_1_managed.zip';

/** The lines of a deployment that went through, as Package Deployer reports them. */
const SUCCEEDED: DeployLine[] = [
  { type: 'tools', message: '1.0.0.139 C:\\VS\\Common7\\IDE\\Extensions\\abc' },
  status('Platform 7.0.8199.32, application 10.40.3708.49257'),
  { type: 'module', message: 'ContosoExt' },
  status(`${UPLOAD} - Staging`),
  status(`${UPLOAD} - Applying Application Module - InProgress; DBSync parameters not set or sync kind is none. Skipping DBSync step.`),
  status(`${UPLOAD} - Succeeded`),
  status('External Package Upload Complete'),
  status('FinOpsCloudDevSamplePackage01 deployed.'),
  { type: 'done', message: '' },
];

describe('parseDeployLine', () => {
  it('reads the program\'s JSON lines and keeps anything else as other', () => {
    expect(parseDeployLine('\uFEFF{"type":"status","message":"Importing solutions"}'))
      .toEqual({ type: 'status', message: 'Importing solutions' });
    expect(parseDeployLine('{"type":"done","message":""}')).toEqual({ type: 'done', message: '' });
    expect(parseDeployLine('Add-Type : compilation failed')).toEqual({ type: 'other', message: 'Add-Type : compilation failed' });
    expect(parseDeployLine('{"type":"surprise"}')).toEqual({ type: 'other', message: '{"type":"surprise"}' });
    expect(parseDeployLine('   ')).toBeUndefined();
  });
});

describe('classifyDeployOutcome', () => {
  it('succeeds when every module was applied and the program completed', () => {
    expect(classifyDeployOutcome(SUCCEEDED, 0)).toEqual({ succeeded: true, modules: ['ContosoExt'], toolsVersion: '1.0.0.139' });
  });

  it('fails on an upload error even though the library returned normally', () => {
    // Seen live: DeployFinOpsPackage returns after an upload error, and the program says done.
    const lines = [
      ...SUCCEEDED.slice(0, 4),
      status(`${UPLOAD} - Upload Error: System.ServiceModel.ProtocolException: The formatter threw an exception`),
      status('Installation failed for Finance and Operations application'),
      { type: 'done', message: '' } as DeployLine,
    ];
    const outcome = classifyDeployOutcome(lines, 0);
    expect(outcome.succeeded).toBe(false);
    expect(outcome.reason).toContain('Upload Error');
  });

  it('recognises a module whose name ends in _<digits>', () => {
    const lines = SUCCEEDED.map(l => ({ ...l, message: l.message.replace(/ContosoExt/g, 'ContosoExt_2') }));
    expect(classifyDeployOutcome(lines, 0)).toMatchObject({ succeeded: true, modules: ['ContosoExt_2'] });
  });

  it('does not count one module\'s Succeeded line for another whose name is its prefix', () => {
    const lines: DeployLine[] = [
      { type: 'module', message: 'ContosoExt' },
      { type: 'module', message: 'ContosoExt_2' },
      status('Upload Finance and Operations Module ContosoExt_2_1_0_0_1_managed.zip - Succeeded'),
      { type: 'done', message: '' },
    ];
    expect(classifyDeployOutcome(lines, 0)).toMatchObject({
      succeeded: false,
      reason: 'The environment never reported ContosoExt as applied.',
    });
  });

  it('fails when a module was never reported as applied', () => {
    const lines = SUCCEEDED.filter(l => !l.message.endsWith('- Succeeded'));
    expect(classifyDeployOutcome(lines, 0)).toMatchObject({ succeeded: false, reason: expect.stringContaining('ContosoExt') });
  });

  it('fails when the program ended without completing', () => {
    const lines = SUCCEEDED.filter(l => l.type !== 'done');
    expect(classifyDeployOutcome(lines, 1)).toMatchObject({
      succeeded: false,
      reason: expect.stringContaining('without reporting completion'),
    });
  });

  it('reports the program\'s own error', () => {
    const lines = [...SUCCEEDED.slice(0, 3), { type: 'error', message: 'The environment refused the deployment: busy' } as DeployLine];
    expect(classifyDeployOutcome(lines, 1)).toMatchObject({ succeeded: false, reason: 'The environment refused the deployment: busy' });
  });

  it('names the members a changed library lacks, and that nothing was uploaded', () => {
    const outcome = classifyDeployOutcome([{ type: 'contract', message: '1.0.0.200: OperationBase.DeploymentPreCheck' }], 3);
    expect(outcome.succeeded).toBe(false);
    expect(outcome.toolsVersion).toBe('1.0.0.200');
    expect(outcome.reason).toContain('OperationBase.DeploymentPreCheck');
    expect(outcome.reason).toContain('Nothing was uploaded');
  });
});

describe('deployPowerShellArgs / deployStdin', () => {
  const REQUEST = {
    extensionDirs: ['C:\\VS\\Common7\\IDE\\Extensions\\x1y2z3w4.abc'],
    packagesLocalDirectory: 'C:\\Users\\José\\PackagesLocalDirectory',
    modulesDir: 'C:\\Temp\\d365deploy-ěš', orgUrl: 'https://contoso-dev.crm.dynamics.com', token: 'token-value',
    packageType: 'Dev' as const, syncKind: 'None' as const,
  };

  it('puts only the constant loader on the command line, never the program or a caller value', () => {
    const args = deployPowerShellArgs();
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[4], 'base64').toString('utf16le')).toBe(UDE_DEPLOY_LOADER);
    expect(UDE_DEPLOY_LOADER).toContain('[Console]::In.ReadToEnd()');
    // The program grows with the contract check; the command line must not.
    expect(`powershell.exe ${args.join(' ')}`.length).toBeLessThan(1_000);
  });

  it('sends the program and the request on stdin as pure ASCII, decoding back exactly', () => {
    const stdin = deployStdin(REQUEST);
    // Windows PowerShell reads redirected stdin in the console code page: only ASCII survives as is.
    expect(stdin).toMatch(/^[ -~]*$/); // printable ASCII: JSON escapes control characters too
    expect(JSON.parse(stdin)).toEqual({ script: UDE_DEPLOY_POWERSHELL, request: REQUEST });
  });

  it('takes its request as a parameter, the token from stdin only', () => {
    expect(UDE_DEPLOY_POWERSHELL.trimStart()).toMatch(/^param\(\$request\)/);
    expect(UDE_DEPLOY_POWERSHELL).not.toMatch(/\$env:|GetEnvironmentVariable/);
    // Early-bound types: without them the msprov_fnopackage upload cannot be serialized.
    expect(UDE_DEPLOY_POWERSHELL).toMatch(/OrganizationWebProxyClient\([^;]+,\s*true\)/);
  });
});

describe('locating', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'ude-deploy-test-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps only installation paths from vswhere output', () => {
    expect(parseVswhereOutput('C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\r\n\r\nD:\\VS\\18\\Preview\n'))
      .toEqual(['C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise', 'D:\\VS\\18\\Preview']);
    expect(parseVswhereOutput('Visual Studio Locator version 3\n')).toEqual([]);
  });

  it('finds the extension folder that holds the deployment library', async () => {
    const install = tempDir();
    const ext = path.join(install, 'Common7', 'IDE', 'Extensions');
    mkdirSync(path.join(ext, 'other'), { recursive: true });
    mkdirSync(path.join(ext, 'x1y2z3w4.abc'), { recursive: true });
    writeFileSync(path.join(ext, 'x1y2z3w4.abc', 'Microsoft.PowerPlatform.VSShared.Util.dll'), '');
    expect(await findPowerPlatformToolsDirs([install, path.join(install, 'missing')])).toEqual([path.join(ext, 'x1y2z3w4.abc')]);
  });

  it('tells a plain model name from a path', () => {
    expect(['ContosoExt', 'Contoso.Ext', 'Contoso_Ext-2'].every(isPlainName)).toBe(true);
    expect(['', '.', '..', '..\\X', '../X', 'a/b', 'C:X', 'a\0b'].some(isPlainName)).toBe(false);
  });

  it('finds the package folder whose descriptor declares the model', async () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'ContosoCore', 'Descriptor'), { recursive: true });
    writeFileSync(path.join(root, 'ContosoCore', 'Descriptor', 'ContosoExt.xml'), '<AxModelInfo/>');
    mkdirSync(path.join(root, 'ContosoTools', 'Descriptor'), { recursive: true });
    writeFileSync(path.join(root, 'ContosoTools', 'Descriptor', 'ContosoTools.xml'), '<AxModelInfo/>');
    expect(await findModelPackage(root, 'ContosoTools')).toBe('ContosoTools');
    expect(await findModelPackage(root, 'ContosoExt')).toBe('ContosoCore');
    expect(await findModelPackage(root, 'ContosoMissing')).toBeUndefined();
    expect(await findModelPackage(path.join(root, 'nope'), 'ContosoExt')).toBeUndefined();
  });
});

describe('sweepStaleStaging', () => {
  const HOUR = 60 * 60_000;
  let root: string;
  let pkg: string;
  /** A staging folder holding a junction to the package, last changed `ageMs` ago. */
  const staging = (name: string, ageMs: number) => {
    const folder = path.join(root, name);
    mkdirSync(folder);
    symlinkSync(pkg, path.join(folder, 'ContosoExt'), 'junction');
    const at = new Date(Date.now() - ageMs);
    utimesSync(folder, at, at);
    return folder;
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ude-sweep-test-'));
    pkg = path.join(root, 'packages', 'ContosoExt');
    mkdirSync(path.join(pkg, 'Descriptor'), { recursive: true });
    writeFileSync(path.join(pkg, 'Descriptor', 'ContosoExt.xml'), '<AxModelInfo/>');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('removes a dead deployment\'s staging folder and its junction, never the package', async () => {
    const stale = staging('d365deploy-old', 3 * HOUR);
    expect(await sweepStaleStaging(root)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(path.join(pkg, 'Descriptor', 'ContosoExt.xml'))).toBe(true);
  });

  it('leaves a folder young enough to belong to a running deployment', async () => {
    const young = staging('d365deploy-new', 30 * 60_000);
    expect(await sweepStaleStaging(root)).toBe(0);
    expect(existsSync(path.join(young, 'ContosoExt', 'Descriptor', 'ContosoExt.xml'))).toBe(true);
  });

  it('leaves a folder holding anything but links, and folders without the prefix', async () => {
    const odd = path.join(root, 'd365deploy-odd');
    mkdirSync(path.join(odd, 'real'), { recursive: true });
    writeFileSync(path.join(odd, 'real', 'keep.txt'), 'x');
    const other = staging('something-else', 3 * HOUR);
    const at = new Date(Date.now() - 3 * HOUR);
    utimesSync(odd, at, at);
    expect(await sweepStaleStaging(root)).toBe(0);
    expect(existsSync(path.join(odd, 'real', 'keep.txt'))).toBe(true);
    expect(existsSync(path.join(other, 'ContosoExt'))).toBe(true);
  });
});

describe('checkDeployPrerequisites', () => {
  const ude = { getDevEnvironmentType: async () => 'ude' as const };
  const env = { D365FO_DATAVERSE_URL: 'https://contoso-dev.crm.dynamics.com' };

  it('refuses together with restartAos', async () => {
    expect(await checkDeployPrerequisites(ude, { restartAos: true }, env))
      .toMatchObject({ ok: false, message: expect.stringContaining('restartAos') });
  });

  it('refuses off UDE', async () => {
    expect(await checkDeployPrerequisites({ getDevEnvironmentType: async () => 'traditional' as const }, {}, env))
      .toMatchObject({ ok: false, message: expect.stringContaining('UDE') });
  });

  it.runIf(process.platform === 'win32')('refuses without a Dataverse URL, naming the setting', async () => {
    expect(await checkDeployPrerequisites(ude, {}, {}))
      .toMatchObject({ ok: false, message: expect.stringContaining('environment.dataverseUrl') });
  });

  it.runIf(process.platform === 'win32')('returns the Dataverse settings on a configured UDE', async () => {
    expect(await checkDeployPrerequisites(ude, {}, env))
      .toMatchObject({ ok: true, dataverse: { url: 'https://contoso-dev.crm.dynamics.com' } });
  });
});
