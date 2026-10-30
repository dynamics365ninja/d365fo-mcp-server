/**
 * Kernel EDTs (#1179) — the runtime defines them, no AxEdt file does.
 *
 * IMetaEdtProvider.Exists, readEdt, the symbol index and a disk probe all answer
 * "not found" for RecId, UserId, ValidFromDateTime, TimeOfDay … although shipped
 * tables use them thousands of times. Every path that treated that as "does not
 * exist" refused a valid write: the bridge's add-field guard, the table scaffold,
 * validate_code(references); and the base-type heuristic typed TimeOfDay, FieldId and
 * TableId fields as String.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  KERNEL_EDT_NAMES, describeKernelEdt, isKernelEdt, kernelEdtBaseType, kernelEdts,
} from '../../src/knowledge/kernelEdts';
import { handleGenerateSmartTable, heuristicEdtBaseType, resolveEdtBaseType } from '../../src/tools/smart/generateSmartTable';
import { validateCodeTool } from '../../src/tools/analysis/validateCode';
import { getEdtInfoTool } from '../../src/tools/readers/edtInfo';
import { WRITE_SERVICE_CS, readStripped, methodBody } from '../bridge/csharpSource';
import { readFileSync } from 'fs';

describe('kernel EDT membership', () => {
  it('holds the names shipped tables use most, case-insensitively', () => {
    for (const name of ['DataAreaId', 'RecId', 'UserId', 'ValidFromDateTime', 'ValidToDate', 'TimeOfDay', 'TableId']) {
      expect(isKernelEdt(name), name).toBe(true);
      expect(isKernelEdt(name.toUpperCase()), name).toBe(true);
    }
  });

  it('does not hold AOT EDTs that only look like system types', () => {
    // RefRecId extends RecId and SysGuid is an AOT EDT; both resolve through the bridge.
    for (const name of ['RefRecId', 'SysGuid', 'CustAccount', 'NoYesId', 'UserIdd']) {
      expect(isKernelEdt(name), name).toBe(false);
    }
  });

  it('has one entry per name, folded case-insensitively', () => {
    expect(KERNEL_EDT_NAMES.size).toBe(kernelEdts().length);
  });

  it('gives the base type every shipped field on it has', () => {
    expect(kernelEdtBaseType('RecId')).toBe('Int64');
    expect(kernelEdtBaseType('ValidFromDateTime')).toBe('UtcDateTime');
    expect(kernelEdtBaseType('ValidFromDate')).toBe('Date');
    expect(kernelEdtBaseType('TimeOfDay')).toBe('Time');
    expect(kernelEdtBaseType('FieldId')).toBe('Integer');
    expect(kernelEdtBaseType('UserId')).toBe('String');
    expect(kernelEdtBaseType('CustAccount')).toBeUndefined();
  });
});

describe('the bridge keeps the same list (MetadataWriteService.KernelEdtNames)', () => {
  const raw = readFileSync(WRITE_SERVICE_CS, 'utf-8');
  const block = /KernelEdtNames\s*=\s*new HashSet<string>\(StringComparer\.OrdinalIgnoreCase\)\s*\{([\s\S]*?)\};/.exec(raw);

  it('declares the set case-insensitively', () => {
    expect(block, 'KernelEdtNames HashSet with OrdinalIgnoreCase').not.toBeNull();
  });

  it('names exactly the TypeScript kernel EDTs', () => {
    const cs = new Set([...block![1].matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase()));
    expect([...cs].sort()).toEqual([...KERNEL_EDT_NAMES].sort());
  });

  it('lets a kernel EDT through the field guard before asking Exists()', () => {
    const body = methodBody(readStripped(WRITE_SERVICE_CS), 'private void RequireExtendedDataTypeExists(');
    const kernel = body.indexOf('KernelEdtNames.Contains(edtName)');
    const exists = body.indexOf('_provider.Edts.Exists(edtName)');
    expect(kernel).toBeGreaterThan(-1);
    expect(kernel).toBeLessThan(exists);
  });

  it('can write a Time field and a Time EDT (TimeOfDay is one)', () => {
    const source = readStripped(WRITE_SERVICE_CS);
    expect(methodBody(source, 'private AxTableField CreateTableField(')).toMatch(/case "time":[\s\S]*?new AxTableFieldTime\(\)/);
    expect(source).toMatch(/case "time":[^\n]*new AxEdtTime \{ Name = name \}/);
  });
});

describe('base type of a field on a kernel EDT', () => {
  it('comes from the list, not the name heuristics', () => {
    // The heuristics returned undefined (→ String) for all of these.
    expect(heuristicEdtBaseType('TimeOfDay')).toBe('Time');
    expect(heuristicEdtBaseType('FieldId')).toBe('Integer');
    expect(heuristicEdtBaseType('TableId')).toBe('Integer');
    expect(heuristicEdtBaseType('RelationType')).toBe('Int64');
  });

  it('ends an index chain that reaches a kernel EDT', () => {
    const db = {
      prepare: () => ({
        get: (name: string) => (name === 'ConShiftStart' ? { extends: 'TimeOfDay', enum_type: null, string_size: null } : undefined),
      }),
    };
    expect(resolveEdtBaseType('ConShiftStart', db)).toBe('Time');
  });
});

describe('validate_code(references) on a kernel EDT', () => {
  // An index that proves nothing, which is all a real one offers for a kernel EDT.
  const blind = {
    symbolIndex: {
      getReadDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }),
      getLabelById: () => [],
    },
  } as any;
  const check = (xml: string) =>
    validateCodeTool({ params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any, blind);

  it('accepts <ExtendedDataType>UserId and ValidFromDateTime', async () => {
    const result = await check(`<?xml version="1.0"?><AxTable><Name>ConShift</Name><Fields>
      <AxTableField i:type="AxTableFieldString"><Name>Worker</Name><ExtendedDataType>UserId</ExtendedDataType></AxTableField>
      <AxTableField i:type="AxTableFieldUtcDateTime"><Name>ValidFrom</Name><ExtendedDataType>ValidFromDateTime</ExtendedDataType></AxTableField>
    </Fields></AxTable>`);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain('UserId" not found');
    expect(result.content[0].text).not.toContain('ValidFromDateTime" not found');
  });

  it('still flags a misspelt one', async () => {
    const result = await check(`<?xml version="1.0"?><AxTable><Name>ConShift</Name><Fields>
      <AxTableField i:type="AxTableFieldString"><Name>Worker</Name><ExtendedDataType>UserIdd</ExtendedDataType></AxTableField>
    </Fields></AxTable>`);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('UserIdd');
  });
});

describe('get_object_info(edt) on a kernel EDT', () => {
  it('says what it is instead of "no data … index the file"', async () => {
    const result: any = await getEdtInfoTool(
      { params: { name: 'get_edt_info', arguments: { edtName: 'recid' } } } as any,
      { symbolIndex: { getReadDb: () => ({}) }, bridge: undefined } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('RecId (kernel EDT)');
    expect(result.content[0].text).toContain('Base type:** Int64');
    expect(result.content[0].text).not.toContain('update_symbol_index');
  });

  it('describes nothing for an AOT EDT', () => {
    expect(describeKernelEdt('CustAccount')).toBeNull();
  });
});

describe('generate_object(scaffold, table) with a field on a kernel EDT', () => {
  it('does not report it as missing (which also blocked the bridge write)', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('EXTENSION_PREFIX', '');
    try {
      const stmt = { all: () => [], get: () => undefined };
      const result = await handleGenerateSmartTable(
        { name: 'ConShift', modelName: 'MyModel', fields: [{ name: 'Worker', edt: 'UserId' }, { name: 'StartTime', edt: 'TimeOfDay' }] },
        { getReadDb: () => ({ prepare: () => stmt }), db: { prepare: () => stmt }, getCustomModels: () => ['MyModel'] } as any,
      );
      const text = result?.content[0].text as string;
      expect(text).not.toContain('"UserId" not found');
      expect(text).toContain('i:type="AxTableFieldTime"');
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
      vi.unstubAllEnvs();
    }
  });
});
