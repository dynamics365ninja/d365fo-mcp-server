/**
 * prepare answers a question about an object, but `goal` is free text — so re-asking
 * the same question in different words looked like a new call.
 *
 * Run f2e7b71a issued four prepares, then two more that repeated the add-field and
 * add-control ones verbatim except for the goal wording. Each reply is capped at ~5 KB
 * and stays in the transcript for the rest of the session, so every later request pays
 * to resend it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const prepareChangeTool = vi.fn();
const prepareCreateTool = vi.fn();

vi.mock('../../src/tools/prepare/prepareChange.js', () => ({
  prepareChangeTool: (...a: unknown[]) => prepareChangeTool(...a),
}));
vi.mock('../../src/tools/prepare/prepareCreate.js', () => ({
  prepareCreateTool: (...a: unknown[]) => prepareCreateTool(...a),
}));

const { prepareTool, pruneRecentPrepares } = await import('../../src/tools/prepare/prepare.js');

const reply = (token: string, body = 'x'.repeat(4000)) => ({
  content: [{ type: 'text', text: `${body}\n**Grounding token:** \`${token}\`` }],
});

const call = (args: Record<string, unknown>) =>
  prepareTool({ method: 'tools/call', params: { name: 'prepare', arguments: args } } as never, {} as never);

const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;

const ADD_FIELD = {
  mode: 'change',
  objectType: 'table',
  operation: 'add-field',
  objectName: 'AslFinCore_TaxTransReportChangeLog',
};

beforeEach(() => {
  prepareChangeTool.mockReset();
  prepareCreateTool.mockReset();
  // The store is module-level; age every entry out between tests.
  pruneRecentPrepares(Date.now() + 60 * 60 * 1000);
});

describe('prepare repeat suppression', () => {
  it('does not re-aggregate when only the goal wording changed', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-abc'));

    const first = await call({ ...ADD_FIELD, goal: 'Add new enum-typed field QualityTier via a table extension' });
    const second = await call({ ...ADD_FIELD, goal: 'Add QualityTier enum field via table extension' });

    expect(prepareChangeTool).toHaveBeenCalledTimes(1);
    expect(text(first).length).toBeGreaterThan(3000);
    expect(text(second)).toContain('Already prepared');
    // The point of the exercise: the repeat is a fraction of the payload.
    expect(text(second).length).toBeLessThan(1000);
  });

  it('hands back the still-valid token so the caller can proceed', async () => {
    prepareChangeTool.mockResolvedValue(reply('5f04aa8a56c7ea7d05eb433c2831ba8d'));

    await call({ ...ADD_FIELD, goal: 'first' });
    const repeat = await call({ ...ADD_FIELD, goal: 'second' });

    expect(text(repeat)).toContain('**Grounding token:** `5f04aa8a56c7ea7d05eb433c2831ba8d`');
  });

  it('treats a different operation on the same object as a new question', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-1'));

    await call({ ...ADD_FIELD, goal: 'g' });
    await call({ ...ADD_FIELD, operation: 'add-field-to-field-group', goal: 'g' });

    expect(prepareChangeTool).toHaveBeenCalledTimes(2);
  });

  it('treats a different object as a new question', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-1'));

    await call({ ...ADD_FIELD, goal: 'g' });
    await call({ ...ADD_FIELD, objectName: 'SomeOtherTable', goal: 'g' });

    expect(prepareChangeTool).toHaveBeenCalledTimes(2);
  });

  it('keeps change and create apart', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-change'));
    prepareCreateTool.mockResolvedValue(reply('tok-create'));

    await call({ mode: 'change', objectType: 'enum', objectName: 'QualityTier', goal: 'g' });
    await call({ mode: 'create', objectType: 'enum', objectName: 'QualityTier', goal: 'g' });

    expect(prepareChangeTool).toHaveBeenCalledTimes(1);
    expect(prepareCreateTool).toHaveBeenCalledTimes(1);
  });

  it('does not suppress after a failed call — that is how a caller retries', async () => {
    prepareChangeTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '❌ objectName not found' }],
      isError: true,
    });
    prepareChangeTool.mockResolvedValueOnce(reply('tok-ok'));

    await call({ ...ADD_FIELD, goal: 'g' });
    const second = await call({ ...ADD_FIELD, goal: 'g' });

    expect(prepareChangeTool).toHaveBeenCalledTimes(2);
    expect(text(second)).not.toContain('Already prepared');
  });

  it('re-aggregates once the entry has aged out', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-1'));

    await call({ ...ADD_FIELD, goal: 'g' });
    pruneRecentPrepares(Date.now() + 31 * 60 * 1000);
    await call({ ...ADD_FIELD, goal: 'g' });

    expect(prepareChangeTool).toHaveBeenCalledTimes(2);
  });
});
