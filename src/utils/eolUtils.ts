/**
 * EOL (line ending) detection utilities for file-writing operations.
 *
 * D365FO .label.txt files are Windows-native CRLF by convention (TFVC and Git
 * both track them as CRLF). Tools that read-normalize-write must preserve the
 * original line ending so VCS diffs only highlight the intentional changes.
 */

/**
 * Detect the dominant line ending in a file's content.
 * Any CRLF present is treated as evidence the whole file is CRLF; falls back
 * to LF only when line endings exist but none are CRLF. Defaults to CRLF for
 * brand-new or empty files to match D365FO conventions.
 */
export function detectEol(content: string): '\r\n' | '\n' {
  if (content.includes('\r\n')) return '\r\n';
  if (content.includes('\n')) return '\n';
  return '\r\n';
}

/**
 * The line ending of the file on disk, or null when it cannot be read.
 *
 * The bridge's replace-code matches with String.Contains against method source
 * read through IMetadataProvider, and that source keeps the file's CRLF. A
 * multi-line oldCode sent with LF, which is how every client sends it, never
 * matched: 168 of 176 multi-line replace-code calls in one project's sessions
 * missed in the bridge and were written by the XML fallback instead, against
 * 3 of 181 single-line ones.
 */
export async function readFileEol(filePath: string): Promise<'\r\n' | '\n' | null> {
  try {
    const { readFile } = await import('fs/promises');
    return detectEol(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** `text` with every line break as `eol`. Null leaves the text as it is. */
export function withEol(text: string, eol: '\r\n' | '\n' | null): string {
  if (!eol) return text;
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
