/**
 * add-control DataGroup pre-flight.
 *
 * A container carrying <DataGroup> is populated by the compiler from that table
 * field group, one control per member named <DataGroup>_<Field>. Adding the
 * field to the field group AND an explicit control for it fails the build with
 * "The duplicate name '…' was detected" — and the duplicate never appears in the
 * XML on disk, so it cannot be found by inspection.
 */

import { describe, it, expect } from 'vitest';
import { checkAddControlAgainstDataGroup } from '../../src/tools/analysis/validateFormPattern';

/** The AslFinCore_TaxTransReportChangeLog shape: Grid > Group[DataGroup=Administration]. */
const BASE_FORM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>DemoChangeLog</Name>
  <Design>
    <Controls>
      <AxFormControl xmlns="" i:type="AxFormGridControl">
        <Name>Grid</Name>
        <Type>Grid</Type>
        <Controls>
          <AxFormControl xmlns="" i:type="AxFormGroupControl">
            <Name>Identification</Name>
            <Type>Group</Type>
            <Controls />
            <DataGroup>Identification</DataGroup>
            <DataSource>DemoChangeLog</DataSource>
          </AxFormControl>
          <AxFormControl xmlns="" i:type="AxFormGroupControl">
            <Name>Administration</Name>
            <Type>Group</Type>
            <Controls />
            <DataGroup>Administration</DataGroup>
            <DataSource>DemoChangeLog</DataSource>
          </AxFormControl>
          <AxFormControl xmlns="" i:type="AxFormGroupControl">
            <Name>Freeform</Name>
            <Type>Group</Type>
            <Controls />
          </AxFormControl>
        </Controls>
        <DataSource>DemoChangeLog</DataSource>
      </AxFormControl>
    </Controls>
  </Design>
</AxForm>`;

describe('checkAddControlAgainstDataGroup', () => {
  it('flags a bound control under a DataGroup parent and names the generated control', async () => {
    const verdict = await checkAddControlAgainstDataGroup(
      BASE_FORM_XML,
      'Administration',
      'DEMO_QualityTier',
      'Administration_DEMO_QualityTier',
    );

    expect(verdict).not.toBeNull();
    expect(verdict!.dataGroup).toBe('Administration');
    expect(verdict!.dataSource).toBe('DemoChangeLog');
    expect(verdict!.generatedName).toBe('Administration_DEMO_QualityTier');
    // Matching the generated name is a guaranteed collision, not a maybe.
    expect(verdict!.exactNameCollision).toBe(true);
  });

  it('still flags when the caller picks a different control name', async () => {
    // A different name dodges the compiler error but renders the field twice,
    // so this is a finding either way — only the certainty changes.
    const verdict = await checkAddControlAgainstDataGroup(
      BASE_FORM_XML,
      'Administration',
      'DEMO_QualityTier',
      'MyQualityTierCombo',
    );

    expect(verdict).not.toBeNull();
    expect(verdict!.generatedName).toBe('Administration_DEMO_QualityTier');
    expect(verdict!.exactNameCollision).toBe(false);
  });

  it('matches the parent case-insensitively', async () => {
    const verdict = await checkAddControlAgainstDataGroup(
      BASE_FORM_XML,
      'administration',
      'DEMO_QualityTier',
      'Administration_DEMO_QualityTier',
    );
    expect(verdict?.dataGroup).toBe('Administration');
  });

  it('passes an unbound control — a button in such a group is legitimate', async () => {
    const verdict = await checkAddControlAgainstDataGroup(
      BASE_FORM_XML,
      'Administration',
      undefined,
      'MyButton',
    );
    expect(verdict).toBeNull();
  });

  it('passes a parent that declares no DataGroup', async () => {
    const verdict = await checkAddControlAgainstDataGroup(
      BASE_FORM_XML,
      'Freeform',
      'DEMO_QualityTier',
      'Freeform_DEMO_QualityTier',
    );
    expect(verdict).toBeNull();
  });

  it('passes when the parent is not in the base form', async () => {
    const verdict = await checkAddControlAgainstDataGroup(
      BASE_FORM_XML,
      'NoSuchGroup',
      'DEMO_QualityTier',
      'X',
    );
    expect(verdict).toBeNull();
  });

  it('returns null rather than throwing on unparseable XML', async () => {
    const verdict = await checkAddControlAgainstDataGroup(
      '<AxForm><Design>',
      'Administration',
      'DEMO_QualityTier',
      'X',
    );
    expect(verdict).toBeNull();
  });
});
