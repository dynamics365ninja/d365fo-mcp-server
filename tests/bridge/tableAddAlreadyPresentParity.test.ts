/**
 * The table Add* writes must look before they add.
 *
 * AddField, AddIndex, AddFieldGroup, AddFieldToFieldGroup and AddRelation added
 * without checking the name. Re-sending an element that exists failed inside the SDK
 * ("Element named: 'AutoReport' of type 'AxTableFieldGroup' already exists among
 * elements") — table create always writes the five Auto groups, so a follow-up
 * add-field-group AutoReport always collided — and stopped the operations[] batch it
 * was in. Each now answers { success, skipped, reason } like the extension paths do,
 * which the TypeScript wrappers already render as "⏭️ NOT written".
 *
 * Checked live against a real table with a bridge built from this source: re-adding
 * an existing field and the AutoReport group both came back skipped, and the table
 * file was unchanged.
 *
 * The bridge only runs on a machine with D365FO installed, so the C# side is held by
 * reading its source (see csharpSource.ts).
 */
import { describe, it, expect } from 'vitest';
import { WRITE_SERVICE_CS, readStripped, methodBody } from './csharpSource';

const source = readStripped(WRITE_SERVICE_CS);

/** True when `check` appears in `body` before `add`. */
const checkedBefore = (body: string, check: string, add: string): boolean => {
  const c = body.indexOf(check);
  const a = body.indexOf(add);
  return c !== -1 && a !== -1 && c < a;
};

describe('table Add* skip an element that already exists', () => {
  const cases: Array<{ method: string; checks: Array<[string, string]> }> = [
    {
      method: 'public object AddField(',
      checks: [
        ['HasMemberNamed(axTable.Fields, fieldName)', 'axTable.AddField(axField)'],
        ['HasMemberNamed(axExt.Fields, fieldName)', 'axExt.Fields.Add(axField)'],
      ],
    },
    {
      method: 'public object AddIndex(',
      checks: [
        ['HasMemberNamed(axTable.Indexes, indexName)', 'axTable.AddIndex(axIdx)'],
        ['HasMemberNamed(axExt.Indexes, indexName)', 'axExt.Indexes.Add(axIdx)'],
      ],
    },
    {
      method: 'public object AddFieldGroup(',
      checks: [
        ['HasMemberNamed(axTable.FieldGroups, groupName)', 'axTable.AddFieldGroup(axFg)'],
        ['HasMemberNamed(axExt.FieldGroups, groupName)', 'axExt.FieldGroups.Add(axFg)'],
      ],
    },
    {
      method: 'public object AddRelation(',
      checks: [
        ['HasMemberNamed(axTable.Relations, relationName)', 'axTable.AddRelation(axRel)'],
        ['HasMemberNamed(axExt.Relations, relationName)', 'axExt.Relations.Add(axRel)'],
      ],
    },
  ];

  for (const { method, checks } of cases) {
    it(`${method.replace('public object ', '').replace('(', '')} checks the name before adding`, () => {
      const body = methodBody(source, method);
      for (const [check, add] of checks) {
        expect(checkedBefore(body, check, add), `${check} before ${add}`).toBe(true);
      }
    });
  }

  it('AddFieldToFieldGroup skips a field already in the group, on tables and extensions', () => {
    const body = methodBody(source, 'public object AddFieldToFieldGroup(');
    const adds = [...body.matchAll(/targetFg\.AddField\(new AxTableFieldGroupField \{ DataField = fieldName \}\)/g)];
    expect(adds).toHaveLength(2);
    for (const add of adds) {
      const before = body.slice(0, add.index);
      const lastLoop = before.lastIndexOf('foreach (AxTableFieldGroupField existing in targetFg.Fields)');
      expect(lastLoop, 'existence loop before each add').toBeGreaterThan(-1);
      expect(body.slice(lastLoop, add.index)).toContain('skipped = true');
    }
  });

  it('the skip answer carries skipped and a reason', () => {
    const helper = methodBody(source, 'private static object AlreadyPresent(');
    expect(helper).toContain('skipped = true');
    expect(helper).toContain('reason =');
  });
});
