/**
 * `Enum::Value` must name a value the enum really has (#1164).
 *
 * resolve_references used to treat the value as proven once the enum existed,
 * so `PurchStatus::NoSuchStatus` passed with "No hallucinated symbols detected"
 * and only failed at build time. The values are now read from the AxEnum XML and
 * from every AxEnumExtension XML the index holds for that enum.
 *
 * `unknown-enum-value` is an ERROR, and under GROUNDING_ENFORCE an error refuses
 * the write — so every place a real value can come from is pinned here as well:
 * an extension in another model, an extension that exists only as compiled
 * metadata (`bin\<Package>_AxEnumExtension.md`), and an enum whose XML cannot be
 * read at all.
 *
 * Same fixture pattern as extensionFieldResolution.test.ts: `:memory:` index,
 * mkdtemp XML laid out like a PackagesLocalDirectory, the real `indexOneFile`
 * and the real `resolveXppReferences`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { indexOneFile } from '../../src/tools/sdlc/updateSymbolIndex';
import {
  resolveXppReferences,
  gateOnReferenceErrors,
  type ResolverDeps,
} from '../../src/tools/write/resolveReferences';
import {
  enumValueNamesFromXml,
  resetCompiledEnumExtensionCache,
} from '../../src/tools/write/enumValueNames';

const ENUM = 'RefProbeStatus';
/** Indexed, but its XML is not on this machine (a DB built elsewhere). */
const UNREADABLE_ENUM = 'RefProbeRemoteStatus';

const ENUM_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxEnum xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>${ENUM}</Name>
	<IsExtensible>true</IsExtensible>
	<Label>@SYS1</Label>
	<UseEnumValue>No</UseEnumValue>
	<EnumValues>
		<AxEnumValue>
			<Name>Open</Name>
			<Label>@SYS2</Label>
			<Value>0</Value>
		</AxEnumValue>
		<AxEnumValue>
			<Label>@SYS3</Label>
			<Name>Closed</Name>
			<Value>1</Value>
		</AxEnumValue>
	</EnumValues>
</AxEnum>`;

const EXTENSION_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxEnumExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>${ENUM}.RefProbeExtension</Name>
	<EnumValues>
		<AxEnumValue>
			<Name>OnHold</Name>
			<Label>@SYS4</Label>
		</AxEnumValue>
	</EnumValues>
</AxEnumExtension>`;

const uses = (expr: string) => `public void run()
{
    ${expr};
}`;

let tmpDir: string;
let packagesRoot: string;
let index: XppSymbolIndex;
let deps: ResolverDeps;

const write = async (rel: string, content: string | Buffer): Promise<string> => {
  const file = path.join(packagesRoot, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
};

const enumViolations = (code: string) =>
  resolveXppReferences(code, deps).violations.filter(v => v.kind === 'unknown-enum-value');

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xpp-enum-value-'));
  packagesRoot = path.join(tmpDir, 'PackagesLocalDirectory');

  index = new XppSymbolIndex(':memory:', ':memory:');
  const enumFile = await write(`RefProbeBase/RefProbeBase/AxEnum/${ENUM}.xml`, ENUM_XML);
  index.addSymbol({ name: ENUM, type: 'enum', filePath: enumFile, model: 'RefProbeBase' });
  index.addSymbol({
    name: UNREADABLE_ENUM, type: 'enum',
    filePath: path.join(packagesRoot, 'Elsewhere', 'Elsewhere', 'AxEnum', `${UNREADABLE_ENUM}.xml`),
    model: 'Elsewhere',
  });

  deps = { db: index.getReadDb(), getLabelById: () => [], getLabelFileIds: () => [] };
});

afterEach(() => {
  delete process.env.GROUNDING_ENFORCE;
});

