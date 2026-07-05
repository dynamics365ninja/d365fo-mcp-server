import { describe, it, expect } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { d365foErrorHelpTool, lookupErrorFix } from '../../src/tools/d365foErrorHelp';

const req = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: { name: 'get_knowledge', arguments: args },
});

function textOf(result: ReturnType<typeof d365foErrorHelpTool>): string {
  const content = (result as any).content;
  return content.map((c: any) => c.text).join('\n');
}

describe('d365foErrorHelp scoring — stopword false-positive regression', () => {
  // Reproduces a live eval-loop finding (docs/USAGE_EXAMPLES.md scenario 4): a
  // missing-model-reference compile error was misdiagnosed as "TTS Level Mismatch".
  // Root cause: the word-level partial-match fallback in scoreError() counted ANY
  // individual word overlap, including grammatical filler ("is", "not") and bare
  // numbers ("0") — both of which appear in totally unrelated error text purely by
  // coincidence (e.g. "Version=0.0.0.0" contains "0"; "...is required..." contains
  // "is"). The "tts is not 0" pattern's word list ["tts","is","not","0"] therefore
  // scored a hit against text that has nothing to do with transactions.
  const missingReferenceError =
    "A reference to 'Dynamics.AX.Directory, Version=0.0.0.0, Culture=neutral, " +
    "PublicKeyToken=null' is required to compile this module.";

  it('does not misdiagnose a missing-assembly-reference error as a TTS issue', () => {
    const result = lookupErrorFix(missingReferenceError);
    expect(result?.title).not.toBe('TTS Level Mismatch');
  });

  it('reports no match (rather than a confident wrong answer) for unrelated error text', () => {
    // With stopwords/numbers excluded from the fallback, no entry in the DB has any
    // real keyword overlap with this message, so the tool should say so honestly.
    const response = d365foErrorHelpTool(req({ errorText: missingReferenceError }));
    expect(textOf(response)).toContain('No matching error pattern found');
  });

  it('still correctly matches a genuine TTS error (no regression on real matches)', () => {
    const result = lookupErrorFix('TTS level is not 0 after ttsbegin/ttscommit imbalance');
    expect(result?.title).toBe('TTS Level Mismatch');
  });

  it('still matches via errorCode prefix for a genuine case', () => {
    const response = d365foErrorHelpTool(
      req({ errorText: 'unbalanced tts detected during insert', errorCode: 'ttsbegin' })
    );
    expect(textOf(response)).toContain('TTS Level Mismatch');
  });
});
