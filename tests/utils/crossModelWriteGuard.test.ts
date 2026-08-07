/**
 * Cross-model write guard — regression tests.
 *
 * Observed failure (a customer solution built as a shared "Core" model plus
 * per-country models that extend it): asked to "add a field to <table>", the
 * agent resolved the table by name, landed in the shared Core model that owns
 * it, and modified it in place. The standard-model guard let it through — Core
 * is a CUSTOM model — so the field never appeared in the workspace's own model,
 * and it changed code every country model inherits. The wanted change was a
 * table extension in the workspace's model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  crossModelWriteRefusal,
  baseObjectOf,
  suggestedExtensionName,
} from '../../src/utils/crossModelWriteGuard';
import {
  clearInferredModelPrefixes,
  primeInferredModelPrefix,
} from '../../src/utils/modelPrefixInference';

/** Shared model that owns the table; the workspace only consumes it. */
const CORE_MODEL = 'ContosoFinanceCore';
/** The model this workspace targets. */
const ACTIVE_MODEL = 'ContosoFinanceSK';

const CORE_TABLE = 'ContosoCore_TaxTransReportChangeLog';

/** Objects of the active model — enough for its prefix to be inferred. */
const ACTIVE_MODEL_OBJECTS = [
  'ContosoSK_VatReport',
  'ContosoSK_VatReportLine',
  'ContosoSK_ControlStatement',
  'ContosoSK_ControlStatementLine',
  `${CORE_TABLE}.ContosoSKExtension`,
];

const resetEnv = () => {
  clearInferredModelPrefixes();
  delete process.env.D365FO_ALLOW_CROSS_MODEL_WRITE;
  delete process.env.D365FO_CROSS_MODEL_WRITE_MODELS;
  delete process.env.EXTENSION_PREFIX;
  delete process.env.EXTENSION_NAMING_STYLE;
};

beforeEach(resetEnv);
afterEach(resetEnv);

