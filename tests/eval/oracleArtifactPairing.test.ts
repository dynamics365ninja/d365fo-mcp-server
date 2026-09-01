/**
 * Golden ↔ actual-file PAIRING for multi-artifact (`--actual-dir`) runs.
 *
 * Corpus evidence:
 *   eval/corpus/runs/2026-08-31T22__L3-enum-field-form-downgrade-guard__278eee3.json
 *     — the case's own README says the display menu item's golden "carries the
 *       legacy `.Ax<Type>` infix … because two objects of different types share
 *       one name, and `artifactKey` needs the two files to stay distinguishable".
 *       `artifactKey` STRIPS that infix, so they were not distinguishable at all.
 *   eval/corpus/runs/2026-08-31T22__L3-numberseq-module-slice__278eee3.json (finding 3)
 *     — a dot-notation extension captured as `NumberSeqModule.ConDemoExtension`
 *       and reproduced as `NumberSeqModule.ConExtension` scored 3 missing on
 *       byte-identical content.
 *
 * A display menu item named exactly after the form it opens is a standard
 * D365FO shape — a table's `FormRef` takes a MENU ITEM name, so the pairing is
 * forced — and a flat `--actual-dir` cannot hold two files called `Foo.xml`.
 * So the corpus legitimately contains colliding logical keys, and the oracle
 * has to pair on more than the key. Every test here is VM-free and fails on the
 * pre-fix code.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateMulti, artifactKey, GOLDEN_CAPTURE_PREFIXES, aotRootElement } from '../../src/eval/oracle/index';
import {
  resolveActualFile, resolveActualFileDetailed, buildActualArtifactsMap,
} from '../../src/eval/oracle/actualArtifactResolution';

const P = GOLDEN_CAPTURE_PREFIXES;
const BUILD_OK = { succeeded: true, bpWarnings: [] };

const formXml = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name>
  <SourceCode><Methods/></SourceCode>
  <DataSources><AxFormDataSource><Name>${name}Ds</Name></AxFormDataSource></DataSources>
</AxForm>`;

const menuItemXml = (name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>
<AxMenuItemDisplay xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name>
  <Label>@TaxTransactionInquiry:HeaderNote</Label>
  <Object>${name}</Object>
</AxMenuItemDisplay>`;

/** The committed golden pair: a form and the display menu item that opens it. */
const GOLDENS: Record<string, string> = {
  'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml': menuItemXml('ConDemoTaxChangeLogDetails'),
  'ConDemoTaxChangeLogDetails.metadata.xml': formXml('ConDemoTaxChangeLogDetails'),
};
const GOLDEN_NAMES = Object.keys(GOLDENS);

function withDir<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pairing-'));
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** golden filename → the basename of the actual file it was paired with. */
function pairing(dir: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of GOLDEN_NAMES) {
    const hit = resolveActualFile(dir, name, P, P, GOLDENS[name]);
    out[name] = hit ? path.basename(hit) : undefined;
  }
  return out;
}

