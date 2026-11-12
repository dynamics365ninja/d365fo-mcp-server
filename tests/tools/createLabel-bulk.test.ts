import { describe, it, expect } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  extractBulkLabels,
  createLabelsBulk,
  type SingleLabelRunner,
} from '../../src/tools/write/createLabel';

describe('extractBulkLabels', () => {
  it('returns the entries for the bulk shape', () => {
    const entries = extractBulkLabels({ labels: [{ labelId: 'A' }, { labelId: 'B' }] });
    expect(entries).toHaveLength(2);
  });

  it('returns null for the single-label shape', () => {
    expect(extractBulkLabels({ labelId: 'A', translations: [] })).toBeNull();
  });

  it('returns null for an empty array and drops non-object entries', () => {
    expect(extractBulkLabels({ labels: [] })).toBeNull();
    expect(extractBulkLabels({ labels: [{ labelId: 'A' }, null, 'x'] })).toHaveLength(1);
  });
});

describe('createLabelsBulk fan-out', () => {
  /** Capture what each single-label call received and return a canned result. */
  function recordingRunner(failOn: Set<string> = new Set()): {
    runner: SingleLabelRunner;
    calls: Array<Record<string, unknown>>;
  } {
    const calls: Array<Record<string, unknown>> = [];
    const runner: SingleLabelRunner = async (req: CallToolRequest) => {
      const args = req.params.arguments as Record<string, unknown>;
      calls.push(args);
      const id = String(args.labelId);
      return failOn.has(id)
        ? { content: [{ type: 'text', text: `❌ ${id} already exists` }], isError: true }
        : { content: [{ type: 'text', text: `✅ created ${id}` }], isError: false };
    };
    return { runner, calls };
  }

  it('merges shared top-level fields into every entry and routes one call each', async () => {
    const { runner, calls } = recordingRunner();
    const raw = {
      labelFileId: 'ContosoExt',
      model: 'ContosoExt',
      languages: ['en-US'],
      labels: [
        { labelId: 'EquipmentName', translations: [{ language: 'en-US', text: 'Equipment name' }] },
        { labelId: 'DailyRate', translations: [{ language: 'en-US', text: 'Daily rate' }] },
      ],
    };

    const res = await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);

    expect(calls).toHaveLength(2);
    // Shared fields propagate; the per-entry array itself does not leak through.
    expect(calls[0]).toMatchObject({ labelFileId: 'ContosoExt', model: 'ContosoExt', labelId: 'EquipmentName' });
    expect(calls[0].labels).toBeUndefined();
    expect(calls[1]).toMatchObject({ labelId: 'DailyRate', languages: ['en-US'] });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('2 created, 0 failed');
  });

  it('continues past a failed entry and reports it as an error overall', async () => {
    const { runner } = recordingRunner(new Set(['DupId']));
    const raw = {
      labelFileId: 'ContosoExt',
      labels: [
        { labelId: 'GoodId', translations: [{ language: 'en-US', text: 'ok' }] },
        { labelId: 'DupId', translations: [{ language: 'en-US', text: 'dup' }] },
        { labelId: 'AlsoGood', translations: [{ language: 'en-US', text: 'ok2' }] },
      ],
    };

    const res = await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('2 created, 1 failed');
    expect(res.content[0].text).toContain('🔴 DupId');
    expect(res.content[0].text).toContain('🟢 AlsoGood');
  });

  describe('bulk update (labels(action="update") forces overwriteExisting)', () => {
    /** Answers with the single-label handler's real verdict lines. */
    function verdictRunner(verdicts: Record<string, string>): {
      runner: SingleLabelRunner;
      calls: Array<Record<string, unknown>>;
    } {
      const calls: Array<Record<string, unknown>> = [];
      const runner: SingleLabelRunner = async (req: CallToolRequest) => {
        const args = req.params.arguments as Record<string, unknown>;
        calls.push(args);
        const id = String(args.labelId);
        const text = verdicts[id] ?? `✅ Label "@ContosoExt:${id}" updated successfully!\n\nLabel ID   : ${id}`;
        return { content: [{ type: 'text', text }], isError: text.startsWith('❌') };
      };
      return { runner, calls };
    }

    const entry = (labelId: string) => ({ labelId, translations: [{ language: 'en-US', text: `${labelId} text` }] });

    it('names update in the header and counts updated, not created', async () => {
      const { runner, calls } = verdictRunner({});
      const raw = { labelFileId: 'ContosoExt', overwriteExisting: true, labels: [entry('EquipmentName'), entry('DailyRate')] };

      const res = await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);

      const header = res.content[0].text.split('\n')[0];
      expect(header).toBe('✅ labels(action="update", labels=[…]): 2 updated, 0 failed (of 2).');
      expect(header).not.toContain('created');
      expect(res.isError).toBe(false);
      // The overwrite flag reaches every entry — that is what makes it an update.
      expect(calls.every(c => c.overwriteExisting === true)).toBe(true);
    });

    it('continues past a failed entry and still reports the others as updated', async () => {
      const { runner, calls } = verdictRunner({ BadId: '❌ Invalid label ID "BadId"' });
      const raw = { labelFileId: 'ContosoExt', overwriteExisting: true, labels: [entry('GoodId'), entry('BadId'), entry('AlsoGood')] };

      const res = await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);

      expect(calls).toHaveLength(3);
      expect(res.isError).toBe(true);
      const text = res.content[0].text;
      expect(text.split('\n')[0]).toBe('⚠️ labels(action="update", labels=[…]): 2 updated, 1 failed (of 3).');
      expect(text).toContain('🔴 BadId');
      expect(text).toContain('🟢 AlsoGood');
    });

    it('does not count an entry the update left unchanged as updated', async () => {
      const { runner } = verdictRunner({
        Untouched: 'ℹ️ Label "@ContosoExt:Untouched" left unchanged — no supplied translation applies to the targeted languages.',
      });
      const raw = { labelFileId: 'ContosoExt', overwriteExisting: true, labels: [entry('Changed'), entry('Untouched')] };

      const res = await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);

      expect(res.content[0].text.split('\n')[0])
        .toBe('✅ labels(action="update", labels=[…]): 1 updated, 1 unchanged, 0 failed (of 2).');
    });
  });

  it('keeps the create header and reports reused and already-existing entries apart from created', async () => {
    const verdicts: Record<string, string> = {
      Fresh: '✅ Label "@ContosoExt:Fresh" created successfully!',
      Reused: '✅ Label "@ContosoExt:Reused" already exists — reusing it (createIfMissing).',
      Existing: '⚠️ Label "Existing" already exists in all languages:\n  - en-US (already exists: "x")',
    };
    const runner: SingleLabelRunner = async (req: CallToolRequest) => ({
      content: [{ type: 'text', text: verdicts[String((req.params.arguments as any).labelId)] }],
      isError: false,
    });
    const raw = {
      labelFileId: 'ContosoExt',
      labels: Object.keys(verdicts).map(labelId => ({ labelId, translations: [{ language: 'en-US', text: 'x' }] })),
    };

    const res = await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);

    expect(res.content[0].text.split('\n')[0])
      .toBe('✅ labels(action="create", labels=[…]): 1 created, 1 reused, 1 unchanged, 0 failed (of 3).');
  });

  it('lets a per-entry field override a shared default', async () => {
    const { runner, calls } = recordingRunner();
    const raw = {
      labelFileId: 'ContosoExt',
      description: 'shared desc',
      labels: [{ labelId: 'A', translations: [], description: 'per-entry desc' }],
    };

    await createLabelsBulk(extractBulkLabels(raw)!, raw, {} as any, runner);
    expect(calls[0].description).toBe('per-entry desc');
  });
});
