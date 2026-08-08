/**
 * MetadataWriteService correctness guards (audit findings #13, #17, #28).
 *
 * All three are the same class of defect — the bridge reports ✅ over a write that did not
 * do what was asked — and none of them can be reproduced from vitest, because the write
 * service only runs against a real D365FO metadata provider on a Windows VM. So they are
 * guarded the way the repo already guards C# invariants: by reading the C# source, with
 * comments stripped so the explanation of a fix cannot stand in for the fix.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { WRITE_SERVICE_CS, readStripped, methodBody } from './csharpSource';

let source: string;

beforeAll(() => {
  source = readStripped(WRITE_SERVICE_CS);
});

describe('#13 rename-field repoints every reference on the object', () => {
  let body: string;

  beforeAll(() => {
    body = methodBody(source, 'public object RenameField(string tableName, string oldName, string newName)');
  });

  // Each of these names a field, and a stale one is a compile error on the next build —
  // not a warning — while rename-field had already reported success.
  it.each([
    ['indexes', 'RepointIndexFields'],
    ['full-text indexes', 'RepointFullTextIndexFields'],
    ['field groups', 'RepointFieldGroupFields'],
    ['relation constraints', 'RepointRelationFields'],
    ['Map connections', 'RepointMappingFields'],
  ])('repoints %s', (_label, helper) => {
    const calls = body.match(new RegExp(`${helper}\\(`, 'g')) ?? [];
    expect(
      calls.length,
      `RenameField does not call ${helper} on both the table and the table-extension branch — ` +
        'the rename leaves references pointing at a field name that no longer exists, and the ' +
        'table stops compiling while the tool reports success',
    ).toBe(2);
  });

  it('repoints the extension-only collections too', () => {
    expect(body).toContain('FieldGroupExtensions');
    expect(body).toContain('RelationExtensions');
  });

  it('reports what it repointed instead of only asserting success', () => {
    const returns = body.match(/repointedReferences/g) ?? [];
    expect(returns.length, 'both rename-field branches must report the references they moved').toBe(2);
  });

  it('moves only the LOCAL side of a relation constraint', () => {
    const helper = methodBody(source, 'private static int RepointConstraintFields(');
    // RelatedField names a column on the OTHER table; rewriting it here would point a
    // working constraint at a field that does not exist there.
    expect(helper).toContain('cf.Field = newName');
    expect(helper).not.toContain('RelatedField = newName');
  });

  it('moves only MapFieldTo in a Map connection', () => {
    const helper = methodBody(source, 'private static int RepointMappingFields(');
    // MapField names the field on the MAP; only MapFieldTo names one on this table.
    expect(helper).toContain('c.MapFieldTo = newName');
    expect(helper).not.toContain('c.MapField = newName');
  });
});

describe('#17 add-enum-value ownership guard', () => {
  it('refuses both branches when the target lives in a Microsoft model', () => {
    const body = methodBody(
      source,
      'public object AddEnumValue(string enumName, string valueName, int value, string? label, string? countryRegionCodes = null)',
    );
    const guards = body.match(/AssertModelWritable\(/g) ?? [];
    expect(
      guards.length,
      'AddEnumValue resolves the BASE enum first, so asking for a value on a shipped enum ' +
        'writes straight into Microsoft\'s model and reports success — both the enum and the ' +
        'enum-extension branch need the guard',
    ).toBe(2);
  });

  it('decides ownership from the model manifest publisher, and defaults to allowing the write', () => {
    const body = methodBody(source, 'private bool IsMicrosoftModel(string? modelName)');
    // Publisher, not a hard-coded model list (which goes stale every release) and not the
    // layer (Microsoft ships the Tutorial model in the usr layer).
    expect(body).toContain('Publisher');
    expect(
      body,
      'the verdict must start at false so an unreadable manifest cannot start refusing writes ' +
        'that work today — a false positive would block a customer\'s own model with no way out',
    ).toContain('var isMicrosoft = false;');
  });

  it('throws rather than reporting a skipped write as success', () => {
    const body = methodBody(source, 'private void AssertModelWritable(');
    expect(body).toContain('throw new InvalidOperationException');
  });
});

describe('#28 property setters report what they could not write', () => {
  it('EDT stringSize fails on a non-string base type instead of returning true', () => {
    const body = methodBody(source, 'private bool SetAxEdtProperty(AxEdt edt, string prop, string value)');
    const stringSize = body.slice(body.indexOf('case "stringsize":'), body.indexOf('case "referencetable":'));
    expect(
      stringSize,
      'stringSize on an int/real/enum EDT has nowhere to go; falling through to `return true` ' +
        'reports a length that was never written',
    ).toMatch(/return false/);
  });

  it('menu-item enum values are rejected with the legal ones, not silently dropped', () => {
    const body = methodBody(source, 'private bool SetAxMenuItemProperty(dynamic mi, string prop, string value)');
    for (const [prop, marker] of [['objecttype', 'MenuItemObjectType'], ['openmode', 'OpenMode']]) {
      const arm = body.slice(body.indexOf(`case "${prop}":`));
      const armBody = arm.slice(0, arm.indexOf('break;'));
      expect(
        armBody,
        `an unparseable ${prop} left the property at its metamodel default and reported success — ` +
          'the menu item then shipped pointing at nothing',
      ).toContain('throw new ArgumentException');
      expect(armBody).toContain(marker);
    }
  });

  it('AxQuery subclass misses are reported, not caught and passed off as applied', () => {
    const body = methodBody(source, 'private bool SetAxQueryProperty(AxQuery q, string prop, string value)');
    const swallowed = body.match(/catch \{ Console\.Error\.WriteLine\([^)]*\); \}/g) ?? [];
    expect(
      swallowed.length,
      'a catch that logs and falls through to `return true` is the same hollow success as an ' +
        'unknown key — the property was not written',
    ).toBe(0);
    expect((body.match(/return false;/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('form control bindings that do not stick are named in the result', () => {
    const create = methodBody(source, 'private dynamic CreateFormControl(');
    expect(
      create,
      'a Group/Tab/Button control has no DataSource; `catch { }` produced an UNBOUND control ' +
        'reported as added and bound',
    ).not.toMatch(/catch \{ \}/);
    expect(create).toContain('unsupportedProperties.Add("dataSource")');
    expect(create).toContain('unsupportedProperties.Add("dataField")');

    const addControl = methodBody(source, 'public object AddControl(string formName, string controlName, string parentControl,');
    expect(addControl, 'add-control must return what did not apply').toContain('unsupportedProperties');
  });

  it('create paths that use these setters report the keys that did not apply', () => {
    for (const signature of [
      'public object CreateEdt(',
      'public object CreateQuery(string name, string modelName, Dictionary<string, string>? properties)',
      'public object CreateMenuItemAction(string name, string modelName, Dictionary<string, string>? properties)',
      'public object CreateMenuItemDisplay(string name, string modelName, Dictionary<string, string>? properties)',
      'public object CreateMenuItemOutput(string name, string modelName, Dictionary<string, string>? properties)',
    ]) {
      const body = methodBody(source, signature);
      expect(body, `${signature} discards the setter result — an unwritable property vanishes`)
        .toContain('unsupportedProperties');
    }
  });
});
