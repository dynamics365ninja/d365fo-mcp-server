/**
 * update_symbol_index({ model }): re-index what changed in one custom model without
 * the caller naming the files.
 *
 * After a git pull or a Visual Studio session the agent does not know which files
 * moved, so the file form meant listing them one by one (27 calls in one audited
 * session) or working on a stale index. Changes are found per file, against the
 * mtime recorded when that file was indexed — not against last_indexed_at, which
 * every write bumps and so hides a file changed before an unrelated write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const refreshProvider = vi.fn(async () => ({ refreshed: true, elapsedMs: 5 }));
let workspace: string;

vi.mock('../../src/bridge/index.js', () => ({
  bridgeRefreshProvider: vi.fn(async (bridge: any) => (bridge ? refreshProvider() : null)),
}));
vi.mock('../../src/utils/modelClassifier.js', () => ({
  isCustomModel: (m: string) => m.toLowerCase() !== 'applicationsuite',
}));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    getWorkspaceInfoDiagnostics: async () => ({ customPackagesPath: workspace, packagePath: null }),
  }),
}));

import { updateSymbolIndexTool } from '../../src/tools/sdlc/updateSymbolIndex.js';
import { resetRefreshTracking } from '../../src/bridge/debouncedRefresh.js';

const AOT_XML = (name: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>${name}</Name></AxEnum>\n`;

/** Just enough of SymbolIndex for this path, with the two tables it reads kept in memory. */
function makeContext() {
  const symbols = new Map<string, string>();      // lower-cased path -> stored path
  const recorded = new Map<string, number>();     // stored path -> mtime
  const removed: string[] = [];
  const labelFiles = new Map<string, string>();   // lower-cased path -> stored path
  const removedLabels: string[] = [];
  return {
    bridge: { isReady: true, metadataAvailable: true },
    workspaceScanner: { invalidate: vi.fn() },
    symbolIndex: {
      db: { transaction: (fn: () => void) => fn },
      addSymbol: (s: any) => { symbols.set(s.filePath.toLowerCase(), s.filePath); },
      removeSymbolsByFile: (fp: string) => {
        removed.push(fp);
        return { deletedCount: symbols.delete(fp.toLowerCase()) ? 1 : 0, objectNames: [] };
      },
      removeLabelsByFile: (fp: string) => {
        removedLabels.push(fp);
        return labelFiles.delete(fp.toLowerCase()) ? 1 : 0;
      },
      bulkAddLabels: (labels: any[]) => {
        for (const l of labels) labelFiles.set(l.filePath.toLowerCase(), l.filePath);
      },
      touchLastIndexed: vi.fn(),
      recordIndexedFile: (fp: string, mtime: number) => { recorded.set(fp, mtime); },
      forgetIndexedFile: (fp: string) => { recorded.delete(fp); },
      getIndexedFileMtimes: () => new Map([...recorded].map(([k, v]) => [k.toLowerCase(), v])),
      getModelFilePaths: () => [...symbols.values()],
      getIndexedFilePaths: () => [...recorded.keys()],
      getAllLabelFilePaths: () => [...labelFiles.values()],
      symbols, recorded, removed, labelFiles, removedLabels,
    },
  } as any;
}

