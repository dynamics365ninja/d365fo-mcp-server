/**
 * A label file id that cannot appear in `@FileId:LabelId` must never be written to.
 *
 * Found on the VM during eval case L3-processguide-flow-slice. The sandbox model
 * is called `fm-mcp`, so its label file id is `fm-mcp`. `labels(action="create")`
 * accepted it, wrote the label into every language file, reported SUCCESS, and
 * advertised `literalStr("@fm-mcp:ScanContainer")` — a reference nothing can
 * resolve, because the hyphen ends the identifier. Two independent witnesses
 * agreed the write was useless: `labels(action="info")` could not find the label
 * it had just created, and xppbp raised
 *   BPErrorLabelIsText: '@fm-mcp:ScanContainer' is not a label ID
 *
 * The charset was never in doubt — `parseLabelReference` has always refused to
 * parse `@fm-mcp:X`. The read side and the write side simply disagreed, and the
 * write side won silently. A refusal that names the id that WOULD work costs one
 * round trip; a success that yields an unreferenceable label costs a build.
 */

import { describe, it, expect } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  isValidLabelFileId,
  suggestLabelFileId,
  parseLabelReference,
} from '../../src/utils/labelReference';
import {
  CreateLabelArgsSchema,
  createLabelTool,
  pickOriginalLabelFileId,
  resolveOrCreateLabelRef,
} from '../../src/tools/write/createLabel';

/**
 * The ACCEPT side is asserted against the schema, never through createLabelTool:
 * a valid id makes the tool do its real job and write .label.txt files into the
 * live model. An earlier draft of this file called the tool with a good id and
 * left an `fmmcp` label file behind in the VM sandbox, which a concurrent eval
 * run then had to reason about. Only the REFUSE side is safe to drive
 * end-to-end — it returns before touching disk.
 */
const accepts = (args: Record<string, unknown>): boolean =>
  CreateLabelArgsSchema.safeParse(args).success;

const call = (args: Record<string, unknown>) =>
  createLabelTool(
    { method: 'tools/call', params: { name: 'labels', arguments: args } } as CallToolRequest,
    {} as any,
  );

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

const validArgs = (labelFileId: string) => ({
  labelId: 'ScanContainer',
  labelFileId,
  model: 'fm-mcp',
  translations: [{ language: 'en-US', text: 'Scan container' }],
});

/** Minimal index stub: only the label-file listing the picker reads. */
const indexWithFiles = (labelFiles: string[]): any => ({
  getLabelFileIds: () => labelFiles.map(labelFileId => ({ labelFileId })),
});

describe('isValidLabelFileId', () => {
  it('accepts what parseLabelReference can read back', () => {
    for (const id of ['ContosoExt', 'SYS', 'fmmcp', 'My_Labels', 'A1']) {
      expect(isValidLabelFileId(id), id).toBe(true);
      expect(parseLabelReference(`@${id}:SomeLabel`).labelFileId).toBe(id);
    }
  });

  it('rejects ids the reference syntax cannot carry', () => {
    for (const id of ['fm-mcp', 'my.labels', '1st', 'has space', '', undefined]) {
      expect(isValidLabelFileId(id as any), String(id)).toBe(false);
    }
    // The round-trip the product actually performs: the file half is not seen.
    expect(parseLabelReference('@fm-mcp:ScanContainer').labelFileId).toBeUndefined();
  });
});

describe('suggestLabelFileId', () => {
  it('offers the nearest usable id', () => {
    expect(suggestLabelFileId('fm-mcp')).toBe('fmmcp');
    expect(suggestLabelFileId('my.labels')).toBe('mylabels');
  });

  it('never suggests something invalid, even for a digit-leading id', () => {
    for (const id of ['fm-mcp', '1st', '2026-model', '...']) {
      expect(isValidLabelFileId(suggestLabelFileId(id)), id).toBe(true);
    }
  });
});

describe('labels(action="create") with an unreferenceable label file id', () => {
  it('refuses instead of writing a label nothing can reference', async () => {
    const result = await call(validArgs('fm-mcp'));

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('labelFileId');
    // It must name the id that works — the caller cannot guess the rule.
    expect(text).toContain('fmmcp');
    expect(text).toContain('@fm-mcp:');
  });

  it('still accepts a valid id', () => {
    expect(accepts(validArgs('fmmcp'))).toBe(true);
    expect(accepts(validArgs('ContosoExt'))).toBe(true);
  });

  it('rejects exactly the ids that cannot be referenced', () => {
    expect(accepts(validArgs('fm-mcp'))).toBe(false);
    expect(accepts(validArgs('my.labels'))).toBe(false);
    expect(accepts(validArgs('1st'))).toBe(false);
  });
});

describe('pickOriginalLabelFileId', () => {
  it('prefers a referenceable file over the one named after the model', () => {
    expect(pickOriginalLabelFileId('fm-mcp', indexWithFiles(['fm-mcp', 'fmmcp']))).toBe('fmmcp');
  });

  it('keeps the model-named file when it is referenceable', () => {
    expect(pickOriginalLabelFileId('ContosoExt', indexWithFiles(['ContosoExt', 'Other'])))
      .toBe('ContosoExt');
  });

  it('does not invent an id when every candidate is unreferenceable', () => {
    // Returning a sanitized id here would silently write into a label file the
    // caller never named; the callers refuse on isValidLabelFileId instead.
    expect(pickOriginalLabelFileId('fm-mcp', indexWithFiles(['fm-mcp']))).toBe('fm-mcp');
  });
});

describe('auto-labelling', () => {
  it('declines rather than handing back an unusable reference', async () => {
    const result = await resolveOrCreateLabelRef(
      { text: 'Scan container', what: 'Caption' } as any,
      { model: 'fm-mcp' } as any,
      indexWithFiles(['fm-mcp']),
    );
    expect(result).toBeNull();
  });
});
