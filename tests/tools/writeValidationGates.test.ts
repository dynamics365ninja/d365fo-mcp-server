/**
 * Input-validation gates for writes that used to succeed while writing something
 * else (audit §3 items 8, 9, 10, 15, 16).
 *
 * What ties them together: every one of them produced a file that BUILDS CLEAN.
 * The D365FO deserializer drops an element whose value is not a member of the
 * target enum, the metadata writer accepts any string as an ExtendedDataType, and
 * a data entity with no query is perfectly well-formed. So none of these was
 * catchable downstream — the tool had to refuse them.
 *
 * The value sets asserted here come from the metamodel itself (reflection over
 * PackagesLocalDirectory\bin\Microsoft.Dynamics.AX.Metadata[.Core].dll), not from
 * documentation — two of them contradicted what this repo had been documenting.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildAxSecurityPrivilegeXml } from '../../src/tools/xml/securityPrivilegeXml';
import { buildAxDataEntityXml, assertDataEntityIsFunctional } from '../../src/tools/xml/dataEntityXml';
import { XmlTemplateGenerator } from '../../src/tools/write/createD365File';

// ── audit 10: security privilege accessLevel / objectType ───────────────────

describe('security privilege accessLevel is a closed enum (audit 10)', () => {
  const maintainGrant = /<Create>Allow<\/Create>/;

  it('maintain still grants full CRUD on both entry points and data entities', () => {
    const ep = buildAxSecurityPrivilegeXml('P', { targetObject: 'MyMenuItem', accessLevel: 'maintain' });
    expect(ep).toMatch(maintainGrant);
    const de = buildAxSecurityPrivilegeXml('P', { dataEntity: 'MyEntity', accessLevel: 'MAINTAIN' });
    expect(de).toMatch(maintainGrant);
    expect(de).toContain('<Correct>Allow</Correct>');
  });

  it('view/read stay Read-only', () => {
    for (const level of ['view', 'read', 'View', undefined]) {
      const xml = buildAxSecurityPrivilegeXml('P', { targetObject: 'MyMenuItem', accessLevel: level });
      expect(xml, String(level)).not.toMatch(maintainGrant);
      expect(xml).toContain('<Read>Allow</Read>');
    }
  });

  it('REFUSES "full"/"edit"/"update" instead of degrading them to Read-only', () => {
    // The exact defect: any string that was not "maintain" produced a read-only
    // privilege that builds clean, passes BP, and grants the wrong permissions.
    for (const level of ['full', 'edit', 'update', 'delete', 'readwrite']) {
      expect(
        () => buildAxSecurityPrivilegeXml('P', { targetObject: 'M', accessLevel: level }),
        level,
      ).toThrow(/accessLevel .* is not supported/);
    }
  });

  it('validates objectType against EntryPointType', () => {
    expect(buildAxSecurityPrivilegeXml('P', { targetObject: 'M', objectType: 'menuitemaction' }))
      .toContain('<ObjectType>MenuItemAction</ObjectType>');
    expect(buildAxSecurityPrivilegeXml('P', { targetObject: 'M', objectType: 'ServiceOperation' }))
      .toContain('<ObjectType>ServiceOperation</ObjectType>');
    expect(() => buildAxSecurityPrivilegeXml('P', { targetObject: 'M', objectType: 'MenuItem' }))
      .toThrow(/objectType: "MenuItem" is not a valid value/);
  });
});

// ── audit 9: explicit enum values ───────────────────────────────────────────

describe('explicit enum values are honoured, not dropped (audit 9)', () => {
  const values = [
    { name: 'None' },
    { name: 'Pending', value: 10 },
    { name: 'Done', value: 20 },
  ];

  it('auto-sets UseEnumValue=Yes and emits <Value> when the caller numbered the values', () => {
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoStatus', { enumValues: values });
    expect(xml).toContain('<UseEnumValue>Yes</UseEnumValue>');
    expect(xml).toContain('<Value>10</Value>');
    expect(xml).toContain('<Value>20</Value>');
  });

  it('leaves an unnumbered enum exactly as before (UseEnumValue=No, no <Value>)', () => {
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoStatus', {
      enumValues: [{ name: 'A' }, { name: 'B' }],
    });
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).not.toContain('<Value>');
  });

  it('treats redundant positional numbering (0,1,2) as no numbering at all', () => {
    // Otherwise a harmless payload — and every extensible enum spelled that way —
    // would start failing.
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoStatus', {
      isExtensible: true,
      enumValues: [{ name: 'A', value: 0 }, { name: 'B', value: 1 }],
    });
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).not.toContain('<Value>');
    expect(xml).toContain('<IsExtensible>true</IsExtensible>');
  });

  it('refuses isExtensible + real numbering (xppc rejects that combination)', () => {
    expect(() => XmlTemplateGenerator.generateAxEnumXml('ConDemoStatus', {
      isExtensible: true,
      enumValues: values,
    })).toThrow(/isExtensible=true cannot be combined with explicit enum values/);
  });

  it('refuses useEnumValue=false + real numbering (a contradiction in one payload)', () => {
    expect(() => XmlTemplateGenerator.generateAxEnumXml('ConDemoStatus', {
      useEnumValue: false,
      enumValues: values,
    })).toThrow(/useEnumValue=false contradicts/);
  });

  it('the extensible-enum rule the project depends on still holds', () => {
    const xml = XmlTemplateGenerator.generateAxEnumXml('ConDemoStatus', {
      isExtensible: true,
      enumValues: [{ name: 'A' }, { name: 'B' }],
    });
    expect(xml).toContain('<UseEnumValue>No</UseEnumValue>');
    expect(xml).not.toContain('<Value>');
  });
});

// ── audit 16: enum-ish property values written verbatim ─────────────────────

describe('enum-ish metadata properties are validated (audit 16)', () => {
  it('entityCategory canonicalizes case and refuses a non-member', () => {
    const xml = buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], entityCategory: 'master' });
    expect(xml).toContain('<EntityCategory>Master</EntityCategory>');
    // `Parameters` is the metamodel member; `Parameter` (what the header used to
    // document) is dropped by the deserializer.
    expect(buildAxDataEntityXml('E', { primaryTable: 'T', fields: [{ name: 'A' }], entityCategory: 'Parameters' }))
      .toContain('<EntityCategory>Parameters</EntityCategory>');
    expect(() => buildAxDataEntityXml('E', {
      primaryTable: 'T', fields: [{ name: 'A' }], entityCategory: 'Parameter',
    })).toThrow(/entityCategory: "Parameter" is not a valid value/);
    expect(() => buildAxDataEntityXml('E', {
      primaryTable: 'T', fields: [{ name: 'A' }], entityCategory: 'Masters',
    })).toThrow(/Master \| Configuration \| Transaction/);
  });

  it('relation cardinality / relationshipType are refused when not metamodel members', () => {
    const ok = XmlTemplateGenerator.generateAxTableExtensionXml('T.ConExtension', {
      relations: [{ name: 'R', relatedTable: 'X', constraints: [], cardinality: 'zeroone', relationshipType: 'composition' }],
    });
    expect(ok).toContain('<Cardinality>ZeroOne</Cardinality>');
    expect(ok).toContain('<RelationshipType>Composition</RelationshipType>');

    expect(() => XmlTemplateGenerator.generateAxTableExtensionXml('T.ConExtension', {
      relations: [{ name: 'R', relatedTable: 'X', constraints: [], cardinality: 'OneToMany' }],
    })).toThrow(/cardinality: "OneToMany" is not a valid value/);

    // The related side is a SMALLER set — ZeroMore is legal on the local side only.
    expect(() => XmlTemplateGenerator.generateAxTableExtensionXml('T.ConExtension', {
      relations: [{ name: 'R', relatedTable: 'X', constraints: [], relatedTableCardinality: 'ZeroMore' }],
    })).toThrow(/relatedTableCardinality: "ZeroMore" is not a valid value/);

    expect(() => XmlTemplateGenerator.generateAxTableExtensionXml('T.ConExtension', {
      relations: [{ name: 'R', relatedTable: 'X', constraints: [], relationshipType: 'ForeignKey' }],
    })).toThrow(/relationshipType: "ForeignKey" is not a valid value/);
  });

  it('security-policy contextType is validated against SecurityPolicyContextType', () => {
    expect(XmlTemplateGenerator.generateAxSecurityPolicyXml('P', { contextType: 'rolename' }))
      .toContain('<ContextType>RoleName</ContextType>');
    // Omitted stays omitted — the element is optional on real shipped policies.
    expect(XmlTemplateGenerator.generateAxSecurityPolicyXml('P', {})).not.toContain('<ContextType>');
    expect(() => XmlTemplateGenerator.generateAxSecurityPolicyXml('P', { contextType: 'Role' }))
      .toThrow(/contextType: "Role" is not a valid value/);
  });
});

// ── audit 15: inert data entity ─────────────────────────────────────────────

describe('a data entity with no primaryTable/fields is refused (audit 15)', () => {
  it('names both required properties', () => {
    expect(() => assertDataEntityIsFunctional('ConDemoEntity', {}))
      .toThrow(/missing primaryTable and fields/);
    expect(() => assertDataEntityIsFunctional('ConDemoEntity', { primaryTable: '  ' , fields: [] }))
      .toThrow(/missing primaryTable and fields/);
    expect(() => assertDataEntityIsFunctional('ConDemoEntity', { primaryTable: 'T', fields: [] }))
      .toThrow(/missing fields/);
  });

  it('passes a real entity through', () => {
    expect(() => assertDataEntityIsFunctional('ConDemoEntity', {
      primaryTable: 'T', fields: [{ name: 'A' }],
    })).not.toThrow();
  });
});

// ── audit 8: the type/fieldType + EDT contract on the C# side ───────────────

describe('bridge field contract (audit 8)', () => {
  // The bridge has no test runner in this repo, so these are source-level pins on
  // the two halves of the defect: the key contract, and the EDT existence gate
  // that stopped "Iteger" from being written as an ExtendedDataType.
  const writeService = readFileSync('bridge/D365MetadataBridge/Services/MetadataWriteService.cs', 'utf8');
  const dispatcher = readFileSync('bridge/D365MetadataBridge/Protocol/RequestDispatcher.cs', 'utf8');

  it('WriteFieldParam binds both the `type` and `fieldType` spellings', () => {
    expect(writeService).toContain('JsonPropertyName("type")');
    expect(writeService).toContain('JsonPropertyName("fieldType")');
    expect(writeService).toContain('JsonPropertyName("edt")');
    expect(writeService).toContain('JsonPropertyName("extendedDataType")');
  });

  it('the add-field RPCs accept both spellings too', () => {
    expect(dispatcher).toContain('GetStringParam("fieldType") ?? request.GetStringParam("type")');
    expect(dispatcher).toContain('S("fieldType") ?? S("type")');
  });

  it('an ExtendedDataType is verified to exist before it is written', () => {
    expect(writeService).toContain('RequireExtendedDataTypeExists');
    expect(writeService).toContain('_provider.Edts.Exists(edtName)');
    // Both paths that can set ExtendedDataType go through the gate.
    expect(writeService).toMatch(/RequireExtendedDataTypeExists\(f\.Name, f\.FieldType!/);
    expect(writeService).toMatch(/RequireExtendedDataTypeExists\(f\.Name, f\.Edt!/);
  });

  it('add-enum-value refuses a non-integer value instead of writing 0', () => {
    expect(dispatcher).toMatch(/is not an integer — nothing was written/);
  });
});
