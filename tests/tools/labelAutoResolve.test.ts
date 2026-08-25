/**
 * Raw label text → a label reference, without a `labels` round trip.
 *
 * Guards the decisions that make this safe rather than convenient: an existing
 * label is only reused when its text is EXACTLY the caller's, an id already
 * meaning something else is never adopted, and an enum's own label id is never
 * handed to a field that points at that enum (BPErrorFieldLabelIsCopyOfEnumLabel,
 * which the agent cannot see until a build runs).
 *
 * The create branch is deliberately absent here — it writes real .label.txt
 * files across every language folder of a model, which is covered live on the VM
 * rather than by a mock that would only assert its own stub.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  resolveOrCreateLabelRef,
  pickOriginalLabelFileId,
} from '../../src/tools/write/createLabel';
import { deriveLabelIdFromText, isRawLabelText } from '../../src/utils/labelReference';

/** Minimal stand-in for the parts of the symbol index the resolver touches. */
function fakeIndex(opts: {
  labels?: Array<{ labelId: string; labelFileId: string; text: string; language?: string }>;
  labelFiles?: string[];
  enumFile?: { name: string; filePath: string };
} = {}): any {
  const rows = opts.labels ?? [];
  return {
    searchLabels: (query: string) =>
      rows.filter(r => r.text.toLowerCase().includes(query.toLowerCase().split(' ')[0])),
    getLabelById: (labelId: string) =>
      rows
        .filter(r => r.labelId.toLowerCase() === labelId.toLowerCase())
        .map(r => ({ ...r, language: r.language ?? 'en-US' })),
    getLabelFileIds: () => (opts.labelFiles ?? []).map(labelFileId => ({ labelFileId })),
    getSymbolByName: (name: string, type: string) =>
      opts.enumFile && type === 'enum' && opts.enumFile.name === name
        ? { name, filePath: opts.enumFile.filePath }
        : null,
  };
}