describe('a form and its same-named display menu item pair with their OWN files', () => {
  it('the logical keys DO collide — which is why the key alone must not decide', () => {
    // Not a defect in the corpus: this is the shape D365FO forces. The oracle
    // has to carry the type through, not ban the shape.
    expect(artifactKey('ConDemoTaxChangeLogDetails.metadata.xml', P))
      .toBe(artifactKey('ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml', P));
  });

  it('capture convention: bare name = form, `.Ax<Type>` = menu item', () => {
    withDir({
      'ConDemoTaxChangeLogDetails.xml': formXml('ConDemoTaxChangeLogDetails'),
      'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.xml': menuItemXml('ConDemoTaxChangeLogDetails'),
    }, dir => {
      expect(pairing(dir)).toEqual({
        'ConDemoTaxChangeLogDetails.metadata.xml': 'ConDemoTaxChangeLogDetails.xml',
        'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml': 'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.xml',
      });
    });
  });

  it('REPRO: the operator gave the bare name to the MENU ITEM — the pair used to cross over', () => {
    // Which of the two same-named objects gets the undecorated filename is the
    // capturing operator's choice, not a contract. Pre-fix, `artifactKey` +
    // `find` paired the form's golden with the menu item's file and vice versa:
    // two unrelated objects diffed against each other under a green-looking run.
    withDir({
      'ConDemoTaxChangeLogDetails.xml': menuItemXml('ConDemoTaxChangeLogDetails'),
      'ConDemoTaxChangeLogDetails.AxForm.xml': formXml('ConDemoTaxChangeLogDetails'),
    }, dir => {
      expect(pairing(dir)).toEqual({
        'ConDemoTaxChangeLogDetails.metadata.xml': 'ConDemoTaxChangeLogDetails.AxForm.xml',
        'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml': 'ConDemoTaxChangeLogDetails.xml',
      });
    });
  });

  it('REPRO: under prefix drift BOTH goldens used to claim the SAME actual file', () => {
    // Pre-fix, `find` returned the alphabetically-first key match for both
    // goldens, so the form's file was never read at all and the run silently
    // scored two goldens against one menu item.
    withDir({
      'ContosoDemoTaxChangeLogDetails.xml': formXml('ContosoDemoTaxChangeLogDetails'),
      'ContosoDemoTaxChangeLogDetails.AxMenuItemDisplay.xml': menuItemXml('ContosoDemoTaxChangeLogDetails'),
    }, dir => {
      expect(pairing(dir)).toEqual({
        'ConDemoTaxChangeLogDetails.metadata.xml': 'ContosoDemoTaxChangeLogDetails.xml',
        'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml': 'ContosoDemoTaxChangeLogDetails.AxMenuItemDisplay.xml',
      });
      const { matchedActualFiles, pairingProblems } =
        buildActualArtifactsMap(dir, GOLDEN_NAMES, P, P, GOLDENS);
      expect(pairingProblems).toEqual([]);
      expect(matchedActualFiles.size).toBe(2); // a bijection, not one file twice
    });
  });

  it('end-to-end: the drifted pair scores golden_match 1, not a wholesale mismatch', async () => {
    await withDir({
      'ContosoDemoTaxChangeLogDetails.xml': formXml('ContosoDemoTaxChangeLogDetails'),
      'ContosoDemoTaxChangeLogDetails.AxMenuItemDisplay.xml': menuItemXml('ContosoDemoTaxChangeLogDetails'),
    }, async dir => {
      const { actualArtifacts } = buildActualArtifactsMap(dir, GOLDEN_NAMES, P, P, GOLDENS);
      const res = await evaluateMulti({
        caseSpec: { id: 'L3-enum-field-form-downgrade-guard', tier: 3 },
        goldenArtifacts: GOLDENS, actualArtifacts, build: BUILD_OK,
        goldenPrefix: P, actualPrefix: P,
      });
      expect({ missing: res.goldenDiff.missing, extra: res.goldenDiff.extra }).toEqual({ missing: [], extra: [] });
      expect(res.score.golden_match).toBe(1);
    });
  });
});

describe('ANTI-MASKING: a pairing that cannot be decided is reported, never guessed', () => {
  it('a genuinely absent artifact stays absent — the menu item is not lent to the form', async () => {
    await withDir({
      'ConDemoTaxChangeLogDetails.xml': menuItemXml('ConDemoTaxChangeLogDetails'),
    }, async dir => {
      const { actualArtifacts, matchedActualFiles, pairingProblems } =
        buildActualArtifactsMap(dir, GOLDEN_NAMES, P, P, GOLDENS);
      expect(actualArtifacts['ConDemoTaxChangeLogDetails.metadata.xml']).toBe('');
      expect(matchedActualFiles.size).toBe(1);
      expect(pairingProblems).toEqual([]);
      const res = await evaluateMulti({
        caseSpec: { id: 'L3-enum-field-form-downgrade-guard', tier: 3 },
        goldenArtifacts: GOLDENS, actualArtifacts, build: BUILD_OK,
        goldenPrefix: P, actualPrefix: P,
      });
      expect(res.score.golden_match).toBe(0);
      expect(res.goldenDiff.missing.length).toBeGreaterThan(0);
    });
  });

  it('two indistinguishable candidates are REPORTED as ambiguous, not resolved by file order', () => {
    // Same object name, same type, two files: nothing can separate them. The
    // resolver must say so rather than take whichever `readdir` listed first.
    withDir({
      'ConDemoTaxChangeLogDetails.xml': menuItemXml('ConDemoTaxChangeLogDetails'),
      'ContosoDemoTaxChangeLogDetails.xml': menuItemXml('ContosoDemoTaxChangeLogDetails'),
    }, dir => {
      const menuGolden = 'ConDemoTaxChangeLogDetails.AxMenuItemDisplay.metadata.xml';
      const res = resolveActualFileDetailed(dir, menuGolden, P, P, GOLDENS[menuGolden]);
      expect(res.file).toBeUndefined();
      expect(res.ambiguous?.length).toBe(2);
      const { actualArtifacts, pairingProblems } =
        buildActualArtifactsMap(dir, [menuGolden], P, P, GOLDENS);
      expect(pairingProblems.map(p => p.reason)).toEqual(['ambiguous']);
      expect(actualArtifacts[menuGolden]).toBe(''); // scored missing, not guessed
    });
  });

  it('two goldens are never paired with the same actual file', () => {
    // If the second golden's best match is already spoken for, one of the two
    // pairings is wrong AND the shared key would drop an artifact from the run.
    withDir({
      'ConDemoTaxChangeLogDetails.xml': formXml('ConDemoTaxChangeLogDetails'),
      'ConDemoTaxChangeLogDetails.AxForm.xml': formXml('ConDemoTaxChangeLogDetails'),
    }, dir => {
      const { matchedActualFiles, pairingProblems } =
        buildActualArtifactsMap(dir, GOLDEN_NAMES, P, P, GOLDENS);
      // The menu-item golden has no menu item to pair with, whatever the names say.
      expect(matchedActualFiles.size).toBeLessThanOrEqual(1);
      expect(pairingProblems.every(p => p.reason === 'ambiguous' || p.reason === 'claimed-by-another-golden')).toBe(true);
    });
  });
});