function writeObject(name: string, folder = 'AxEnum'): string {
  const dir = path.join(workspace, 'ContosoPackage', 'Contoso', folder);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.xml`);
  fs.writeFileSync(file, AOT_XML(name), 'utf-8');
  return file;
}

/** Move a file's mtime forward, the way a pull or an editor save does. */
function touch(file: string): void {
  const later = new Date(fs.statSync(file).mtimeMs + 5_000);
  fs.utimesSync(file, later, later);
}

const textOf = (r: any): string => r.content[0].text;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-model-reindex-'));
  refreshProvider.mockClear();
  resetRefreshTracking();
});

afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* locked */ }
});

describe('update_symbol_index({ model })', () => {
  it('reads every file once on the first pass and records each one', async () => {
    const files = ['ConAlpha', 'ConBeta', 'ConGamma'].map(n => writeObject(n));
    const context = makeContext();

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Indexed : 3 changed or new');
    expect(textOf(result)).toContain('first pass');
    expect([...context.symbolIndex.recorded.keys()].sort()).toEqual(files.sort());
    expect(refreshProvider).toHaveBeenCalledTimes(1);
  });

  it('does nothing, not even a bridge refresh, when no file changed', async () => {
    ['ConAlpha', 'ConBeta'].forEach(n => writeObject(n));
    const context = makeContext();
    await updateSymbolIndexTool({ model: 'Contoso' }, context);
    refreshProvider.mockClear();

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('already indexed');
    expect(textOf(result)).toContain('2 file(s) checked');
    expect(refreshProvider).not.toHaveBeenCalled();
  });

  it('re-indexes only the files whose mtime moved, and names them', async () => {
    const [alpha] = ['ConAlpha', 'ConBeta', 'ConGamma'].map(n => writeObject(n));
    const context = makeContext();
    await updateSymbolIndexTool({ model: 'Contoso' }, context);
    touch(alpha);
    const added = writeObject('ConDelta');

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('Indexed : 2 changed or new');
    expect(textOf(result)).not.toContain('first pass');
    expect(textOf(result)).toMatch(/Objects : (ConAlpha, ConDelta|ConDelta, ConAlpha)/);
    expect(context.symbolIndex.recorded.get(alpha)).toBe(fs.statSync(alpha).mtimeMs);
    expect(context.symbolIndex.recorded.has(added)).toBe(true);
  });

  it('removes the rows of a file deleted from disk', async () => {
    const [, beta] = ['ConAlpha', 'ConBeta'].map(n => writeObject(n));
    const context = makeContext();
    await updateSymbolIndexTool({ model: 'Contoso' }, context);
    fs.rmSync(beta);

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('Removed : 1 deleted from disk');
    expect(context.symbolIndex.removed).toContain(beta);
    expect(context.symbolIndex.recorded.has(beta)).toBe(false);
  });

  it('removes the labels of a label file deleted from disk: labels are not symbols', async () => {
    writeObject('ConAlpha');
    const dir = path.join(workspace, 'ContosoPackage', 'Contoso', 'AxLabelFile', 'LabelResources', 'en-US');
    fs.mkdirSync(dir, { recursive: true });
    const labelFile = path.join(dir, 'ConLabels.en-US.label.txt');
    fs.writeFileSync(labelFile, 'ConHello=Hello\n', 'utf-8');
    const context = makeContext();
    await updateSymbolIndexTool({ model: 'Contoso' }, context);
    expect(context.symbolIndex.labelFiles.size).toBe(1);
    // A full build never fills indexed_files: only the labels DB knows this file.
    context.symbolIndex.recorded.delete(labelFile);
    fs.rmSync(labelFile);
    context.symbolIndex.removedLabels.length = 0;

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('Removed : 1 deleted from disk');
    expect(context.symbolIndex.removedLabels).toEqual([labelFile]);
    expect(context.symbolIndex.labelFiles.size).toBe(0);
  });

  it('leaves alone rows it cannot judge: relative paths and paths outside the model folder', async () => {
    writeObject('ConAlpha');
    const context = makeContext();
    await updateSymbolIndexTool({ model: 'Contoso' }, context);
    context.symbolIndex.symbols.set('relative', 'Contoso\\AxEnum\\ConRelative.xml');
    const foreign = path.join(os.tmpdir(), 'Elsewhere', 'Contoso', 'AxEnum', 'ConForeign.xml');
    context.symbolIndex.symbols.set(foreign.toLowerCase(), foreign);
    // indexOneFile clears a file's old rows before writing new ones; only this pass counts.
    context.symbolIndex.removed.length = 0;

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('already indexed');
    expect(context.symbolIndex.removed).toEqual([]);
  });

  it('indexes only AOT files: build output, compiler copies and the descriptor are skipped', async () => {
    writeObject('ConAlpha');
    const pkg = path.join(workspace, 'ContosoPackage', 'Contoso');
    for (const [dir, name] of [['bin', 'ConBin.xml'], ['XppMetadata', 'ConCopy.xml'], ['Descriptor', 'Contoso.xml']]) {
      fs.mkdirSync(path.join(pkg, dir), { recursive: true });
      fs.writeFileSync(path.join(pkg, dir, name), AOT_XML('x'));
    }
    const context = makeContext();

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('Checked : 1 file(s)');
  });

  it('refuses a standard model, which build-database owns', async () => {
    const result = await updateSymbolIndexTool({ model: 'ApplicationSuite' }, makeContext());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('build-database');
    expect(refreshProvider).not.toHaveBeenCalled();
  });

  it('says so when no folder exists for the model', async () => {
    const result = await updateSymbolIndexTool({ model: 'Fabrikam' }, makeContext());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No folder found for model "Fabrikam"');
  });

  it('refuses filePath and model together', async () => {
    const file = writeObject('ConAlpha');

    const result = await updateSymbolIndexTool({ model: 'Contoso', filePath: file }, makeContext());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not both');
  });

  it('records the mtime when a single file is indexed, so the next model pass skips it', async () => {
    writeObject('ConAlpha');
    const beta = writeObject('ConBeta');
    const context = makeContext();
    await updateSymbolIndexTool({ model: 'Contoso' }, context);
    touch(beta);
    // What the file form (and d365fo_file's inline upsert) does after a write.
    await updateSymbolIndexTool({ filePath: beta }, context);

    const result = await updateSymbolIndexTool({ model: 'Contoso' }, context);

    expect(textOf(result)).toContain('already indexed');
  });
});
