/**
 * Phase 1.2 — index the written file in-process.
 *
 * A newly created EDT, enum or table was not in the SQLite symbol index until
 * something indexed it, and until then `search` and every index-backed reader
 * behaved as though it did not exist. The server said so itself: a create
 * warned the agent to call update_symbol_index, which it then did — two more
 * round trips (the index call, then the retried lookup) for a file this process
 * had just written and can parse in milliseconds.
 *
 * The failure path matters as much as the happy one: the write already
 * succeeded and is on disk, so a failure to index must never turn a successful
 * create into an error. It has to degrade to the note the tool used to print.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIndexOneFile } = vi.hoisted(() => ({ mockIndexOneFile: vi.fn() }));

vi.mock('../../src/tools/updateSymbolIndex', () => ({ indexOneFile: mockIndexOneFile }));

import { upsertWrittenFileIntoIndex } from '../../src/tools/inlineIndexUpsert';

const ctx = { symbolIndex: {} } as any;

describe('upsertWrittenFileIntoIndex', () => {
  beforeEach(() => {
    mockIndexOneFile.mockReset();
    mockIndexOneFile.mockResolvedValue({ text: 'indexed', isError: false });
  });

  it('indexes the written file and says so', async () => {
    const note = await upsertWrittenFileIntoIndex('K:/PLD/Pkg/Model/AxTable/Foo.xml', ctx);

    expect(mockIndexOneFile).toHaveBeenCalledWith('K:/PLD/Pkg/Model/AxTable/Foo.xml', ctx);
    expect(note).toContain('Symbol index updated in place');
    expect(note).toContain('no update_symbol_index call needed');
  });

  it('degrades to the old instruction when indexing fails, without failing the write', async () => {
    mockIndexOneFile.mockResolvedValue({ text: 'parse error', isError: true });

    const note = await upsertWrittenFileIntoIndex('K:/PLD/Pkg/Model/AxTable/Foo.xml', ctx);

    expect(note).toContain('symbol index could not be updated');
    expect(note).toContain('update_symbol_index(filePath=');
  });

  it('swallows a thrown indexer rather than propagating into the write result', async () => {
    mockIndexOneFile.mockRejectedValue(new Error('database is locked'));

    const note = await upsertWrittenFileIntoIndex('K:/PLD/Pkg/Model/AxTable/Foo.xml', ctx);

    expect(note).toContain('database is locked');
    expect(note).toContain('update_symbol_index(filePath=');
  });

  it('does nothing without a path or a symbol index', async () => {
    expect(await upsertWrittenFileIntoIndex(undefined, ctx)).toBe('');
    expect(await upsertWrittenFileIntoIndex('K:/x.xml', {} as any)).toBe('');
    expect(mockIndexOneFile).not.toHaveBeenCalled();
  });
});
