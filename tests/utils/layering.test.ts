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

  it('generators do not import the big write tools', () => {
    // generateSmartForm imported findBaseFormXml from the 5,600-line modify TOOL
    // just to read a form's XML. That is a generator reaching into a writer, and
    // it is one of the edges that kept modifyD365File growing; the locator now
    // lives in src/utils/baseObjectXml.ts, which anything may import.
    //
    // Two stay allowed on purpose, and neither is a write TOOL:
    //   writeAnchorGuard   — a 93-line GUARD (may this scaffold write here at
    //     all?). A generator that could not ask it would re-implement the
    //     refusal or skip it.
    //   inlineIndexUpsert  — the shared post-write step that tells the symbol
    //     index about a file just written. A generator that writes an object and
    //     skips it leaves that object invisible to the untyped `search` that now
    //     answers from the index.
    const ALLOWED = ['writeAnchorGuard', 'inlineIndexUpsert'];
    const offenders: string[] = [];
    for (const file of globSync('src/tools/smart/**/*.ts')) {
      for (const spec of importsOf(file)) {
        if (!spec.includes('../write/')) continue;
        if (ALLOWED.some(a => spec.includes(a))) continue;
        offenders.push(`${file.replace(/\\/g, '/')} → ${spec}`);
      }
    }
    expect(offenders, 'a generator is importing a write tool').toEqual([]);
  });

  it('records the two upward edges that are deliberate', () => {
    // Neither is a cycle and neither drags a tool into a lower layer, but both
    // point up, so they are pinned rather than left to multiply silently:
    //   utils/provenanceStore  → server/serverMode  (SERVER_MODE, a startup
    //     constant that happens to be declared with the mode logic)
    //   tools/specs/opSpecs    → server/toolSchemas (reads the PUBLISHED tool
    //     definition to render its op-spec index — the schema is the contract
    //     it documents, so this one is by design)
    // If a third appears, decide deliberately instead of discovering it in the
    // next audit.
    const upward: string[] = [];
    for (const file of [...globSync('src/utils/**/*.ts'), ...globSync('src/tools/specs/**/*.ts')]) {
      for (const spec of importsOf(file)) {
        if (/(\.\.\/)+server\//.test(spec)) upward.push(`${file.replace(/\\/g, '/')} → ${spec}`);
      }
    }
    expect(upward.sort()).toEqual([
      'src/tools/specs/opSpecs.ts → ../../server/toolSchemas/d365foFile.js',
      'src/utils/provenanceStore.ts → ../server/serverMode.js',
    ]);
  });

  it('the write tool dispatches rather than holding every writer', () => {
    // 5,645 lines and +44% between two audits: the argument schema, a 62-arm
    // operation switch, the disk locators AND fifteen direct-XML writers in one
    // file. The writers moved to directXmlWriters.ts; this keeps the split from
    // silently undoing itself. Raise it only with a reason, the way the schema
    // budget is raised.
    const src = readFileSync('src/tools/write/modifyD365File.ts', 'utf8');
    expect(src.split('\n').length).toBeLessThan(4600);
  });

  it('the dispatcher routes rather than implementing', () => {
    // get_workspace_info was ~320 lines inline in the switch, which made the
    // router the largest single tool implementation in the codebase.
    const src = readFileSync('src/tools/toolHandler.ts', 'utf8');
    expect(src.split('\n').length).toBeLessThan(500);
  });
});
