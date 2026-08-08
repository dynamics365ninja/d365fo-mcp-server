/**
 * Regression test — C# bridge `replaceCode` must never edit a method it was not asked to edit.
 *
 * MetadataWriteService.ReplaceInMethods() walks a chain of increasingly loose passes looking for
 * `oldCode`. The last link, ReplaceCodeInXmlFallback(), used to take only (axObject, oldCode,
 * newCode) — no method scope at all. So whenever the REQUESTED method did not contain the snippet,
 * the fallback found it in some other member, rewrote that one, and ReplaceCode returned
 * `success: true` naming the method the caller asked for. The caller's edit had silently landed in
 * an unrelated method.
 *
 * The same catch block also turned genuine exceptions (SDK binder faults, provider I/O) into
 * `return false`, which every ReplaceCode arm reports as "oldCode not found" — steering the calling
 * agent into retrying different snippets against a perfectly healthy method instead of surfacing
 * the real failure.
 *
 * Repo tests cannot exercise this: it lives in C# behind the metadata SDK, and the TypeScript side
 * mocks BridgeClient. This is the cheap standing guard on the source itself.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const WRITE_SERVICE_CS = path.join(
  path.resolve(__dirname, '..', '..'),
  'bridge', 'D365MetadataBridge', 'Services', 'MetadataWriteService.cs',
);

let source: string;

/**
 * Slices a member body: from its signature up to the next member declaration, which in this file
 * is always a `///` doc comment / access modifier at 8-space indentation.
 */
function memberBody(marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `member not found — signature changed? ${marker}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const next = rest.slice(marker.length).search(/\n {8}(?:\/\/\/|private|public|internal|protected)/);
  return next === -1 ? rest : rest.slice(0, marker.length + next);
}

/** Every index at which `needle` occurs in `haystack`. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

describe('bridge replaceCode — fallback stays inside the requested method', () => {
  beforeAll(() => {
    source = fs.readFileSync(WRITE_SERVICE_CS, 'utf8');
  });

  it('ReplaceCodeInXmlFallback takes the method scope as parameters', () => {
    expect(
      source,
      'ReplaceCodeInXmlFallback must receive methodName / controlNameFilter / effectiveMethodName — ' +
        'without them it replaces oldCode in ANY member and reports success for the requested one',
    ).toMatch(
      /private bool ReplaceCodeInXmlFallback\(\s*dynamic axObject,\s*string\? methodName,\s*string\? controlNameFilter,\s*string\? effectiveMethodName,\s*string oldCode,\s*string newCode\s*\)/,
    );
  });

  it('every call site forwards the method scope', () => {
    const callSites = indicesOf(source, 'ReplaceCodeInXmlFallback(')
      // Drop the declaration; keep invocations.
      .filter((at) => !/private bool $/.test(source.slice(Math.max(0, at - 13), at)))
      .map((at) => {
        const tail = source.slice(at, at + 300);
        const end = tail.indexOf(';');
        return end === -1 ? tail : tail.slice(0, end);
      });

    expect(callSites.length, 'expected exactly one ReplaceCodeInXmlFallback invocation').toBe(1);

    for (const args of callSites) {
      for (const param of ['methodName', 'controlNameFilter', 'effectiveMethodName']) {
        expect(
          args,
          `ReplaceCodeInXmlFallback invoked without '${param}' — an unscoped fallback silently ` +
            `edits a different method and still returns success`,
        ).toContain(param);
      }
    }
  });

  it('guards every replacement inside the fallback with a name check', () => {
    const body = memberBody('private bool ReplaceCodeInXmlFallback(dynamic axObject,');

    expect(body, 'fallback lost its name predicate').toContain('IsRequestedMember');

    // The predicate must refuse an unnamed member: a member we cannot name is a member we cannot
    // prove is the target, so it must not be edited on a bare text match.
    expect(body).toMatch(/if \(memberName == null\) return false;/);

    // A control-scoped request ("PostButton.clicked") must not reach a sibling control.
    expect(
      body,
      'fallback iterates DataControls without honouring controlNameFilter — it can edit an ' +
        'override on a control the caller never named',
    ).toMatch(/controlNameFilter != null &&\s*!string\.Equals\(ctrlName, controlNameFilter[\s\S]{0,80}continue;/);

    // Each Source write must sit downstream of a scope guard.
    const writes = indicesOf(body, '.Source = src.Replace(');
    expect(
      writes.length,
      'expected the three known Source writes in the fallback (SourceCode.<collection> item, ' +
        'DataControl method, DataControl direct Source)',
    ).toBe(3);

    for (const at of writes) {
      const preceding = body.slice(Math.max(0, at - 900), at);
      expect(
        /IsRequestedMember\(|controlNameFilter != null/.test(preceding),
        `an unguarded Source write at fallback offset ${at} — a replacement with no name/control ` +
          `check crosses a method boundary`,
      ).toBe(true);
    }
  });

  it('does not let an unqualified methodName match a control-level Source in ReplaceInMethods', () => {
    const body = memberBody('private bool ReplaceInMethods(object axObject,');
    expect(
      body,
      'the direct-Source DataControl fallback must be tied to the request (control named, or the ' +
        'control name IS the method) — otherwise methodName="clicked" rewrites the first control ' +
        'in the form that happens to contain oldCode',
    ).toMatch(/bool itemIsRequestedMember[\s\S]{0,400}if \(!replaced && itemIsRequestedMember\)/);
  });
});

describe('bridge replaceCode — real errors are not reported as "oldCode not found"', () => {
  beforeAll(() => {
    source = fs.readFileSync(WRITE_SERVICE_CS, 'utf8');
  });

  it('ReplaceInMethods rethrows instead of returning false on exception', () => {
    const body = memberBody('private bool ReplaceInMethods(object axObject,');

    const catchAt = body.indexOf('catch (Exception ex)');
    expect(catchAt, 'ReplaceInMethods has no typed catch — did the method get restructured?')
      .toBeGreaterThan(0);

    const tail = body.slice(catchAt);
    expect(
      tail,
      'a swallowed exception becomes `false`, which every ReplaceCode arm reports as ' +
        '"oldCode not found" — the agent then retries different snippets instead of seeing the ' +
        'real fault',
    ).not.toMatch(/return false;/);
    expect(tail).toContain('throw new InvalidOperationException');
    expect(tail, 'the original exception must survive as InnerException').toMatch(/,\s*ex\);/);
  });

  it('ReplaceCodeInXmlFallback rethrows instead of swallowing', () => {
    const body = memberBody('private bool ReplaceCodeInXmlFallback(dynamic axObject,');
    const catchAt = body.indexOf('catch (Exception ex)');
    expect(catchAt, 'fallback has no typed catch — did the method get restructured?').toBeGreaterThan(0);
    expect(
      body.slice(catchAt),
      'swallowing here leaves the caller with "oldCode not found" after an aborted scan, possibly ' +
        'with a partial edit already applied',
    ).toContain('throw;');
  });

  it('every "oldCode not found" message names the method that was searched', () => {
    const lines = source
      .split('\n')
      .filter((l) => l.includes('throw new InvalidOperationException($"oldCode not found'));
    expect(lines.length, 'expected one not-found throw per ReplaceCode object-type arm').toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `not-found message omits methodName: ${line.trim()}`).toContain('methodName');
    }
  });
});
