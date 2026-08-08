/**
 * The reader half of the schedule/settle contract introduced with the
 * debounced provider refresh.
 *
 * Writers no longer await `refreshProvider()` — they schedule it, so the
 * DiskProvider rebuild leaves the response path. That moves the freshness
 * guarantee onto the READER: without one, a `get_object_info` issued right
 * after a create could see a provider up to SETTLE_MS staler than it did
 * before the change, which is a (narrow) regression in exactly the direction
 * the eager refresh existed to prevent.
 *
 * Every bridge-backed tool passes through the readiness gate in toolHandler,
 * so settling there covers reads and writes alike — one place instead of one
 * per reader, and impossible to forget when a reader is added.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const handler = readFileSync('src/tools/toolHandler.ts', 'utf8');

/** Source with comments stripped, so an explanatory comment cannot satisfy an assertion. */
const code = handler
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('bridge-backed tools settle a scheduled provider refresh', () => {
  it('flushes the coalescer inside the bridge-readiness gate', () => {
    expect(code).toMatch(/debouncedRefresh\.flush\(\)/);

    // It has to be INSIDE the `if (bridgeWait)` block: flushing for tools that
    // never touch the bridge would be pointless work on every single call.
    const gate = code.slice(code.indexOf('if (bridgeWait)'));
    const gateEnd = gate.indexOf('\n    }');
    expect(gate.slice(0, gateEnd)).toMatch(/await debouncedRefresh\.flush\(\)/);
  });

  it('settles AFTER the bridge is ready, not before', () => {
    // Flushing before the bridge exists would rebuild nothing and then let the
    // real write-scheduled rebuild sit unsettled behind it.
    const block = code.slice(code.indexOf('if (bridgeWait)'));
    expect(block.indexOf('await bridgeWait.outcome'))
      .toBeLessThan(block.indexOf('debouncedRefresh.flush()'));
  });

  it('gates on the shared BRIDGE_BACKED_TOOLS set so a new reader is covered automatically', () => {
    expect(code).toMatch(/BRIDGE_BACKED_TOOLS\.has\(toolName\)/);
  });
});
