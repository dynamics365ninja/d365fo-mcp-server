/**
 * Layer direction, pinned.
 *
 * `src/tools/` is the MCP surface: it may reach down into `src/utils/`,
 * `src/workspace/`, `src/bridge/` and `src/metadata/`. Those may not reach back
 * up. The audit found the rule broken in two places, and both cost more than
 * tidiness:
 *
 *  - `utils/smartXmlBuilder.ts` imported `decodeXmlEntitiesFromXppSource` from
 *    `tools/modifyD365File.ts`, so an XML builder pulled a whole write tool in
 *    behind it — a three-module cycle running the wrong way across the boundary.
 *  - `createD365File.ts` and `modifyD365File.ts`, the two largest files in the
 *    codebase, imported each other directly.
 *
 * A cycle is not a style question here: it decides what a module drags into the
 * bundle, and it is why four read-only tools were loading the write path just to
 * ask where a file lives.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { globSync } from 'fs';
import path from 'path';

/** Every import specifier in a file, in source order. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
}

const LOWER_LAYERS = ['src/utils', 'src/workspace', 'src/bridge', 'src/metadata', 'src/database'];

describe('layer direction', () => {
  it('nothing below src/tools imports from src/tools', () => {
    const offenders: string[] = [];
    for (const layer of LOWER_LAYERS) {
      for (const file of globSync(`${layer}/**/*.ts`)) {
        for (const spec of importsOf(file)) {
          if (spec.includes('../tools') || spec.includes('/src/tools/')) {
            offenders.push(`${file.replace(/\\/g, '/')} → ${spec}`);
          }
        }
      }
    }
    expect(offenders, `imports pointing up into src/tools:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the two biggest write tools do not import each other', () => {
    const create = importsOf('src/tools/write/createD365File.ts');
    const modify = importsOf('src/tools/write/modifyD365File.ts');

    expect(create.filter(s => s.includes('modifyD365File'))).toEqual([]);
    expect(modify.filter(s => s.includes('createD365File'))).toEqual([]);
  });

  it('read-only object readers do not import the write tools', () => {
    // tableInfo/enumInfo/queryInfo/viewInfo each imported findD365FileOnDisk from
    // modifyD365File, so reading a table loaded the whole write path.
    for (const reader of ['tableInfo', 'enumInfo', 'queryInfo', 'viewInfo']) {
      const specs = importsOf(path.join('src/tools/readers', `${reader}.ts`));
      expect(
        specs.filter(s => /modifyD365File|createD365File/.test(s)),
        `${reader} still imports a write tool`,
      ).toEqual([]);
    }
  });

  it('the dispatcher routes rather than implementing', () => {
    // get_workspace_info was ~320 lines inline in the switch, which made the
    // router the largest single tool implementation in the codebase.
    const src = readFileSync('src/tools/toolHandler.ts', 'utf8');
    expect(src.split('\n').length).toBeLessThan(500);
  });
});
