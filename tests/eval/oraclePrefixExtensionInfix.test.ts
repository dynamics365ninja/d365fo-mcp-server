/**
 * EXTENSION_PREFIX canonicalisation for the MS extension-class convention
 * `{Base}{Prefix}_Extension`, where the prefix is an INFIX — mid-identifier and
 * followed by an underscore, not by the PascalCase continuation of an object
 * name.
 *
 * Corpus evidence:
 *   eval/corpus/runs/2026-08-31T23__L2-coc-extension__278eee3.json
 *     — build 0 errors / 0 BP warnings and the committed runtime oracle
 *       (EvalL2CocCarFactsTest) passed 2/2, i.e. the CoC wrapper is
 *       runtime-verified correct, yet golden_match scored 0 with the ONLY
 *       differences being `AxClass/Name` and the class-name line inside
 *       `AxClass/SourceCode/Declaration`:
 *         expected FMVehicleDataContractCon_Extension
 *         actual   FMVehicleDataContractConDemo_Extension
 *   eval/corpus/runs/2026-07-07T04__L2-coc-extension__cb1b73d.json
 *     — the SAME gap, reported eight weeks earlier. Its proposed fix ("change
 *       `(?=[A-Z])` to `(?=[A-Z_])`") is insufficient and is pinned as such
 *       below: the leading identifier-start boundary, not the lookahead, is what
 *       blocks the substitution.
 *
 * `canonicalizePrefix` is deliberately LOSSY — it exists so an artifact captured
 * under one prefix session compares equal to the same artifact produced under
 * another. Loosening it too far is a WORSE defect than the one fixed here,
 * because two genuinely different objects would compare equal and a real diff
 * would silently pass. The `anti-greedy` block therefore pins the boundary that
 * must NOT move; treat a failure there as a scoring-integrity regression.
 *
 * Every test in this file is VM-free.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  canonicalizePrefix, artifactKey, evaluate, normalizeAotXml, diffNormalized,
  GOLDEN_CAPTURE_PREFIXES,
} from '../../src/eval/oracle/index';
import { resolveActualFile } from '../../src/eval/oracle/actualArtifactResolution';

/** The default golden-side prefix set (src/eval/oracle/normalize.ts). */
const P = GOLDEN_CAPTURE_PREFIXES;
/** The prefix the VM session that produced the run record was configured with. */
const SESSION = 'ConDemo';

