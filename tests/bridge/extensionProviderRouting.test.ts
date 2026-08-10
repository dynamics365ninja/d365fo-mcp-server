/**
 * Extension types must be resolved against their OWN provider collection.
 *
 * IMetadataProvider keys Tables/Forms by plain object names; a table or form
 * extension is keyed by its dotted "Base.ModelExtension" name in
 * TableExtensions/FormExtensions. Routing an extension through the base
 * collection therefore always misses — a deterministic false negative that
 * refreshing the provider cannot fix. It surfaced as a bogus "not found by
 * IMetadataProvider after refresh" warning on every successful extension write.
 */

import { describe, it, expect } from 'vitest';
import { READ_SERVICE_CS, WRITE_SERVICE_CS, readStripped, methodBody } from './csharpSource';

/** The `case "<label>":` block of a C# switch, up to the next `case`/`default`. */
function caseBlock(body: string, label: string): string {
  const start = body.indexOf(`case "${label}":`);
  expect(start, `case "${label}:" not found`).toBeGreaterThan(-1);
  const rest = body.slice(start + `case "${label}":`.length);
  const end = rest.search(/\n\s*(case "|default:)/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('ValidateObject routes extensions to the extension providers', () => {
  const body = methodBody(readStripped(READ_SERVICE_CS), 'public object? ValidateObject(');

  it('reads table-extension from TableExtensions, never Tables', () => {
    const block = caseBlock(body, 'table-extension');
    expect(block).toContain('_provider.TableExtensions');
    expect(block).not.toContain('_provider.Tables.');
  });

  it('reads form-extension from FormExtensions, never Forms', () => {
    const block = caseBlock(body, 'form-extension');
    expect(block).toContain('_provider.FormExtensions');
    expect(block).not.toContain('_provider.Forms.');
  });

  it('does not let table-extension fall through the plain table case', () => {
    // `case "table": case "table-extension":` sharing one body is the original bug.
    expect(body).not.toMatch(/case "table":\s*case "table-extension":/);
    expect(body).not.toMatch(/case "form":\s*case "form-extension":/);
  });

  it('still resolves the plain types against the base collections', () => {
    expect(caseBlock(body, 'table')).toContain('_provider.Tables');
    expect(caseBlock(body, 'form')).toContain('_provider.Forms');
  });
});

describe('ResolveObjectInfo routes extensions to the extension providers', () => {
  const body = methodBody(readStripped(READ_SERVICE_CS), 'public object? ResolveObjectInfo(');

  it('probes table-extension via TableExtensions', () => {
    const block = caseBlock(body, 'table-extension');
    expect(block).toContain('TableExtensions');
    expect(block).not.toContain('p.Tables.');
  });

  it('probes form-extension via FormExtensions', () => {
    const block = caseBlock(body, 'form-extension');
    expect(block).toContain('FormExtensions');
    expect(block).not.toContain('p.Forms.');
  });

  it('does not share a body between a base type and its extension', () => {
    expect(body).not.toMatch(/case "table":\s*case "table-extension":/);
    expect(body).not.toMatch(/case "form":\s*case "form-extension":/);
  });
});

describe('AddControl refuses form extensions instead of misreporting them', () => {
  const body = methodBody(readStripped(WRITE_SERVICE_CS), 'public object AddControl(');

  it('rejects a dotted name before the Forms lookup can miss', () => {
    const guard = body.indexOf("formName.Contains('.')");
    const lookup = body.indexOf('_provider.Forms.Read(formName)');
    expect(guard, 'no dotted-name guard in AddControl').toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(guard);
  });

  it('says the name is a form extension rather than that the form is missing', () => {
    expect(body).toContain('is a form extension');
  });
});
