/**
 * `labels(action="search")` must not recommend a label that is not on disk.
 *
 * Benchmark run d79f62a3 (2026-08-17): one search returned three
 * `[AslFinanceSK]` labels with exactly the wording the task needed — the enum's,
 * the field's and the `%1`/`%2` error message. All three were leftovers of a
 * rolled-back session: present in the symbol index, absent from the .label.txt.
 * The agent wrote all three into the enum, the field and the X++; `xppc` does
 * not check labels, so the 115 s build passed and only `run_bp_check` found
 * them (`BPErrorUnknownLabel`). `action="info"` had the disk check that would
 * have said so; `action="search"` — the call an agent makes BEFORE reusing a
 * label — did not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStat, mockReadFile } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({ stat: mockStat, readFile: mockReadFile }));

import { searchLabelsTool, REUSABLE_MARKER, STALE_MARKER } from '../../src/tools/analysis/searchLabels';
import { resetLabelSearchHistory } from '../../src/tools/analysis/labelSearchHistory';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const EN = 'K:\\Packages\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyModel.en-US.label.txt';
const CS = 'K:\\Packages\\MyModel\\AxLabelFile\\LabelResources\\cs\\MyModel.cs.label.txt';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'search_labels', arguments: args },
});

const row = (overrides: Partial<any> = {}) => ({
  labelId: 'QualityTier',
  labelFileId: 'MyModel',
  model: 'MyModel',
  language: 'en-US',
  text: 'Quality tier',
  comment: '',
  ...overrides,
});

function buildContext(rows: any[], paths: string[] = [EN]): XppServerContext {
  return {
    symbolIndex: {
      searchLabels: vi.fn(() => rows),
      getLabelFilePaths: vi.fn(() => paths.map(filePath => ({ language: 'en-US', filePath }))),
    } as any,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  } as XppServerContext;
}

const textOf = (result: any): string => result.content[0].text as string;

beforeEach(() => {
  resetLabelSearchHistory();
  mockStat.mockReset();
  mockReadFile.mockReset();
  mockStat.mockResolvedValue({ isFile: () => true, size: 2048 });
  process.env.D365FO_MODEL_NAME = 'MyModel';
});

describe('search_labels disk confirmation', () => {
  it('marks a row the label file does not declare and never recommends it', async () => {
    mockReadFile.mockResolvedValue('SomethingElse=Other text\n');

    const text = textOf(await searchLabelsTool(req({ query: 'quality tier' }), buildContext([row()])));

    expect(text).toContain(STALE_MARKER);
    expect(text).toContain('NOT in');
    // The verdict the batch reads back must not claim a reusable label exists.
    expect(text).not.toContain(REUSABLE_MARKER);
    // …and it must hand over the call that fixes it.
    expect(text).toContain('labels(action="create"');
  });

  it('recommends a row the label file does declare', async () => {
    mockReadFile.mockResolvedValue('QualityTier=Quality tier\n');

    const text = textOf(await searchLabelsTool(req({ query: 'quality tier' }), buildContext([row()])));

    expect(text).toContain(REUSABLE_MARKER);
    expect(text).not.toContain(STALE_MARKER);
  });

  it('recommends the real label when a phantom is listed alongside it', async () => {
    mockReadFile.mockResolvedValue('QualityTierReal=Quality tier\n');

    const text = textOf(await searchLabelsTool(
      req({ query: 'quality tier' }),
      buildContext([row(), row({ labelId: 'QualityTierReal' })]),
    ));

    expect(text).toContain(`${REUSABLE_MARKER}  literalStr("@MyModel:QualityTierReal")`);
    expect(text).toContain(STALE_MARKER);
  });

  it('reads each label file once however many ids it has to confirm', async () => {
    mockReadFile.mockResolvedValue('SomethingElse=x\n');

    await searchLabelsTool(
      req({ query: 'quality tier' }),
      buildContext([row(), row({ labelId: 'QualityTierDowngradeNotAllowed' }), row({ labelId: 'Third' })], [EN, CS]),
    );

    // Two files, three ids — two reads, not six.
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('never reads Microsoft label files — their rows cannot be phantoms', async () => {
    const text = textOf(await searchLabelsTool(
      req({ query: 'cannot be decreased' }),
      buildContext([row({ labelId: '@SYS321819', labelFileId: 'SYS', model: 'ApplicationPlatform' })]),
    ));

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(text).toContain(REUSABLE_MARKER);
    expect(text).not.toContain(STALE_MARKER);
  });

  it('says nothing when the file cannot be read — silence, not a false alarm', async () => {
    mockStat.mockRejectedValue(new Error('EACCES'));

    const text = textOf(await searchLabelsTool(req({ query: 'quality tier' }), buildContext([row()])));

    expect(text).not.toContain(STALE_MARKER);
    expect(text).toContain(REUSABLE_MARKER);
  });

  it('says nothing when the index has no path for the label file', async () => {
    const text = textOf(await searchLabelsTool(req({ query: 'quality tier' }), buildContext([row()], [])));

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(text).not.toContain(STALE_MARKER);
    expect(text).toContain(REUSABLE_MARKER);
  });
});
