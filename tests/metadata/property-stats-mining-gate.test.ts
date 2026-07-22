/**
 * #722: which models may be mined into property_stats.
 *
 * property_stats is a corpus of "what does the standard Microsoft platform do" — prepare,
 * generate_object and validate_code present its majority values as platform convention.
 * Two holes let non-Microsoft code in:
 *
 *   1. the table miner's gate is isStandardModel(), which reads CUSTOM_MODELS from the
 *      environment — empty by design in build-database on UDE, so our own model and every
 *      third-party ISV model under the custom root were mined as Microsoft's;
 *   2. the AxFormDesign pattern miner had no gate at all, on any environment.
 *
 * Both now run through XppSymbolIndex.isMineableModel(), which honours the non-Microsoft
 * set that build-database supplies from the extract manifest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import { clearAutoDetectedModels } from '../../src/utils/modelClassifier';

let tmpDir: string;
const originalCustomModels = process.env.CUSTOM_MODELS;
const originalPrefix = process.env.EXTENSION_PREFIX;
const originalModelName = process.env.D365FO_MODEL_NAME;

/** A table whose properties the miner would record: label, table group, index presence. */
async function writeTable(root: string, model: string, name: string): Promise<void> {
  const dir = path.join(root, model, 'tables');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify({
    name,
    label: `${name} label`,
    tableGroup: 'Main',
    primaryIndex: 'RecIdIdx',
    fields: [{ name: 'AccountNum', extendedDataType: 'CustAccount' }],
  }));
}

/** A form with a Design pattern node — the second miner. */
async function writeForm(root: string, model: string, name: string, pattern: string): Promise<void> {
  const dir = path.join(root, model, 'forms');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify({
    name,
    patternNodes: [{ nodePath: 'Design', pattern, patternVersion: '1.1', childSequence: [] }],
  }));
}

function statCount(index: XppSymbolIndex, nodeType: string, property: string, model: string): number {
  const row = index.getReadDb().prepare(
    'SELECT COALESCE(SUM(count), 0) AS n FROM property_stats WHERE node_type = ? AND property = ? AND model = ?',
  ).get(nodeType, property, model) as { n: number };
  return row.n;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stats-gate-'));
  // The gate must not depend on ambient env — build-database on UDE has none of these set.
  delete process.env.CUSTOM_MODELS;
  delete process.env.EXTENSION_PREFIX;
  delete process.env.D365FO_MODEL_NAME;
  clearAutoDetectedModels();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const [k, v] of [
    ['CUSTOM_MODELS', originalCustomModels],
    ['EXTENSION_PREFIX', originalPrefix],
    ['D365FO_MODEL_NAME', originalModelName],
  ] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  clearAutoDetectedModels();
});

describe('table property stats', () => {
  it('mines a Microsoft model', async () => {
    await writeTable(tmpDir, 'ApplicationSuite', 'CustTable');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxTable', 'TableGroup', 'ApplicationSuite')).toBe(1);
    index.close?.();
  });

  it('REGRESSION: skips a model the caller declared non-Microsoft, with CUSTOM_MODELS empty', async () => {
    // The UDE shape: nothing in the environment marks ContosoRobotics as ours, so
    // isStandardModel() says "standard" — only the extract manifest knows better.
    await writeTable(tmpDir, 'ContosoRobotics', 'ConRoboTable');
    await writeTable(tmpDir, 'ApplicationSuite', 'CustTable');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.setNonMicrosoftModels(['ContosoRobotics']);
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxTable', 'TableGroup', 'ContosoRobotics')).toBe(0);
    expect(statCount(index, 'AxTable', 'TableGroup', 'ApplicationSuite')).toBe(1);
    index.close?.();
  });

  it('excludes third-party ISV models too, not just our own', async () => {
    await writeTable(tmpDir, 'SomeIsvSolution', 'IsvTable');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.setNonMicrosoftModels(['ContosoRobotics', 'SomeIsvSolution']);
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxTable', 'TableGroup', 'SomeIsvSolution')).toBe(0);
    index.close?.();
  });

  it('the declared set is matched case-insensitively', async () => {
    await writeTable(tmpDir, 'ContosoRobotics', 'ConRoboTable');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.setNonMicrosoftModels(['contosorobotics']);
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxTable', 'TableGroup', 'ContosoRobotics')).toBe(0);
    index.close?.();
  });

  it('CUSTOM_MODELS still excludes a model when no set was declared', async () => {
    process.env.CUSTOM_MODELS = 'ContosoRobotics';
    await writeTable(tmpDir, 'ContosoRobotics', 'ConRoboTable');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxTable', 'TableGroup', 'ContosoRobotics')).toBe(0);
    index.close?.();
  });
});

describe('AxFormDesign pattern stats', () => {
  it('mines a Microsoft model', async () => {
    await writeForm(tmpDir, 'ApplicationSuite', 'CustTableListPage', 'ListPage');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxFormDesign', 'Pattern', 'ApplicationSuite')).toBe(1);
    index.close?.();
  });

  it('REGRESSION: skips a declared non-Microsoft model (this miner had no gate at all)', async () => {
    await writeForm(tmpDir, 'ContosoRobotics', 'ConRoboForm', 'SimpleList');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.setNonMicrosoftModels(['ContosoRobotics']);
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxFormDesign', 'Pattern', 'ContosoRobotics')).toBe(0);
    index.close?.();
  });

  it('REGRESSION: skips a CUSTOM_MODELS model on a traditional environment', async () => {
    // Not UDE-specific: before the fix, any environment with custom forms skewed the
    // mined pattern distribution that generateSmartForm falls back to.
    process.env.CUSTOM_MODELS = 'ContosoRobotics';
    await writeForm(tmpDir, 'ContosoRobotics', 'ConRoboForm', 'SimpleList');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxFormDesign', 'Pattern', 'ContosoRobotics')).toBe(0);
    index.close?.();
  });

  it('form_patterns rows are still recorded for excluded models', async () => {
    // The gate is about the STATS corpus only — per-model pattern facts stay queryable,
    // otherwise form_info/cross-checks would lose sight of custom forms entirely.
    await writeForm(tmpDir, 'ContosoRobotics', 'ConRoboForm', 'SimpleList');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.setNonMicrosoftModels(['ContosoRobotics']);
    await index.indexMetadataDirectory(tmpDir);

    const row = index.getReadDb().prepare(
      'SELECT COUNT(*) AS n FROM form_patterns WHERE model = ?',
    ).get('ContosoRobotics') as { n: number };
    expect(row.n).toBe(1);
    index.close?.();
  });
});

describe('setNonMicrosoftModels semantics', () => {
  it('an empty declaration leaves isStandardModel() in charge', async () => {
    process.env.CUSTOM_MODELS = 'ContosoRobotics';
    await writeTable(tmpDir, 'ContosoRobotics', 'ConRoboTable');
    await writeTable(tmpDir, 'ApplicationSuite', 'CustTable');

    const index = new XppSymbolIndex(':memory:', ':memory:');
    index.setNonMicrosoftModels([]);
    await index.indexMetadataDirectory(tmpDir);

    expect(statCount(index, 'AxTable', 'TableGroup', 'ContosoRobotics')).toBe(0);
    expect(statCount(index, 'AxTable', 'TableGroup', 'ApplicationSuite')).toBe(1);
    index.close?.();
  });
});