describe('crossModelWriteRefusal', () => {
  it('refuses a write into a different CUSTOM model and names both models', () => {
    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      owningPackage: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
    });

    expect(msg).toBeTruthy();
    expect(msg).toContain(CORE_MODEL);
    expect(msg).toContain(ACTIVE_MODEL);
    expect(msg).toContain(CORE_TABLE);
  });

  it('steers to a NEW table extension in the active model, named per that model', () => {
    primeInferredModelPrefix(ACTIVE_MODEL, ACTIVE_MODEL_OBJECTS);

    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
    })!;

    expect(msg).toContain('action="create"');
    expect(msg).toContain('objectType="table-extension"');
    // The extension element carries the ACTIVE model's own infix, read off its
    // existing extensions — not the Core model's prefix, and not EXTENSION_PREFIX.
    expect(msg).toContain(`${CORE_TABLE}.ContosoSKExtension`);
  });

  it('points at the extension the active model already has, instead of a new one', () => {
    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
      existingExtensions: [
        { name: `${CORE_TABLE}.ContosoSKExtension`, type: 'table-extension' },
      ],
    })!;

    expect(msg).toContain(`${CORE_TABLE}.ContosoSKExtension`);
    expect(msg).toContain('action="modify"');
    expect(msg).not.toContain('action="create"');
  });

  it('allows the write when the object belongs to the active model', () => {
    expect(crossModelWriteRefusal({
      objectName: 'ContosoSK_VatReport',
      objectType: 'table',
      owningModel: ACTIVE_MODEL,
      owningPackage: ACTIVE_MODEL,
      activeModel: ACTIVE_MODEL,
    })).toBeNull();
  });

  it('allows the write when only the PACKAGE segment matches the active model', () => {
    expect(crossModelWriteRefusal({
      objectName: 'ContosoSK_VatReport',
      objectType: 'table',
      owningModel: `${ACTIVE_MODEL}Model`,
      owningPackage: ACTIVE_MODEL,
      activeModel: ACTIVE_MODEL,
    })).toBeNull();
  });

  // The first version of the guard accepted modelName="<owning model>" as consent.
  // The agent read that out of the refusal text, added the parameter, and wrote into
  // the shared model anyway. Consent the caller can mint for itself is not consent.
  it('does not offer the caller a way to authorise itself', () => {
    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
    })!;

    expect(msg).not.toContain(`modelName="${CORE_MODEL}"`);
    expect(msg).toMatch(/Do NOT route around this guard/);
    expect(msg).toMatch(/user's decision/);
  });

  it('treats pieces left in the other model by an earlier run as no authorisation', () => {
    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
    })!;

    expect(msg).toMatch(/earlier run made this same mistake/);
  });

  it('honours the server-wide opt-out', () => {
    process.env.D365FO_ALLOW_CROSS_MODEL_WRITE = 'true';
    expect(crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
    })).toBeNull();
  });

  it('honours the per-model allow-list, and only for the models on it', () => {
    process.env.D365FO_CROSS_MODEL_WRITE_MODELS = ` OtherModel , ${CORE_MODEL.toLowerCase()} `;

    expect(crossModelWriteRefusal({
      objectName: CORE_TABLE, objectType: 'table',
      owningModel: CORE_MODEL, activeModel: ACTIVE_MODEL,
    })).toBeNull();

    expect(crossModelWriteRefusal({
      objectName: 'ContosoCZ_Foo', objectType: 'table',
      owningModel: 'ContosoFinanceCZ', activeModel: ACTIVE_MODEL,
    })).toBeTruthy();
  });

  it('covers create as well as modify, with the matching verb', () => {
    const msg = crossModelWriteRefusal({
      objectName: 'ContosoCore_QualityTier',
      objectType: 'enum',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
      action: 'create',
    })!;

    expect(msg).toContain('Refusing to create "ContosoCore_QualityTier"');
    expect(msg).toContain(CORE_MODEL);
  });

  it('never blocks on a guess: no active model, or no model resolved from the path', () => {
    expect(crossModelWriteRefusal({
      objectName: CORE_TABLE, objectType: 'table',
      owningModel: CORE_MODEL, activeModel: '',
    })).toBeNull();
    expect(crossModelWriteRefusal({
      objectName: CORE_TABLE, objectType: 'table',
      owningModel: null, activeModel: ACTIVE_MODEL,
    })).toBeNull();
  });

  it("refuses a write into ANOTHER model's extension and steers to the active model's own", () => {
    primeInferredModelPrefix(ACTIVE_MODEL, ACTIVE_MODEL_OBJECTS);

    const msg = crossModelWriteRefusal({
      objectName: `${CORE_TABLE}.ContosoCZExtension`,
      objectType: 'table-extension',
      owningModel: 'ContosoFinanceCZ',
      activeModel: ACTIVE_MODEL,
    })!;

    expect(msg).toContain('ContosoFinanceCZ');
    expect(msg).toContain(`${CORE_TABLE}.ContosoSKExtension`);
  });

  // Second self-served bypass, from a live demo (2026-08-07): refused nothing —
  // the agent never even hit the refusal. It called
  // get_workspace_info(projectName="<owning model>"), which moved the ACTIVE model,
  // and then wrote freely, because the guard was comparing the owning model against
  // a value the caller had just changed. Call sites now pass the write ANCHOR.
  it('refuses a write into a model reached by a get_workspace_info project switch', () => {
    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      owningPackage: CORE_MODEL,
      // Anchor stays with the workspace even though reads switched to CORE_MODEL.
      activeModel: ACTIVE_MODEL,
      toolSwitchedModel: CORE_MODEL,
    })!;

    expect(msg).toContain('Refusing to modify');
    expect(msg).toContain('get_workspace_info');
    expect(msg).toContain('it did not change where writes may land');
    // Must not hand back the workaround it just closed.
    expect(msg).not.toContain(`projectName="${CORE_MODEL}"` + ' to write');
  });

  it('says nothing about a project switch when the write is refused for another reason', () => {
    const msg = crossModelWriteRefusal({
      objectName: CORE_TABLE,
      objectType: 'table',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
      toolSwitchedModel: null,
    })!;

    expect(msg).not.toContain('get_workspace_info(projectName');
  });

  it('still refuses for a type with no extension form, without a bogus suggestion', () => {
    const msg = crossModelWriteRefusal({
      objectName: 'ContosoCore_SomePrivilege',
      objectType: 'security-privilege',
      owningModel: CORE_MODEL,
      activeModel: ACTIVE_MODEL,
    })!;

    expect(msg).toContain('Refusing to modify');
    expect(msg).not.toContain('action="create"');
    expect(msg).toContain(`D365FO_CROSS_MODEL_WRITE_MODELS=${CORE_MODEL}`);
  });
});

describe('baseObjectOf', () => {
  it('strips the extension token from both extension forms', () => {
    expect(baseObjectOf('CustTable.FooExtension', 'table-extension')).toBe('CustTable');
    expect(baseObjectOf('SalesFormLetterFoo_Extension', 'class-extension')).toBe('SalesFormLetterFoo');
    expect(baseObjectOf('CustTable', 'table')).toBe('CustTable');
  });
});

describe('suggestedExtensionName', () => {
  it('uses the class-extension shape for classes and dot notation otherwise', () => {
    process.env.EXTENSION_PREFIX = 'Demo';
    expect(suggestedExtensionName('CustTable', 'table', 'DemoModel'))
      .toBe('CustTable.DemoExtension');
    expect(suggestedExtensionName('SalesFormLetter', 'class', 'DemoModel'))
      .toBe('SalesFormLetterDemo_Extension');
  });

  it('returns null for a type that cannot be extended', () => {
    process.env.EXTENSION_PREFIX = 'Demo';
    expect(suggestedExtensionName('SomePrivilege', 'security-privilege', 'DemoModel')).toBeNull();
  });
});