describe('deriveLabelIdFromText', () => {
  it('names the meaning of the text, not the object', () => {
    expect(deriveLabelIdFromText('Credit limit')).toBe('CreditLimit');
    expect(deriveLabelIdFromText('customer name')).toBe('CustomerName');
    expect(deriveLabelIdFromText('Amount cannot be negative!')).toBe('AmountCannotBeNegative');
  });

  it('folds diacritics rather than dropping the letters', () => {
    expect(deriveLabelIdFromText('Kvalität')).toBe('Kvalitat');
  });

  it('never produces an id the create schema would reject', () => {
    // Must start with a letter and hold only [A-Za-z0-9_].
    for (const text of ['1st line', '  spaced  out ', 'A/B test', '%1 must exceed %2']) {
      const id = deriveLabelIdFromText(text);
      expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
  });

  it('returns empty when there is nothing to name', () => {
    expect(deriveLabelIdFromText('—')).toBe('');
    expect(deriveLabelIdFromText('')).toBe('');
  });
});

describe('isRawLabelText', () => {
  it('treats an existing reference as already resolved', () => {
    expect(isRawLabelText('@ContosoExt:CreditLimit')).toBe(false);
    expect(isRawLabelText('@SYS67433')).toBe(false);
  });
  it('treats display text as raw', () => {
    expect(isRawLabelText('Credit limit')).toBe(true);
  });
  it('ignores empty and non-string values', () => {
    expect(isRawLabelText('')).toBe(false);
    expect(isRawLabelText('   ')).toBe(false);
    expect(isRawLabelText(undefined)).toBe(false);
    expect(isRawLabelText(42)).toBe(false);
  });
});

describe('pickOriginalLabelFileId', () => {
  it('prefers the file named after the model', () => {
    const idx = fakeIndex({ labelFiles: ['SomethingElse', 'ContosoExt'] });
    expect(pickOriginalLabelFileId('ContosoExt', idx)).toBe('ContosoExt');
  });

  it('never targets a label file EXTENSION', () => {
    const idx = fakeIndex({ labelFiles: ['ContosoExt_Extension', 'ContosoLabels'] });
    expect(pickOriginalLabelFileId('ContosoExt', idx)).toBe('ContosoLabels');
  });

  it('falls back to the model name when the index knows nothing', () => {
    expect(pickOriginalLabelFileId('ContosoExt', fakeIndex())).toBe('ContosoExt');
  });
});

describe('resolveOrCreateLabelRef', () => {
  const target = { model: 'ContosoExt', labelFileId: 'ContosoExt' };

  it('leaves an @Ref alone — that is the escape hatch', async () => {
    const out = await resolveOrCreateLabelRef(
      { text: '@ContosoExt:CreditLimit', what: 'Label' }, target, fakeIndex(),
    );
    expect(out).toBeNull();
  });

  it('reuses a label that already carries exactly that text', async () => {
    const idx = fakeIndex({
      labels: [{ labelId: 'CreditLimit', labelFileId: 'ContosoExt', text: 'Credit limit' }],
    });
    const out = await resolveOrCreateLabelRef({ text: 'Credit limit', what: 'Label' }, target, idx);
    expect(out?.ref).toBe('@ContosoExt:CreditLimit');
    expect(out?.note).toContain('reused');
    expect(out?.note).toContain('@ContosoExt:CreditLimit');
  });

  it('does not reuse a label whose text merely resembles the caller\'s', async () => {
    // Same words, different sentence: the index matches wording, not meaning, so
    // rewriting the caller's XML onto it would put a different sentence on screen.
    // Every id this text could mint is taken by other text as well, so the only
    // way out would be adopting the near-miss — and a null result proves it did not.
    const idx = fakeIndex({
      labels: [
        { labelId: 'CreditLimitExceeded', labelFileId: 'ContosoExt', text: 'Credit limit exceeded' },
        ...['CreditLimit', 'CreditLimitField', 'CreditLimit2', 'CreditLimit3', 'CreditLimit4'].map(labelId => ({
          labelId, labelFileId: 'ContosoExt', text: 'Something else',
        })),
      ],
    });
    const out = await resolveOrCreateLabelRef({ text: 'Credit limit', what: 'Label' }, target, idx);
    expect(out).toBeNull();
  });

  it('never adopts an id that already means something else', async () => {
    // Every candidate id is taken by a DIFFERENT text, so there is nothing safe
    // to write: the resolver declines rather than pointing the object at
    // "Statut" when the caller wrote "Status".
    const taken = ['Status', 'StatusField', 'Status2', 'Status3', 'Status4'].map(labelId => ({
      labelId, labelFileId: 'ContosoExt', text: 'Statut',
    }));
    const out = await resolveOrCreateLabelRef({ text: 'Status', what: 'Label' }, target, fakeIndex({ labels: taken }));
    expect(out).toBeNull();
  });

  it('never hands an enum field the enum\'s own label id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lblprobe-'));
    const enumFile = path.join(dir, 'ContosoVehicleStatus.xml');
    await fs.writeFile(
      enumFile,
      '<?xml version="1.0" encoding="utf-8"?>\n<AxEnum><Name>ContosoVehicleStatus</Name>' +
      '<Label>@ContosoExt:Status</Label><EnumValues><AxEnumValue><Name>Idle</Name>' +
      '<Label>@ContosoExt:Idle</Label></AxEnumValue></EnumValues></AxEnum>',
      'utf-8',
    );
    // The enum's own label carries exactly the field's text, so a plain
    // resolve-by-text would return it and xppbp would answer
    // BPErrorFieldLabelIsCopyOfEnumLabel — invisible until a build runs.
    // Every alternative id is taken here, so a null result proves the enum's id
    // was excluded rather than merely outranked.
    const idx = fakeIndex({
      enumFile: { name: 'ContosoVehicleStatus', filePath: enumFile },
      labels: [
        { labelId: 'Status', labelFileId: 'ContosoExt', text: 'Status' },
        ...['StatusField', 'Status2', 'Status3', 'Status4'].map(labelId => ({
          labelId, labelFileId: 'ContosoExt', text: 'Something else',
        })),
      ],
    });
    const out = await resolveOrCreateLabelRef(
      { text: 'Status', what: 'field "VehicleStatus"', enumType: 'ContosoVehicleStatus' },
      target,
      idx,
    );
    expect(out).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('declines to reuse anything when the enum could not be read', async () => {
    // One label carries the field's text under an id no candidate would mint, and
    // every candidate id is taken by other text. Without an enum the resolver
    // reuses that label; with an unreadable enum it must not, because an
    // unverifiable reuse is exactly how the enum's own id gets picked up.
    const idx = fakeIndex({
      labels: [
        { labelId: 'VehicleState', labelFileId: 'ContosoExt', text: 'Status' },
        ...['Status', 'StatusField', 'Status2', 'Status3', 'Status4'].map(labelId => ({
          labelId, labelFileId: 'ContosoExt', text: 'Something else',
        })),
      ],
    });

    const withoutEnum = await resolveOrCreateLabelRef({ text: 'Status', what: 'Label' }, target, idx);
    expect(withoutEnum?.ref).toBe('@ContosoExt:VehicleState');

    const withEnum = await resolveOrCreateLabelRef(
      { text: 'Status', what: 'field "VehicleStatus"', enumType: 'ContosoVehicleStatus' },
      target,
      idx,
    );
    expect(withEnum).toBeNull();
  });

  it('does nothing without a model to write into', async () => {
    const out = await resolveOrCreateLabelRef({ text: 'Credit limit', what: 'Label' }, { model: '' }, fakeIndex());
    expect(out).toBeNull();
  });
});
