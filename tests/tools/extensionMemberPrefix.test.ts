/**
 * Prefixing of members added INSIDE an extension.
 *
 * An extension lives in your model but its host object is Microsoft's, so an
 * unprefixed field/index/enum value collides with whatever Microsoft or another
 * ISV adds to the same host later — Microsoft's naming guideline requires the
 * prefix and BP rejects the bare form. The tool used to pass fieldName straight
 * through to the bridge, so `add-field` on a table extension wrote an unprefixed
 * field while `create` on the same model prefixed the object name.
 *
 * Ground truth: K:\…\HBReavis\HBReavis\AxTableExtension\AssetBookTable.HBRExtension.xml
 * contains <Name>HBR_MandatoryReasonCode</Name> — prefixed with the REGULAR
 * token (HBR_), not the extension infix (HBR).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyExtensionMemberPrefix } from '../../src/tools/modifyD365File.js';
import {
  setModelObjectNameSource,
  clearInferredModelPrefixes,
} from '../../src/utils/modelPrefixInference.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  clearInferredModelPrefixes();
  setModelObjectNameSource(null);
  delete process.env.EXTENSION_PREFIX;
  delete process.env.EXTENSION_PREFIX_SOURCE;
  process.env.EXTENSION_PREFIX = 'HBR_';
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('applyExtensionMemberPrefix', () => {
  it('prefixes a field added to a table extension', () => {
    const args: Record<string, any> = { fieldName: 'MandatoryReasonCode' };

    const note = applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'HBReavis');

    expect(args.fieldName).toBe('HBR_MandatoryReasonCode');
    expect(note).toContain('HBR_MandatoryReasonCode');
  });

  it('prefixes indexes, field groups and enum values too', () => {
    const index: Record<string, any> = { indexName: 'ByReasonCode' };
    const group: Record<string, any> = { fieldGroupName: 'Approval' };
    const value: Record<string, any> = { enumValueName: 'PendingReview' };

    applyExtensionMemberPrefix(index, 'table-extension', 'add-index', 'HBReavis');
    applyExtensionMemberPrefix(group, 'table-extension', 'add-field-group', 'HBReavis');
    applyExtensionMemberPrefix(value, 'enum-extension', 'add-enum-value', 'HBReavis');

    expect(index.indexName).toBe('HBR_ByReasonCode');
    expect(group.fieldGroupName).toBe('HBR_Approval');
    expect(value.enumValueName).toBe('HBR_PendingReview');
  });

  it('leaves a name that already carries the prefix untouched', () => {
    const args: Record<string, any> = { fieldName: 'HBR_MandatoryReasonCode' };

    expect(applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'HBReavis')).toBe('');
    expect(args.fieldName).toBe('HBR_MandatoryReasonCode');
  });

  it('recognises the bare form of an underscore prefix as already applied', () => {
    // An agent that hand-builds "HBRSomething" must not end up with HBR_HBRSomething.
    const args: Record<string, any> = { fieldName: 'HBRMandatoryReasonCode' };

    applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'HBReavis');

    expect(args.fieldName).toBe('HBRMandatoryReasonCode');
  });

  it('does not touch fields on a plain table', () => {
    // A table you own is entirely yours — its fields need no prefix, and adding
    // one would contradict every field the create path already wrote.
    const args: Record<string, any> = { fieldName: 'ApprovingWorker' };

    applyExtensionMemberPrefix(args, 'table', 'add-field', 'HBReavis');

    expect(args.fieldName).toBe('ApprovingWorker');
  });

  it('never renames a method on a class extension', () => {
    // A CoC method name must match the base method it wraps; prefixing it turns
    // an override into dead code that never runs.
    const args: Record<string, any> = { methodName: 'insert' };

    applyExtensionMemberPrefix(args, 'class-extension', 'add-method', 'HBReavis');

    expect(args.methodName).toBe('insert');
  });

  it('never renames the field group targeted by add-field-to-field-group', () => {
    // That group already exists and is usually Microsoft's (e.g. "Setup").
    const args: Record<string, any> = { fieldGroupName: 'Setup', fieldName: 'HBR_MandatoryReasonCode' };

    applyExtensionMemberPrefix(args, 'table-extension', 'add-field-to-field-group', 'HBReavis');

    expect(args.fieldGroupName).toBe('Setup');
  });

  it('never renames a member being removed or modified', () => {
    const removed: Record<string, any> = { fieldName: 'HBR_Legacy' };
    const modified: Record<string, any> = { fieldName: 'SomeExistingField' };

    applyExtensionMemberPrefix(removed, 'table-extension', 'remove-field', 'HBReavis');
    applyExtensionMemberPrefix(modified, 'table-extension', 'modify-field', 'HBReavis');

    expect(removed.fieldName).toBe('HBR_Legacy');
    expect(modified.fieldName).toBe('SomeExistingField');
  });

  it('uses the prefix inferred from the model over the configured one', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => [
      'HBC_REMLeaseContractLineUGs', 'HBC_OldDebtsReportController',
      'HBC_OldDebtsReportDP', 'HBC_AssetFirstUseDate',
    ]);
    const args: Record<string, any> = { fieldName: 'BankAccountVerified' };

    applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'HBReavisCus');

    expect(args.fieldName).toBe('HBC_BankAccountVerified');
  });

  it('changes nothing when no prefix resolves at all', () => {
    delete process.env.EXTENSION_PREFIX;
    setModelObjectNameSource(() => []);
    const args: Record<string, any> = { fieldName: 'ApprovingWorker' };

    expect(applyExtensionMemberPrefix(args, 'table-extension', 'add-field', '')).toBe('');
    expect(args.fieldName).toBe('ApprovingWorker');
  });
});
