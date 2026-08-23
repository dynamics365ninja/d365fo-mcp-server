/**
 * Case-catalog integrity gate (VM-free).
 *
 * The catalog under eval/cases/ had a JSON Schema (eval/cases/schema.json) and no
 * enforcement of it, so three classes of drift accumulated silently and were only
 * found by a hand audit (2026-08-23):
 *
 *  1. **Dead tool names in instructions.** `get_method` and `suggest_edt` were
 *     unpublished when their contracts moved into `get_object_info` options and
 *     `prepare` (src/tools/toolHandler.ts keeps the routes alive only as a
 *     recovery hint); `get_form_info` / `get_label_info` / `find_object` never
 *     existed at all under those names. 15 case instructions still told the
 *     implementer to reach for them — i.e. the case was scoring the agent against
 *     a tool path the published tool list cannot even describe.
 *  2. **target_artifact_types under-declaring the golden.** Seven cases listed
 *     fewer artifacts than their own committed golden folder contains
 *     (L2-form-over-view omitted an entire AxQuery), so the spec no longer said
 *     what the case produces.
 *  3. **golden_pending drift.** The flag is what exempts a case from counting as
 *     proof in COVERAGE.md; nothing checked it against the presence of a golden.
 *
 * Every assertion below is derived from a live source (the published tool
 * schemas, the golden folders, the schema file), never from a hand-kept list, so
 * a renamed tool or a re-captured golden fails here instead of rotting.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { toolSchemas } from '../../src/server/toolSchemas/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CASES_DIR = path.join(REPO_ROOT, 'eval', 'cases');

interface CaseSpec {
  id: string;
  title: string;
  tier: number;
  instruction: string;
  target_artifact_types: string[];
  golden_path: string;
  systest?: string;
  golden_pending?: boolean;
  systest_pending?: boolean;
  ignore?: string[];
  tags?: string[];
  split?: 'train' | 'holdout';
}

const SCHEMA = JSON.parse(fs.readFileSync(path.join(CASES_DIR, 'schema.json'), 'utf8'));

const caseFiles = fs
  .readdirSync(CASES_DIR)
  .filter(f => f.endsWith('.json') && f !== 'schema.json')
  .sort();

const cases: Array<{ file: string; spec: CaseSpec }> = caseFiles.map(file => ({
  file,
  spec: JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8')) as CaseSpec,
}));

/** Absolute path of a case's golden folder, with the trailing slash the specs carry. */
function goldenDir(spec: CaseSpec): string {
  return path.join(REPO_ROOT, spec.golden_path.replace(/\/+$/, ''));
}

/** The `*.metadata.xml` artifacts committed for a case (empty when the folder is absent). */
function goldenArtifacts(spec: CaseSpec): string[] {
  const dir = goldenDir(spec);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.metadata.xml')).sort();
}

/**
 * A few AOT kinds serialize under a root element that is not the folder/type name.
 * A BP-suppression list lives in `AxIgnoreDiagnosticList/` but its root element is
 * `<IgnoreDiagnostics>`, so the raw root cannot be compared to the declared type
 * without this mapping.
 */
const ROOT_ELEMENT_TO_AOT_TYPE: Record<string, string> = {
  IgnoreDiagnostics: 'AxIgnoreDiagnosticList',
};

/**
 * Declared AOT type of a golden artifact, reading past the provenance comment
 * header rather than stripping it. A one-pass `replace(/<!--...-->/g, '')` is the
 * incomplete-sanitisation shape CodeQL flags (a `<!--` inside a comment survives
 * it), and walking forward is the more direct way to say "first real element".
 */
function goldenRootElement(dir: string, file: string): string {
  const xml = fs.readFileSync(path.join(dir, file), 'utf8');
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    const root = /^<([A-Za-z][\w.]*)[\s>/]/.exec(xml.slice(lt, lt + 256))?.[1];
    if (root) return ROOT_ELEMENT_TO_AOT_TYPE[root] ?? root;
    i = lt + 1;
  }
  return '(none)';
}

