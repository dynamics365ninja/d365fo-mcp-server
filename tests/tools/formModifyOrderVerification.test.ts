/**
 * Post-write element-order verification on the modify path (issue #989).
 *
 * `create` can only pass through a defect the caller supplied, and it is gated
 * BEFORE the write. `modify` is different in kind: the direct XML writers insert
 * elements into an existing document, and an insertion at the wrong offset IS
 * the #979 defect — the same class as the nesting-scope trap behind #927/#928.
 * That failure is one this server introduces, and it can only be seen after the
 * operation has applied, so it is a loud report rather than a gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', async () => {
  const readFile = vi.fn();
  return { readFile, default: { readFile } };
});

import { readFile } from 'fs/promises';
import { verifyFormElementOrder } from '../../src/tools/write/inlineWriteVerification';

const BROKEN =
  `<AxForm><Design><Controls>\n<AxFormControl i:type="AxFormGroupControl">\n` +
  `<Name>Overview</Name>\n<Type>Group</Type>\n<DataGroup>Overview</DataGroup>\n` +
  `<DataSource>T</DataSource>\n<Controls>\n` +
  `<AxFormControl i:type="AxFormStringControl"><Name>Overview_Foo</Name><Type>String</Type></AxFormControl>\n` +
  `</Controls>\n</AxFormControl>\n</Controls></Design></AxForm>`;

const CLEAN =
  `<AxForm><Design><Controls>\n<AxFormControl i:type="AxFormGroupControl">\n` +
  `<Name>Overview</Name>\n<Type>Group</Type>\n<Controls>\n` +
  `<AxFormControl i:type="AxFormStringControl"><Name>Overview_Foo</Name><Type>String</Type></AxFormControl>\n` +
  `</Controls>\n<DataGroup>Overview</DataGroup>\n<DataSource>T</DataSource>\n` +
  `</AxFormControl>\n</Controls></Design></AxForm>`;

beforeEach(() => vi.clearAllMocks());

describe('verifyFormElementOrder', () => {
  it('reports a file the write just made unreadable to the compiler', async () => {
    vi.mocked(readFile).mockResolvedValue(BROKEN as never);
    const note = await verifyFormElementOrder('K:/pkg/AxForm/F.xml', 'form');
    expect(note).toMatch(/will DROP silently/);
    expect(note).toMatch(/<Controls> must come AFTER <DataSource>/);
    // It must name the remedy and own the fault — the caller did not do this.
    expect(note).toMatch(/undo_last_modification/);
    expect(note).toMatch(/defect in the write, not in your request/);
  });

  it('says nothing when the written document is sound', async () => {
    vi.mocked(readFile).mockResolvedValue(CLEAN as never);
    expect(await verifyFormElementOrder('K:/pkg/AxForm/F.xml', 'form')).toBe('');
  });

  it('covers form extensions, which spell the control element differently', async () => {
    vi.mocked(readFile).mockResolvedValue(
      (`<AxFormExtension><Controls><AxFormExtensionControl>\n<Name>W</Name>\n` +
       `<FormControl i:type="AxFormGroupControl">\n<Name>G</Name>\n<Type>Group</Type>\n` +
       `<DataSource>T</DataSource>\n<Controls />\n</FormControl>\n<Parent>P</Parent>\n` +
       `</AxFormExtensionControl></Controls></AxFormExtension>`) as never,
    );
    expect(await verifyFormElementOrder('K:/pkg/AxFormExtension/F.Ext.xml', 'form-extension'))
      .toMatch(/will DROP silently/);
  });

  it('does not read the file for object types this cannot apply to', async () => {
    expect(await verifyFormElementOrder('K:/pkg/AxTable/T.xml', 'table')).toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('is advisory — a read failure must not turn a good write into a failure', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('EBUSY'));
    expect(await verifyFormElementOrder('K:/pkg/AxForm/F.xml', 'form')).toBe('');
  });
});
