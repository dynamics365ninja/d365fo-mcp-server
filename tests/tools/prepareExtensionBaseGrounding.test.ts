/**
 * `prepare(mode="create")` on an extension type must ground the caller in the
 * object being EXTENDED (issue #983 follow-up, found by reading the live tool
 * output after the fix shipped).
 *
 * Publishing the extension objectTypes made the write reachable; it did not make
 * it grounded. Everything that decides whether an enum extension can work lives
 * on the BASE: it has to exist, it has to be extensible — a sealed enum cannot be
 * extended at all — and a member name already on it is a build error, not a
 * merge. `prepare(mode="change")` is built around reading the base object;
 * `prepare(mode="create")` said nothing about it, so the one call an agent makes
 * before writing an extension covered everything except the precondition.
 *
 * The second half is where the answer comes FROM. `checkObjectNaming` can only
 * probe the symbol index, while `search`, `get_object_info` and the write path
 * all prefer the C# bridge. On the eval instance — indexed with
 * `extractMode: "custom"`, `customModels: ["fm-mcp"]` — the index holds no
 * standard models, so `NumberSeqModule` (ApplicationPlatform, Extensible: Yes,
 * 7 members, read instantly by the bridge) came back as "not found in symbol
 * index … Ensure it's indexed": false, with advice re-indexing can never satisfy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/configManager', () => ({
  getConfigManager: vi.fn(() => ({
    getModelName: () => 'fm-mcp',
    getWriteAnchorModel: () => 'fm-mcp',
    getAutoDetectedModelName: async () => 'fm-mcp',
  })),
}));

const NUMBER_SEQ_MODULE = {
  name: 'NumberSeqModule',
  model: 'ApplicationPlatform',
  isExtensible: true,
  values: [
    { name: 'General', value: 0 },
    { name: 'Docu', value: 1 },
    { name: 'Workflow', value: 3 },
  ],
};

/** A context whose symbol index is EMPTY — as an extractMode:"custom" one is for standard models. */
const buildContext = (bridge?: Record<string, unknown>) => {
  const stmt = { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
  const db = { prepare: vi.fn(() => stmt) };
  return {
    symbolIndex: { db, getReadDb: () => db } as any,
    bridge,
    parser: {} as any,
    cache: {} as any,
    workspaceScanner: {} as any,
    hybridSearch: {} as any,
  } as any;
};

const readyBridge = (over: Record<string, unknown> = {}) => ({
  isReady: true,
  metadataAvailable: true,
  readEnum: vi.fn(async () => NUMBER_SEQ_MODULE),
  resolveObjectInfo: vi.fn(async () => ({ exists: true, objectType: 'table', objectName: 'CustTable', model: 'ApplicationSuite' })),
  ...over,
});

async function prepareCreate(objectName: string, objectType: string, bridge?: Record<string, unknown>) {
  const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
  const res = await prepareCreateTool(
    { params: { arguments: { goal: 'test', objectName, objectType } } },
    buildContext(bridge),
  );
  return String(res.content[0].text);
}

beforeEach(() => vi.clearAllMocks());

describe('prepare(create) grounds an extension in its base object', () => {
  it('reports the base enum, its extensibility and the member names already taken', async () => {
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension', readyBridge());
    expect(text).toContain('### Base object');
    expect(text).toContain('NumberSeqModule');
    expect(text).toContain('Extensible: Yes');
    // A member name already on the base is a build error, not a merge.
    expect(text).toMatch(/General, Docu, Workflow/);
  });

  it('does NOT claim a bridge-verified base is missing from the index', async () => {
    // The index is empty here, exactly as an extractMode:"custom" one is for a
    // Microsoft base. The bridge answered, so the index must not get a vote.
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension', readyBridge());
    expect(text).not.toMatch(/not found in the symbol index/);
    expect(text).not.toMatch(/Ensure it's indexed/);
  });

  it('calls a non-extensible base what it is — the write cannot build', async () => {
    const sealed = readyBridge({
      readEnum: vi.fn(async () => ({ ...NUMBER_SEQ_MODULE, isExtensible: false })),
    });
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension', sealed);
    expect(text).toContain('Extensible: NO');
    expect(text).toMatch(/CANNOT be extended/);
  });

  it('says so plainly when the base does not exist', async () => {
    const missing = readyBridge({ readEnum: vi.fn(async () => null) });
    const text = await prepareCreate('NoSuchEnum.ConDemoRent', 'enum-extension', missing);
    expect(text).toMatch(/does not exist as an enum/);
    expect(text).toMatch(/cannot build/);
  });

  it('falls back to a generic existence probe for non-enum extension types', async () => {
    const bridge = readyBridge();
    const text = await prepareCreate('CustTable.ConDemoExtension', 'table-extension', bridge);
    expect(bridge.resolveObjectInfo).toHaveBeenCalledWith('table', 'CustTable');
    expect(text).toContain('### Base object');
    expect(text).toContain('CustTable');
  });

  it('without a bridge, says the index may simply be scoped — not that the base is missing', async () => {
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension', undefined);
    expect(text).toMatch(/could not be verified|scoped to custom models/);
    // The old wording told the agent to re-index, which cannot help here.
    expect(text).not.toMatch(/Ensure it's indexed\./);
  });

  it('adds no Base object section for a non-extension type', async () => {
    const text = await prepareCreate('ImportParameters', 'table', readyBridge());
    expect(text).not.toContain('### Base object');
  });

  it('does not tell the caller a dotted extension name will be prefixed for them', async () => {
    const text = await prepareCreate('NumberSeqModule.ConDemoRent', 'enum-extension', readyBridge());
    expect(text).not.toContain('the prefix is applied for you');
    expect(text).toMatch(/only the suffix after the dot is yours to choose/);
  });
});

/**
 * Extension siblings and extension collisions (issue #995).
 *
 * Both come from one fact about the index: an extension row does NOT carry
 * `parent_name IS NULL`. It records the object it EXTENDS there instead — all 278
 * enum extensions in a production index do. Every helper in symbolLookup requires
 * the NULL, so extensions are invisible to all of them.
 *
 * Consequences, both measured against a real index:
 *   • `prepare` answered "greenfield" for NumberSeqModule.ConDemoRent while 25
 *     extensions of that exact enum sat in the index.
 *   • the collision check cleared `NumberSeqModule.Kitting` — an enum-extension
 *     that IS in the index — as "✅ No collision", right before a write.
 */
describe('prepare(create) sees extension rows (#995)', () => {
  const SIBLINGS = [
    { name: 'NumberSeqModule.Administration', type: 'enum-extension', model: 'ApplicationFoundation', extends_class: null, file_path: null },
    { name: 'NumberSeqModule.RentalManagement', type: 'enum-extension', model: 'RentalManagement', extends_class: null, file_path: null },
  ];

  /**
   * A db that answers only the two shapes extensions live under, so a query that
   * still demands `parent_name IS NULL` gets nothing — the pre-fix behaviour.
   */
  const extensionAwareDb = (opts: { siblings?: unknown[]; taken?: unknown[] } = {}) => {
    const prepare = vi.fn((sql: string) => ({
      all: vi.fn((..._p: unknown[]) => {
        if (sql.includes('parent_name IS NULL')) return [];
        if (sql.includes('parent_name = ?')) return opts.siblings ?? [];
        if (sql.includes('parent_name IS NOT NULL')) return opts.taken ?? [];
        return [];
      }),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    }));
    return { prepare };
  };

  const runWith = async (db: unknown, objectName: string, objectType: string) => {
    const { prepareCreateTool } = await import('../../src/tools/prepare/prepareCreate.js');
    const res = await prepareCreateTool(
      { params: { arguments: { goal: 'test', objectName, objectType } } },
      {
        symbolIndex: { db, getReadDb: () => db } as any,
        bridge: readyBridge(),
        parser: {} as any, cache: {} as any, workspaceScanner: {} as any, hybridSearch: {} as any,
      } as any,
    );
    return String(res.content[0].text);
  };

  it('lists the other extensions of the same base instead of "greenfield"', async () => {
    const text = await runWith(extensionAwareDb({ siblings: SIBLINGS }), 'NumberSeqModule.ConDemoRent', 'enum-extension');
    expect(text).not.toContain('greenfield');
    expect(text).toContain('NumberSeqModule.RentalManagement');
    expect(text).toContain('RentalManagement');
  });

  it('says "this is the first" rather than "greenfield" when the base truly has none', async () => {
    const text = await runWith(extensionAwareDb({ siblings: [] }), 'NumberSeqModule.ConDemoRent', 'enum-extension');
    expect(text).toMatch(/no other enum-extension of "NumberSeqModule" in the index — this is the first/);
  });

  it('does NOT clear a name an existing extension already holds', async () => {
    const taken = [{ name: 'NumberSeqModule.Kitting', type: 'enum-extension', model: 'Kitting', extends_class: null, file_path: null }];
    const text = await runWith(extensionAwareDb({ taken }), 'NumberSeqModule.Kitting', 'enum-extension');
    expect(text).not.toContain('✅ No collision');
    expect(text).toContain('already exists as enum-extension');
    expect(text).toContain('Kitting');
  });

  it('does not run the child probe for an undotted name', async () => {
    const db = extensionAwareDb();
    await runWith(db, 'ImportParameters', 'table');
    const childProbes = (db.prepare as any).mock.calls
      .filter((c: unknown[]) => String(c[0]).includes('parent_name IS NOT NULL'));
    expect(childProbes).toHaveLength(0);
  });
});
