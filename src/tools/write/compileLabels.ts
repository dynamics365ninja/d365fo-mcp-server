/**
 * compileLabels.ts
 *
 * Compiles a model's label files into resource assemblies with labelc.exe.
 *
 * A label written through `labels(action="create")` lands as a line in
 * `<model>\AxLabelFile\LabelResources\<lang>\<file>.<lang>.label.txt`. Nothing
 * reads that text file at compile time: the compiler and the best-practice
 * checker resolve `@LabelFile:Id` against the compiled resource assembly at
 * `<model>\Resources\<LabelFile>.dll`, which only labelc.exe produces.
 *
 * This server never ran labelc, so on a model whose labels had only ever been
 * created through the MCP tools the `Resources` folder did not exist at all —
 * every reference to a freshly created label was reported as an unknown label.
 * Observed 2026-07-29 in the Contoso eval sandbox: two `BPErrorUnknownLabel`
 * plus five `BPUnusedStrFmtArgument` cascading from them, all six of which
 * vanished after a manual labelc run with no source change whatsoever. That
 * makes it the worst kind of diagnostic — it points at correct code, and the
 * only way to clear it is a step the tool never mentions.
 *
 * VS runs label compilation BEFORE the X++ compile, and so must this: labelc
 * after xppc would leave the current build reporting the stale errors and only
 * clear them on the next one.
 */

import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import { access, readdir, stat } from 'fs/promises';
import { findFrameworkTool } from '../../utils/frameworkBin.js';

const execFileAsync = util.promisify(execFile);

/** labelc spawns csc/al/resgen per label file; a big model takes a few seconds. */
const LABELC_TIMEOUT_MS = 5 * 60 * 1000;

export interface CompileLabelsResult {
  /** True when labelc was not run at all (nothing to do, or it could not be found). */
  skipped: boolean;
  /** False only when a run was attempted and failed. */
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Toolchain discovery
//
// labelc shells out to csc.exe, al.exe and resgen.exe and finds them on PATH
// — which is what VS relies on. The MCP server does not control the PATH it
// inherits, so the directories are located here and put first on labelc's own
// PATH, falling back to the inherited PATH when they cannot be found.
//
// They are NOT passed as -CompilerPath / -SdkToolsPath. labelc 7.0.8199.32
// lists both in its usage text but does not parse them: given either, with or
// without spaces in the value, it prints the usage text and compiles nothing.
// PATH is the lookup every labelc version falls back to.
// ---------------------------------------------------------------------------

const CSC_DIRS = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319',
];

const SDK_BASES = [
  'C:\\Program Files (x86)\\Microsoft SDKs\\Windows',
  'C:\\Program Files\\Microsoft SDKs\\Windows',
];

async function findCscDir(): Promise<string | null> {
  for (const dir of CSC_DIRS) {
    try { await access(path.join(dir, 'csc.exe')); return dir; } catch { /* next */ }
  }
  return null;
}