/** The CoC extension class of eval/goldens/L2-coc-extension, under one prefix token. */
const cocExtensionXml = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name>
  <SourceCode>
    <Declaration><![CDATA[
[ExtensionOf(classStr(FMVehicleDataContract))]
final class ${name}
{
}
]]></Declaration>
    <Methods>
      <Method>
        <Name>CarFactsSummary</Name>
        <Source><![CDATA[
    public str CarFactsSummary()
    {
        return next CarFactsSummary() + ' [verified]';
    }
]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>`;

describe('EXTENSION_PREFIX as an extension-class INFIX (regression: 2026-08-31T23__L2-coc-extension__278eee3)', () => {
  it('canonicalises `{Base}{Prefix}_Extension` on both sides of the run that failed', () => {
    const golden = canonicalizePrefix('FMVehicleDataContractCon_Extension', P);
    const actual = canonicalizePrefix('FMVehicleDataContractConDemo_Extension', SESSION);
    expect(golden).toBe('FMVehicleDataContractPFX_Extension');
    expect(actual).toBe(golden);
  });

  it('canonicalises the ORIGINAL capture prefix too (`Asl`, git 828bcea, before the mechanical Asl→Con rename in 39c747c)', () => {
    expect(canonicalizePrefix('FMVehicleDataContractAsl_Extension', 'Asl'))
      .toBe(canonicalizePrefix('FMVehicleDataContractCon_Extension', P));
    expect(canonicalizePrefix('FMVehicleDataContractAsl_Extension', 'Asl'))
      .toBe(canonicalizePrefix('FMVehicleDataContractConDemo_Extension', SESSION));
  });

  it('canonicalises the class name inside the X++ Declaration text, not just the `<Name>` element', () => {
    const decl = (n: string): string =>
      `[ExtensionOf(classStr(FMVehicleDataContract))]\nfinal class ${n}\n{\n}`;
    expect(canonicalizePrefix(decl('FMVehicleDataContractCon_Extension'), P))
      .toBe(canonicalizePrefix(decl('FMVehicleDataContractConDemo_Extension'), SESSION));
  });

  it('a bare `{Prefix}_Extension` (no base) canonicalises as well', () => {
    expect(canonicalizePrefix('Con_Extension', P)).toBe('PFX_Extension');
    expect(canonicalizePrefix('ConDemo_Extension', SESSION)).toBe('PFX_Extension');
  });

  it('the fix proposed 8 weeks ago — widening the lookahead to [A-Z_] — would NOT have closed this', () => {
    // Documented as a MEASUREMENT, not as behaviour under test: with the leading
    // identifier-start boundary in place, no lookahead widening can match a
    // prefix that is preceded by an alphanumeric character.
    const withLookaheadOnly = 'FMVehicleDataContractCon_Extension'
      .replace(/(^|[^A-Za-z0-9])Con(?=[A-Z_])/g, '$1PFX');
    expect(withLookaheadOnly).toBe('FMVehicleDataContractCon_Extension');
  });

  it('normalizeAotXml + evaluate: the two prefix sessions diff clean', async () => {
    const goldenXml = cocExtensionXml('FMVehicleDataContractCon_Extension');
    const actualXml = cocExtensionXml('FMVehicleDataContractConDemo_Extension');

    const g = await normalizeAotXml(goldenXml, [], P);
    const a = await normalizeAotXml(actualXml, [], SESSION);
    expect(g.get('AxClass/Name')).toBe(a.get('AxClass/Name'));
    expect(diffNormalized(g, a).matched).toBe(true);

    const res = await evaluate({
      caseSpec: { id: 'L2-coc-extension', tier: 2 },
      goldenXml, actualXml,
      goldenPrefix: P, actualPrefix: SESSION,
      build: { succeeded: true, bpWarnings: [] },
      systest: { ran: true, passed: true, failures: [] },
    });
    expect(res.goldenDiff.changed).toEqual([]);
    expect(res.goldenDiff.matched).toBe(true);
    expect(res.score.golden_match).toBe(1);
  });

  it('pairs the golden with the actual file the session wrote (`artifactKey` / `resolveActualFile`)', () => {
    expect(artifactKey('FMVehicleDataContractCon_Extension.metadata.xml', P))
      .toBe(artifactKey('FMVehicleDataContractConDemo_Extension.metadata.xml', SESSION));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-infix-'));
    try {
      const actualName = 'FMVehicleDataContractConDemo_Extension.xml';
      fs.writeFileSync(
        path.join(dir, actualName),
        cocExtensionXml('FMVehicleDataContractConDemo_Extension'),
      );
      const hit = resolveActualFile(
        dir, 'FMVehicleDataContractCon_Extension.metadata.xml', P, SESSION,
        cocExtensionXml('FMVehicleDataContractCon_Extension'),
      );
      expect(hit && path.basename(hit)).toBe(actualName);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('anti-greedy: canonicalizePrefix must not collapse two DIFFERENT objects (scoring integrity)', () => {
  it('leaves a mid-identifier prefix token alone when it is a normal PascalCase word', () => {
    // The leading identifier-start boundary of the general branch must NOT move.
    // If it did, `SalesConNote` would canonicalise to `SalesPFXNote` and a real
    // diff against an unrelated object would silently pass.
    expect(canonicalizePrefix('SalesConNote', P)).toBe('SalesConNote');
    expect(canonicalizePrefix('CustContosoThing', 'Contoso')).toBe('CustContosoThing');
    expect(canonicalizePrefix('FMVehicleDataContractConDemo', SESSION))
      .toBe('FMVehicleDataContractConDemo');
  });

  it('does not swallow the PascalCase run before `_Extension` (a longer name is a DIFFERENT object)', () => {
    // `Con` here is the head of the word "Config", not the prefix: the infix
    // branch requires the token to be IMMEDIATELY followed by `_Extension`.
    expect(canonicalizePrefix('FMVehicleDataContractConfig_Extension', P))
      .toBe('FMVehicleDataContractConfig_Extension');
    expect(canonicalizePrefix('FMVehicleDataContractConfig_Extension', P))
      .not.toBe(canonicalizePrefix('FMVehicleDataContractCon_Extension', P));
  });

  it('leaves an UNPREFIXED extension class alone (base merely contains the token)', () => {
    expect(canonicalizePrefix('FMVehicleDataContract_Extension', P))
      .toBe('FMVehicleDataContract_Extension');
    expect(canonicalizePrefix('ReconciliationJournal_Extension', P))
      .toBe('ReconciliationJournal_Extension');
  });

  it('requires `_Extension` to END the identifier', () => {
    expect(canonicalizePrefix('FMVehicleDataContractCon_ExtensionHelper', P))
      .toBe('FMVehicleDataContractCon_ExtensionHelper');
    expect(canonicalizePrefix('FMVehicleDataContractCon_Extension2', P))
      .toBe('FMVehicleDataContractCon_Extension2');
  });

  it('two different extension classes under the SAME prefix stay different', () => {
    const a = canonicalizePrefix('FMVehicleDataContractCon_Extension', P);
    const b = canonicalizePrefix('FMVehicleServiceCon_Extension', P);
    expect(a).not.toBe(b);
  });

  it('normalizeAotXml still REPORTS a real name difference between two extension classes', async () => {
    const g = await normalizeAotXml(cocExtensionXml('FMVehicleDataContractCon_Extension'), [], P);
    const a = await normalizeAotXml(cocExtensionXml('FMVehicleServiceConDemo_Extension'), [], SESSION);
    expect(diffNormalized(g, a).matched).toBe(false);
  });

  it('free-form text keeps its incidental prefix occurrences', () => {
    expect(canonicalizePrefix('Contoso at the wheel', 'Contoso')).toBe('Contoso at the wheel');
    expect(canonicalizePrefix('Con is not a prefix here', P)).toBe('Con is not a prefix here');
  });
});
