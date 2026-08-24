/**
 * Kernel enums have no AOT element, so "absent from the index" is not evidence
 * against them. Both failures guarded here were confirmed live on 2026-08-24.
 */

import { describe, it, expect } from 'vitest';
import {
  isKernelEnum, getKernelEnum, describeKernelEnum, KERNEL_ENUM_NAMES,
} from '../../src/knowledge/kernelEnums';

describe('kernel enum membership', () => {
  it('covers the enums that have no AxEnum anywhere in PackagesLocalDirectory', () => {
    // Each name was checked against the complete set of 8,220 AxEnum/*.xml
    // basenames on this install (metamodel 7.0.7996.33) and is absent from all.
    for (const name of [
      'NoYes', 'Exception', 'Types', 'TableScope', 'ConcurrencyModel',
      'StatementType', 'IsolationLevel', 'UtcDateTimeOrder', 'DateOrder',
      'DateDay', 'DateMonth', 'DateYear',
    ]) {
      expect(isKernelEnum(name), name + ' should be a kernel enum').toBe(true);
    }
  });

  it('is case-insensitive, because X++ is', () => {
    expect(isKernelEnum('noyes')).toBe(true);
    expect(isKernelEnum('NOYES')).toBe(true);
    expect(isKernelEnum('  NoYes  ')).toBe(true);
  });

  it('does not swallow the real AOT enums whose names merely contain a kernel one', () => {
    // These exist in the AOT and must keep being verified against the index —
    // they are exactly what search offers when NoYes cannot be found.
    for (const name of ['NoYesBlank', 'NoYesCombo', 'DefaultNoYes', 'HcmBlankNoYes']) {
      expect(isKernelEnum(name), name + ' is a real AOT enum').toBe(false);
    }
    expect(isKernelEnum('')).toBe(false);
    expect(isKernelEnum(undefined)).toBe(false);
  });

  it('exposes lowercase names, the shape the X++ allow-list already used', () => {
    expect(KERNEL_ENUM_NAMES.has('noyes')).toBe(true);
    expect(KERNEL_ENUM_NAMES.has('NoYes')).toBe(false);
  });
});

describe('describeKernelEnum', () => {
  it('answers authoritatively instead of sending the caller to index a file', () => {
    const out = describeKernelEnum('NoYes')!;
    expect(out).toContain('kernel enum');
    // The two things that stop the loop: nothing to index, and the reference is valid.
    expect(out).toContain('nothing to index');
    expect(out).toContain('<EnumType>NoYes</EnumType>');
    expect(out).toContain('NoYes::Value');
    // And the specific wrong turn it must not take.
    expect(out).toContain('NoYesBlank');
    expect(out).not.toContain('update_symbol_index');
  });

  it('renders observed values without claiming they are exhaustive', () => {
    const out = describeKernelEnum('NoYes')!;
    expect(out).toContain('`NoYes::No`');
    expect(out).toContain('`NoYes::Yes`');
    expect(out).toContain('observed rather than exhaustive');
  });

  it('omits the values section where no usage was observed, rather than guessing', () => {
    const out = describeKernelEnum('DateOrder')!;
    expect(out).toContain('kernel enum');
    expect(out).not.toContain('## Values');
    expect(getKernelEnum('DateOrder')!.values).toBeUndefined();
  });

  it('returns null for anything that is not a kernel enum', () => {
    expect(describeKernelEnum('NoYesBlank')).toBeNull();
    expect(describeKernelEnum('CustTable')).toBeNull();
  });
});
