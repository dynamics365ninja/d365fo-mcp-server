/**
 * Labels must be compiled, and compiled BEFORE the X++ compile. VM-free.
 *
 * Observed 2026-07-29 in the Contoso eval sandbox. Labels created through
 * `labels(action="create")` reached `Contoso.en-US.label.txt`, but
 * `build_d365fo_project` never ran labelc.exe, so `Contoso\Resources\` did not
 * exist after two full builds and the BP check reported:
 *
 *     BPErrorUnknownLabel  ×2
 *     BPUnusedStrFmtArgument ×5   (cascading from the two above)
 *
 * All six vanished after a single manual labelc run with NO source change —
 * the diagnostics were pointing at correct code, and the only cure was a step
 * the tool never took and never mentioned.
 *
 * Ordering is half the fix: xppc and xppbp resolve @Model:Id against the
 * compiled assembly, so a labelc that runs after xppc leaves the current build
 * reporting the stale errors and clears them only on the next one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  findLabelFileDirs,
  labelAssembliesAreStale,
  labelcArgs,
  labelcEnv,
} from '../../src/tools/write/compileLabels';
import { describeLabelCompilation } from '../../src/tools/sdlc/buildProject';

const MODEL = 'Contoso';

let packagesDir: string;
let packageDir: string;

async function writeAt(file: string, at: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'Label=Value\n', 'utf-8');
  await fs.utimes(file, new Date(at), new Date(at));
}

beforeEach(async () => {
  packagesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'labelc-'));
  packageDir = path.join(packagesDir, MODEL);
  await fs.mkdir(packageDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(packagesDir, { recursive: true, force: true });
});

describe('findLabelFileDirs', () => {
  it('finds the label folder one level below the package folder', async () => {
    // Contoso\Contoso\AxLabelFile — the inner name is the MODEL, not the package.
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    await fs.mkdir(labelDir, { recursive: true });
    expect(await findLabelFileDirs(packageDir)).toEqual([labelDir]);
  });

  it('finds label folders of every model in a multi-model package', async () => {
    await fs.mkdir(path.join(packageDir, 'ModelA', 'AxLabelFile'), { recursive: true });
    await fs.mkdir(path.join(packageDir, 'ModelB', 'AxLabelFile'), { recursive: true });
    // A model folder without labels must not be reported.
    await fs.mkdir(path.join(packageDir, 'ModelC', 'AxClass'), { recursive: true });
    const found = await findLabelFileDirs(packageDir);
    expect(found.map(d => path.basename(path.dirname(d))).sort()).toEqual(['ModelA', 'ModelB']);
  });

  it('returns nothing for a package that has no labels at all', async () => {
    await fs.mkdir(path.join(packageDir, MODEL, 'AxClass'), { recursive: true });
    expect(await findLabelFileDirs(packageDir)).toEqual([]);
  });

  it('returns nothing rather than throwing when the package folder is missing', async () => {
    expect(await findLabelFileDirs(path.join(packagesDir, 'NoSuchModel'))).toEqual([]);
  });
});

describe('labelAssembliesAreStale', () => {
  it('is true when Resources does not exist — the incident', async () => {
    // The Contoso sandbox had labels and no Resources folder at all, because
    // labelc had never run. This is the case that must always compile.
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Contoso.en-US.label.txt'), Date.now());
    expect(await labelAssembliesAreStale([labelDir], path.join(packageDir, 'Resources'))).toBe(true);
  });

  it('is false for an AxLabelFile folder that holds no label sources', async () => {
    // Nothing to compile, so labelc must not run on every build for it.
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    await fs.mkdir(path.join(labelDir, 'LabelResources', 'en-US'), { recursive: true });
    expect(await labelAssembliesAreStale([labelDir], path.join(packageDir, 'Resources'))).toBe(false);
  });

  it('is true when a label file was edited after the assembly was built', async () => {
    const builtAt = Date.now() - 60_000;
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(resourcesDir, `${MODEL}.dll`), builtAt);
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Contoso.en-US.label.txt'), builtAt + 30_000);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(true);
  });

  it('is false when the assembly is newer than every label source', async () => {
    const builtAt = Date.now();
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Contoso.en-US.label.txt'), builtAt - 60_000);
    await writeAt(path.join(resourcesDir, `${MODEL}.dll`), builtAt);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(false);
  });

  // labelc names each assembly after its LABEL FILE. On the VM, model VLTBase
  // has label file VLTLabel → Resources\VLTLabel.dll; looking for VLTBase.dll
  // found nothing, so labelc ran — and rewrote Resources — on every build.
  it('is false when the label file\'s own assembly is current, whatever the module is called', async () => {
    const builtAt = Date.now();
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'VLTLabel.en-US.label.txt'), builtAt - 60_000);
    await writeAt(path.join(labelDir, 'LabelResources', 'it', 'VLTLabel.it.label.txt'), builtAt - 60_000);
    await writeAt(path.join(resourcesDir, 'VLTLabel.dll'), builtAt);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(false);
  });

  // VLTBase on the VM: ten label files, all assemblies present; VLTLabel was
  // edited and recompiled later than the other nine were built. Measured
  // against the model's newest source, the nine older assemblies kept it
  // "stale" for good.
  it('holds each assembly to its own label file, not to the newest source in the model', async () => {
    const now = Date.now();
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Old.en-US.label.txt'), now - 600_000);
    await writeAt(path.join(labelDir, 'Old_en-US.xml'), now - 600_000);
    await writeAt(path.join(resourcesDir, 'Old.dll'), now - 300_000);
    await writeAt(path.join(labelDir, 'LabelResources', 'it-IT', 'VLTLabel.it-IT.label.txt'), now - 120_000);
    await writeAt(path.join(resourcesDir, 'VLTLabel.dll'), now);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(false);

    await writeAt(path.join(labelDir, 'Old_en-US.xml'), now - 60_000);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(true);
  });

  it('is true when one of several label files has no assembly yet', async () => {
    const builtAt = Date.now();
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'First.en-US.label.txt'), builtAt - 60_000);
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Second.en-US.label.txt'), builtAt - 60_000);
    await writeAt(path.join(resourcesDir, 'First.dll'), builtAt);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(true);
  });

  it('sees a label file nested several folders deep', async () => {
    const builtAt = Date.now() - 60_000;
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(resourcesDir, `${MODEL}.dll`), builtAt);
    await writeAt(path.join(labelDir, 'LabelResources', 'de', 'deep', 'Contoso.de.label.txt'), builtAt + 5_000);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir)).toBe(true);
  });
});

describe('labelcArgs', () => {
  it('matches the invocation Visual Studio records in CompileLabels.xml', () => {
    // K:\...\bin\labelc.exe -metadata="K:\AosService\PackagesLocalDirectory"
    //   -output="K:\AosService\PackagesLocalDirectory\Demo\Resources"
    //   -modelmodule="Demo"
    const args = labelcArgs('K:\\AosService\\PackagesLocalDirectory', 'Demo',
      'K:\\AosService\\PackagesLocalDirectory\\Demo\\Resources');
    expect(args).toEqual([
      '-Metadata=K:\\AosService\\PackagesLocalDirectory',
      '-Output=K:\\AosService\\PackagesLocalDirectory\\Demo\\Resources',
      '-ModelModule=Demo',
    ]);
  });
});

describe('labelcEnv', () => {
  // labelc resolves csc/al/resgen from PATH, which the MCP server does not
  // control — VS gets away with it because it runs from a dev shell.
  const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const SDK = 'C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools';

  it('puts the located directories before the inherited PATH', () => {
    const env = labelcEnv({ Path: 'C:\\Windows\\system32', OTHER: 'x' }, CSC, SDK);
    expect(env).toEqual({ Path: `${CSC};${SDK};C:\\Windows\\system32`, OTHER: 'x' });
  });

  it('adds only what was located', () => {
    expect(labelcEnv({ PATH: 'C:\\bin' }, null, SDK)).toEqual({ PATH: `${SDK};C:\\bin` });
  });

  it('creates PATH when none was inherited', () => {
    expect(labelcEnv({ OTHER: 'x' }, CSC, null)).toEqual({ OTHER: 'x', PATH: CSC });
  });

  it('leaves the environment alone when nothing was located', () => {
    const env = { PATH: 'C:\\bin' };
    expect(labelcEnv(env, null, null)).toBe(env);
  });
});

describe('describeLabelCompilation', () => {
  it('says nothing when there was nothing to do', () => {
    expect(describeLabelCompilation(MODEL, { skipped: true, success: true, message: 'up to date' })).toBe('');
  });

  it('confirms a real compilation in one line', () => {
    const text = describeLabelCompilation(MODEL, {
      skipped: false, success: true, message: 'Done compiling 1 label files!',
    });
    expect(text).toContain('Labels compiled for Contoso');
    expect(text).toContain('Done compiling 1 label files!');
  });

  it('names the bogus diagnostics a failure will produce', () => {
    // Without this the reader sees BPErrorUnknownLabel on a label that plainly
    // exists and starts editing correct source.
    const text = describeLabelCompilation(MODEL, {
      skipped: true, success: false, message: 'labelc.exe not found',
    });
    expect(text).toContain('FAILED');
    expect(text).toContain('BPErrorUnknownLabel');
  });
});

describe('build ordering', () => {
  it('compiles labels before spawning xppc', async () => {
    // The whole point. labelc after xppc would leave THIS build reporting
    // unknown-label errors and clear them only on the next one.
    const order: string[] = [];

    vi.resetModules();
    vi.doMock('../../src/tools/write/compileLabels.js', () => ({
      compileModelLabels: vi.fn(async () => {
        order.push('labelc');
        return { skipped: false, success: true, message: 'Done compiling 1 label files!' };
      }),
    }));
    vi.doMock('child_process', () => ({
      spawn: vi.fn(() => {
        order.push('xppc');
        return { pid: 4242, unref: vi.fn(), on: vi.fn() };
      }),
      execFile: vi.fn((_f: string, _a: string[], _o: any, cb: Function) => cb(null, { stdout: '', stderr: '' })),
    }));
    vi.doMock('fs', () => ({ openSync: vi.fn().mockReturnValue(3), closeSync: vi.fn() }));
    vi.doMock('fs/promises', () => ({
      access: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      appendFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockRejectedValue(new Error('ENOENT')),
      stat: vi.fn().mockResolvedValue({ mtimeMs: 0 }),
    }));
    vi.doMock('../../src/utils/configManager.js', () => ({
      getConfigManager: () => ({
        ensureLoaded: vi.fn(),
        getProjectPath: vi.fn().mockResolvedValue(null),
        getPackagePath: vi.fn().mockReturnValue(null),
        getContext: vi.fn().mockReturnValue({}),
        getCustomPackagesPath: vi.fn().mockResolvedValue(null),
        getMicrosoftPackagesPath: vi.fn().mockResolvedValue(null),
        getActiveXppConfig: vi.fn().mockResolvedValue(null),
        getModelName: vi.fn().mockReturnValue(MODEL),
      }),
    }));
    vi.doMock('../../src/utils/operationLocks.js', () => ({
      withOperationLock: (_k: string, fn: () => any) => fn(),
      isOperationLockHeld: vi.fn().mockResolvedValue(false),
      forceReleaseLock: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../src/utils/packagesRoot.js', () => ({
      packagesRoots: () => ['K:\\AosService\\PackagesLocalDirectory'],
      findPackagesRoot: () => 'K:\\AosService\\PackagesLocalDirectory',
      packagesRootCandidates: (...rel: string[]) =>
        [path.join('K:\\AosService\\PackagesLocalDirectory', ...rel)],
      defaultPackagesRoot: () => 'K:\\AosService\\PackagesLocalDirectory',
      describePackagesRootScan: () => 'Detected packages roots: K:',
    }));

    const { buildProjectTool } = await import('../../src/tools/sdlc/buildProject');
    await buildProjectTool({ wait: false }, {});

    expect(order).toEqual(['labelc', 'xppc']);

    vi.doUnmock('../../src/tools/write/compileLabels.js');
    vi.resetModules();
  });
});
