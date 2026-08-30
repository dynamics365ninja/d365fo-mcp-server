/**
 * Two questions the server used to leave unanswered: the raw XML of an object,
 * which callers went to the shell for, and where a slow write spent its time.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { renderObjectXml, objectXmlNotFound } from '../../src/tools/readers/objectXml';
import { createPhaseTimer } from '../../src/utils/phaseTimer';

const XML_LINES = Array.from({ length: 120 }, (_, i) => `\t<Line${i + 1}>value</Line${i + 1}>`);
const XML = `<?xml version="1.0" encoding="utf-8"?>\n<AxTable>\n${XML_LINES.join('\n')}\n</AxTable>`;

let root: string;
let file: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'objxml-'));
  file = path.join(root, 'MyTable.xml');
  await writeFile(file, `﻿${XML}`, 'utf-8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('get_object_info(include="xml")', () => {
  it('returns the file path and the content', async () => {
    const res = await renderObjectXml(file, 'table', 'MyTable');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('MyTable.xml');
    expect(res.text).toContain('<Line1>value</Line1>');
    expect(res.text).toContain('Lines:** 1-123 of 123');
  });

  it('strips the BOM so the first line is usable XML', async () => {
    const res = await renderObjectXml(file, 'table', 'MyTable');
    expect(res.text).toContain('```xml\n<?xml version');
  });

  it('pages by line range', async () => {
    const res = await renderObjectXml(file, 'table', 'MyTable', { startLine: 3, endLine: 5 });
    expect(res.text).toContain('Lines:** 3-5 of 123');
    expect(res.text).toContain('<Line2>');
    expect(res.text).not.toContain('<Line10>');
  });

  it('cuts at maxChars and says to page rather than raise it', async () => {
    const res = await renderObjectXml(file, 'table', 'MyTable', { maxChars: 200 });
    expect(res.text).toContain('✂️ Cut at 200 chars');
    expect(res.text).toContain('startLine');
  });

  it('reports an unreadable file instead of returning empty', async () => {
    const res = await renderObjectXml(path.join(root, 'gone.xml'), 'table', 'Gone');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('could not read it');
  });

  it('names modelName as the fix when nothing was located', () => {
    const res = objectXmlNotFound('table', 'NoSuchTable', 'MyModel');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no file on disk');
    expect(res.text).toContain('options.modelName');
  });
});

describe('phase timing on a slow write', () => {
  it('stays silent under the threshold', async () => {
    const t = createPhaseTimer();
    await t.time('quick', async () => undefined);
    expect(t.render(10_000)).toBe('');
  });

  it('names the phases, largest first, when the call was slow', () => {
    const t = createPhaseTimer();
    t.add('C# bridge Create()', 90_000);
    t.add('symbol index upsert', 2_000);
    t.add('write verification', 300);
    const out = t.render(10_000);
    expect(out).toContain('⏱️ This call took');
    const order = ['C# bridge Create()', 'symbol index upsert', 'write verification']
      .map(name => out.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('accounts for time no phase claimed', () => {
    vi.useFakeTimers();
    try {
      const t = createPhaseTimer();
      t.add('measured', 1_000);
      vi.advanceTimersByTime(30_000);
      expect(t.render(10_000)).toContain('(unmeasured)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the phase even when the work throws', async () => {
    const t = createPhaseTimer();
    await expect(t.time('boom', async () => { throw new Error('x'); })).rejects.toThrow('x');
    t.add('filler', 20_000);
    expect(t.render(10_000)).toContain('filler');
  });

  // A call that takes minutes is invisible WHILE it takes them: the phase block
  // is only ever read afterwards. One create in benchmark run d79f62a3 took
  // 341 s and reported all of it as `(unmeasured)` — nothing to look at, live or
  // later. The heartbeat puts the phase in flight on stderr as it happens.
  it('says on stderr what it is still doing', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const t = createPhaseTimer();
      let release: () => void = () => {};
      const pending = t.time('C# bridge Create()', () => new Promise<void>(r => { release = r; }));
      await vi.advanceTimersByTimeAsync(31_000);
      release();
      await pending;

      const said = stderr.mock.calls.map(c => String(c[0])).join(String.fromCharCode(10));
      expect(said).toContain('[slow-call]');
      expect(said).toContain('C# bridge Create()');
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops the heartbeat once the call has answered', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const t = createPhaseTimer();
      await t.time('quick', async () => undefined);
      t.render(10_000);
      stderr.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});
