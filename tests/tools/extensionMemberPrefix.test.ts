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
 * The shape to match, as real table extensions on disk write it — …\Demo\
 * AxTableExtension\AssetBookTable.DEMOExtension.xml holding a field named
 * <Name>DEMO_MandatoryReasonCode</Name>: the member carries the REGULAR token
 * (DEMO_), not the extension infix (DEMO) the file name itself uses.
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
  process.env.EXTENSION_PREFIX = 'DEMO_';
});

afterEach(() => {
  setModelObjectNameSource(null);
  clearInferredModelPrefixes();
  process.env = { ...originalEnv };
});

describe('applyExtensionMemberPrefix', () => {
  it('prefixes a field added to a table extension', () => {
    const args: Record<string, any> = { fieldName: 'MandatoryReasonCode' };

    const note = applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'Demo');

    expect(args.fieldName).toBe('DEMO_MandatoryReasonCode');
    expect(note).toContain('DEMO_MandatoryReasonCode');
  });

  it('prefixes indexes, field groups and enum values too', () => {
    const index: Record<string, any> = { indexName: 'ByReasonCode' };
    const group: Record<string, any> = { fieldGroupName: 'Approval' };
    const value: Record<string, any> = { enumValueName: 'PendingReview' };

    applyExtensionMemberPrefix(index, 'table-extension', 'add-index', 'Demo');
    applyExtensionMemberPrefix(group, 'table-extension', 'add-field-group', 'Demo');
    applyExtensionMemberPrefix(value, 'enum-extension', 'add-enum-value', 'Demo');

    expect(index.indexName).toBe('DEMO_ByReasonCode');
    expect(group.fieldGroupName).toBe('DEMO_Approval');
    expect(value.enumValueName).toBe('DEMO_PendingReview');
  });

  it('leaves a name that already carries the prefix untouched', () => {
    const args: Record<string, any> = { fieldName: 'DEMO_MandatoryReasonCode' };

    expect(applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'Demo')).toBe('');
    expect(args.fieldName).toBe('DEMO_MandatoryReasonCode');
  });

  it('recognises the bare form of an underscore prefix as already applied', () => {
    // An agent that hand-builds "DEMOSomething" must not end up with DEMO_DEMOSomething.
    const args: Record<string, any> = { fieldName: 'DEMOMandatoryReasonCode' };

    applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'Demo');

    expect(args.fieldName).toBe('DEMOMandatoryReasonCode');
  });

  it('does not touch fields on a plain table', () => {
    // A table you own is entirely yours — its fields need no prefix, and adding
    // one would contradict every field the create path already wrote.
    const args: Record<string, any> = { fieldName: 'ApprovingWorker' };

    applyExtensionMemberPrefix(args, 'table', 'add-field', 'Demo');

    expect(args.fieldName).toBe('ApprovingWorker');
  });

  it('never renames a method on a class extension', () => {
    // A CoC method name must match the base method it wraps; prefixing it turns
    // an override into dead code that never runs.
    const args: Record<string, any> = { methodName: 'insert' };

    applyExtensionMemberPrefix(args, 'class-extension', 'add-method', 'Demo');

    expect(args.methodName).toBe('insert');
  });

  it('never renames the field group targeted by add-field-to-field-group', () => {
    // That group already exists and is usually Microsoft's (e.g. "Setup").
    const args: Record<string, any> = { fieldGroupName: 'Setup', fieldName: 'DEMO_MandatoryReasonCode' };

    applyExtensionMemberPrefix(args, 'table-extension', 'add-field-to-field-group', 'Demo');

    expect(args.fieldGroupName).toBe('Setup');
  });

  it('never renames a member being removed or modified', () => {
    const removed: Record<string, any> = { fieldName: 'DEMO_Legacy' };
    const modified: Record<string, any> = { fieldName: 'SomeExistingField' };

    applyExtensionMemberPrefix(removed, 'table-extension', 'remove-field', 'Demo');
    applyExtensionMemberPrefix(modified, 'table-extension', 'modify-field', 'Demo');

    expect(removed.fieldName).toBe('DEMO_Legacy');
    expect(modified.fieldName).toBe('SomeExistingField');
  });

  it('uses the prefix inferred from the model over the configured one', () => {
    process.env.EXTENSION_PREFIX = 'Con';
    setModelObjectNameSource(() => [
      'DMC_REMLeaseContractLineUGs', 'DMC_OldDebtsReportController',
      'DMC_OldDebtsReportDP', 'DMC_AssetFirstUseDate',
    ]);
    const args: Record<string, any> = { fieldName: 'BankAccountVerified' };

    applyExtensionMemberPrefix(args, 'table-extension', 'add-field', 'DemoCus');

    expect(args.fieldName).toBe('DMC_BankAccountVerified');
  });

  it('changes nothing when no prefix resolves at all', () => {
    delete process.env.EXTENSION_PREFIX;
    setModelObjectNameSource(() => []);
    const args: Record<string, any> = { fieldName: 'ApprovingWorker' };

    expect(applyExtensionMemberPrefix(args, 'table-extension', 'add-field', '')).toBe('');
    expect(args.fieldName).toBe('ApprovingWorker');
  });
});
