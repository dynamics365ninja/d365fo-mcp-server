/**
 * object_patterns(domain="form", action="repair") — repairFormControls.ts had no
 * direct coverage.
 *
 * This is the one form tool that REWRITES a caller's XML and hands it back with
 * "write this". Two failure shapes matter and neither shows up in a build:
 *  • it silently drops or mangles a control the caller already had, and the
 *    reviewer approves the diff because the added controls look right;
 *  • it reports success on a form it did not actually understand (no <Pattern>,
 *    unknown pattern, not an AxForm) instead of saying so.
 *
 * It also must not write to disk — the contract is explicitly "returns the XML,
 * you write it" — so a regression that starts writing is worth catching here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, default: { ...actual }, readFile: vi.fn(), writeFile: vi.fn() };
});

import * as fs from 'fs/promises';
import { repairFormControlsTool } from '../../src/tools/xml/repairFormControls';
import type { XppServerContext } from '../../src/types/context';

/** SimpleList declares ActionPane (required) + Grid (required); this has neither. */
const BARE_SIMPLE_LIST = `<?xml version="1.0" encoding="utf-8"?>
<AxForm xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>MyGroupForm</Name>
  <DataSources>
    <AxFormDataSource>
      <Name>MyGroupTable</Name>
      <Table>MyGroupTable</Table>
    </AxFormDataSource>
  </DataSources>
  <Design>
    <Pattern>SimpleList</Pattern>
    <PatternVersion>1.1</PatternVersion>
    <Style>SimpleList</Style>
    <Controls>
      <AxFormControl xmlns=""
          i:type="AxFormStaticTextControl">
        <Name>MyExistingMarker</Name>
        <Type>StaticText</Type>
        <Text>keep me verbatim</Text>
      </AxFormControl>
    </Controls>
  </Design>
</AxForm>`;

function ctx(fields: string[] = []): XppServerContext {
  const db = {
    prepare: () => ({
      get: () => undefined,
      all: () => fields.map(name => ({ name })),
    }),
  };
  return { symbolIndex: { getReadDb: () => db } } as unknown as XppServerContext;
}

const req = (args: Record<string, unknown>) =>
  ({ params: { name: 'object_patterns', arguments: args } }) as never;

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

describe('repairFormControlsTool', () => {
  beforeEach(() => {
    vi.mocked(fs.readFile).mockReset();
    vi.mocked(fs.writeFile).mockReset();
  });

  describe('input handling', () => {
    it('requires one of xml / formName / filePath', async () => {
      const r = await repairFormControlsTool(req({}), ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('Provide one of: xml, formName, or filePath');
    });

    it('reads from filePath when given', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(BARE_SIMPLE_LIST as never);
      const r = await repairFormControlsTool(req({ filePath: 'K:\\x\\MyGroupForm.xml' }), ctx());
      expect(fs.readFile).toHaveBeenCalledWith('K:\\x\\MyGroupForm.xml', 'utf-8');
      expect(textOf(r)).toContain('K:\\x\\MyGroupForm.xml');
    });

    it('surfaces a read failure rather than reporting an empty form', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('EACCES') as never);
      const r = await repairFormControlsTool(req({ filePath: 'K:\\x.xml' }), ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('Could not read form XML');
      expect(textOf(r)).toContain('EACCES');
    });

    it('tells the caller to pass a path when the form is not indexed', async () => {
      const r = await repairFormControlsTool(req({ formName: 'NotIndexed' }), ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('not found in the symbol index');
      expect(textOf(r)).toContain('Pass filePath or xml directly');
    });
  });

  describe('refuses to guess', () => {
    it('rejects a document that is not an AxForm', async () => {
      const r = await repairFormControlsTool(req({ xml: '<AxTable><Name>X</Name></AxTable>' }), ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('Not an AxForm document');
    });

    it('reports malformed XML as a parse error', async () => {
      const r = await repairFormControlsTool(req({ xml: '<AxForm><Design></AxForm>' }), ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('XML parse error');
    });

    it('does nothing (and says why) when the form declares no pattern', async () => {
      const noPattern = BARE_SIMPLE_LIST
        .replace('<Pattern>SimpleList</Pattern>\n    ', '')
        .replace('<PatternVersion>1.1</PatternVersion>\n    ', '');
      const r = await repairFormControlsTool(req({ xml: noPattern }), ctx());
      // Informational, not an error: there is nothing wrong, just nothing to do.
      expect(r.isError).toBeUndefined();
      expect(textOf(r)).toContain('declares no <Pattern>');
      expect(textOf(r)).toContain('action="analyze"');
    });

    it('refuses an unknown pattern instead of picking a nearby one', async () => {
      const bogus = BARE_SIMPLE_LIST.replace('<Pattern>SimpleList</Pattern>', '<Pattern>NotARealPattern</Pattern>');
      const r = await repairFormControlsTool(req({ xml: bogus }), ctx());
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('unknown pattern "NotARealPattern"');
    });
  });

  describe('repair', () => {
    it('adds the missing required top-level controls and reports each one', async () => {
      const r = await repairFormControlsTool(req({ xml: BARE_SIMPLE_LIST }), ctx(['GroupId', 'Name']));
      const out = textOf(r);
      expect(out).toContain('Repaired **SimpleList** form');
      expect(out).toMatch(/Added \d+ required control\(s\)/);
      expect(out).toContain('ActionPane');
      expect(out).toContain('Grid');
    });

    it('preserves the caller\'s existing controls verbatim', async () => {
      // The whole point of repair-vs-regenerate: a hand-written control must
      // survive byte-for-byte, or the reviewer silently loses work.
      const out = textOf(await repairFormControlsTool(req({ xml: BARE_SIMPLE_LIST }), ctx()));
      expect(out).toContain('MyExistingMarker');
      expect(out).toContain('keep me verbatim');
    });

    it('returns the repaired XML in a fenced block and points at the write call', async () => {
      const out = textOf(await repairFormControlsTool(req({ xml: BARE_SIMPLE_LIST }), ctx()));
      expect(out).toContain('```xml');
      expect(out).toContain('<AxForm');
      expect(out).toContain('d365fo_file(action="create"');
      expect(out).toContain('overwrite=true');
    });

    it('NEVER writes to disk — the caller reviews and writes', async () => {
      await repairFormControlsTool(req({ xml: BARE_SIMPLE_LIST }), ctx());
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('reports "nothing to repair" when every required control is present', async () => {
      // Repair the bare form, then feed its own output back in: the second pass
      // must be a no-op. A repair that is not idempotent would keep appending.
      const first = textOf(await repairFormControlsTool(req({ xml: BARE_SIMPLE_LIST }), ctx()));
      const repaired = first.slice(first.indexOf('```xml') + 6, first.lastIndexOf('```')).trim();

      const second = await repairFormControlsTool(req({ xml: repaired }), ctx());
      expect(textOf(second)).toContain('no missing required top-level controls');
      expect(textOf(second)).not.toContain('Added');
    });

    it('survives an unavailable symbol index (grids come back empty, not crashed)', async () => {
      const brokenCtx = {
        symbolIndex: {
          getReadDb: () => ({ prepare: () => { throw new Error('DB closed'); } }),
        },
      } as unknown as XppServerContext;
      const r = await repairFormControlsTool(req({ xml: BARE_SIMPLE_LIST }), brokenCtx);
      expect(textOf(r)).toContain('Repaired **SimpleList** form');
    });
  });
});
