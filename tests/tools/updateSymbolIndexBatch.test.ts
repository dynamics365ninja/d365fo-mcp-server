/**
 * update_symbol_index: one bridge refresh per CALL, not per object.
 *
 * Indexing N freshly created objects meant N tool calls, each rebuilding the C#
 * DiskProvider from scratch (266 ms measured on the reference VM, and the whole
 * provider is thrown away and recreated each time). Worse, d365fo_file's
 * create/modify paths already refresh the provider on their way out, so the very
 * next update_symbol_index call was rebuilding a provider that could not
 * possibly see anything new.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const refreshProvider = vi.fn(async () => ({ refreshed: true, elapsedMs: 5 }));

vi.mock('../../src/bridge/index.js', () => ({
  bridgeRefreshProvider: vi.fn(async (bridge: any) => (bridge ? refreshProvider() : null)),
}));

import { updateSymbolIndexTool } from '../../src/tools/sdlc/updateSymbolIndex.js';
import { markRefreshStarted, resetRefreshTracking } from '../../src/bridge/debouncedRefresh.js';

const AOT_XML = (name: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>${name}</Name></AxEnum>\n`;

let workspace: string;

/** Minimal context: the tool only touches these members on this path. */
function makeContext() {
  const added: Array<{ name: string }> = [];
  return {
    bridge: { isReady: true, metadataAvailable: true },
    workspaceScanner: { invalidate: vi.fn() },
    symbolIndex: {
      db: { transaction: (fn: () => void) => fn },
      addSymbol: (s: any) => { added.push(s); },
      removeSymbolsByFile: () => ({ deletedCount: 0, objectNames: [] }),
      removeLabelsByFile: () => 0,
      touchLastIndexed: vi.fn(),
      added,
    },
  } as any;
}

function writeObject(model: string, name: string): string {
  const dir = path.join(workspace, model, model, 'AxEnum');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.xml`);
  fs.writeFileSync(file, AOT_XML(name), 'utf-8');
  return file;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-update-index-'));
  refreshProvider.mockClear();
  resetRefreshTracking();
});

afterEach(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* locked */ }
  resetRefreshTracking();
});

describe('update_symbol_index batching', () => {
  it('refreshes the bridge once for a whole array of files', async () => {
    const files = ['ConAlpha', 'ConBeta', 'ConGamma'].map(n => writeObject('Contoso', n));
    const context = makeContext();

    const result = await updateSymbolIndexTool({ filePath: files }, context);

    expect(refreshProvider).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('3/3');
    expect(context.symbolIndex.added.map((s: any) => s.name).sort())
      .toEqual(['ConAlpha', 'ConBeta', 'ConGamma']);
  });

  it('still accepts a single path and keeps its single-file message', async () => {
    const file = writeObject('Contoso', 'ConAlpha');

    const result = await updateSymbolIndexTool({ filePath: file }, makeContext());

    expect(result.content[0].text).toContain('Symbol index updated for **ConAlpha**');
    expect(result.content[0].text).not.toContain('1/1');
  });

  it('skips the refresh when one already ran after the files were written', async () => {
    const file = writeObject('Contoso', 'ConAlpha');
    // What d365fo_file(create) does on its way out, before the agent calls us.
    markRefreshStarted(Date.now() + 1000);

    const result = await updateSymbolIndexTool({ filePath: file }, makeContext());

    expect(refreshProvider).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('already refreshed');
  });

  // #830: the skip was silent, so the agent kept spending a round trip on it —
  // four times in one audited session. A redundant call now says so first.
  it('leads a redundant single-file call with the not-needed note', async () => {
    const file = writeObject('Contoso', 'ConAlpha');
    markRefreshStarted(Date.now() + 1000);

    const { content } = await updateSymbolIndexTool({ filePath: file }, makeContext());
    const text: string = content[0].text;

    expect(text.startsWith('ℹ️ This call was not needed.')).toBe(true);
    expect(text).toContain('d365fo_file');
    expect(text).toContain('OUTSIDE this server');
    // The note replaces the bridge line, it does not add a second one.
    expect(text).not.toContain('Bridge provider refreshed');
    // The SQLite reindex — the only thing that populates the symbol DB — still ran.
    expect(text).toContain('Symbol index updated for **ConAlpha**');
  });

  it('leads a redundant batch call with the note too', async () => {
    const files = ['ConAlpha', 'ConBeta'].map(n => writeObject('Contoso', n));
    markRefreshStarted(Date.now() + 1000);

    const { content } = await updateSymbolIndexTool({ filePath: files }, makeContext());
    const text: string = content[0].text;

    expect(refreshProvider).not.toHaveBeenCalled();
    expect(text.startsWith('ℹ️ This call was not needed.')).toBe(true);
    expect(text).toContain('2/2');
  });

  it('says nothing about redundancy when the refresh was genuinely needed', async () => {
    markRefreshStarted(Date.now() - 60_000);
    const file = writeObject('Contoso', 'ConAlpha');

    const { content } = await updateSymbolIndexTool({ filePath: file }, makeContext());

    expect(content[0].text).not.toContain('This call was not needed');
    expect(content[0].text).toContain('Bridge provider refreshed');
  });

  it('does refresh when a file changed after the last refresh', async () => {
    markRefreshStarted(Date.now() - 60_000);
    const file = writeObject('Contoso', 'ConAlpha');

    await updateSymbolIndexTool({ filePath: file }, makeContext());

    expect(refreshProvider).toHaveBeenCalledTimes(1);
  });

  it('reports per-file failures without abandoning the rest of the batch', async () => {
    const good = writeObject('Contoso', 'ConAlpha');
    const missing = path.join(workspace, 'Contoso', 'Contoso', 'AxEnum', 'ConGone.xml');

    const result = await updateSymbolIndexTool({ filePath: [good, missing] }, makeContext());

    // A missing file is a deletion, not an error — both entries are accounted for.
    expect(result.content[0].text).toContain('2/2');
    expect(result.content[0].text).toContain('ConAlpha');
    expect(result.content[0].text).toContain('ConGone');
  });

  it('falls back to the refresh-only mode when no path is given', async () => {
    const result = await updateSymbolIndexTool({}, makeContext());

    expect(refreshProvider).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Bridge/cache refresh');
  });
});
