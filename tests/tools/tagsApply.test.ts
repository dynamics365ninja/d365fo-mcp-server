/**
 * Tags applied to a written file: explicit tags, the D365FO_DEFAULT_TAG instance default, opt-out,
 * "the default never overrides", add-* element targets and modify-property Tags.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyCreateTags, applyOperationTags, methodNamesOf, modifyObjectTagsProperty, resolveTagsToWrite, tagsOnlyResult, targetsOf,
} from '../../src/tools/write/tagsApply';
import { readElementTags, readObjectTags } from '../../src/tools/xml/tagsEdit';
import { D365FO_FILE_OP_SPECS, D365FO_FILE_PARAM_SPECS, renderCreatePropertySpec } from '../../src/tools/specs/d365foFileOpSpecs';

const TABLE = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
  '\t<Name>ContosoRentTable</Name>',
  '\t<SourceCode>',
  '\t\t<Declaration><![CDATA[',
  'public class ContosoRentTable extends common',
  '{',
  '}',
  ']]></Declaration>',
  '\t\t<Methods>',
  '\t\t\t<Method>',
  '\t\t\t\t<Name>find</Name>',
  '\t\t\t\t<Source><![CDATA[',
  '    public static ContosoRentTable find() { return null; }',
  ']]></Source>',
  '\t\t\t</Method>',
  '\t\t</Methods>',
  '\t</SourceCode>',
  '\t<Label>@ContosoExt:Rent</Label>',
  '\t<TableGroup>Main</TableGroup>',
  '\t<Fields>',
  '\t\t<AxTableField xmlns=""',
  '\t\t\ti:type="AxTableFieldString">',
  '\t\t\t<Name>Name</Name>',
  '\t\t\t<ExtendedDataType>Name</ExtendedDataType>',
  '\t\t</AxTableField>',
  '\t\t<AxTableField xmlns=""',
  '\t\t\ti:type="AxTableFieldString">',
  '\t\t\t<Name>Note</Name>',
  '\t\t\t<ExtendedDataType>Notes</ExtendedDataType>',
  '\t\t\t<Tags>OLD-1</Tags>',
  '\t\t</AxTableField>',
  '\t</Fields>',
  '</AxTable>',
].join('\r\n');

let dir: string;
let file: string;
const saved = process.env.D365FO_DEFAULT_TAG;
const read = () => fs.readFileSync(file, 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-apply-'));
  file = path.join(dir, 'ContosoRentTable.xml');
  fs.writeFileSync(file, TABLE);
  delete process.env.D365FO_DEFAULT_TAG;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.D365FO_DEFAULT_TAG;
  else process.env.D365FO_DEFAULT_TAG = saved;
});

describe('create', () => {
  it('writes nothing, and says nothing, without tags or a default (backward compatible)', async () => {
    expect(await applyCreateTags(file, {})).toBe('');
    expect(read()).toBe(TABLE);
  });

  it('writes an explicit tag and reports it', async () => {
    const note = await applyCreateTags(file, { tags: ['ABC-1', 'ABC-2'] });
    expect(readObjectTags(read())).toBe('ABC-1, ABC-2');
    expect(note).toContain('ABC-1, ABC-2');
  });

  it('applies the instance default and names it', async () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    const note = await applyCreateTags(file, {});
    expect(readObjectTags(read())).toBe('ABC-9');
    expect(note).toContain('D365FO_DEFAULT_TAG');
  });

  it('opts out with tags=""', async () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    await applyCreateTags(file, { tags: '' });
    expect(readObjectTags(read())).toBeUndefined();
  });

  it('never lets the default replace a tag the create already wrote', async () => {
    fs.writeFileSync(file, TABLE.replace('\t<TableGroup>Main</TableGroup>', '\t<TableGroup>Main</TableGroup>\r\n\t<Tags>OWN-1</Tags>'));
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    await applyCreateTags(file, {});
    expect(readObjectTags(read())).toBe('OWN-1');
  });

  it('skips silently, for the default, an object type with no known position', async () => {
    fs.writeFileSync(file, '<AxReport>\r\n\t<Name>ContosoR</Name>\r\n</AxReport>');
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    expect(await applyCreateTags(file, {})).toBe('');
    expect(read()).not.toContain('<Tags>');
    expect(await applyCreateTags(file, { tags: 'ABC-1' })).toContain('not written');
  });
});

describe('add-* and modify operations', () => {
  it('tags an added field with the explicit tag', async () => {
    const note = await applyOperationTags(file, 'add-field', { fieldName: 'Name', tags: 'ABC-1' });
    expect(readElementTags(read(), 'field', 'Name')).toBe('ABC-1');
    expect(note).toContain('field Name');
  });

  it('uses the default for an add, but not over an existing tag', async () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    await applyOperationTags(file, 'add-field', { fieldName: 'Name' });
    await applyOperationTags(file, 'add-field', { fieldName: 'Note' });
    expect(readElementTags(read(), 'field', 'Name')).toBe('ABC-9');
    expect(readElementTags(read(), 'field', 'Note')).toBe('OLD-1');
  });

  it('does not retag on a modify unless tags are passed', async () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    expect(await applyOperationTags(file, 'modify-field', { fieldName: 'Name', fieldLabel: 'x' })).toBe('');
    expect(read()).toBe(TABLE);
    await applyOperationTags(file, 'modify-field', { fieldName: 'Note', tags: 'ABC-2', tagsMode: 'add' });
    expect(readElementTags(read(), 'field', 'Note')).toBe('OLD-1, ABC-2');
  });

  it('opts out per call', async () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    await applyOperationTags(file, 'add-field', { fieldName: 'Name', tags: '' });
    expect(readElementTags(read(), 'field', 'Name')).toBeUndefined();
  });

  it('tags every method of a multi-method add-method', async () => {
    const src = '/// <summary>x { }</summary>\npublic static void a() { if (true) { } }\n[Hookable(false)]\npublic void b(str _s = "{")\n{\n}';
    expect(methodNamesOf(src)).toEqual(['a', 'b']);
    expect(targetsOf('add-method', { sourceCode: src })?.names).toEqual(['a', 'b']);
    expect(targetsOf('add-method', { methodName: 'find' })?.names).toEqual(['find']);
    await applyOperationTags(file, 'add-method', { methodName: 'find', tags: 'ABC-1' });
    expect(readElementTags(read(), 'method', 'find')).toBe('ABC-1');
  });

  it('reports instead of throwing when the element is not in the file', async () => {
    const note = await applyOperationTags(file, 'add-field', { fieldName: 'Nope', tags: 'ABC-1' });
    expect(note).toContain('not written');
    expect(read()).toBe(TABLE);
  });

  it('ignores an operation that adds nothing taggable', async () => {
    process.env.D365FO_DEFAULT_TAG = 'ABC-9';
    expect(await applyOperationTags(file, 'add-control', { controlName: 'X' })).toBe('');
  });
});

describe('default tag resolution', () => {
  it('writes nothing without tags or a default', () => {
    expect(resolveTagsToWrite(undefined)).toEqual({ source: 'none' });
  });
  it('uses the instance default, lets an explicit tag win, and tags="" opts out', () => {
    process.env.D365FO_DEFAULT_TAG = ' ABC-9 ';
    expect(resolveTagsToWrite(undefined)).toEqual({ tags: 'ABC-9', source: 'default' });
    expect(resolveTagsToWrite('ABC-1')).toEqual({ tags: 'ABC-1', source: 'explicit' });
    expect(resolveTagsToWrite('')).toEqual({ source: 'opt-out' });
  });
});

describe('review fixes', () => {
  const RELATION = TABLE.replace('\t</Fields>', [
    '\t</Fields>', '\t<Relations>', '\t\t<AxTableRelation>', '\t\t\t<Name>R</Name>', '\t\t\t<Tags>OLD-1</Tags>',
    '\t\t\t<Constraints>', '\t\t\t\t<AxTableRelationConstraint xmlns=""', '\t\t\t\t\ti:type="AxTableRelationConstraintField">',
    '\t\t\t\t\t<Name>C</Name>', '\t\t\t\t\t<Tags>OLD-1</Tags>', '\t\t\t\t\t<Field>Name</Field>',
    '\t\t\t\t</AxTableRelationConstraint>', '\t\t\t</Constraints>', '\t\t</AxTableRelation>', '\t</Relations>',
  ].join('\r\n'));

  it('the default never replaces an existing constraint tag', async () => {
    fs.writeFileSync(file, RELATION);
    process.env.D365FO_DEFAULT_TAG = 'NEW-2';
    await applyOperationTags(file, 'add-relation', { relationName: 'R' });
    expect(readElementTags(read(), 'relation', 'R')).toBe('OLD-1');
    expect(readElementTags(read(), 'constraint', 'C', 'R')).toBe('OLD-1');
  });

  it('an explicit "" on a modify removes the tag; on an add it only opts out', async () => {
    await applyOperationTags(file, 'modify-field', { fieldName: 'Note', tags: '' });
    expect(readElementTags(read(), 'field', 'Note')).toBeUndefined();
    fs.writeFileSync(file, TABLE);
    await applyOperationTags(file, 'add-field', { fieldName: 'Note', tags: '' });
    expect(readElementTags(read(), 'field', 'Note')).toBe('OLD-1');
  });

  it('a tags-only modify of a missing element fails instead of reporting success', async () => {
    expect((await tagsOnlyResult(file, 'modify-field', { fieldName: 'Nope', tags: 'ABC-1' }))?.success).toBe(false);
    expect((await tagsOnlyResult(file, 'modify-field', { fieldName: 'Name', tags: 'ABC-1' }))?.success).toBe(true);
    expect(await tagsOnlyResult(file, 'modify-field', { fieldName: 'Name', tags: 'ABC-1', fieldLabel: 'x' })).toBeUndefined();
    expect(await tagsOnlyResult(file, 'modify-field', { fieldName: 'Name' })).toBeUndefined();
    expect(await tagsOnlyResult(file, 'add-field', { fieldName: 'Name', tags: 'ABC-1' })).toBeUndefined();
  });

  it('does not tag a form data source / control override as the root method of the same name', () => {
    expect(targetsOf('add-method', { methodName: 'DS.init', sourceCode: 'public void init() { }' })).toBeNull();
  });

  it('names a generated table method after tableMethodType', () => {
    expect(targetsOf('add-table-method', { tableMethodType: 'find' })?.names).toEqual(['find']);
  });
});

describe('modify-property Tags', () => {
  it('is not about Tags for other properties', async () => {
    expect(await modifyObjectTagsProperty(file, { propertyPath: 'Label', propertyValue: 'x' })).toBeNull();
    expect(await modifyObjectTagsProperty(file, { propertyPath: 'Tags', propertyValue: 'x', controlName: 'C' })).toBeNull();
  });

  it('inserts, adds, removes by mode and clears with an empty value', async () => {
    const set = (v: string, tagsMode?: string) => modifyObjectTagsProperty(file, { propertyPath: 'Tags', propertyValue: v, tagsMode });
    expect((await set('ABC-1'))?.success).toBe(true);
    expect(read()).toContain('\t<TableGroup>Main</TableGroup>\r\n\t<Tags>ABC-1</Tags>\r\n\t<Fields>');
    await set('ABC-2', 'add');
    expect(readObjectTags(read())).toBe('ABC-1, ABC-2');
    await set('ABC-1', 'remove');
    expect(readObjectTags(read())).toBe('ABC-2');
    await set('');
    expect(read()).toBe(TABLE);
  });

  it('fails clearly on an unsupported object type', async () => {
    fs.writeFileSync(file, '<AxReport>\r\n\t<Name>ContosoR</Name>\r\n</AxReport>');
    const r = await modifyObjectTagsProperty(file, { propertyPath: 'tags', propertyValue: 'ABC-1' });
    expect(r?.success).toBe(false);
  });
});

describe('discoverability', () => {
  it('documents tags on every operation that reads them, and on create', () => {
    expect(D365FO_FILE_PARAM_SPECS.tags.description).toContain('D365FO_DEFAULT_TAG');
    expect(D365FO_FILE_PARAM_SPECS.tagsMode).toBeDefined();
    for (const op of ['add-field', 'modify-field', 'add-relation', 'add-index', 'add-field-group', 'add-enum-value', 'modify-enum-value', 'add-method', 'add-table-method', 'add-display-method']) {
      expect(D365FO_FILE_OP_SPECS[op].optional).toContain('tags');
    }
    expect(D365FO_FILE_OP_SPECS['modify-field'].mutationOneOf).toContain('tags');
    expect(D365FO_FILE_OP_SPECS['modify-property'].optional).toContain('tagsMode');
    expect(renderCreatePropertySpec('table')).toContain('properties.tags');
    expect(renderCreatePropertySpec('class')).toContain('properties.tags');
  });
});

describe('write verification', () => {
  it('does not claim a Tags modify failed when tagsMode combined or normalised the value', async () => {
    const { claimedMarkerFor } = await import('../../src/tools/write/preserveMetadataElements');
    const { modifyIntentFor } = await import('../../src/tools/write/inlineWriteVerification');
    const args = { propertyPath: 'Tags', propertyValue: 'ABC-1', tagsMode: 'add' };
    expect(claimedMarkerFor('modify-property', args)).toBeNull();
    expect(modifyIntentFor('modify-property', 'table', args)).toBeNull();
  });
});