describe('dot-notation extension filenames (corpus: L3-numberseq-module-slice, finding 3)', () => {
  const enumExtXml = (name: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>
<AxEnumExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name>
  <EnumValues><AxEnumValue><Name>DemoSlice</Name><Label>@SYS334317</Label></AxEnumValue></EnumValues>
</AxEnumExtension>`;

  it('the extension SUFFIX is session-chosen, so it must not survive in the key', () => {
    // Pre-fix: "NumberSeqModule.PFXDemoExtension" vs "NumberSeqModule" — the
    // marker only stripped a bare `.<prefix>Extension`.
    expect(artifactKey('NumberSeqModule.ConDemoExtension.metadata.xml', P))
      .toBe(artifactKey('NumberSeqModule.ConExtension.metadata.xml', P));
    // …and an extension is still never confused with its base object's own file.
    expect(artifactKey('NumberSeqModule.ConExtension.metadata.xml', P))
      .toBe(artifactKey('NumberSeqModule.metadata.xml', P));
  });

  it('a golden captured as `.ConDemoExtension` pairs with an actual `.ConExtension`', () => {
    const goldenName = 'NumberSeqModule.ConDemoExtension.metadata.xml';
    const goldenXml = enumExtXml('NumberSeqModule.ConDemoExtension');
    withDir({ 'NumberSeqModule.ConExtension.xml': enumExtXml('NumberSeqModule.ConExtension') }, dir => {
      const hit = resolveActualFile(dir, goldenName, P, P, goldenXml);
      expect(hit && path.basename(hit)).toBe('NumberSeqModule.ConExtension.xml');
    });
  });

  it('the hand-abbreviated committed golden stem `NumberSeqModuleExt` still finds its AOT file', () => {
    // eval/goldens/L2-numberseq-basic/NumberSeqModuleExt.AxEnumExtension.metadata.xml
    // declares <Name>NumberSeqModule.ConExtension</Name>. No filename rule maps
    // "NumberSeqModuleExt" onto that — but the document says what it is.
    const goldenName = 'NumberSeqModuleExt.AxEnumExtension.metadata.xml';
    const goldenXml = enumExtXml('NumberSeqModule.ConExtension');
    withDir({ 'NumberSeqModule.ConExtension.xml': goldenXml }, dir => {
      const hit = resolveActualFile(dir, goldenName, P, P, goldenXml);
      expect(hit && path.basename(hit)).toBe('NumberSeqModule.ConExtension.xml');
    });
  });

  it('an extension is not paired with its BASE object of a different type', () => {
    const goldenName = 'NumberSeqModuleExt.AxEnumExtension.metadata.xml';
    const goldenXml = enumExtXml('NumberSeqModule.ConExtension');
    withDir({
      'NumberSeqModule.xml': '<?xml version="1.0"?>\n<AxEnum><Name>NumberSeqModule</Name></AxEnum>',
    }, dir => {
      expect(resolveActualFile(dir, goldenName, P, P, goldenXml)).toBeUndefined();
    });
  });
});

describe('aotRootElement reads the real root, not markup inside the prologue', () => {
  it('ignores an element name that only appears inside a comment', () => {
    expect(aotRootElement('<!-- <AxForm> was here --><AxMenuItemDisplay><Name>X</Name>'))
      .toBe('AxMenuItemDisplay');
  });

  it('ignores an element name inside the XML declaration and a doctype', () => {
    expect(aotRootElement('<?xml version="1.0" encoding="utf-8"?><AxTable><Name>X</Name>'))
      .toBe('AxTable');
    expect(aotRootElement('<!DOCTYPE AxForm SYSTEM "x.dtd"><AxTableExtension>'))
      .toBe('AxTableExtension');
  });

  it('does not read a type out of an UNTERMINATED comment', () => {
    // Ordered alternation alone is NOT enough here, which this test caught:
    // the scanner fails at the `<!--`, advances one character, and then matches
    // `<AxForm>` inside the comment — the same bug as the single-pass strip it
    // replaced. It takes an explicit unterminated-comment branch that consumes
    // to end-of-input to stop the scan.
    expect(aotRootElement('<!-- <AxForm><Name>Injected</Name>')).toBeUndefined();
  });

  it('still returns undefined for a document with no element at all', () => {
    expect(aotRootElement('')).toBeUndefined();
    expect(aotRootElement(undefined)).toBeUndefined();
  });

  it('is not left stateful by a previous call (global regex lastIndex)', () => {
    const xml = '<AxForm><Name>A</Name></AxForm>';
    expect(aotRootElement(xml)).toBe('AxForm');
    expect(aotRootElement(xml)).toBe('AxForm');
  });
});
