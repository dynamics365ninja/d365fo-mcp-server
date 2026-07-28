/**
 * L2-coc-inherited-method pins two facts the agent can only know by walking the
 * extends chain: the class that DECLARES the inherited method, and the chain
 * itself. This test guards WHERE those facts are written.
 *
 * The case as first drafted put them in a `///` <remarks> block. That is void:
 * `canonicalizeXppDocComments` collapses every contiguous run of `///` lines to
 * one `/// <xmldoc/>` placeholder (deliberately — doc-comment WORDING is not
 * pinned by any case, and d365fo_file auto-injects generated prose). So the
 * golden would have compared equal for a completely wrong declaring class, and
 * the case would have scored golden_match=1 while proving nothing at all.
 *
 * Moving the facts into `//` body comments fixes it: only `///` runs collapse.
 * The test asserts the property that matters — that the oracle can actually
 * tell a right answer from a wrong one — rather than the instruction wording,
 * so it keeps holding if the case is reworded.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { normalizeAotXml, renderNormalized } from '../../src/eval/oracle/normalize';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CASE_ID = 'L2-coc-inherited-method';

const caseSpec = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'eval', 'cases', `${CASE_ID}.json`), 'utf8'),
);

/** The wrapper shape the case mandates, parameterised by the two pinned facts. */
const wrapper = (declaring: string, chain: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>SalesFormLetter_InvoiceCon_Extension</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>promptAndRun</Name>
        <Source><![CDATA[/// <summary>
/// Chain of Command wrapper for a method the augmented class only inherits.
/// </summary>
public void promptAndRun()
{
    // Declared on: ${declaring}
    // Chain: ${chain}
    next promptAndRun();
}]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>`;

/** The void shape: same facts, but inside the `///` header. */
const wrapperInDocComment = (declaring: string) => `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>SalesFormLetter_InvoiceCon_Extension</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>promptAndRun</Name>
        <Source><![CDATA[/// <summary>
/// Chain of Command wrapper for a method the augmented class only inherits.
/// </summary>
/// <remarks>
/// Declared on: ${declaring}
/// </remarks>
public void promptAndRun()
{
    next promptAndRun();
}]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>`;

const norm = async (xml: string) =>
  renderNormalized(await normalizeAotXml(xml, caseSpec.ignore ?? []));

const CHAIN = 'SalesFormLetter_Invoice -> SalesFormLetter -> FormLetterServiceController';

describe(`${CASE_ID}: the pinned inheritance facts must survive golden normalization`, () => {
  it('the golden distinguishes the right declaring class from a wrong one', async () => {
    const right = await norm(wrapper('SalesFormLetter', CHAIN));
    const wrong = await norm(wrapper('TotallyWrongClass', CHAIN));
    expect(right).not.toBe(wrong);
    expect(right).toContain('// Declared on: SalesFormLetter');
  });

  it('the golden distinguishes the right chain from a truncated one', async () => {
    const right = await norm(wrapper('SalesFormLetter', CHAIN));
    const truncated = await norm(wrapper('SalesFormLetter', 'SalesFormLetter_Invoice'));
    expect(right).not.toBe(truncated);
  });

  it('documents WHY: the same facts in a /// block are erased, so the oracle goes blind', async () => {
    const right = await norm(wrapperInDocComment('SalesFormLetter'));
    const wrong = await norm(wrapperInDocComment('TotallyWrongClass'));
    // This is the bug the case was rewritten to avoid — a wrong answer scoring
    // golden_match=1. If this ever stops holding, the /// collapse changed and
    // the case instruction's rationale needs revisiting.
    expect(right).toBe(wrong);
    expect(right).toContain('/// <xmldoc/>');
  });

  it('the case instruction keeps the facts out of the /// header', () => {
    const instruction: string = caseSpec.instruction;
    // The mandated wrapper text must carry them as `//` body comments…
    expect(instruction).toContain('// Declared on: <DeclaringClass>');
    expect(instruction).toContain('// Chain: <Chain>');
    // …and never as `///` doc lines.
    expect(instruction).not.toContain('/// Declared on:');
    expect(instruction).not.toContain('/// Chain:');
  });
});
