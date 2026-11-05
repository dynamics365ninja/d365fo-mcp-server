/**
 * Model masks: names, globs, exclusions, module or display name, and what each side of a comparison selects.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  globToRegExp,
  isExactSpec,
  listModelNames,
  parseModelSpec,
  selectModels,
  selectOnBothSides,
  type ModelName,
} from '../../src/metadata/modelSelector';

const models: ModelName[] = [
  { name: 'ContosoCore', aliases: ['Contoso Core'] },
  { name: 'ContosoExt' },
  { name: 'ContosoDemoExt' },
  { name: 'FabrikamTools', aliases: ['Fabrikam Tools'] },
  { name: 'ApplicationSuite' },
];

describe('globToRegExp', () => {
  it('matches * and ? and nothing else, ignoring case', () => {
    expect(globToRegExp('Contoso*').test('contosoext')).toBe(true);
    expect(globToRegExp('Contoso?xt').test('ContosoExt')).toBe(true);
    expect(globToRegExp('Contoso?xt').test('ContosoDemoExt')).toBe(false);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
    expect(globToRegExp('*Ext').test('ContosoDemoExt')).toBe(true);
    expect(globToRegExp('Ext').test('ContosoExt')).toBe(false);
  });
});

describe('selectModels', () => {
  it('takes comma-separated names and masks', () => {
    expect(selectModels('ContosoCore,Fabrikam*', models)).toEqual(['ContosoCore', 'FabrikamTools']);
    expect(selectModels(['ContosoCore', 'Fabrikam*'], models)).toEqual(['ContosoCore', 'FabrikamTools']);
    expect(selectModels(' ContosoExt , ContosoDemoExt ', models)).toEqual(['ContosoExt', 'ContosoDemoExt']);
  });

  it('excludes with a leading !, and an exclusion-only spec starts from every model', () => {
    expect(selectModels('Contoso*,!*Demo*', models)).toEqual(['ContosoCore', 'ContosoExt']);
    expect(selectModels('!Contoso*', models)).toEqual(['FabrikamTools', 'ApplicationSuite']);
    expect(selectModels('*,!ApplicationSuite', models)).toHaveLength(4);
  });

  it('matches the display name as well as the module name', () => {
    expect(selectModels('Contoso Core', models)).toEqual(['ContosoCore']);
    expect(selectModels('Fabrikam T*', models)).toEqual(['FabrikamTools']);
    expect(selectModels('!Contoso Core,Contoso*', models)).toEqual(['ContosoExt', 'ContosoDemoExt']);
  });

  it('selects everything for an empty spec and nothing for a mask that matches nothing', () => {
    expect(selectModels(undefined, models)).toHaveLength(5);
    expect(selectModels('Nothing*', models)).toEqual([]);
  });

  it('knows an exact list from a mask', () => {
    expect(isExactSpec('ContosoCore,ContosoExt')).toBe(true);
    expect(isExactSpec('Contoso*')).toBe(false);
    expect(isExactSpec('!ContosoExt')).toBe(false);
    expect(parseModelSpec('A*,!B').patterns).toEqual(['A*', '!B']);
  });
});

describe('selectOnBothSides', () => {
  it('lists what the mask selected on each side and what only one side has', () => {
    const from: ModelName[] = [{ name: 'ContosoCore' }, { name: 'ContosoOld' }, { name: 'ContosoExt' }];
    const to: ModelName[] = [{ name: 'ContosoCore' }, { name: 'ContosoNew' }, { name: 'ContosoExt' }];
    const s = selectOnBothSides('Contoso*', from, to);
    expect(s.from).toEqual(['ContosoCore', 'ContosoOld', 'ContosoExt']);
    expect(s.to).toEqual(['ContosoCore', 'ContosoNew', 'ContosoExt']);
    expect(s.both).toEqual(['ContosoCore', 'ContosoExt']);
    expect(s.onlyInFrom).toEqual(['ContosoOld']);
    expect(s.onlyInTo).toEqual(['ContosoNew']);
  });

  it('leaves out the models named in `skip` (our own models are not dependencies)', () => {
    const side: ModelName[] = [{ name: 'ContosoCore' }, { name: 'ContosoExt' }];
    expect(selectOnBothSides('*', side, side, ['contosoext']).both).toEqual(['ContosoCore']);
  });
});

describe('listModelNames', () => {
  let tmp = '';
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reads the display name a binary-ISV record carries', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-selector-'));
    fs.mkdirSync(path.join(tmp, 'ContosoCore', 'classes'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'ContosoCore', 'classes', 'A.json'),
      JSON.stringify({ name: 'A', binaryIsv: { displayName: 'Contoso Core' } }),
    );
    fs.mkdirSync(path.join(tmp, 'ContosoExt', 'classes'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ContosoExt', 'classes', 'B.json'), JSON.stringify({ name: 'B' }));
    const names = listModelNames(tmp);
    expect(names.find(n => n.name === 'ContosoCore')?.aliases).toEqual(['Contoso Core']);
    expect(names.find(n => n.name === 'ContosoExt')?.aliases).toEqual([]);
    expect(selectModels('Contoso Core', names)).toEqual(['ContosoCore']);
  });
});
