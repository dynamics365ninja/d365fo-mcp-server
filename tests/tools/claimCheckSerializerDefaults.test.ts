/**
 * The post-write claim check and the values the serializer does not write.
 *
 * `modify-property EntityCategory=Master` on a data entity, and
 * `SupportsSetBasedSqlOperations=false`, were reported as failed writes after a
 * successful bridge round trip: the serializer omits a property that holds its
 * default (Master, No), and writes NoYes as Yes/No, never true/false. Neither is
 * a lost value. A non-default value that is missing still is.
 */

import { describe, it, expect } from 'vitest';
import { claimedMarkerFor, renderClaimCheck } from '../../src/tools/write/preserveMetadataElements';
import { isOmittedDefault, noYesSpelling, rootElementOf } from '../../src/tools/write/serializerOmittedDefaults';

const entity = (props: string): string =>
  '<?xml version="1.0" encoding="utf-8"?>\r\n' +
  '<AxDataEntityView xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\r\n' +
  '\t<Name>ContosoRentEquipmentEntity</Name>\r\n' +
  props +
  '\t<PublicCollectionName>ContosoRentEquipments</PublicCollectionName>\r\n' +
  '\t<Fields>\r\n' +
  '\t\t<AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField">\r\n' +
  '\t\t\t<Name>IsReadOnly</Name>\r\n' +
  '\t\t\t<IsReadOnly>Yes</IsReadOnly>\r\n' +
  '\t\t</AxDataEntityViewField>\r\n' +
  '\t</Fields>\r\n' +
  '</AxDataEntityView>\r\n';

const check = (path: string, value: string, xml: string): string =>
  renderClaimCheck(claimedMarkerFor('modify-property', { propertyPath: path, propertyValue: value }), xml);

describe('claim check: a default the serializer omits is not a failed write', () => {
  it('EntityCategory=Master with no <EntityCategory> element passes', () => {
    expect(check('entityCategory', 'Master', entity('\t<IsPublic>Yes</IsPublic>\r\n'))).toBe('');
    expect(check('EntityCategory', 'master', entity(''))).toBe('');
  });

  it('a NoYes property set to its default (No / false) with no element passes', () => {
    for (const p of ['SupportsSetBasedSqlOperations', 'supportsSetBasedSqlOperations', 'IsPublic', 'DataManagementEnabled']) {
      expect(check(p, 'No', entity(''))).toBe('');
      expect(check(p, 'false', entity(''))).toBe('');
    }
  });

  it('EnableSetBasedSqlOperations=Auto (its default, 99 rather than 0) passes when absent', () => {
    expect(check('EnableSetBasedSqlOperations', 'Auto', entity(''))).toBe('');
  });

  it('a nested element of the same name does not count as the top-level property', () => {
    // The mapped field's <IsReadOnly>Yes</IsReadOnly> is not the entity's IsReadOnly.
    expect(check('IsReadOnly', 'No', entity(''))).toBe('');
  });

  it('true/false is matched against the Yes/No the serializer writes', () => {
    const xml = entity('\t<SupportsSetBasedSqlOperations>Yes</SupportsSetBasedSqlOperations>\r\n');
    expect(check('supportsSetBasedSqlOperations', 'true', xml)).toBe('');
    expect(check('supportsSetBasedSqlOperations', 'Yes', xml)).toBe('');
  });

  it('a table default (CacheLookup=None) passes when absent', () => {
    const table = '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">\n\t<Name>ContosoRentTable</Name>\n\t<Label>@ContosoExt:X</Label>\n\t<Fields />\n</AxTable>\n';
    expect(check('CacheLookup', 'None', table)).toBe('');
    expect(check('CacheLookup', 'Found', table)).toMatch(/is NOT in the file/);
  });
});

describe('claim check: a value that really did not land is still reported', () => {
  it('a non-default EntityCategory that is missing fails', () => {
    expect(check('EntityCategory', 'Transaction', entity(''))).toMatch(/"EntityCategory=Transaction" is NOT in the file/);
  });

  it('a default value fails when the element is present with ANOTHER value', () => {
    const xml = entity('\t<EntityCategory>Document</EntityCategory>\r\n');
    expect(check('EntityCategory', 'Master', xml)).toMatch(/is NOT in the file/);
    const ssbso = entity('\t<SupportsSetBasedSqlOperations>Yes</SupportsSetBasedSqlOperations>\r\n');
    expect(check('SupportsSetBasedSqlOperations', 'false', ssbso)).toMatch(/is NOT in the file/);
  });

  it('a non-default NoYes value (Yes / true) that is missing fails', () => {
    expect(check('SupportsSetBasedSqlOperations', 'true', entity(''))).toMatch(/is NOT in the file/);
    expect(check('IsPublic', 'Yes', entity(''))).toMatch(/is NOT in the file/);
  });

  it('a default of one object type is not borrowed by another', () => {
    // Visible=Yes is an AxTable default, not an AxDataEntityView one.
    expect(check('Visible', 'Yes', entity(''))).toMatch(/is NOT in the file/);
    // An unknown root type has no defaults at all.
    expect(check('EntityCategory', 'Master', '<AxView>\n\t<Name>ContosoView</Name>\n</AxView>\n'))
      .toMatch(/is NOT in the file/);
  });
});

describe('serializerOmittedDefaults helpers', () => {
  it('spells NoYes the way the file does', () => {
    expect(noYesSpelling('true')).toBe('Yes');
    expect(noYesSpelling(' FALSE ')).toBe('No');
    expect(noYesSpelling('Yes')).toBe('Yes');
    expect(noYesSpelling('Master')).toBeNull();
  });

  it('reads the root element', () => {
    expect(rootElementOf(entity(''))).toBe('AxDataEntityView');
    expect(rootElementOf('<AxTable>\n</AxTable>')).toBe('AxTable');
    expect(rootElementOf('<Root/>')).toBeNull();
  });

  it('knows the table defaults it shares with the restore guard', () => {
    expect(isOmittedDefault('AxTable', 'SaveDataPerCompany', 'true')).toBe(true);
    expect(isOmittedDefault('AxTable', 'SaveDataPerCompany', 'No')).toBe(false);
    expect(isOmittedDefault(null, 'EntityCategory', 'Master')).toBe(false);
  });
});
