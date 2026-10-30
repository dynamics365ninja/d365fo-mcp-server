/**
 * How compileModelLabels invokes labelc.exe. VM-free.
 *
 * labelc 7.0.8199.32 (the PackagesLocalDirectory\bin build on a traditional
 * VM) prints `-CompilerPath` and `-SdkToolsPath` in its usage text but does
 * not parse them: given either option, with or without spaces in the value,
 * it prints the usage text and compiles nothing. The label assemblies were
 * then never regenerated, while the X++ compile itself succeeded. What
 * every labelc version does honour is the documented fallback — locating
 * csc.exe, al.exe and resgen.exe on PATH — so the located toolchain has to
 * reach labelc that way instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  execFileMock, CSC_DIR, SDK_BASE, SDK_TOOLS_DIR, METADATA, MODEL, LABEL_DIR,
} = vi.hoisted(() => {
  const SDK_BASE = 'C:\\Program Files (x86)\\Microsoft SDKs\\Windows';
  const METADATA = 'K:\\Repo\\Metadata';
  const MODEL = 'MyModel';
  return {
    execFileMock: vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, { stdout: 'Completed label compilation in 1 seconds with exit code 0.', stderr: '' });
    }),
    CSC_DIR: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',
    SDK_BASE,
    SDK_TOOLS_DIR: `${SDK_BASE}\\v10.0A\\bin\\NETFX 4.8 Tools`,
    METADATA,
    MODEL,
    LABEL_DIR: `${METADATA}\\${MODEL}\\${MODEL}\\AxLabelFile`,
  };
});

// labelc only runs on Windows, but CI runs on Linux: give the code under test
// Windows path semantics so the backslash paths below are what it builds.
vi.mock('path', async () => {
  const p: any = await vi.importActual('path');
  return { ...p.win32, default: p.win32 };
});
vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('../../src/utils/frameworkBin.js', () => ({
  findFrameworkTool: vi.fn(async () => 'K:\\AosService\\PackagesLocalDirectory\\bin\\labelc.exe'),
}));

// A file system holding one model with one label file, never compiled, and
// a located csc + SDK toolchain.
vi.mock('fs/promises', () => {
  const files = new Set([
    `${CSC_DIR}\\csc.exe`,
    `${SDK_TOOLS_DIR}\\al.exe`,
    `${SDK_TOOLS_DIR}\\resgen.exe`,
    LABEL_DIR,
  ]);
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const dirent = (name: string, dir: boolean) => ({ name, isDirectory: () => dir });
  const m = {
    access: vi.fn(async (p: string) => { if (!files.has(p)) throw enoent(p); }),
    readdir: vi.fn(async (p: string, opts?: { withFileTypes?: boolean }) => {
      const listing: Record<string, Array<[string, boolean]>> = {
        [SDK_BASE]: [['v10.0A', true]],
        [`${SDK_BASE}\\v10.0A\\bin`]: [['NETFX 4.8 Tools', true]],
        [`${METADATA}\\${MODEL}`]: [[MODEL, true]],
        [LABEL_DIR]: [['MyLabels_en-US.xml', false]],
      };
      const entries = listing[p];
      if (!entries) throw enoent(p);
      return opts?.withFileTypes ? entries.map(([n, d]) => dirent(n, d)) : entries.map(([n]) => n);
    }),
    stat: vi.fn(async (p: string) => {
      if (p.endsWith('.xml')) return { mtimeMs: 1000 };
      throw enoent(p);
    }),
  };
  return { ...m, default: m };
});

import { compileModelLabels } from '../../src/tools/write/compileLabels';

describe('compileModelLabels — labelc invocation', () => {
  beforeEach(() => { execFileMock.mockClear(); });

  it('passes no option that labelc 7.0.8199.32 rejects', async () => {
    const result = await compileModelLabels('K:\\AosService\\PackagesLocalDirectory', METADATA, MODEL);

    expect(result.success).toBe(true);
    const args: string[] = execFileMock.mock.calls[0][1];
    expect(args).toEqual([
      `-Metadata=${METADATA}`,
      `-Output=${METADATA}\\${MODEL}\\Resources`,
      `-ModelModule=${MODEL}`,
    ]);
  });

  it('puts the located csc and SDK tools first on labelc\'s PATH', async () => {
    await compileModelLabels('K:\\AosService\\PackagesLocalDirectory', METADATA, MODEL);

    const opts = execFileMock.mock.calls[0][2];
    const pathKey = Object.keys(opts.env ?? {}).find(k => k.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
    const entries = String(opts.env[pathKey!]).split(';');
    expect(entries.slice(0, 2)).toEqual([CSC_DIR, SDK_TOOLS_DIR]);
  });

  it('fails a run that printed the usage text instead of compiling', async () => {
    // What labelc 7.0.8199.32 did with -CompilerPath: usage text, exit 0.
    execFileMock.mockImplementationOnce((_file, _args, _opts, cb) => {
      cb(null, { stdout: 'Usage: labelc.exe -metadata=<path> -output=<path> -modelmodule=<name>', stderr: '' });
    });

    const result = await compileModelLabels('K:\\AosService\\PackagesLocalDirectory', METADATA, MODEL);

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.message).toMatch(/did not report a compilation result: Usage: labelc\.exe/);
  });
});