describe('eval case catalog — schema conformance', () => {
  it('there is a catalog to check', () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  it.each(cases.map(c => [c.file, c] as const))('%s conforms to cases/schema.json', (_f, { spec }) => {
    const props = SCHEMA.properties as Record<string, { type?: string; enum?: string[]; pattern?: string }>;

    for (const key of SCHEMA.required as string[]) {
      expect(spec, `missing required key "${key}"`).toHaveProperty(key);
    }
    // additionalProperties: false — an unknown key is a typo that silently does nothing.
    for (const key of Object.keys(spec)) {
      expect(Object.keys(props), `unknown key "${key}"`).toContain(key);
    }
    for (const [key, value] of Object.entries(spec)) {
      const def = props[key];
      const kind = Array.isArray(value) ? 'array' : typeof value;
      const expected = def.type === 'integer' ? 'number' : def.type;
      if (expected) expect(kind, `"${key}" should be ${def.type}`).toBe(expected);
      if (def.enum) expect(def.enum, `"${key}" value`).toContain(value);
      if (def.pattern) expect(String(value)).toMatch(new RegExp(def.pattern));
    }
  });

  it.each(cases.map(c => [c.file, c] as const))('%s: id, filename and tier agree', (file, { spec }) => {
    expect(`${spec.id}.json`).toBe(file);
    expect(spec.tier).toBe(Number(spec.id[1]));
  });
});

describe('eval case catalog — golden and SysTest wiring', () => {
  it.each(cases.map(c => [c.id, c.spec] as const))(
    '%s: golden folder state matches golden_pending',
    (_id, spec) => {
      const artifacts = goldenArtifacts(spec);
      if (spec.golden_pending) {
        // A pending case must not already carry a golden — the flag is what keeps it
        // out of the coverage numerator, so a captured-but-still-pending case
        // under-reports coverage and never gets its flag flipped.
        expect(artifacts, 'golden_pending case already has a captured golden').toEqual([]);
      } else {
        expect(fs.existsSync(goldenDir(spec)), `missing golden folder ${spec.golden_path}`).toBe(true);
        expect(artifacts.length, 'golden folder has no *.metadata.xml').toBeGreaterThan(0);
      }
    },
  );

  it.each(cases.filter(c => !c.spec.golden_pending).map(c => [c.id, c.spec] as const))(
    '%s: target_artifact_types matches what the golden actually contains',
    (_id, spec) => {
      const dir = goldenDir(spec);
      const actual = goldenArtifacts(spec).map(f => goldenRootElement(dir, f)).sort();
      expect([...spec.target_artifact_types].sort()).toEqual(actual);
    },
  );

  it.each(cases.filter(c => c.spec.systest).map(c => [c.id, c.spec] as const))(
    '%s: the declared SysTest file exists',
    (_id, spec) => {
      expect(fs.existsSync(path.join(REPO_ROOT, spec.systest as string))).toBe(true);
    },
  );

  it('every committed golden folder belongs to a case', () => {
    const owned = new Set(cases.map(c => path.basename(c.spec.golden_path.replace(/\/+$/, ''))));
    const orphans = fs
      .readdirSync(path.join(REPO_ROOT, 'eval', 'goldens'))
      .filter(d => !owned.has(d));
    expect(orphans).toEqual([]);
  });
});

describe('eval case catalog — instructions name only published tools', () => {
  const published = new Set(toolSchemas.map(t => t.name));

  /**
   * Names an instruction may spell as `name(` without them being MCP tools: X++
   * members the case asks the agent to write. Only tool-shaped snake_case tokens
   * are checked, which excludes X++ camelCase/PascalCase members by construction.
   */
  const TOOL_SHAPED = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g;

  it('the published tool list is what this gate checks against', () => {
    // Guards the gate itself: an empty/renamed export would make every case pass.
    expect(published.has('get_object_info')).toBe(true);
    expect(published.has('d365fo_file')).toBe(true);
    expect(published.size).toBeGreaterThan(15);
  });

  it.each(cases.map(c => [c.id, c.spec] as const))('%s names no unpublished tool', (_id, spec) => {
    const hay = `${spec.title}\n${spec.instruction}`;
    const named = new Set<string>();
    for (const m of hay.matchAll(TOOL_SHAPED)) named.add(m[1]);
    const unknown = [...named].filter(n => !published.has(n));
    expect(
      unknown,
      'instruction points the implementer at a tool the published tool list does not contain',
    ).toEqual([]);
  });

  /**
   * `get_method` and `suggest_edt` still ROUTE (toolHandler.ts keeps them as a
   * recovery path for an agent holding a stale name) but are not published, so a
   * case must never send the implementer to them. Checked by name because the
   * generic gate above cannot tell "routed but unpublished" from "never existed".
   */
  it.each(cases.map(c => [c.id, c.spec] as const))(
    '%s does not steer to an unpublished legacy tool',
    (_id, spec) => {
      const hay = `${spec.title}\n${spec.instruction}`;
      for (const legacy of ['get_method', 'suggest_edt', 'get_form_info', 'get_label_info', 'find_object']) {
        expect(hay, `mentions the unpublished "${legacy}"`).not.toContain(legacy);
      }
    },
  );
});
