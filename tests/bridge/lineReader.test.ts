/**
 * BridgeLineReader — splitting the bridge child's stdout into lines.
 *
 * The bridge speaks newline-delimited JSON, and a reply can be one line of many
 * megabytes delivered in thousands of chunks. These tests pin the two things the
 * old inline loop got wrong (a character split across two chunks, and work that
 * grew with the square of the line length) and the splitting behaviour that must
 * not change: complete lines, empty lines, CRLF, several lines in one chunk and a
 * trailing partial line.
 */

import { describe, it, expect } from 'vitest';
import { BridgeLineReader } from '../../src/bridge/lineReader';

const utf8 = (text: string) => Buffer.from(text, 'utf8');

function drain(reader: BridgeLineReader): string[] {
  const lines: string[] = [];
  let line: string | undefined;
  while ((line = reader.next()) !== undefined) lines.push(line);
  return lines;
}

/** Feed `bytes` to the reader in pieces of `size` bytes and return every line it produced. */
function feedInPieces(reader: BridgeLineReader, bytes: Buffer, size: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    reader.push(bytes.subarray(i, i + size));
    lines.push(...drain(reader));
  }
  return lines;
}

describe('BridgeLineReader', () => {
  it('returns a complete line without its newline', () => {
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":"1","result":true}\n'));

    expect(drain(reader)).toEqual(['{"id":"1","result":true}']);
    expect(reader.pendingParts).toBe(0);
  });

  it('returns every line of a chunk that holds several, in order', () => {
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n'));

    expect(drain(reader)).toEqual(['{"id":"1"}', '{"id":"2"}', '{"id":"3"}']);
  });

  it('joins one line that arrives across many chunks', () => {
    const reader = new BridgeLineReader();
    const line = JSON.stringify({ id: '7', result: { text: 'x'.repeat(5000) } });

    const lines = feedInPieces(reader, utf8(line + '\n'), 64);

    expect(lines).toEqual([line]);
  });

  it('holds a trailing partial line back until its newline arrives', () => {
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":"1"}\n{"id":'));

    expect(drain(reader)).toEqual(['{"id":"1"}']);
    expect(reader.next()).toBeUndefined();

    reader.push(utf8('"2"}\n'));
    expect(drain(reader)).toEqual(['{"id":"2"}']);
  });

  it('completes the line when a chunk ends exactly on the newline', () => {
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":'));
    reader.push(utf8('"1"}\n'));

    expect(drain(reader)).toEqual(['{"id":"1"}']);
    expect(reader.pendingParts).toBe(0);
  });

  it('completes the line when the newline arrives in a chunk of its own', () => {
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":"1"}'));
    expect(reader.next()).toBeUndefined();

    reader.push(utf8('\n'));
    expect(drain(reader)).toEqual(['{"id":"1"}']);
  });

  it('ignores an empty chunk', () => {
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":'));
    reader.push(Buffer.alloc(0));
    reader.push(utf8('"1"}\n'));
    reader.push(Buffer.alloc(0));

    expect(drain(reader)).toEqual(['{"id":"1"}']);
  });

  it('returns empty lines as empty strings and leaves a carriage return in place', () => {
    // The caller trims each line and skips the empty ones, as it always did, so
    // the reader must not decide that for it.
    const reader = new BridgeLineReader();
    reader.push(utf8('\n{"id":"1"}\r\n\r\n  {"id":"2"}  \n'));

    expect(drain(reader)).toEqual(['', '{"id":"1"}\r', '\r', '  {"id":"2"}  ']);
  });

  it('keeps a two-byte character that is split across two chunks', () => {
    const reader = new BridgeLineReader();
    const line = '{"label":"Količina ž"}';
    const bytes = utf8(line + '\n');
    const cut = bytes.indexOf(utf8('ž')) + 1; // between the two bytes of "ž"

    reader.push(bytes.subarray(0, cut));
    reader.push(bytes.subarray(cut));

    const lines = drain(reader);
    expect(lines).toEqual([line]);
    expect(lines[0]).not.toContain('�');
  });

  it('keeps a four-byte character whatever byte the chunks are cut on', () => {
    const line = '{"comment":"done 🚀 ž 日本"}';
    const bytes = utf8(line + '\n');

    for (let size = 1; size <= 5; size++) {
      expect(feedInPieces(new BridgeLineReader(), bytes, size)).toEqual([line]);
    }
  });

  it('hands out lines one at a time, so a caller that stops early loses nothing', () => {
    // The client stops reading a chunk at the "ready" message and picks the rest
    // up on the next chunk.
    const reader = new BridgeLineReader();
    reader.push(utf8('{"id":"ready"}\n{"id":"1"}\n'));

    expect(reader.next()).toBe('{"id":"ready"}');

    reader.push(utf8('{"id":"2"}\n'));
    expect(drain(reader)).toEqual(['{"id":"1"}', '{"id":"2"}']);
  });

  it('forgets a partial line, waiting lines and a half-received character on reset', () => {
    const reader = new BridgeLineReader();
    const euro = utf8('€');
    reader.push(utf8('{"id":"1"}\n{"id":"2","text":"'));
    reader.push(euro.subarray(0, 2));

    reader.reset();
    reader.push(utf8('{"id":"3"}\n'));

    expect(drain(reader)).toEqual(['{"id":"3"}']);
    expect(reader.pendingParts).toBe(0);
  });

  describe('work grows with the size of the reply, not its square', () => {
    const CHUNK = 1024;
    const CHUNKS = 2000;

    it('keeps the unfinished line as one part per chunk instead of re-joining it', () => {
      const reader = new BridgeLineReader();
      const chunk = utf8('x'.repeat(CHUNK));

      for (let i = 0; i < CHUNKS; i++) reader.push(chunk);

      expect(reader.pendingParts).toBe(CHUNKS);
      expect(reader.next()).toBeUndefined();

      reader.push(utf8('\n'));
      const line = reader.next();
      expect(line).toHaveLength(CHUNK * CHUNKS);
      expect(reader.pendingParts).toBe(0);
    });

    it('searches each character for the newline once', () => {
      // Counts what the newline search actually examines, so the result does not
      // depend on how fast the machine is. Re-scanning the accumulated text on
      // every chunk would examine about CHUNKS / 2 times the reply size.
      const reader = new BridgeLineReader();
      const chunk = utf8('x'.repeat(CHUNK));
      const last = utf8('x'.repeat(CHUNK - 1) + '\n');
      const total = CHUNK * (CHUNKS + 1);

      const original = String.prototype.indexOf;
      let examined = 0;
      String.prototype.indexOf = function (this: string, search: string, position?: number) {
        const from = Math.max(0, position ?? 0);
        const found = original.call(this, search, position);
        examined += (found === -1 ? this.length : found + 1) - Math.min(from, this.length);
        return found;
      };
      try {
        for (let i = 0; i < CHUNKS; i++) reader.push(chunk);
        reader.push(last);
      } finally {
        String.prototype.indexOf = original;
      }

      expect(reader.next()).toHaveLength(total - 1);
      expect(examined).toBeGreaterThanOrEqual(total);
      expect(examined).toBeLessThanOrEqual(total * 2);
    });
  });
});
