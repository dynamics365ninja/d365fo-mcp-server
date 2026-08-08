/**
 * terminalUi — capability-aware console formatting for the dev/HTTP startup banner.
 *
 * Legacy Windows terminals (PowerShell 5.1/conhost) render UTF-8 emoji as
 * mojibake, so we detect Unicode-capable terminals and fall back to ASCII
 * glyphs ([OK]/[!]/-> instead of ✓/⚠/›) elsewhere. ANSI colour is likewise
 * disabled for pipes, NO_COLOR, and dumb terminals.
 */

import { relative, isAbsolute, sep } from 'path';

const isWin = process.platform === 'win32';

/**
 * Whether the terminal reliably renders Unicode (box-drawing + emoji).
 * On Windows only modern hosts qualify. Honour FORCE_UNICODE=1/0 as an override.
 */
export const supportsUnicode: boolean = (() => {
  if (process.env.FORCE_UNICODE === '1') return true;
  if (process.env.FORCE_UNICODE === '0') return false;
  if (!isWin) return process.env.TERM !== 'linux';
  return (
    Boolean(process.env.WT_SESSION) ||       // Windows Terminal
    process.env.TERM_PROGRAM === 'vscode' ||
    Boolean(process.env.ConEmuTask) ||       // ConEmu / Cmder
    process.env.TERM === 'xterm-256color' ||
    process.env.WSLENV !== undefined         // WSL interop
  );
})();

/**
 * Whether to emit ANSI colour codes. Disabled for non-TTY (pipes/redirects),
 * NO_COLOR, and dumb terminals; FORCE_COLOR=1 forces it on.
 */
const supportsColor: boolean = (() => {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if ('NO_COLOR' in process.env) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
})();

// Colour helpers
const wrap = (open: number, close: number) => (s: string): string =>
  supportsColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

// Glyphs (Unicode with ASCII fallback)
const U = supportsUnicode;
export const glyph = {
  tl: U ? '╭' : '+',
  tr: U ? '╮' : '+',
  bl: U ? '╰' : '+',
  br: U ? '╯' : '+',
  h: U ? '─' : '-',
  v: U ? '│' : '|',
  dot: U ? '·' : '-',
  ok: U ? '✓' : 'OK',
  warn: U ? '▲' : '!',
  err: U ? '✗' : 'x',
  info: U ? 'ℹ' : 'i',
  arrow: U ? '›' : '>',
  bullet: U ? '•' : '*',
  ellipsis: U ? '…' : '...',
};

// Emoji -> ASCII sanitiser. Maps semantic emoji to short ASCII tags, then strips
// remaining decorative emoji + variation selectors. No-op when Unicode is supported.
// Trailing space (if any) is preserved so "✅ Loaded" becomes "[OK] Loaded".
const EMOJI_TAGS: Array<[RegExp, string]> = [
  [/✅|✔️?/g, '[OK]'],
  [/❌/g, '[X]'],
  [/⚠️?/g, '[!]'],
  [/ℹ️?/g, '[i]'],
  [/⏭️?/g, '[skip]'],
];
// Decorative emoji / pictographs (+ variation selector & ZWJ) plus any spaces
// immediately following them, so real indentation is preserved after stripping.
// U+FE0F (variation selector) and U+200D (ZWJ) are combining characters ON
// PURPOSE — they are the glue in emoji sequences, and stripping them alongside
// the base pictograph is the whole point. Matching only whole grapheme clusters
// would leave orphaned joiners behind, which is what mojibakes on cp852/cp1250.
// biome-ignore lint/suspicious/noMisleadingCharacterClass: combining chars are intentional, see above
const EMOJI_STRIP = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2300}-\u{23FF}])+ */gu;

// Fancy punctuation that also mojibakes on legacy code pages (cp852/cp1250); transliterate to plain ASCII.
const PUNCT_MAP: Array<[RegExp, string]> = [
  [/[—–‒―]/g, '-'],
  [/…/g, '...'],
  [/[·•]/g, '-'],
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/[‹›]/g, '>'],
  [/→/g, '->'],
  [/×/g, 'x'],
  [/ /g, ' '],   // non-breaking space
];

