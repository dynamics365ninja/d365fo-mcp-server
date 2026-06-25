import { describe, it, expect } from 'vitest';
import {
  validateFormExtensionControlShape,
  buildFormExtensionShapeError,
} from '../../src/utils/formExtensionShapeValidator';

const WRONG_SHAPE =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
  `\t<Name>BudgetControlConfiguration.MyExt</Name>\n` +
  `\t<Controls>\n` +
  `\t\t<AxFormControlExtension>\n` +
  `\t\t\t<Name>X</Name>\n` +
  `\t\t\t<ParentControlName>Tab</ParentControlName>\n` +
  `\t\t\t<FormControlExtension>\n` +
  `\t\t\t\t<AxFormIntControl xmlns:d4p1="Microsoft.Dynamics.AX.Metadata.V6">\n` +
  `\t\t\t\t\t<d4p1:Name>X</d4p1:Name>\n` +
  `\t\t\t\t</AxFormIntControl>\n` +
  `\t\t\t</FormControlExtension>\n` +
  `\t\t</AxFormControlExtension>\n` +
  `\t</Controls>\n` +
  `</AxFormExtension>`;

const CORRECT_SHAPE =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<AxFormExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="Microsoft.Dynamics.AX.Metadata.V6">\n` +
  `\t<Name>BudgetControlConfiguration.MyExt</Name>\n` +
  `\t<Controls>\n` +
  `\t\t<AxFormExtensionControl xmlns="">\n` +
  `\t\t\t<Name>FormExtensionControlabc123xyz</Name>\n` +
  `\t\t\t<FormControl xmlns="" i:type="AxFormIntegerControl">\n` +
  `\t\t\t\t<Name>X</Name>\n` +
  `\t\t\t\t<Type>Integer</Type>\n` +
  `\t\t\t\t<FormControlExtension i:nil="true" />\n` +
  `\t\t\t\t<DataField>X</DataField>\n` +
  `\t\t\t\t<DataSource>T</DataSource>\n` +
  `\t\t\t</FormControl>\n` +
  `\t\t\t<Parent>Tab</Parent>\n` +
  `\t\t</AxFormExtensionControl>\n` +
  `\t</Controls>\n` +
  `</AxFormExtension>`;

describe('validateFormExtensionControlShape', () => {
  it('flags all four malformed tokens in the wrong shape', () => {
    const problems = validateFormExtensionControlShape(WRONG_SHAPE);
    const found = problems.map(p => p.found);
    expect(found).toContain('<AxFormControlExtension>');
    expect(found).toContain('<ParentControlName>');
    expect(found).toContain('<FormControlExtension><AxForm…Control>');
    expect(found).toContain('AxFormIntControl');
  });

  it('passes the correct SDK-serialized shape with no problems', () => {
    expect(validateFormExtensionControlShape(CORRECT_SHAPE)).toEqual([]);
  });

  it('does not flag the legitimate self-closing <FormControlExtension i:nil="true" />', () => {
    // The correct shape contains <FormControlExtension i:nil="true" /> — must NOT be flagged.
    const problems = validateFormExtensionControlShape(CORRECT_SHAPE);
    expect(problems.find(p => p.found.includes('FormControlExtension'))).toBeUndefined();
  });

  it('buildFormExtensionShapeError includes the correct template and the found tokens', () => {
    const problems = validateFormExtensionControlShape(WRONG_SHAPE);
    const msg = buildFormExtensionShapeError('BudgetControlConfiguration.MyExt', problems);
    expect(msg).toMatch(/AxFormExtensionControl xmlns=""/);
    expect(msg).toMatch(/AxFormIntegerControl/);
    expect(msg).toMatch(/<Parent>/);
    expect(msg).toMatch(/AxFormIntControl/); // the "found" token is shown too
  });
});
