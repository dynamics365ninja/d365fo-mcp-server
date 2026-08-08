/**
 * Extension Strategy Advisor Tests
 * Focus: the field-change-reaction scenario must recommend modifiedField(),
 * NOT initValue(), when the goal is "react when a user changes a field".
 */

import { describe, it, expect } from 'vitest';
import { extensionStrategyAdvisorTool } from '../../src/tools/knowledge/extensionStrategyAdvisor';
import type { XppServerContext } from '../../src/types/context';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const ctx = {} as XppServerContext;

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'extension_info', arguments: args },
});

describe('extension_info strategy — field-change-reaction', () => {
  it('recommends modifiedField (not initValue) when reacting to a user field change', async () => {
    const result = await extensionStrategyAdvisorTool(
      req({ goal: 'recalculate the total when the user changes the quantity field', objectName: 'LedgerJournalTrans' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('field-change-reaction');
    expect(text).toMatch(/modifiedField/);
    // The recommended mechanism must not be initValue-based defaulting.
    expect(text).not.toMatch(/Recommended:.*initValue/);
  });

  it('explicit scenario=field-change-reaction routes to modifiedField', async () => {
    const result = await extensionStrategyAdvisorTool(
      req({ goal: 'do something', scenario: 'field-change-reaction' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/modifiedField/);
  });

  it('still recommends initValue for genuine new-record defaulting', async () => {
    const result = await extensionStrategyAdvisorTool(
      req({ goal: 'set a default value for the warehouse field on new records' }),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('field-defaulting');
    expect(text).toMatch(/initValue/);
  });
});
