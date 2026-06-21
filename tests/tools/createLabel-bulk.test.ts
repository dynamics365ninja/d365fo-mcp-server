import { describe, it, expect } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  extractBulkLabels,
  createLabelsBulk,
  type SingleLabelRunner,
} from '../../src/tools/createLabel';

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
