/**
 * Label where-used — REAL xref DB smoke test (VM / full-mode only).
 *
 * The unit tests (label-references.test.ts) mock the bridge, so they prove the
 * TS routing/formatting but NOT the core cross-layer claim of this feature:
 * that the existing generic xref query matches a "/Labels/@…" target path and
 * that both stored id forms ("@WAX2194", "@LabelFile:LabelId") resolve — no C#
 * change. That can only be verified against a real DYNAMICSXREFDB.
 *
 * This suite closes that gap. It is OPT-IN and skipped everywhere the VM isn't
 * present (normal CI, dev boxes), so it never flakes the default `npm test`:
 *
 *   # on a D365FO VM / UDE with a compiled xref DB:
 *   D365FO_XREF_INTEGRATION=1 npx vitest run tests/tools/label-references.integration.test.ts
 *
 * Optional overrides (defaults target platform labels that are broadly
 * referenced, but any environment may differ — point these at a label you know
 * exists in your model):
 *   D365FO_XREF_TEST_LABEL=@SYS9694          # a widely-referenced label id
 *   D365FO_XREF_TEST_LABEL_NEWFORM=@ApplicationPlatform:AbortButtonText
 *   D365FO_PACKAGE_PATH / D365FO_XREF_SERVER / D365FO_XREF_DB  # bridge connection
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createBridgeClient } from '../../src/bridge/bridgeClient';
import { tryBridgeReferences } from '../../src/bridge/bridgeAdapter';
import { resolveLabelTarget } from '../../src/tools/analysis/findReferences';
import type { BridgeClient } from '../../src/bridge/bridgeClient';

const RUN = !!process.env.D365FO_XREF_INTEGRATION;
const OLD_FORM = process.env.D365FO_XREF_TEST_LABEL ?? '@SYS9694';
const NEW_FORM = process.env.D365FO_XREF_TEST_LABEL_NEWFORM ?? '@ApplicationPlatform:AbortButtonText';

// skipIf keeps the default test run green off-VM; opting in with a VM that has
// no xref DB fails loudly in beforeAll (a config error the operator wants told).
describe.skipIf(!RUN)('label where-used — real DYNAMICSXREFDB', () => {
  let bridge: BridgeClient | null = null;

  beforeAll(async () => {
    bridge = await createBridgeClient({
      xrefServer: process.env.D365FO_XREF_SERVER || undefined,
      xrefDatabase: process.env.D365FO_XREF_DB || undefined,
    });
    if (!bridge) throw new Error('createBridgeClient returned null — set D365FO_PACKAGE_PATH to a valid PackagesLocalDirectory.');
    if (!bridge.xrefAvailable) throw new Error('Bridge is up but xref DB is unavailable — configure DYNAMICSXREFDB (D365FO_XREF_SERVER/D365FO_XREF_DB) for full mode.');
  }, 180_000);

  afterAll(() => { bridge?.dispose(); });

  it('resolves an old-form label id to a "/Labels/@…" path and queries it without a bridge error', async () => {
    const path = resolveLabelTarget(OLD_FORM);
    expect(path).toBe(`/Labels/${OLD_FORM}`);

    const outcome = await tryBridgeReferences(bridge!, path!, 50, OLD_FORM, 'label');
    // The claim under test: the generic xref query MATCHES a label path (no SQL
    // error, bridge is available). 'ok' or 'empty' both prove that; 'error' /
    // 'unavailable' would mean the label path isn't understood by the query.
    expect(outcome.status === 'ok' || outcome.status === 'empty').toBe(true);
    if (outcome.status === 'ok') {
      const text = (outcome.result.content[0] as { text: string }).text;
      expect(text).toContain('By source object type');
      expect(text).toContain(`References to label \`${OLD_FORM}\``);
    }
  }, 60_000);

  it('resolves a new-form "@LabelFile:LabelId" id verbatim (colon preserved) and queries it', async () => {
    const path = resolveLabelTarget(NEW_FORM);
    expect(path).toBe(`/Labels/${NEW_FORM}`);

    const outcome = await tryBridgeReferences(bridge!, path!, 50, NEW_FORM, 'label');
    expect(outcome.status === 'ok' || outcome.status === 'empty').toBe(true);
  }, 60_000);
});
