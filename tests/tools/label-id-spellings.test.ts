/**
 * #888 — label ids were matched against the stored `Key=` token verbatim.
 *
 * `labelParser` stores that token as the file writes it, and the 27 legacy
 * AX-era label files (SYS SYP GLS GEE … WAX) write theirs WITH the sigil:
 * `@GLS4170035=Accountants`. On the reference environment that is 865k of the
 * 1.42M indexed rows, so:
 *   - `labels(action="info", labelId="GLS4170035")` reported "not found" for a
 *     label whose file it had just listed, and the message read as a claim
 *     about the label rather than about the key match;
 *   - `search` output — always a reference — was never valid `info` input;
 *   - `resolveXppReferences` looked up the regex capture group (`SYS12345`)
 *     against an index holding `@SYS12345`, so EVERY legacy label in X++ drew
 *     an unknown-label warning during write validation;
 *   - `<Label>@SYSnnnnn</Label>` in metadata XML matched no branch at all and
 *     went unverified.
 *
 * These run against a real XppSymbolIndex whose rows are inserted exactly as
 * the parser writes them — a mock that stores the bare id is what hid the
 * resolver bug in the first place.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { XppSymbolIndex } from '../../src/metadata/symbolIndex';
import {
  formatLabelReference,
  labelIdSpellings,
  parseLabelReference,
} from '../../src/utils/labelReference';
import { getLabelInfoTool } from '../../src/tools/readers/getLabelInfo';
import { resolveXppReferences } from '../../src/tools/write/resolveReferences';
import { validateCodeTool } from '../../src/tools/analysis/validateCode';

let index: XppSymbolIndex;
let tmpDir: string;
let glsPath: string;

beforeAll(async () => {
  index = new XppSymbolIndex(':memory:', ':memory:');

  // A real .label.txt for the legacy file, so the on-disk staleness check has
  // something to read (it is the half that the naive fix breaks).
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'labels-888-'));
  glsPath = path.join(tmpDir, 'GLS.en-us.label.txt');
  await fs.writeFile(glsPath, '﻿@GLS0=GLS label file.\n@GLS4170035=Accountants\n', 'utf-8');

  // Legacy files: key stored WITH '@'.
  index.addLabel({
    labelId: '@GLS4170035', labelFileId: 'GLS', model: 'ApplicationPlatform',
    language: 'en-US', text: 'Accountants', filePath: glsPath,
  });
  index.addLabel({
    labelId: '@SYS12345', labelFileId: 'SYS', model: 'ApplicationPlatform',
    language: 'en-US', text: 'Customer', filePath: path.join(tmpDir, 'SYS.en-us.label.txt'),
  });
  // Modern file: bare key.
  index.addLabel({
    labelId: 'EquipmentName', labelFileId: 'ContosoExt', model: 'ContosoExt',
    language: 'en-US', text: 'Equipment name', filePath: path.join(tmpDir, 'ContosoExt.en-US.label.txt'),
  });
});

afterAll(async () => {
  index?.close?.();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── the helper pair ──────────────────────────────────────────────────────────

describe('parseLabelReference — inverse of formatLabelReference', () => {
  it('splits the modern reference', () => {
    expect(parseLabelReference('@ContosoExt:EquipmentName'))
      .toEqual({ labelFileId: 'ContosoExt', labelId: 'EquipmentName' });
  });

  it('drops the sigil from the legacy form, naming no file', () => {
    expect(parseLabelReference('@GLS4170035')).toEqual({ labelId: 'GLS4170035' });
    expect(parseLabelReference('GLS4170035')).toEqual({ labelId: 'GLS4170035' });
  });

  it('keeps the id half of the doubled form the formatter repairs', () => {
    expect(parseLabelReference('@SYS:@SYS67433'))
      .toEqual({ labelFileId: 'SYS', labelId: '@SYS67433' });
  });

  it('round-trips whatever formatLabelReference emitted', () => {
    for (const [file, id] of [['GLS', '@GLS4170035'], ['ContosoExt', 'EquipmentName']] as const) {
      const parsed = parseLabelReference(formatLabelReference(file, id));
      expect(labelIdSpellings(parsed.labelId)).toContain(id);
    }
  });
});

describe('labelIdSpellings', () => {
  it('offers both storage spellings', () => {
    expect(labelIdSpellings('EquipmentName')).toEqual(['EquipmentName', '@EquipmentName']);
  });

  it('adds the upper-cased legacy form — every key in the 27 files is uppercase', () => {
    expect(labelIdSpellings('sys67433')).toContain('@SYS67433');
  });

  it('leaves a modern id\'s casing alone — it is the author\'s', () => {
    expect(labelIdSpellings('equipmentname')).not.toContain('EquipmentName');
  });
});

// ── the lookup ───────────────────────────────────────────────────────────────

describe('getLabelById accepts every spelling the server emits', () => {
  const ids = (id: string, file?: string, model?: string) =>
    index.getLabelById(id, file, model).map(r => r.labelId);

  it('bare legacy id, with the file+model filters that used to make it fail', () => {
    expect(ids('GLS4170035', 'GLS', 'ApplicationPlatform')).toEqual(['@GLS4170035']);
  });

  it('legacy id with sigil, and the @File:Id spelling of the same label', () => {
    expect(ids('@GLS4170035')).toEqual(['@GLS4170035']);
    expect(ids('@GLS:GLS4170035')).toEqual(['@GLS4170035']);
  });

  it('modern label by bare id and by reference — the form search prints', () => {
    expect(ids('EquipmentName')).toEqual(['EquipmentName']);
    expect(ids('@ContosoExt:EquipmentName')).toEqual(['EquipmentName']);
    expect(ids('@ContosoExt:EquipmentName', 'ContosoExt')).toEqual(['EquipmentName']);
  });

  it('legacy lookup is case-insensitive', () => {
    expect(ids('@sys12345')).toEqual(['@SYS12345']);
  });

  it('a contradicting file filter still narrows to nothing', () => {
    expect(ids('@ContosoExt:EquipmentName', 'SYS')).toEqual([]);
    expect(ids('GLS4170035', 'SYS')).toEqual([]);
  });

  it('returns the id EXACTLY as stored, not as asked', () => {
    expect(index.getLabelById('gls4170035')[0].labelId).toBe('@GLS4170035');
  });
});

// ── the tool ─────────────────────────────────────────────────────────────────

const info = (args: Record<string, unknown>) =>
  getLabelInfoTool(
    { method: 'tools/call', params: { name: 'get_label_info', arguments: args } } as any,
    { symbolIndex: index } as any,
  );
const textOf = (r: any) => r.content[0].text as string;

describe('labels(action="info") — the reported matrix', () => {
  it('resolves the bare legacy id with file+model supplied (the reported failure)', async () => {
    const r = await info({ labelId: 'GLS4170035', labelFileId: 'GLS', model: 'ApplicationPlatform' });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain('Accountants');
  });

  it('resolves the @File:Id form', async () => {
    const r = await info({ labelId: '@ContosoExt:EquipmentName', labelFileId: 'ContosoExt' });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain('Equipment name');
  });

  it('emits the canonical reference for a legacy label — never the doubled form', async () => {
    const text = textOf(await info({ labelId: 'GLS4170035' }));
    expect(text).toContain('@GLS4170035');
    expect(text).not.toContain(':@');
  });

  it('does not report a legacy label as missing from its file on disk', async () => {
    // The trap: the disk check must probe the STORED key. Probing the bare id
    // the lookup now accepts would condemn every label in the 27 legacy files.
    const text = textOf(await info({ labelId: 'GLS4170035' }));
    expect(text).not.toContain('NOT in its label file on disk');
  });

  it('says the KEY did not match, and does not assert the label is absent', async () => {
    const r = await info({ labelId: 'NoSuchLabel' });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain('No label matched the ID');
    expect(text).not.toContain('not found in label file');
    // The remediation must work from an ID, which is all the caller has.
    expect(text).toContain('labels(action="search", query="NoSuchLabel")');
  });
});

// ── the write-validation path ────────────────────────────────────────────────

describe('resolveXppReferences — legacy labels in X++', () => {
  const deps = () => ({
    db: index.getReadDb(),
    getLabelById: index.getLabelById.bind(index),
    getLabelFileIds: index.getLabelFileIds.bind(index),
  }) as any;

  it('does not warn about a legacy label that IS in the index', () => {
    const res = resolveXppReferences('info("@SYS12345");', deps());
    expect(res.violations).toEqual([]);
    expect(res.verifiedCount).toBeGreaterThan(0);
  });

  it('still warns about one that is not', () => {
    const res = resolveXppReferences('info("@SYS99999");', deps());
    expect(res.violations.map(v => v.kind)).toEqual(['unknown-label']);
  });

  it('verifies the modern reference too', () => {
    expect(resolveXppReferences('info("@ContosoExt:EquipmentName");', deps()).violations).toEqual([]);
  });
});

describe('validate_code references mode — <Label> coverage', () => {
  // Built per call, not at describe time: the index only exists after beforeAll,
  // and resolveXmlReferences answers "0 verified" for a context without one —
  // which reads exactly like a clean result.
  const validate = (xml: string) =>
    validateCodeTool(
      { params: { arguments: { mode: 'references', codeType: 'xml-table', code: xml } } } as any,
      { symbolIndex: index } as any,
    );
  const xmlWith = (label: string) =>
    `<?xml version="1.0"?><AxTable><Name>MyTable</Name><Label>${label}</Label></AxTable>`;

  it('flags a legacy label that is not in the index (was skipped entirely)', async () => {
    const text = textOf(await validate(xmlWith('@SYS99999')));
    expect(text).toContain('@SYS99999');
  });

  it('accepts a legacy label that is', async () => {
    const text = textOf(await validate(xmlWith('@SYS12345')));
    expect(text).not.toContain('@SYS12345 not found');
  });
});
