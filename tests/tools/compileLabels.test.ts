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
} from '../../src/tools/compileLabels';
import { describeLabelCompilation } from '../../src/tools/buildProject';

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
    expect(await labelAssembliesAreStale([labelDir], path.join(packageDir, 'Resources'), MODEL)).toBe(true);
  });

  it('is true when a label file was edited after the assembly was built', async () => {
    const builtAt = Date.now() - 60_000;
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(resourcesDir, `${MODEL}.dll`), builtAt);
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Contoso.en-US.label.txt'), builtAt + 30_000);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir, MODEL)).toBe(true);
  });

  it('is false when the assembly is newer than every label source', async () => {
    const builtAt = Date.now();
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(labelDir, 'LabelResources', 'en-US', 'Contoso.en-US.label.txt'), builtAt - 60_000);
    await writeAt(path.join(resourcesDir, `${MODEL}.dll`), builtAt);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir, MODEL)).toBe(false);
  });

  it('sees a label file nested several folders deep', async () => {
    const builtAt = Date.now() - 60_000;
    const labelDir = path.join(packageDir, MODEL, 'AxLabelFile');
    const resourcesDir = path.join(packageDir, 'Resources');
    await writeAt(path.join(resourcesDir, `${MODEL}.dll`), builtAt);
    await writeAt(path.join(labelDir, 'LabelResources', 'de', 'deep', 'Contoso.de.label.txt'), builtAt + 5_000);
    expect(await labelAssembliesAreStale([labelDir], resourcesDir, MODEL)).toBe(true);
  });
});

describe('labelcArgs', () => {
  it('matches the invocation Visual Studio records in CompileLabels.xml', () => {
    // K:\...\bin\labelc.exe -metadata="K:\AosService\PackagesLocalDirectory"
    //   -output="K:\AosService\PackagesLocalDirectory\Demo\Resources"
    //   -modelmodule="Demo"
    const args = labelcArgs('K:\\AosService\\PackagesLocalDirectory', 'Demo',
      'K:\\AosService\\PackagesLocalDirectory\\Demo\\Resources', null, null);
    expect(args).toEqual([
      '-Metadata=K:\\AosService\\PackagesLocalDirectory',
      '-Output=K:\\AosService\\PackagesLocalDirectory\\Demo\\Resources',
      '-ModelModule=Demo',
    ]);
  });

  it('pins csc and the SDK tools when they were located', () => {
    // labelc otherwise resolves csc/al/resgen from PATH, which the MCP server
    // does not control — VS gets away with it because it runs from a dev shell.
    const args = labelcArgs('K:\\PLD', 'Contoso', 'K:\\PLD\\Contoso\\Resources',
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',
      'C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools');
    expect(args).toContain('-CompilerPath=C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319');
    expect(args).toContain(
      '-SdkToolsPath=C:\\Program Files (x86)\\Microsoft SDKs\\Windows\\v10.0A\\bin\\NETFX 4.8 Tools',
    );
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
    vi.doMock('../../src/tools/compileLabels.js', () => ({
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
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
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

    const { buildProjectTool } = await import('../../src/tools/buildProject');
    await buildProjectTool({ wait: false }, {});

    expect(order).toEqual(['labelc', 'xppc']);

    vi.doUnmock('../../src/tools/compileLabels.js');
    vi.resetModules();
  });
});
