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
 * Total bytes one check may read before giving up with "no verdict".
 *
 * A label file id has ~74 language variants, and the platform's own are ~10 MB
 * each: @SYS alone is 764 MB across its files, and a sweep of all of them was
 * measured at 17 s on the reference VM — one tool call holding the server for
 * long enough that a client gives up on it. With the budget the same sweep gives
 * up at 218 ms and reports no verdict, which is the honest answer anyway: the
 * files it did read do not know whether the id is in the ones it skipped.
 *
 * The budget rather than a "skip Microsoft models" rule, because
 * isStandardModel() is defined as "not custom" — an unrecognised custom model
 * reads as Microsoft's, and the check would switch itself off precisely where a
 * stale row is most likely.
 */
const MAX_TOTAL_READ_BYTES = 32 * 1024 * 1024;

/** Regex-safe form of a label id, which may legitimately contain '@' and '.'. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A label file line is `LabelId=Text`, with ` ;Comment` continuation lines and
 * `;`-prefixed comments. Only the id half matters here.
 *
 * Matched with one multiline regex rather than split()+loop: splitting a 10 MB
 * file builds ~250k throwaway strings per file, which is most of the cost of the
 * check and all of it is avoidable. Leading blanks are tolerated the way trim()
 * did; a ';' comment line cannot match because the id has to start the line.
 */
function fileDeclaresLabel(content: string, labelId: string): boolean {
  // ﻿ is in the class because every shipped .label.txt starts with a BOM and
  // Node's utf-8 read keeps it. The old split()+trim() absorbed it by accident —
  // JS trim() counts U+FEFF as whitespace — so dropping it here would have made
  // the FIRST label of every file unfindable, i.e. reported as missing.
  return new RegExp(`^[\\uFEFF \\t]*${escapeRegex(labelId)}[ \\t]*=`, 'im').test(content);
}

/**
 * Same verdict as labelMissingOnDisk, for several ids at once, reading each file
 * ONCE instead of once per id.
 *
 * `labels(action="search")` checks every candidate row it is about to show, and
 * those rows share a label file — so the per-id form would read the same 4 MB
 * .label.txt ten times to answer ten questions the first read already settled.
 *
 * Every requested id gets an entry: `true` missing, `false` present, `null` no
 * verdict. The read budget is shared across the whole batch, so an id left
 * unanswered when the budget runs out reports `null` rather than "missing".
 */
export async function labelsMissingOnDisk(
  labelIds: string[],
  filePaths: string[],
): Promise<Map<string, boolean | null>> {
  const verdicts = new Map<string, boolean | null>();
  const pending = new Set(labelIds);
  if (pending.size === 0) return verdicts;

  let readAny = false;
  let bytesRead = 0;
  let overBudget = false;

  for (const filePath of filePaths) {
    if (pending.size === 0) break;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_LABEL_FILE_BYTES) continue;
      // Over budget before every id has an answer: stop and say nothing about the
      // rest. Reporting "missing" off a partial sweep would be a verdict the
      // files never gave.
      if (bytesRead + stat.size > MAX_TOTAL_READ_BYTES) { overBudget = true; break; }
      const content = await fs.readFile(filePath, 'utf-8');
      bytesRead += stat.size;
      readAny = true;

      for (const labelId of [...pending]) {
        // Present in ANY language file is present — a label only translated to
        // one language is normal, and this check is about existence, not
        // completeness.
        if (fileDeclaresLabel(content, labelId)) {
          verdicts.set(labelId, false);
          pending.delete(labelId);
        }
      }
    } catch {
      // Missing or unreadable file: no verdict from this path.
    }
  }

  for (const labelId of pending) {
    verdicts.set(labelId, overBudget || !readAny ? null : true);
  }
  return verdicts;
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
  return (await labelsMissingOnDisk([labelId], filePaths)).get(labelId) ?? null;
}
