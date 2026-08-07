/**
 * Stale label rows — the index says a label exists, the .label.txt does not.
 *
 * Live demo, 2026-08-07: labels(action="info") answered with a full translation
 * list for a label in the customer's core model, so the agent referenced it in
 * the field and the EDT. It was a phantom — nothing on disk — and the only
 * symptom was a best-practice error, `Unknown label`, several build cycles later.
 *
 * The check reports "missing" ONLY when it actually read a file that lacks the
 * id; anything unreadable stays silent, because a false "your label is gone"
 * would send the caller off recreating labels that are fine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStat, mockReadFile } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('fs/promises', () => ({ stat: mockStat, readFile: mockReadFile }));

import { labelMissingOnDisk } from '../../src/utils/labelDiskCheck';

const FILE = 'K:\\Packages\\MyModel\\AxLabelFile\\LabelResources\\en-US\\MyModel.en-US.label.txt';
const CS_FILE = 'K:\\Packages\\MyModel\\AxLabelFile\\LabelResources\\cs\\MyModel.cs.label.txt';

const readable = (size = 2048) => mockStat.mockResolvedValue({ isFile: () => true, size });

beforeEach(() => {
  mockStat.mockReset();
  mockReadFile.mockReset();
});

describe('labelMissingOnDisk', () => {
  it('reports missing when the file reads fine and lacks the id', async () => {
    readable();
    mockReadFile.mockResolvedValue('OtherLabel=Something\nThirdLabel=Else\n');

    expect(await labelMissingOnDisk('QualityTier', [FILE])).toBe(true);
  });

  it('accepts a label the file declares', async () => {
    readable();
    mockReadFile.mockResolvedValue(';comment\nQualityTier=Quality tier\n QualityTier comment line\n');

    expect(await labelMissingOnDisk('QualityTier', [FILE])).toBe(false);
  });

  it('accepts a label present in only one language file', async () => {
    readable();
    mockReadFile
      .mockResolvedValueOnce('SomethingElse=x\n')
      .mockResolvedValueOnce('QualityTier=Úroveň kvality\n');

    expect(await labelMissingOnDisk('QualityTier', [FILE, CS_FILE])).toBe(false);
  });

  it('does not confuse a label whose id is a prefix of another', async () => {
    readable();
    mockReadFile.mockResolvedValue('QualityTierNone=None\nQualityTierGold=Gold\n');

    expect(await labelMissingOnDisk('QualityTier', [FILE])).toBe(true);
  });

  it('matches case-insensitively, like the label resolver does', async () => {
    readable();
    mockReadFile.mockResolvedValue('qualitytier=Quality tier\n');

    expect(await labelMissingOnDisk('QualityTier', [FILE])).toBe(false);
  });

  it('gives no verdict when nothing could be read', async () => {
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    expect(await labelMissingOnDisk('QualityTier', [FILE])).toBeNull();
  });

  it('gives no verdict when no path is indexed at all', async () => {
    expect(await labelMissingOnDisk('QualityTier', [])).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('skips a file too large to be worth reading rather than guessing', async () => {
    mockStat.mockResolvedValue({ isFile: () => true, size: 64 * 1024 * 1024 });

    expect(await labelMissingOnDisk('QualityTier', [FILE])).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('finds the FIRST label of a file, which carries the BOM', async () => {
    // Every shipped .label.txt starts with a UTF-8 BOM and Node's utf-8 read
    // keeps it, so the first id reads as "﻿Account". Missing that would
    // report one real label per file as gone.
    readable();
    mockReadFile.mockResolvedValue('﻿Account=Account\nAccountAlias=Alias\n');

    expect(await labelMissingOnDisk('Account', [FILE])).toBe(false);
  });

  it('gives no verdict rather than sweeping hundreds of megabytes', async () => {
    // A label file id has ~74 language variants and the platform's own are
    // ~10 MB each (@SYS: 764 MB, 17 s for one lookup on the reference VM). One
    // tool call must not hold the server for that long; callers skip Microsoft
    // models, and this is the backstop.
    mockStat.mockResolvedValue({ isFile: () => true, size: 12 * 1024 * 1024 });
    mockReadFile.mockResolvedValue('SomethingElse=x\n');

    const many = Array.from({ length: 74 }, (_, i) => `${FILE}.${i}`);

    expect(await labelMissingOnDisk('QualityTier', many)).toBeNull();
    expect(mockReadFile.mock.calls.length).toBeLessThan(10);
  });
});
