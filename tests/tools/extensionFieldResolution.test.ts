/**
 * A field an extension contributes must resolve, whatever kind of extension
 * contributed it and however that extension spells the object it extends.
 *
 * `unknown-field` is an ERROR, and under GROUNDING_ENFORCE an error refuses the
 * write that carries it — so a false positive here does not cost a round trip,
 * it stops the task. Three shapes got one past the previous check, all of them
 * present in shipped metadata on a stock box:
 *
 *   1. The extension spells the base object with different casing than the
 *      object's own name (`vendVendorParametersStaging.*Extension` against the
 *      table `VendVendorParametersStaging`, and 3 more models on that same
 *      table). The nocase re-probe existed but was gated on "the base object is
 *      not in the index" — which is never true in exactly this case.
 *   2. A VIEW extension contributed the column. The lookup filtered
 *      `extension_type = 'table-extension'`, and `fieldExists` is reached for
 *      every TABLE_LIKE_TYPES buffer, views included.
 *   3. The index holds no column list for the object at all, so "not found" was
 *      a statement about the index reported as a statement about the code.
 *
 * Same fixture pattern as extensionMetadataIncremental.test.ts: `:memory:`
 * index, mkdtemp XML, the real `indexOneFile` and the real `resolveXppReferences`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { indexOneFile } from '../../src/tools/sdlc/updateSymbolIndex';
import { resolveXppReferences, type ResolverDeps } from '../../src/tools/write/resolveReferences';

const MODEL = 'RefProbeExt';

/** As the AOT spells the table itself. */
const TABLE = 'RefProbeVendStaging';
/** As the shipped extension spells the SAME table — note the leading lower case. */
const TABLE_AS_EXTENSION_SPELLS_IT = 'refProbeVendStaging';

const VIEW = 'RefProbePartyView';
/** A table the index knows and holds no columns for. */
const FIELDLESS_TABLE = 'RefProbeFieldlessTable';

const TABLE_EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>${TABLE_AS_EXTENSION_SPELLS_IT}.RefProbeExtension</Name>
	<Fields>
		<AxTableField xmlns=""
			i:type="AxTableFieldEnum">
			<Name>RefProbe_QualityTier</Name>
			<EnumType>RefProbe_QualityTier</EnumType>
		</AxTableField>
	</Fields>
</AxTableExtension>`;

const VIEW_EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxViewExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>${VIEW}.RefProbeExtension</Name>
	<Fields>
		<AxViewField xmlns=""
			i:type="AxViewFieldString">
			<Name>RefProbe_IsSimplified</Name>
		</AxViewField>
	</Fields>
</AxViewExtension>`;

/** `Buffer.Field` on a declared buffer — the shape that reaches the field check. */
const reads = (type: string, field: string) => `public void run()
{
    ${type} buf;

    if (buf.${field})
    {
        info("x");
    }
}`;

/** The intrinsic path into the same check. */
const fieldStrOn = (type: string, field: string) => `public void run()
{
    info(fieldStr(${type}, ${field}));
}`;

let tmpDir: string;
let index: XppSymbolIndex;
let deps: ResolverDeps;

const write = async (aotFolder: string, fileName: string, xml: string): Promise<string> => {
  const dir = path.join(tmpDir, MODEL, aotFolder);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  await fs.writeFile(file, xml, 'utf-8');
  return file;
};

const fieldViolations = (code: string) =>
  resolveXppReferences(code, deps).violations.filter(v => v.kind === 'unknown-field');

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpp-ext-field-'));

  index = new XppSymbolIndex(':memory:', ':memory:');
  // The base objects, as a full build of the shared model left them.
  index.addSymbol({ name: TABLE, type: 'table', filePath: 'K:\\base\\t.xml', model: 'RefProbeBase' });
  index.addSymbol({
    name: 'Voucher', type: 'field', parentName: TABLE,
    filePath: 'K:\\base\\t.xml', model: 'RefProbeBase',
  });
  index.addSymbol({ name: VIEW, type: 'view', filePath: 'K:\\base\\v.xml', model: 'RefProbeBase' });
  index.addSymbol({
    name: 'PartyId', type: 'field', parentName: VIEW,
    filePath: 'K:\\base\\v.xml', model: 'RefProbeBase',
  });
  index.addSymbol({
    name: FIELDLESS_TABLE, type: 'table', filePath: 'K:\\base\\f.xml', model: 'RefProbeBase',
  });

  deps = { db: index.getReadDb(), getLabelById: () => [], getLabelFileIds: () => [] };
});

