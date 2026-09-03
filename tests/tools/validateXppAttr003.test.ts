/**
 * ATTR003 — two attributes stacked on a method.
 *
 * Why this rule exists when DECL001 and CONV001 were rejected: the rejection
 * criterion was "the compiler's own messages are exact and arrive at the same
 * moment a build would". Here the compiler answers
 * `Compile Fatal Error: … Invalid token '['` with a line and column — it names a
 * token, not a rule, and being a PARSE error it abandons the entire file rather
 * than the method. Nothing in that message says the fix is a comma.
 *
 * The exemption is the hard half. On a CLASS declaration the same stack is legal
 * and ordinary: a census of this install found 2,163 AxClass files doing it, and
 * **0 of 760,583 methods**. A rule that could not tell the two positions apart
 * would report every feature class in ApplicationSuite.
 *
 * Both facts are compiler-verified, not reasoned:
 * `scripts/oracles/probes/coverage-v4c.ts` fails on the stacked method in BOTH the
 * short and the `…Attribute`-suffixed spelling, while the very same attributes
 * compile alone — which is what rules out "the short name does not resolve" as
 * the explanation.
 */

import { describe, expect, it } from 'vitest';
import { runRules } from '../../src/tools/analysis/validateXpp';

const attr003 = (code: string) => runRules(code, 'xpp').filter(v => v.rule === 'ATTR003');

describe('ATTR003 fires on a stacked METHOD attribute', () => {
  it('catches the shape the unit-testing topic invites', () => {
    // The topic lists [SysTestMethod], [SysTestCategory], [SysTestPriority] one
    // under another; stacking them is the obvious reading of that list.
    const v = attr003(`class T extends SysTestCase
{
    [SysTestMethod]
    [SysTestCategory('Unit')]
    public void testX()
    {
    }
}`);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe('error');
    expect(v[0].fix).toContain('[SysTestMethod, SysTestCategory]');
  });

  it('reports one finding per stack, not one per pair', () => {
    const v = attr003(`class T
{
    [A]
    [B]
    [C]
    public void m()
    {
    }
}`);
    expect(v).toHaveLength(1);
  });

  it('still fires when a doc comment sits between the stack and the method', () => {
    expect(attr003(`class T
{
    [SysTestMethod]
    [SysTestPriority('1')]
    /// <summary>Something.</summary>
    public void testX()
    {
    }
}`)).toHaveLength(1);
  });
});

describe('ATTR003 stays silent where stacking is legal or absent', () => {
  it('does not fire above a class declaration', () => {
    // 2,163 shipped files. This exemption is the rule's whole risk surface.
    expect(attr003(`[ExportAttribute(identifierStr(IFeatureMetadata))]
[SysObsolete('x', false, 31\\12\\2030)]
internal final class MyFeature implements IFeatureMetadata
{
}`)).toEqual([]);
  });

  it('does not fire above an abstract or static class', () => {
    expect(attr003(`[A]
[B]
public abstract class MyBase
{
}`)).toEqual([]);
    expect(attr003(`[A]
[B]
public static class MyExt_Extension
{
}`)).toEqual([]);
  });

  it('does not fire on one bracket carrying several attributes', () => {
    // The legal way to do what the developer meant.
    expect(attr003(`class T
{
    [DataMemberAttribute('SalesId'), SysOperationLabelAttribute('@SYS1')]
    public str parmSalesId()
    {
        return '';
    }
}`)).toEqual([]);
  });

  it('does not fire on a single attribute', () => {
    expect(attr003(`class T
{
    [SysTestMethod]
    public void testX()
    {
    }
}`)).toEqual([]);
  });

  it('does not fire on consecutive container destructuring', () => {
    // Two lines that begin with '[' and are not attributes. ATTR001 once read
    // this shape as an attribute list in 195 shipped classes.
    expect(attr003(`class T
{
    public void m(container _con)
    {
        str a, b;

        [a, b] = _con;
        [b, a] = _con;
    }
}`)).toEqual([]);
  });

  it('does not fire on an attribute inside a string or a comment', () => {
    expect(attr003(`class T
{
    public void m()
    {
        str doc = '[SysTestMethod]';
        // [SysTestMethod]
        // [SysTestCategory]
        info(doc);
    }
}`)).toEqual([]);
  });
});

/**
 * The false positive a release audit found, one day after the rule shipped.
 *
 * `maskStringsAndComments` keeps a comment's opener and blanks the rest, so a
 * `///` line comes back as `//` and spaces — the `startsWith('///')` skip never
 * matched anything, and `//` and block comments were not skipped at all. The
 * comment line became the "target", failed the class-declaration test, and a
 * legal class-level stack was reported as a parse error. The full-install sweep
 * missed it because shipped code puts its doc comment ABOVE the attributes.
 */
describe('ATTR003 walks past every comment spelling between a class stack and its declaration', () => {
  it('a line comment', () => {
    expect(attr003(`[ExtensionOf(classStr(SalesLine))]
[SysObsolete('x', false, 31\\12\\2030)]
// wraps the base
final class SalesLine_Extension
{
}`)).toEqual([]);
  });

  it('a doc comment', () => {
    expect(attr003(`[A]
[B]
/// <summary>Documented after the attributes.</summary>
public final class MyFeature
{
}`)).toEqual([]);
  });

  it('a block comment, including a multi-line one', () => {
    expect(attr003(`[A]
[B]
/* one line */
internal final class MyFeature
{
}`)).toEqual([]);
    expect(attr003(`[A]
[B]
/*
   several
   lines
*/
internal final class MyFeature
{
}`)).toEqual([]);
  });

  it('still fires when the same comments precede a METHOD', () => {
    // The skip must not turn into an exemption: what is decorated still decides.
    expect(attr003(`class T
{
    [SysTestMethod]
    [SysTestPriority('1')]
    // ordinary comment
    /* and a block */
    public void testX()
    {
    }
}`)).toHaveLength(1);
  });
});
