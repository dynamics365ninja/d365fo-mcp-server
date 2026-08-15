/**
 * Guidance the server hands an agent must name a tool the agent can actually
 * see in ListTools.
 *
 * `get_method` is not published — toolHandler.ts keeps the route only so an
 * agent still holding the name from an earlier session gets an answer instead
 * of "unknown tool" — and `get_method_signature` is not routable at all; it
 * only ever existed as an internal sub-request name inside getMethod.ts. Yet
 * both were spelled out as call syntax in knowledge entries, CoC prompts, error
 * details and the comment headers of generated X++ files. An agent following
 * one of those either calls a name it cannot look up, or (the `include:
 * "signature"` case that started this) asks for a signature while being told it
 * is asking for a body.
 *
 * Asserted against the source rather than against each rendered string: this
 * text is spread over knowledge arrays, prompt templates and code generators
 * that would each need their own fixture, and the rule — do not write
 * `get_method(...)` into text an agent reads — is checkable directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { globSync } from 'node:fs';

const SRC = join(process.cwd(), 'src');

/** Call syntax for the unpublished readers, wherever it appears in text. */
const UNPUBLISHED_CALL = /\bget_method(_signature|_source)?\s*\(/;

/**
 * A line that only *talks about* the old name — the docblocks explaining why it
 * is gone, and the audit note in classInfo.ts recording what the wording used
 * to be — is the point, not a violation. Only instructions matter here.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('agent-facing guidance', () => {
  it('never spells out a call to an unpublished method reader', () => {
    const files = globSync('**/*.ts', { cwd: SRC }).map(f => join(SRC, f));
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (UNPUBLISHED_CALL.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
