/**
 * The XML add-index fallback reports an existing index as a skip, not an add.
 *
 * It answered "✅ Index 'X' already present — skipped (idempotent)" with success and
 * no `skipped`, so a batch counted it as applied, and a caller who asked for
 * different fields read success over an index that was never changed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { directXmlAddIndex } from '../../src/tools/write/directXmlWriters';

const TABLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
	<Name>ContosoSetting</Name>
	<Indexes>
		<AxTableIndex>
			<Name>SettingIdx</Name>
			<Fields>
				<AxTableIndexField>
					<DataField>SettingId</DataField>
				</AxTableIndexField>
			</Fields>
		</AxTableIndex>
	</Indexes>
</AxTable>
`;

let dir: string | undefined;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('directXmlAddIndex on an index that exists', () => {
  it('reports a skip and leaves the file as it was', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xml-add-index-'));
    const file = path.join(dir, 'ContosoSetting.xml');
    await fs.writeFile(file, TABLE_XML, 'utf-8');

    const result = await directXmlAddIndex(file, 'SettingIdx', ['OtherField'], false, false);

    expect(result?.success).toBe(true);
    expect(result?.skipped).toBe(true);
    expect(result?.message).toContain('NOT written');
    expect(result?.message).not.toContain('✅');
    expect(await fs.readFile(file, 'utf-8')).toBe(TABLE_XML);
  });
});
