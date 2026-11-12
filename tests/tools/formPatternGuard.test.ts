import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FormPatternTemplates } from '../../src/utils/formPatternTemplates';
import { describeFormPatternErrors, scanFormPatternErrors } from '../../src/tools/sdlc/formPatternGuard';

// A FieldsFieldGroups container without ColumnsMode is ColumnsMode Fixed, its metamodel default;
// the pattern requires Fill. A pipeline build rejects such a form.
const opts = (formName: string) => ({
  formName,
  dsName: 'ContosoRentEquipmentTable',
  dsTable: 'ContosoRentEquipmentTable',
  caption: 'Rent equipment',
  gridFields: ['EquipmentId', 'Name'],
  sections: [{ name: 'General', caption: 'General' }],
});
const compliantForm = (name: string) => FormPatternTemplates.buildSimpleListDetails(opts(name));
const withoutColumnsMode = (name: string) => compliantForm(name).replace(/\s*<ColumnsMode>Fill<\/ColumnsMode>/g, '');

let root: string;
const write = (rel: string, text: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-guard-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('scanFormPatternErrors', () => {
  it('reports a FieldsFieldGroups container without ColumnsMode Fill as an error, per form', async () => {
    write('ContosoExt/ContosoExt/AxForm/ContosoRentEquipment.xml', withoutColumnsMode('ContosoRentEquipment'));
    const r = await scanFormPatternErrors(root, 'ContosoExt');
    expect(r.formsChecked).toBe(1);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatchObject({ form: 'ContosoRentEquipment', rule: 'FP011' });
    expect(r.errors.map(e => e.excerpt).join('\n')).toContain('ColumnsMode must be "Fill", is "Fixed" (default)');
  });

  it('finds nothing in a form that follows its pattern', async () => {
    write('ContosoExt/ContosoExt/AxForm/ContosoRentEquipment.xml', compliantForm('ContosoRentEquipment'));
    const r = await scanFormPatternErrors(root, 'ContosoExt');
    expect(r).toEqual({ errors: [], formsChecked: 1, unreadable: [] });
  });

  it('checks the forms of every model in the package and skips folders without forms', async () => {
    write('ContosoExt/ContosoExt/AxForm/ContosoRentEquipment.xml', compliantForm('ContosoRentEquipment'));
    write('ContosoExt/ContosoExtTest/AxForm/ContosoRentEquipmentTest.xml', withoutColumnsMode('ContosoRentEquipmentTest'));
    write('ContosoExt/bin/Dynamics.AX.ContosoExt.dll', 'binary');
    write('ContosoExt/ContosoExt/AxClass/ContosoHelper.xml', '<AxClass><Name>ContosoHelper</Name></AxClass>');
    const r = await scanFormPatternErrors(root, 'ContosoExt');
    expect(r.formsChecked).toBe(2);
    expect(new Set(r.errors.map(e => e.form))).toEqual(new Set(['ContosoRentEquipmentTest']));
    expect(r.unreadable).toEqual([]);
  });

  it('lists a file it cannot parse as unreadable, never as a pattern error', async () => {
    write('ContosoExt/ContosoExt/AxForm/ContosoBroken.xml', '<AxForm><Design>');
    const r = await scanFormPatternErrors(root, 'ContosoExt');
    expect(r.errors).toEqual([]);
    expect(r.unreadable).toHaveLength(1);
  });

  it('reports a missing package folder as unreadable', async () => {
    const r = await scanFormPatternErrors(root, 'ContosoMissing');
    expect(r.errors).toEqual([]);
    expect(r.unreadable).toHaveLength(1);
  });
});

describe('describeFormPatternErrors', () => {
  it('names the form, the control path, the finding and the rule, and caps the list', () => {
    const errors = Array.from({ length: 23 }, (_, i) => ({
      form: `ContosoForm${String(i).padStart(2, '0')}`, rule: 'FP011', path: 'Design/Group[HeaderGroup]',
      excerpt: 'sub-pattern FieldsFieldGroups 1.1: ColumnsMode must be "Fill", is "Fixed" (default)',
    }));
    const text = describeFormPatternErrors(errors);
    expect(text.split('\n')[0]).toBe(
      '  AxForm/ContosoForm00: Design/Group[HeaderGroup]: sub-pattern FieldsFieldGroups 1.1: ColumnsMode must be "Fill", is "Fixed" (default) (FP011)',
    );
    expect(text).toContain('… and 3 more');
    expect(text).not.toContain('ContosoForm20');
  });
});
