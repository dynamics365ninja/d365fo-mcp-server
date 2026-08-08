/**
 * Shared loader for the C#-source parity tests.
 *
 * The bridge's behaviour is not reachable from vitest — D365MetadataBridge.exe only runs
 * on a Windows VM with D365FO installed — so the repo's standing guard for C#-side
 * invariants is a TypeScript test that reads the C# source (see
 * tests/bridge/addFieldDispatchParity.test.ts for the original of the pattern).
 *
 * Comments are stripped before any assertion runs. Without that, these tests are trivially
 * satisfiable by the explanatory comment describing the fix — which is exactly the text a
 * later refactor is most likely to leave behind after deleting the code it describes.
 */

import * as fs from 'fs';
import * as path from 'path';

const BRIDGE_DIR = path.join(path.resolve(__dirname, '..', '..'), 'bridge', 'D365MetadataBridge');

export const WRITE_SERVICE_CS = path.join(BRIDGE_DIR, 'Services', 'MetadataWriteService.cs');
export const READ_SERVICE_CS = path.join(BRIDGE_DIR, 'Services', 'MetadataReadService.cs');
export const XREF_SERVICE_CS = path.join(BRIDGE_DIR, 'Services', 'CrossReferenceService.cs');

/**
 * Removes `//` line comments and block comments, leaving string and char literals intact
 * (a `//` inside a literal is data, not a comment). Newlines are preserved so the result
 * still slices cleanly by method.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '"' || c === "'") {
      // Verbatim strings (@"…") escape a quote by doubling it, not with a backslash.
      const verbatim = c === '"' && source[i - 1] === '@';
      out += c;
      i++;
      while (i < source.length) {
        if (!verbatim && source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        if (source[i] === c) {
          if (verbatim && source[i + 1] === c) { out += c + c; i += 2; continue; }
          out += c;
          i++;
          break;
        }
        out += source[i];
        i++;
      }
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** Comment-stripped contents of a C# source file. */
export function readStripped(file: string): string {
  return stripComments(fs.readFileSync(file, 'utf8'));
}

/**
 * The body of a C# method, from its signature to the matching closing brace.
 * `signature` must be a distinctive fragment of the declaration line.
 */
export function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`method not found in C# source: ${signature}`);
  const open = source.indexOf('{', start);
  if (open === -1) throw new Error(`no body found for: ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${signature}`);
}
