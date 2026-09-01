/**
 * The doc-comment presence signal is DIRECTIONAL, and the blank line the writer
 * puts before a class body's closing brace is canonicalised away.
 *
 * Both are the same root cause seen twice: the WRITER changed after the goldens
 * were captured.
 *
 *  - `ensureXppDocComment` injects a class-level `///` block unconditionally,
 *    and commit 0a95198 (2026-08-09) extended that to the bridge create path —
 *    five weeks after the affected goldens were captured (2026-07-07 /
 *    2026-07-23). 34 of the 159 committed goldens carrying a class/interface
 *    `<Declaration>` have no `///` block at all.
 *  - `ensureBlankLineBeforeClosingBrace` adds a blank line between the last
 *    member variable and `}`, and `reindentXppSource` preserves blank lines, so
 *    that one survives canonicalisation too.
 *
 * Evidence: eval/corpus/runs/2026-08-31T23__L3-batch-basic__278eee3.json, whose
 * `DemoBatchContract` Declaration differs from its golden in EXACTLY those two
 * ways and nothing else.
 *
 * What this file pins is the DIRECTION, because that is the part a future
 * "simplify this" change would quietly drop: a golden that HAS a doc comment
 * and an actual that does not must still FAIL. See `valuesEquivalent` in
 * src/eval/oracle/normalize.ts for the rationale and for the deliberate policy
 * of NOT re-capturing the goldens in a batch.
 */

import { describe, it, expect } from 'vitest';
import { normalizeAotXml, valuesEquivalent } from '../../src/eval/oracle/normalize';
import { diffNormalized } from '../../src/eval/oracle/diff';