/** Replace/strip emoji & fancy punctuation so legacy code pages don't show mojibake. No-op on Unicode terminals. */
export function sanitize(text: string): string {
  if (supportsUnicode) return text;
  let out = text;
  for (const [re, tag] of EMOJI_TAGS) out = out.replace(re, tag);
  out = out.replace(EMOJI_STRIP, '');
  for (const [re, rep] of PUNCT_MAP) out = out.replace(re, rep);
  return out;
}

// Layout helpers
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is what an ANSI SGR sequence IS — no non-control spelling exists
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible length of a string, ignoring ANSI colour codes. */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Pad `s` (accounting for ANSI codes) with spaces to `width` on the right. */
function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLen(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/**
 * Draw a rounded box around the given rows. Each row is a pre-styled string;
 * width is derived from the widest visible row (min `minWidth`), capped sensibly.
 */
export function box(rows: string[], minWidth = 48): string[] {
  const inner = Math.max(minWidth, ...rows.map(visibleLen));
  const top = c.gray(glyph.tl + glyph.h.repeat(inner + 2) + glyph.tr);
  const bottom = c.gray(glyph.bl + glyph.h.repeat(inner + 2) + glyph.br);
  const body = rows.map(
    (r) => c.gray(glyph.v) + ' ' + padEndVisible(r, inner) + ' ' + c.gray(glyph.v),
  );
  return [top, ...body, bottom];
}

/** Build a left/right justified line of total visible `width`. */
export function spread(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLen(left) - visibleLen(right));
  return left + ' '.repeat(gap) + right;
}

/** A `label  value` row with the label dimmed and padded to `labelWidth`. */
export function kv(label: string, value: string, labelWidth = 9): string {
  return '  ' + c.dim(padEndVisible(label, labelWidth)) + value;
}

/** A section header (uppercased, accented). */
export function sectionTitle(title: string): string {
  return '  ' + c.bold(c.cyan(title.toUpperCase()));
}

/** A status line such as "✓ Ready in 3.2s". `kind` picks the glyph + colour. */
export function statusLine(kind: 'step' | 'ok' | 'warn' | 'err' | 'info', msg: string): string {
  const map = {
    step: [glyph.arrow, c.cyan] as const,
    ok: [glyph.ok, c.green] as const,
    warn: [glyph.warn, c.yellow] as const,
    err: [glyph.err, c.red] as const,
    info: [glyph.info, c.gray] as const,
  };
  const [g, paint] = map[kind];
  return '  ' + paint(g) + ' ' + msg;
}

/** Warnings emitted during startup, collected for an end-of-startup summary. */
export const startupWarnings: string[] = [];

/**
 * Convenience status loggers for the startup sequence. Resolve console.*
 * lazily at call time so stdio/HTTP overrides installed in main() apply.
 *  - step/ok/info → stdout (suppressed in stdio mode)
 *  - warn/err     → stderr (kept visible to MCP clients in stdio mode)
 *  - detail       → dimmed, indented sub-line under the preceding status
 */
export const log = {
  step: (msg: string): void => console.log(statusLine('step', msg)),
  ok: (msg: string): void => console.log(statusLine('ok', msg)),
  info: (msg: string): void => console.log(statusLine('info', msg)),
  warn: (msg: string): void => { startupWarnings.push(msg); console.error(statusLine('warn', msg)); },
  err: (msg: string): void => console.error(statusLine('err', msg)),
  detail: (msg: string): void => console.log('      ' + c.dim(msg)),
};

/**
 * Render a path relative to `cwd` (prefixed with "./") when it lives under it,
 * otherwise return the absolute path unchanged. Keeps long startup paths short.
 */
export function shortPath(p: string, cwd = process.cwd()): string {
  const rel = relative(cwd, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? '.' + sep + rel : p;
}
