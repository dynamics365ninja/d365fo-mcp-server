/**
 * fsExtensionScanner — the last-resort disk fallback, previously untested.
 *
 * It exists for one reason stated in its own header: when the SQLite index has
 * nothing for a base object, the agent's next move is a PowerShell
 * Get-ChildItem / Select-String sweep of PackagesLocalDirectory. That is slow,
 * unreviewable, and the single behaviour the instruction files most insist
 * against. So this scanner is the thing standing between a miss and a shell-out,
 * and a silent regression here re-opens that door without any test failing.
 *
 * What is pinned below: the naming conventions it filters on (class-style vs
 * dotted), the extraction of what an extension actually ADDS, and the fact that
 * an unreadable directory anywhere in the walk is skipped rather than fatal — a
 * packages root always contains folders the process cannot enter.
 *
 * NOT covered here: the D365FO_DISABLE_FS_FALLBACK kill switch and the
 * SCAN_TIMEOUT_MS budget. Both are read into module-level constants at import,
 * so exercising them needs a module reset per case; left for a follow-up rather
 * than faked with a test that would pass regardless.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A virtual packages tree. Keys are absolute-ish paths using the platform
// separator that path.join produces, so the tests work on win32 and posix.
let DIRS: Record<string, string[]> = {};
let FILES: Record<string, string> = {};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: vi.fn(async (p: string) => {
        if (!(p in DIRS)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return DIRS[p];
      }),
      stat: vi.fn(async (p: string) => {
        if (p in DIRS) return { isDirectory: () => true } as never;
        if (p in FILES) return { isDirectory: () => false } as never;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      readFile: vi.fn(async (p: string) => {
        if (!(p in FILES)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return FILES[p];
      }),
    },
  };
});

import path from 'path';
import { scanFsExtensions, EXTENSION_FOLDER_CONFIG } from '../../src/utils/fsExtensionScanner';

const ROOT = path.join('K:', 'AosService', 'PackagesLocalDirectory');
const j = (...parts: string[]) => path.join(...parts);

/** Register a file and every directory on the way to it. */
function addFile(fullPath: string, content: string): void {
  FILES[fullPath] = content;
  let dir = path.dirname(fullPath);
  let child = path.basename(fullPath);
  // Walk up to (and including) ROOT's parent, registering each level.
  while (dir.length >= ROOT.length) {
    DIRS[dir] ??= [];
    if (!DIRS[dir].includes(child)) DIRS[dir].push(child);
    child = path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const TABLE_EXT_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MySalesTable.MyModel</Name>
  <Fields>
    <AxTableField i:type="AxTableFieldString">
      <Name>MyPriority</Name>
    </AxTableField>
    <AxTableField i:type="AxTableFieldEnum">
      <Name>MyStatus</Name>
    </AxTableField>
  </Fields>
  <Indexes>
    <AxTableIndex>
      <Name>MyPriorityIdx</Name>
    </AxTableIndex>
  </Indexes>
</AxTableExtension>`;

const CLASS_EXT_XML = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MySalesTable_MyModel_Extension</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>validateWrite</Name>
        <Source>public boolean validateWrite()
{
    boolean ret = next validateWrite();
    return ret;
}</Source>
      </Method>
      <Method>
        <Name>myHelper</Name>
        <Source>public void myHelper()
{
}</Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>`;

/**
 * Results are cached for 30 s keyed on (packagePath, extensionType, objectName),
 * and the cache is module-level. Every test therefore uses its own base-object
 * name — otherwise the second test in a file reads the first one's answer.
 */
let seq = 0;
const uniqueName = (stem: string) => `${stem}${seq++}`;

describe('scanFsExtensions', () => {
  beforeEach(() => {
    DIRS = {};
    FILES = {};
    delete process.env.D365FO_DISABLE_FS_FALLBACK;
  });
  afterEach(() => {
    delete process.env.D365FO_DISABLE_FS_FALLBACK;
  });

  it('covers every extension type the tools can ask for', () => {
    // A type present in the tool enums but missing here returns [] silently,
    // which reads to the agent as "no extensions exist".
    for (const t of ['table-extension', 'form-extension', 'enum-extension', 'edt-extension',
                     'data-entity-extension', 'menu-extension', 'class-extension']) {
      expect(EXTENSION_FOLDER_CONFIG[t], `no folder config for ${t}`).toBeDefined();
    }
    expect(EXTENSION_FOLDER_CONFIG['class-extension'].isClassStyle).toBe(true);
    expect(EXTENSION_FOLDER_CONFIG['table-extension'].isClassStyle).toBeFalsy();
  });

  it('returns [] for an unknown extension type instead of throwing', async () => {
    expect(await scanFsExtensions('X', 'not-a-real-type', ROOT)).toEqual([]);
  });

  it('returns [] when the packages root is unreadable', async () => {
    expect(await scanFsExtensions(uniqueName('Missing'), 'table-extension', ROOT)).toEqual([]);
  });

  describe('dotted naming (BaseName.ModelName.xml)', () => {
    it('finds the extension and reports what it adds', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'MyPkg', 'MyModel', 'AxTableExtension', `${base}.MyModel.xml`), TABLE_EXT_XML);

      const [hit, ...rest] = await scanFsExtensions(base, 'table-extension', ROOT);
      expect(rest).toEqual([]);
      expect(hit.model).toBe('MyModel');
      expect(hit.filePath).toContain('AxTableExtension');
      expect(hit.addedFields).toEqual(['MyPriority', 'MyStatus']);
      expect(hit.addedIndexes).toEqual(['MyPriorityIdx']);
    });

    it('matches the base name case-insensitively — X++ identifiers are', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'MyPkg', 'MyModel', 'AxTableExtension', `${base}.MyModel.xml`), TABLE_EXT_XML);
      expect(await scanFsExtensions(base.toUpperCase(), 'table-extension', ROOT)).toHaveLength(1);
    });

    it('does not match a DIFFERENT table whose name merely starts the same', async () => {
      // `MySalesTableLine.MyModel.xml` must not answer a query for MySalesTable —
      // the dot is the boundary, and a prefix match here would report another
      // table's fields as this one's.
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'MyPkg', 'MyModel', 'AxTableExtension', `${base}Line.MyModel.xml`), TABLE_EXT_XML);
      expect(await scanFsExtensions(base, 'table-extension', ROOT)).toEqual([]);
    });

    it('finds extensions of the same base in several models', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'PkgA', 'ModelA', 'AxTableExtension', `${base}.ModelA.xml`), TABLE_EXT_XML);
      addFile(j(ROOT, 'PkgB', 'ModelB', 'AxTableExtension', `${base}.ModelB.xml`), TABLE_EXT_XML);

      const hits = await scanFsExtensions(base, 'table-extension', ROOT);
      expect(hits.map(h => h.model).sort()).toEqual(['ModelA', 'ModelB']);
    });
  });

  describe('class-style naming (BaseName_…_Extension.xml in AxClass/)', () => {
    it('finds the extension and separates CoC wrappers from plain methods', async () => {
      const base = uniqueName('MySalesTable');
      const xml = CLASS_EXT_XML.replace('MySalesTable_MyModel_Extension', `${base}_MyModel_Extension`);
      addFile(j(ROOT, 'MyPkg', 'MyModel', 'AxClass', `${base}_MyModel_Extension.xml`), xml);

      const [hit] = await scanFsExtensions(base, 'class-extension', ROOT);
      expect(hit.addedMethods).toEqual(['validateWrite', 'myHelper']);
      // `next` in the body is what makes it a Chain of Command wrapper — the
      // distinction the agent needs before deciding to wrap or to add.
      expect(hit.cocMethods).toEqual(['validateWrite']);
    });

    it('ignores an AxClass file that is not an _Extension', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'MyPkg', 'MyModel', 'AxClass', `${base}_Helper.xml`), CLASS_EXT_XML);
      expect(await scanFsExtensions(base, 'class-extension', ROOT)).toEqual([]);
    });

    it('requires the underscore boundary after the base name', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'MyPkg', 'MyModel', 'AxClass', `${base}Line_Extension.xml`), CLASS_EXT_XML);
      expect(await scanFsExtensions(base, 'class-extension', ROOT)).toEqual([]);
    });
  });

  describe('resilience', () => {
    it('skips a package directory it cannot read and keeps going', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'GoodPkg', 'MyModel', 'AxTableExtension', `${base}.MyModel.xml`), TABLE_EXT_XML);
      // A directory entry with no entry in DIRS/FILES — stat throws, as it does
      // for the folders the AOS service owns and this process cannot enter.
      DIRS[ROOT].push('UnreadablePkg');

      expect(await scanFsExtensions(base, 'table-extension', ROOT)).toHaveLength(1);
    });

    it('skips a file whose XML is malformed rather than failing the whole scan', async () => {
      const base = uniqueName('MySalesTable');
      addFile(j(ROOT, 'PkgA', 'ModelA', 'AxTableExtension', `${base}.ModelA.xml`), '<AxTableExtension>truncated');
      addFile(j(ROOT, 'PkgB', 'ModelB', 'AxTableExtension', `${base}.ModelB.xml`), TABLE_EXT_XML);

      const hits = await scanFsExtensions(base, 'table-extension', ROOT);
      expect(hits.map(h => h.model)).toEqual(['ModelB']);
    });
  });
});
