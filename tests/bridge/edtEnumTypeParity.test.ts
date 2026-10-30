/**
 * The bridge's EDT writer must accept EnumType on an enum EDT.
 *
 * SetAxEdtProperty had no `enumtype` case, so `enumType` fell to `default` and came
 * back in unsupportedProperties: an enum EDT created through the bridge had no enum.
 * Checked live with a bridge built from this source: BaseType Enum, Extends NoYesId,
 * enumType NoYes wrote AxEdtEnum with <EnumType>NoYes</EnumType> after
 * <TableReferences />, the shape of every shipped child of an enum EDT, and reported
 * no unsupported property.
 */
import { describe, it, expect } from 'vitest';
import { WRITE_SERVICE_CS, readStripped, methodBody } from './csharpSource';

const source = readStripped(WRITE_SERVICE_CS);

describe('SetAxEdtProperty', () => {
  const body = methodBody(source, 'private bool SetAxEdtProperty(');

  it('sets EnumType on an AxEdtEnum', () => {
    expect(body).toMatch(/case "enumtype":[\s\S]*?AxEdtEnum[\s\S]*?\.EnumType = value;/);
  });

  it('refuses EnumType on any other EDT type instead of reporting it applied', () => {
    expect(body).toMatch(/case "enumtype":\s*if \(edt is not AxEdtEnum \w+\) return false;/);
  });
});