afterAll(async () => {
  index.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('enumValueNamesFromXml', () => {
  it('takes each value name, not the enum name, whatever the child order', () => {
    expect(enumValueNamesFromXml(ENUM_XML)).toEqual(['Open', 'Closed']);
    expect(enumValueNamesFromXml(EXTENSION_XML)).toEqual(['OnHold']);
  });
});

describe('Enum::Value against the enum itself', () => {
  it('accepts a value the enum declares, in any casing', () => {
    expect(enumViolations(uses(`${ENUM} s = ${ENUM}::Open`))).toEqual([]);
    expect(enumViolations(uses(`${ENUM} s = ${ENUM.toLowerCase()}::closed`))).toEqual([]);
  });

  it('reports a value the enum does not have, as an error', () => {
    const found = enumViolations(uses(`${ENUM} s = ${ENUM}::NoSuchStatus`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'error',
      identifier: `${ENUM}::NoSuchStatus`,
      line: 3,
    });
    expect(found[0].detail).toContain(`get_object_info(objectType="enum", name="${ENUM}")`);
  });

  it('refuses the write under GROUNDING_ENFORCE', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const gate = gateOnReferenceErrors(uses(`${ENUM} s = ${ENUM}::Bogus`), {
      getReadDb: () => deps.db,
      getLabelById: deps.getLabelById,
      getLabelFileIds: deps.getLabelFileIds,
    }, 'test');
    expect(gate?.content[0].text).toContain('unknown-enum-value');
  });

  it('stays silent when the enum XML cannot be read — unknown is not missing', () => {
    expect(enumViolations(uses(`${UNREADABLE_ENUM}::Anything`))).toEqual([]);
  });

  it('skips a namespace-qualified .NET enum that shares the name', () => {
    expect(enumViolations(uses(`var v = Contoso.Contracts.${ENUM}::DotNetOnly`))).toEqual([]);
  });

  it('only warns when a using directive may have imported a .NET enum of that name', () => {
    // Shipped X++ does this: `using Microsoft.Xrm.Sdk.Query;` then `OrderType::Descending`.
    const found = enumViolations(`using Contoso.Contracts;\n\n${uses(`var v = ${ENUM}::DotNetOnly`)}`);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warning');
    // The using STATEMENT is not a directive and changes nothing.
    const statement = enumViolations(uses(`using (var x = new Foo()) { ${ENUM} s = ${ENUM}::Bogus; }`));
    expect(statement[0]?.severity).toBe('error');
  });
});

describe('values another model adds', () => {
  it('accepts a value from an indexed AxEnumExtension', async () => {
    expect(enumViolations(uses(`${ENUM}::OnHold`))).toHaveLength(1);

    const file = await write(
      `RefProbeExt/RefProbeExt/AxEnumExtension/${ENUM}.RefProbeExtension.xml`, EXTENSION_XML,
    );
    const result = await indexOneFile(file, { symbolIndex: index } as any);
    expect(result.isError).toBe(false);

    expect(enumViolations(uses(`${ENUM}::OnHold`))).toEqual([]);
    // …and the extension does not make every name acceptable.
    expect(enumViolations(uses(`${ENUM}::Bogus`))).toHaveLength(1);
  });

  it('accepts a value only compiled metadata adds (a package shipped without XML)', async () => {
    expect(enumViolations(uses(`${ENUM}::Shipped`))).toHaveLength(1);

    // The real file is binary: length-prefixed strings around the names.
    const md = Buffer.concat([
      Buffer.from([0x00, 0x1d]), Buffer.from(`${ENUM}.BinaryOnly`, 'latin1'),
      Buffer.from([0xff, 0x07]), Buffer.from('Shipped', 'latin1'), Buffer.from([0x00]),
    ]);
    await write('BinaryOnly/bin/BinaryOnly_AxEnumExtension.md', md);
    resetCompiledEnumExtensionCache();

    expect(enumViolations(uses(`${ENUM}::Shipped`))).toEqual([]);
    expect(enumViolations(uses(`${ENUM}::StillBogus`))).toHaveLength(1);
  });
});
