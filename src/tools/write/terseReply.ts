/**
 * `params.terse` — the short form of a d365fo_file create / modify reply.
 *
 * A write reply carries the verdict, the path, and then prose that is true on
 * every successful write: the on-disk verification, the index line, the project
 * registration, the next-step and batch hints, and for replace-code an echo of
 * the changed lines. One reply is cheap. A session of a few hundred writes pays
 * for that prose a few hundred times, and none of it changes what the caller
 * does next.
 *
 * This is ONE pass over the composed reply text rather than a flag threaded
 * through every writer: the writers keep composing the full reply, and the
 * dispatcher shortens it when the caller asked for that.
 *
 * It works from a DENY list, on purpose. Only lines whose exact wording is
 * known here, and known to say nothing but "this went well" or "here is what to
 * do next", are removed. Everything else stays: the verdict lines, the path,
 * every warning and error, every note about something not done, not applied,
 * skipped, ignored, dropped or failed, best-practice and validation findings,
 * auto-correction notes, and any line this file has never heard of. A new note
 * added to a writer is therefore kept until someone decides it is informational
 * and lists it below. A reply that is an error is returned untouched.
 */

/** Lines that only confirm success or suggest a next step. Matched whole, never as a prefix. */
const INFORMATIONAL_LINES: readonly RegExp[] = [
  // Next step — only the plain build hint. The create variant that starts with
  // "add the file to your .rnrproj" names something the caller still has to do.
  /^Next: build_d365fo_project\(bpCheck:true\) — builds (?:AND best-practice-checks|and runs the best-practice check) in one call\.$/,
  // Batch-edit hints (inlineWriteVerification.renderBatchEditHint).
  /^More edits to "[^"]*"\? Send them together: operations:\[\{operation:"…"\}, …\] in ONE modify call\.$/,
  /^Further edits to "[^"]*" go in ONE call: d365fo_file\(action="modify", objectType="[^"]*", objectName="[^"]*", operations:\[…\]\) — not one call per edit\.$/,
  /^It exists now — do not create it again\.$/,
  // The verification that passed. A project-membership finding is its own line
  // after this one and is kept. The failed verification starts with ❌.
  /^✅ Verified: on disk \(\d+ bytes\)(?:, referenced by the \.rnrproj)?\.?$/,
  /^🔎 Symbol index updated in place — no update_symbol_index call needed\.$/,
  /^\(Pass autoCorrect=false to have corrections like this raise an error instead\.\)$/,
];

/** The project registration that worked. Ends in free text (a path), so it is screened for PROBLEM_MARKER. */
const PROJECT_OK_LINE = /^✅ (?:Added to|Already referenced by) project: \S.*$/;

/**
 * Wording that marks a line as carrying a problem. The two droppable lines that
 * end in free text (the project path, the bridge's API message) are kept when
 * they match it.
 */
const PROBLEM_MARKER = /⚠|❌|⛔|⏭|✂|\bNOT\b|\bnot (?:applied|attempted|written|created|added|found)\b|skipp|ignored|dropped|fail|error|refus|could not|cannot/i;

/** Verdict of a write that went through. The bridge's `🔧 API:` line under it only names the API used. */
const APPLIED_VERDICT = /^✅ (?:Created \S|.+ — applied via )/;
/** Anything that starts a part of the reply whose outcome is not known to be a clean write. */
const SECTION_START = /^(?:⏭|❌|⚠|⛔|ℹ|### |---$)/;

const CHANGED_LINES_HEADER = '**Result on disk** (› = changed):';
const FENCE = '```';

/** Shorten the text of one successful create / modify reply. See the file header for what is kept. */
export function terseReplyText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let underAppliedVerdict = false;

  const drop = (): void => {
    // The blank line that set the dropped line apart goes with it. A blank line
    // after it stays and separates what follows.
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // replace-code's echo of the changed region: a header and one fenced block.
    // The fence holds the caller's own code, so it is not screened for markers.
    // An echo with no closing fence (cut by the batch budget) is left alone.
    if (line === CHANGED_LINES_HEADER && lines[i + 1]?.trim() === FENCE) {
      const close = lines.findIndex((l, j) => j > i + 1 && l.trim() === FENCE);
      if (close !== -1) {
        drop();
        i = close;
        continue;
      }
    }

    if (APPLIED_VERDICT.test(line)) underAppliedVerdict = true;
    else if (SECTION_START.test(line)) underAppliedVerdict = false;

    const informational =
      INFORMATIONAL_LINES.some(re => re.test(line)) ||
      (!PROBLEM_MARKER.test(line) && (
        PROJECT_OK_LINE.test(line) ||
        // On a skip this line is where the bridge gives its reason, so it only
        // goes when the verdict above it says the write was applied.
        (underAppliedVerdict && line.startsWith('🔧 API: '))
      ));
    if (informational) {
      drop();
      continue;
    }
    out.push(lines[i]);
  }

  const short = out.join('\n').replace(/\s+$/, '');
  // Never hand back nothing: a reply made only of lines listed above has no
  // verdict this pass recognises, so it is not one to shorten.
  return short.trim() === '' ? text : short;
}

/** True for the values that switch `terse` on, the same spelling `bpCheck` accepts. */
export function isTerse(flag: unknown): boolean {
  return flag === true || flag === 'true';
}

/**
 * Apply `terse` to a tool result. An error result is returned as it is: when a
 * write failed, the explanation is the content.
 */
export function terseResult<T>(result: T): T {
  const r = result as { isError?: boolean; content?: unknown } | null | undefined;
  if (!r || r.isError || !Array.isArray(r.content)) return result;
  return {
    ...r,
    content: r.content.map((c: any) =>
      c?.type === 'text' && typeof c.text === 'string' ? { ...c, text: terseReplyText(c.text) } : c),
  } as T;
}