afterAll(async () => {
  index.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('an extension that spells the base object with different casing', () => {
  it('starts out unable to resolve the field — nothing is indexed yet', () => {
    expect(fieldViolations(reads(TABLE, 'RefProbe_QualityTier'))).toHaveLength(1);
  });

  it('resolves it once the extension is indexed, though the casing still differs', async () => {
    const file = await write(
      'AxTableExtension', `${TABLE_AS_EXTENSION_SPELLS_IT}.RefProbeExtension.xml`, TABLE_EXTENSION_XML,
    );
    const result = await indexOneFile(file, { symbolIndex: index } as any);
    expect(result.isError).toBe(false);

    // The row really does carry the other spelling — otherwise this test would
    // pass for the wrong reason.
    const row = index.getReadDb().prepare(
      `SELECT base_object_name FROM extension_metadata WHERE extension_type = 'table-extension'`,
    ).get() as { base_object_name: string };
    expect(row.base_object_name).toBe(TABLE_AS_EXTENSION_SPELLS_IT);
    expect(row.base_object_name).not.toBe(TABLE);

    expect(fieldViolations(reads(TABLE, 'RefProbe_QualityTier'))).toEqual([]);
  });

  it('resolves it through fieldStr() too', () => {
    expect(fieldViolations(fieldStrOn(TABLE, 'RefProbe_QualityTier'))).toEqual([]);
  });
});

describe('a column contributed by a VIEW extension', () => {
  it('resolves on a view buffer', async () => {
    expect(fieldViolations(reads(VIEW, 'RefProbe_IsSimplified'))).toHaveLength(1);

    const file = await write('AxViewExtension', `${VIEW}.RefProbeExtension.xml`, VIEW_EXTENSION_XML);
    const result = await indexOneFile(file, { symbolIndex: index } as any);
    expect(result.isError).toBe(false);

    expect(fieldViolations(reads(VIEW, 'RefProbe_IsSimplified'))).toEqual([]);
  });
});

describe('a field that genuinely does not exist', () => {
  it('is still an error on a table whose columns the index knows', () => {
    const violations = fieldViolations(reads(TABLE, 'RefProbe_NotAThing'));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('error');
  });

  it('is still an error on a table that has an extension, but not this field', () => {
    const violations = fieldViolations(fieldStrOn(TABLE, 'RefProbe_AlsoNotAThing'));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('error');
  });

  it('names the reader that can actually show extension-contributed fields', () => {
    const [violation] = fieldViolations(reads(TABLE, 'RefProbe_NotAThing'));
    expect(violation.detail).toContain('objectType="table-extension"');
  });

  it('offers the prefixed name when that is the only difference', () => {
    const [violation] = fieldViolations(reads(TABLE, 'QualityTier'));
    expect(violation.severity).toBe('error');
    expect(violation.detail).toContain('RefProbe_QualityTier');
  });
});

describe('a table the index holds no column list for', () => {
  it('reports uncertainty as a warning instead of blocking the write', () => {
    const violations = fieldViolations(reads(FIELDLESS_TABLE, 'AnyColumnAtAll'));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('warning');
    expect(violations[0].detail).toContain('no column list');
  });

  it('still resolves the system fields there', () => {
    expect(fieldViolations(reads(FIELDLESS_TABLE, 'RecId'))).toEqual([]);
  });
});

/**
 * The reindex reports exactly one inserted symbol whether it wrote the
 * extension_metadata row or fell back to a bare object row — and only the first
 * makes the extension's members resolvable. An agent reading "✅ Symbol index
 * updated" could not tell the two apart, which is how a session spent three more
 * round trips re-validating code the index was never going to accept.
 */
describe('what the reindex says about the extension record', () => {
  it('says it wrote one', async () => {
    const file = await write(
      'AxTableExtension', `${TABLE_AS_EXTENSION_SPELLS_IT}.RefProbeExtension.xml`, TABLE_EXTENSION_XML,
    );
    const result = await indexOneFile(file, { symbolIndex: index } as any);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Extension record: written');
  });

  it('says it did NOT, instead of reporting plain success', async () => {
    const file = await write(
      'AxTableExtension', 'RefProbeUnparseable.RefProbeExtension.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<NotATableExtension><Name>x</Name></NotATableExtension>',
    );
    const result = await indexOneFile(file, { symbolIndex: index } as any);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Extension record: NOT written');
  });
});
