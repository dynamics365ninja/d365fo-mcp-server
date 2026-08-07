/**
 * Does an indexed label actually exist in its .label.txt on disk?
 *
 * The symbol index is a snapshot. When it is ahead of the file system — a label
 * row from a run that was rolled back, a model rebuilt outside the server, an
 * index written before a git checkout — `labels(action="info")` answers with a
 * full translation list for a label that is not in any file. Downstream, the
 * caller reuses that "existing" label in XML and the failure only surfaces as a
 * best-practice error at build time: `Unknown label '@Model:LabelId'`. Observed
 * in a live demo (2026-08-07), together with a phantom enum and a phantom field.
 *
 * The check is deliberately one-way. A label the file HAS is never questioned,
 * and any doubt — unreadable path, no indexed path, oversized file — reports
 * `null` ("could not verify") rather than a verdict. Only "the file reads fine
 * and this id is not in it" is worth telling the caller about, because that one
 * is always a real defect in what they were about to build on.
 */

import * as fs from 'fs/promises';

/** Above this, don't pay the read: shipped Microsoft label files are the only ones near it. */
const MAX_LABEL_FILE_BYTES = 16 * 1024 * 1024;

/**
 * A label file line is `LabelId=Text`, with ` =Comment` continuation lines and
 * `;`-prefixed comments. Only the id half matters here.
 */
function fileDeclaresLabel(content: string, labelId: string): boolean {
  const needle = labelId.toLowerCase();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim().toLowerCase() === needle) return true;
  }
  return false;
}

/**
 * `true`  — the file was read and does NOT declare the label (index is stale),
 * `false` — the file declares it,
 * `null`  — could not verify; say nothing.
 */
export async function labelMissingOnDisk(
  labelId: string,
  filePaths: string[],
): Promise<boolean | null> {
  let readAny = false;

  for (const filePath of filePaths) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_LABEL_FILE_BYTES) continue;
      const content = await fs.readFile(filePath, 'utf-8');
      readAny = true;
      // Present in ANY language file is present — a label only translated to one
      // language is normal, and this check is about existence, not completeness.
      if (fileDeclaresLabel(content, labelId)) return false;
    } catch {
      // Missing or unreadable file: no verdict from this path.
    }
  }

  return readAny ? true : null;
}
