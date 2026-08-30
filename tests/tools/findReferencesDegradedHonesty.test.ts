/**
 * With the xref bridge down, find_references must not sound authoritative.
 *
 * Reported on the VM during eval case L3-legacy-workexecutedisplay-extend. The
 * tool answered `Total References Found: 0` + `- Symbol might be unused` for
 * `buildAdjustIn`, which `WHSWorkExecuteDisplayAdjustIn.displayForm` calls twice.
 * The agent believed it, and the case's scored requirement — "run find_references
 * FIRST and record what you found" — was answered with a confident falsehood.
 *
 * Root cause, confirmed against the production index: `source_snippet` is a
 * PREVIEW of a method's first ten lines (xmlParser.ts / enhancedParser.ts), and
 * the fallback matches call sites against those previews. `displayForm` runs to
 * hundreds of lines, so its calls sit far outside the indexed text. The one "hit"
 * the tool did report elsewhere was a method's own declaration — which does sit in
 * its own first ten lines.
 *
 * Two things are pinned here: the zero must describe its own blind spot instead
 * of concluding "unused", and an intra-type call below line ten must be recovered
 * by reading the declaring type's source.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { findReferencesTool } from '../../src/tools/analysis/findReferences';

let dir: string;
let classFile: string;

/** A caller whose call site sits well past the ten lines the index previews. */
const CLASS_SOURCE = `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>WHSWorkExecuteDisplayAdjustIn</Name>
  <SourceCode>
    <Methods>
      <Method>
        <Name>displayForm</Name>
        <Source><![CDATA[
    public container displayForm(container _con, str _buttonClicked)
    {
        // line 1 of padding
        // line 2 of padding
        // line 3 of padding
        // line 4 of padding
        // line 5 of padding
        // line 6 of padding
        // line 7 of padding
        // line 8 of padding
        // line 9 of padding
        // line 10 of padding
        // line 11 of padding
        // line 12 of padding
        ret = this.buildAdjustIn(_con);
        return ret;
    }
]]></Source>
      </Method>
    </Methods>
  </SourceCode>
</AxClass>
`;

/**
 * Index stub: the rows find_references reads, with a source_snippet that is a
 * ten-line PREVIEW — the shape the real indexer stores, and the reason the scan
 * alone finds nothing.
 */
function stubIndex(rows: Array<{ name: string; parent_name: string; file_path: string; source_snippet: string }>) {
  const db = {
    prepare: (sql: string) => ({
      all: (...params: any[]) => {
        if (/DISTINCT parent_name/.test(sql)) {
          return rows
            .filter(r => r.name === params[0])
            .map(r => ({ parent_name: r.parent_name, file_path: r.file_path }));
        }
        // The FTS path: previews only, so nothing matches the deep call site.
        return [];
      },
      get: () => undefined,
    }),
  };
  return {
    getReadDb: () => db,
    searchLabels: () => [],
  } as any;
}

const call = (args: Record<string, unknown>, index: any) =>
  findReferencesTool(
    { method: 'tools/call', params: { name: 'find_references', arguments: args } } as any,
    // No bridge → the degraded path is the one under test.
    { symbolIndex: index, bridge: undefined } as any,
  );

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'findrefs-'));
  classFile = path.join(dir, 'WHSWorkExecuteDisplayAdjustIn.xml');
  await fsp.writeFile(classFile, CLASS_SOURCE, 'utf-8');
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('find_references with the xref bridge unavailable', () => {
  it('recovers an intra-type call the ten-line preview cannot show', async () => {
    const index = stubIndex([
      {
        name: 'buildAdjustIn',
        parent_name: 'WHSWorkExecuteDisplayAdjustIn',
        file_path: classFile,
        source_snippet: 'protected container buildAdjustIn(container _con)\n{\n}\n',
      },
    ]);

    const text = textOf(await call(
      { targetName: 'buildAdjustIn', targetType: 'method', includeContext: true }, index,
    ));

    expect(text).toContain('this.buildAdjustIn(');
    expect(text).toContain('WHSWorkExecuteDisplayAdjustIn');
    expect(text).not.toMatch(/Total References Found:\*\* 0/);
    // It must say where the extra hits came from, since they did not come from
    // the scan the Source line names.
    expect(text).toMatch(/declaring type's source directly/i);
  });

  it('never concludes "unused" from a degraded zero', async () => {
    const index = stubIndex([]);

    const text = textOf(await call({ targetName: 'neverCalledAnywhere', targetType: 'method' }, index));

    expect(text).not.toMatch(/might be unused/i);
    expect(text).toMatch(/not evidence/i);
    // The blind spot must be named, not hinted at.
    expect(text).toMatch(/FIRST TEN LINES/i);
    expect(text).toMatch(/DYNAMICSXREFDB/);
  });

  it('says so when ownerName could not be honoured, instead of implying it was', async () => {
    const index = stubIndex([]);

    const text = textOf(await call(
      { targetName: 'processWorkLine', targetType: 'method', ownerName: 'WHSWorkExecuteDisplay' },
      index,
    ));

    expect(text).toMatch(/could NOT be honoured/i);
  });
});
