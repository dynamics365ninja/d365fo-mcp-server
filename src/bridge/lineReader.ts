/**
 * Splits the bridge child's stdout into lines.
 *
 * The protocol is newline-delimited JSON, and one reply can be many megabytes on
 * a single line that arrives in thousands of chunks. Two things follow from that:
 *
 *   - Only the newly arrived text is searched for the newline, and the parts of
 *     an unfinished line are kept in an array and joined once when the line
 *     completes. Appending every chunk to one string and searching it from the
 *     start is quadratic in the size of the line (measured: 2.7 s for a 20 MB
 *     reply against about 120 ms this way).
 *   - Bytes are decoded with a StringDecoder, which holds back the first bytes
 *     of a multi-byte character until the rest arrives. Decoding each chunk on
 *     its own turns a character that straddles two chunks into U+FFFD.
 *
 * Lines are returned as they were sent, without the terminating "\n" and with
 * nothing trimmed (a "\r" before the newline stays). An empty line is returned
 * as "". Text after the last newline stays pending until its newline arrives.
 */

import { StringDecoder } from 'node:string_decoder';

export class BridgeLineReader {
  private decoder = new StringDecoder('utf8');
  /** Text of the line still being received, in arrival order. Never holds a newline. */
  private parts: string[] = [];
  /** Complete lines not yet handed out by next(). */
  private lines: string[] = [];
  private head = 0;

  /** Add a chunk of stdout. Complete lines become available through next(). */
  push(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    if (!text) return;

    let start = 0;
    let newlineIdx: number;
    while ((newlineIdx = text.indexOf('\n', start)) !== -1) {
      const segment = text.substring(start, newlineIdx);
      if (this.parts.length > 0) {
        this.parts.push(segment);
        this.lines.push(this.parts.join(''));
        this.parts = [];
      } else {
        this.lines.push(segment);
      }
      start = newlineIdx + 1;
    }
    if (start < text.length) {
      this.parts.push(start === 0 ? text : text.substring(start));
    }
  }

  /** The next complete line, or undefined when none is waiting. */
  next(): string | undefined {
    if (this.head >= this.lines.length) {
      if (this.head > 0) {
        this.lines = [];
        this.head = 0;
      }
      return undefined;
    }
    const line = this.lines[this.head];
    // Release the reference: a multi-megabyte line must not stay reachable from
    // the queue after it has been handed out.
    this.lines[this.head++] = '';
    return line;
  }

  /** Forget everything received so far, including a half-received character. */
  reset(): void {
    this.decoder = new StringDecoder('utf8');
    this.parts = [];
    this.lines = [];
    this.head = 0;
  }

  /** How many parts the unfinished line is held in (one per chunk that added to it). */
  get pendingParts(): number {
    return this.parts.length;
  }
}