/** Directory holding both al.exe and resgen.exe, newest SDK first. */
async function findSdkToolsDir(): Promise<string | null> {
  for (const base of SDK_BASES) {
    let versions: string[];
    try {
      versions = (await readdir(base)).sort().reverse();
    } catch {
      continue;
    }
    for (const version of versions) {
      const binDir = path.join(base, version, 'bin');
      let subDirs: string[] = [];
      try {
        subDirs = (await readdir(binDir)).filter(name => /^NETFX .* Tools$/i.test(name)).sort().reverse();
      } catch {
        continue;
      }
      // The versioned "NETFX x.y Tools" subfolders first, then bin itself for
      // older SDK layouts that put the tools directly there.
      for (const sub of [...subDirs, '']) {
        const dir = sub ? path.join(binDir, sub) : binDir;
        try {
          await access(path.join(dir, 'al.exe'));
          await access(path.join(dir, 'resgen.exe'));
          return dir;
        } catch { /* next */ }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// What needs compiling
// ---------------------------------------------------------------------------

/**
 * Every `AxLabelFile` directory in a model package.
 *
 * A package folder contains one folder per model it holds, and the label files
 * sit one level below that — `Contoso\Contoso\AxLabelFile`. The inner name is
 * the MODEL name, which need not equal the package name, so the layout is
 * discovered rather than assumed.
 */
export async function findLabelFileDirs(packageDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(packageDir);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(packageDir, entry, 'AxLabelFile');
    try {
      await access(candidate);
      hits.push(candidate);
    } catch { /* not a model folder with labels */ }
  }
  return hits;
}

/**
 * Newest source mtime per label file ID under `dirs`: its
 * `<id>.<lang>.label.txt` files and its `<id>_<lang>.xml` descriptors.
 */
async function newestSourcePerLabelFile(dirs: string[]): Promise<Map<string, number>> {
  const newest = new Map<string, number>();
  const stack = [...dirs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const id = /^(.+)\.[^.]+\.label\.txt$/i.exec(entry.name)?.[1] ?? /^(.+)_[^_]+\.xml$/i.exec(entry.name)?.[1];
      if (!id) continue;
      try {
        const { mtimeMs } = await stat(full);
        if (mtimeMs > (newest.get(id) ?? 0)) newest.set(id, mtimeMs);
      } catch { /* vanished mid-scan */ }
    }
  }
  return newest;
}

/**
 * Whether the compiled assemblies no longer describe the label sources.
 *
 * Missing output counts as stale, so the case this defect was found in — a
 * model that never had a `Resources` folder — always compiles. Errs toward
 * recompiling: labelc costs about a second, while skipping a needed run
 * reinstates the bogus unknown-label errors this module exists to prevent.
 */
export async function labelAssembliesAreStale(
  labelDirs: string[],
  resourcesDir: string,
): Promise<boolean> {
  // labelc emits one assembly per LABEL FILE — Resources\<LabelFileId>.dll —
  // not one per module. Looking for Resources\<module>.dll found nothing on any
  // model whose label file is named differently (VLTBase / VLTLabel on the VM),
  // so labelc ran on every build and rewrote Resources. Each assembly is held
  // to its OWN sources: on that model the other nine label files' assemblies
  // are older than VLTLabel's latest edit, and measured against the model's
  // newest source they would keep it stale forever.
  const sources = await newestSourcePerLabelFile(labelDirs);
  // An AxLabelFile folder with no label sources (its last label file deleted,
  // or a model scaffolded with the empty folder) has nothing to compile:
  // answering "stale" ran labelc on every build for no output.
  if (sources.size === 0) return false;
  for (const [id, newestSource] of sources) {
    try {
      if (newestSource > (await stat(path.join(resourcesDir, `${id}.dll`))).mtimeMs) return true;
    } catch {
      return true; // this label file was never compiled
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The arguments VS passes. */
export function labelcArgs(
  customPackagesPath: string,
  modelName: string,
  resourcesDir: string,
): string[] {
  return [
    `-Metadata=${customPackagesPath}`,
    `-Output=${resourcesDir}`,
    `-ModelModule=${modelName}`,
  ];
}

/** `env` with the located toolchain directories first on its PATH. */
export function labelcEnv(
  env: NodeJS.ProcessEnv,
  cscDir: string | null,
  sdkToolsDir: string | null,
): NodeJS.ProcessEnv {
  const toolDirs = [cscDir, sdkToolsDir].filter((d): d is string => !!d);
  if (toolDirs.length === 0) return env;
  // Windows env names are case-insensitive, but a copied env object is not:
  // reuse whatever spelling the inherited PATH has, so it is not duplicated.
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const inherited = env[pathKey];
  // ';' rather than path.delimiter: labelc only runs on Windows, and the
  // result must not depend on the host the tests run on.
  return { ...env, [pathKey]: [...toolDirs, ...(inherited ? [inherited] : [])].join(';') };
}

/** The lines worth keeping out of labelc's verbose progress report. */
function summarise(output: string): string {
  const interesting = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^(Done compiling|Completed label compilation|error|warning)/i.test(line));
  return interesting.join(' | ') || 'labelc reported no output';
}

/**
 * Compile `modelName`'s labels into `<model>\Resources`. Called before xppc so
 * the compile and BP check that follow can resolve the labels.
 *
 * @param microsoftPackagesPath Framework directory holding `bin\labelc.exe`.
 * @param customPackagesPath    Model store root — the folder containing the model folder.
 * @param modelName             Package/module to compile labels for.
 * @param force                 Recompile even when the assemblies look current (full builds).
 */
export async function compileModelLabels(
  microsoftPackagesPath: string,
  customPackagesPath: string,
  modelName: string,
  force = false,
): Promise<CompileLabelsResult> {
  const packageDir   = path.join(customPackagesPath, modelName);
  const resourcesDir = path.join(packageDir, 'Resources');

  const labelDirs = await findLabelFileDirs(packageDir);
  if (labelDirs.length === 0) {
    return { skipped: true, success: true, message: `${modelName} has no label files` };
  }

  if (!force && !(await labelAssembliesAreStale(labelDirs, resourcesDir))) {
    return { skipped: true, success: true, message: 'label assemblies are up to date' };
  }

  const labelcExe = await findFrameworkTool(microsoftPackagesPath, 'labelc.exe');
  if (!labelcExe) {
    return {
      skipped: true,
      success: false,
      message:
        `labelc.exe not found (looked in ${microsoftPackagesPath}\\bin) — labels will not be ` +
        `compiled, so references to them may be reported as unknown labels`,
    };
  }

  const args = labelcArgs(customPackagesPath, modelName, resourcesDir);

  try {
    const { stdout, stderr } = await execFileAsync(labelcExe, args, {
      timeout: LABELC_TIMEOUT_MS,
      windowsHide: true,
      env: labelcEnv(process.env, await findCscDir(), await findSdkToolsDir()),
    });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    // labelc can report a non-zero compilation result while exiting 0, so the
    // trailing status line is authoritative rather than the process exit code.
    const reported = /Completed label compilation in .* with exit code (\d+)/i.exec(output);
    // No status line means labelc compiled nothing — given arguments it does not
    // parse, it prints its usage text and exits 0. Reporting that as success is
    // how unrebuilt label assemblies went unnoticed behind a green build.
    if (!reported) {
      const excerpt = output.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no output';
      return { skipped: false, success: false, message: `labelc.exe did not report a compilation result: ${excerpt}` };
    }
    if (reported[1] !== '0') {
      return { skipped: false, success: false, message: `labelc.exe reported exit code ${reported[1]}: ${summarise(output)}` };
    }
    return { skipped: false, success: true, message: summarise(output) };
  } catch (err: any) {
    const output = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n').trim();
    return { skipped: false, success: false, message: `labelc.exe failed: ${output}` };
  }
}