/** Wrap an X++ class declaration in the AxClass shape the oracle reads. */
const axClass = (declaration: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>ConDemoBatchContract</Name>
  <SourceCode>
    <Declaration><![CDATA[${declaration}]]></Declaration>
  </SourceCode>
</AxClass>`;

/** The golden as captured 2026-07: no doc comment, no blank line before `}`. */
const GOLDEN_DECLARATION = `
[DataContractAttribute]
class ConDemoBatchContract
{
    int batchSize;
    int priorityFactor;
}
`;

/** What the writer produces today: doc comment injected, blank line added. */
const ACTUAL_DECLARATION = `
/// <summary>
/// Data contract class that defines parameters for the demo batch operation.
/// </summary>
[DataContractAttribute]
class ConDemoBatchContract
{
    int batchSize;
    int priorityFactor;

}
`;

const DECLARATION_PATH = 'AxClass/SourceCode/Declaration';

async function diffDeclarations(golden: string, actual: string) {
  const [g, a] = await Promise.all([
    normalizeAotXml(axClass(golden)),
    normalizeAotXml(axClass(actual)),
  ]);
  return diffNormalized(g, a);
}

describe('doc-comment presence is directional', () => {
  it('an actual carrying a doc comment its golden lacks compares EQUAL', () => {
    expect(valuesEquivalent('class Foo\n{\n}', '/// <xmldoc/>\nclass Foo\n{\n}')).toBe(true);
  });

  it('a golden carrying a doc comment the actual lacks still FAILS', () => {
    // The regression direction. Documentation the corpus proved reachable that a
    // run stopped producing is a real defect, and must never be softened away.
    expect(valuesEquivalent('/// <xmldoc/>\nclass Foo\n{\n}', 'class Foo\n{\n}')).toBe(false);
  });

  it('is directional per METHOD too, not only at the top of a value', () => {
    const withDoc = 'class Foo\n{\n/// <xmldoc/>\npublic void bar()\n{\n}\n}';
    const withoutDoc = 'class Foo\n{\npublic void bar()\n{\n}\n}';
    expect(valuesEquivalent(withoutDoc, withDoc)).toBe(true);
    expect(valuesEquivalent(withDoc, withoutDoc)).toBe(false);
  });

  it('does not make two values differing in anything else equal', () => {
    expect(valuesEquivalent('class Foo\n{\n}', '/// <xmldoc/>\nclass Bar\n{\n}')).toBe(false);
    expect(
      valuesEquivalent('class Foo\n{\n    int a;\n}', '/// <xmldoc/>\nclass Foo\n{\n    int b;\n}'),
    ).toBe(false);
    // An extra NON-doc line on the actual side is a real diff, not a doc comment.
    expect(valuesEquivalent('class Foo\n{\n}', 'class Foo\n{\n    int a;\n}')).toBe(false);
  });

  it('survives the whole normalize→diff path, doc comment alone', async () => {
    // The doc-comment half in isolation (no blank line involved), so reverting
    // only the diff-layer rule fails a test.
    const golden = 'class ConDemoBatchContract\n{\n}\n';
    const actual = '/// <summary>\n/// Generated prose.\n/// </summary>\nclass ConDemoBatchContract\n{\n}\n';
    expect((await diffDeclarations(golden, actual)).matched).toBe(true);
    expect((await diffDeclarations(actual, golden)).matched).toBe(false);
  });

  it('still collapses doc-comment CONTENT (unchanged behaviour)', async () => {
    const a = await normalizeAotXml(axClass('/// <summary>\n/// One wording.\n/// </summary>\nclass ConDemoBatchContract\n{\n}\n'));
    const b = await normalizeAotXml(axClass('/// <summary>\n/// A completely different wording.\n/// </summary>\nclass ConDemoBatchContract\n{\n}\n'));
    expect(diffNormalized(a, b).matched).toBe(true);
  });
});

describe('blank line before a closing brace is canonicalised away', () => {
  it('the writer-added blank line before `}` does not register as a diff', async () => {
    const noBlank = 'class ConDemoBatchContract\n{\n    int batchSize;\n}\n';
    const withBlank = 'class ConDemoBatchContract\n{\n    int batchSize;\n\n}\n';
    const [g, a] = await Promise.all([
      normalizeAotXml(axClass(noBlank)),
      normalizeAotXml(axClass(withBlank)),
    ]);
    expect(diffNormalized(g, a).matched).toBe(true);
    // Symmetric — nothing scores blank lines, so neither direction hides a defect.
    expect(diffNormalized(a, g).matched).toBe(true);
  });

  it('keeps a blank line that separates statements inside a body', async () => {
    // Narrow by design: only a blank run immediately before `}` is dropped, so a
    // golden that asserts paragraph structure inside a body still asserts it.
    const withGap = 'class Foo\n{\n    int a;\n\n    int b;\n}\n';
    const withoutGap = 'class Foo\n{\n    int a;\n    int b;\n}\n';
    const [g, a] = await Promise.all([
      normalizeAotXml(axClass(withGap)),
      normalizeAotXml(axClass(withoutGap)),
    ]);
    expect(diffNormalized(g, a).matched).toBe(false);
  });
});

describe('L3-batch-basic DemoBatchContract Declaration (corpus repro)', () => {
  it('matched=false on main, matched=true with both rules', async () => {
    const diff = await diffDeclarations(GOLDEN_DECLARATION, ACTUAL_DECLARATION);
    expect(diff.matched).toBe(true);
    expect(diff.changed).toEqual([]);
  });

  it('a genuine token change in the same Declaration still fails', async () => {
    const broken = ACTUAL_DECLARATION.replace('int priorityFactor;', 'str priorityFactor;');
    const diff = await diffDeclarations(GOLDEN_DECLARATION, broken);
    expect(diff.matched).toBe(false);
    expect(diff.changed.map(c => c.path)).toEqual([DECLARATION_PATH]);
  });

  it('dropping a doc comment the golden HAS still fails', async () => {
    // Same case, mirrored: give the golden the doc comment and take it off the
    // actual. The oracle must not call that a match.
    const diff = await diffDeclarations(ACTUAL_DECLARATION, GOLDEN_DECLARATION);
    expect(diff.matched).toBe(false);
    expect(diff.changed.map(c => c.path)).toEqual([DECLARATION_PATH]);
  });
});
