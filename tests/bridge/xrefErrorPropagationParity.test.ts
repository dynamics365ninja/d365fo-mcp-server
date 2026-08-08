/**
 * Cross-reference failures must not be reported as empty results (audit finding #27).
 *
 * Every method in CrossReferenceService answers "what else touches this?", and the answer
 * decides whether it is safe to change something. A failed SQL query used to come back as a
 * SUCCESSFUL response carrying `count = 0` plus an `error` field — which reads, to any caller
 * that does not go looking for the extra field, as the strongest possible clearance: nothing
 * references this. The worse the database's state, the safer everything looked.
 *
 * The service only runs against DYNAMICSXREFDB on a D365FO VM, so this is a source-level
 * guard, comment-stripped so the explanation cannot pass for the code.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { XREF_SERVICE_CS, readStripped } from './csharpSource';

let source: string;

beforeAll(() => {
  source = readStripped(XREF_SERVICE_CS);
});

describe('cross-reference query failures', () => {
  it('never returns a result object carrying an error field', () => {
    const inBand = source.match(/error\s*=\s*ex\.Message/g) ?? [];
    expect(
      inBand.length,
      'a catch block still returns `error = ex.Message` inside a success response — the caller ' +
        'sees count=0 and concludes "no references, safe to change" while the database is down',
    ).toBe(0);
  });

  it('has no catch block that returns a zero count', () => {
    // Slice each catch body and require that none of them ends in a `return`: the only
    // correct exits from a failed query are `throw` and propagation.
    const catches = [...source.matchAll(/catch\s*\([^)]*\)\s*\{/g)];
    expect(catches.length, 'CrossReferenceService should still have catch blocks to check').toBeGreaterThan(0);

    for (const match of catches) {
      const start = match.index! + match[0].length - 1;
      let depth = 0;
      let body = '';
      for (let i = start; i < source.length; i++) {
        body += source[i];
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) break;
      }
      expect(
        body,
        `a catch block returns a value instead of propagating:\n${body.trim().slice(0, 300)}`,
      ).not.toMatch(/\breturn\b/);
    }
  });

  it('routes failures through a helper that says the query was not answered', () => {
    expect(source).toContain('private static Exception QueryFailed(');
    const throws = source.match(/throw QueryFailed\(/g) ?? [];
    expect(
      throws.length,
      'all four query methods (findReferences, findExtensionClasses, findEventSubscribers, ' +
        'findApiUsageCallers) must surface a failure as an error',
    ).toBe(4);
  });
});

describe('the dispatcher turns a thrown xref failure into an error response', () => {
  it('HandleXref has no catch-all that fabricates a success', async () => {
    const { readStripped: read } = await import('./csharpSource');
    const path = await import('path');
    const dispatcher = read(path.join(
      path.resolve(__dirname, '..', '..'),
      'bridge', 'D365MetadataBridge', 'Protocol', 'RequestDispatcher.cs',
    ));
    const start = dispatcher.indexOf('private Task<BridgeResponse> HandleXref(');
    expect(start, 'HandleXref not found — the throw above would have no receiver').toBeGreaterThan(0);
    const body = dispatcher.slice(start, dispatcher.indexOf('private ', start + 10));
    expect(body).toContain('BridgeResponse.CreateError');
  });
});
