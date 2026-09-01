/**
 * Reader for the `/xml:` result document SysTestConsole writes.
 *
 * This lives beside the runner rather than in `src/eval/` because it is loaded
 * at runtime by `sysTestRunner.ts`, and `src/eval/**` is a dev-only tree that
 * package.json's `files` list keeps out of the published tarball
 * (`"!dist/eval/**"`). A shipped module importing across that boundary makes
 * the installed server fail to start with ERR_MODULE_NOT_FOUND. The eval
 * oracle re-exports this from `src/eval/oracle/systest.ts`; the dependency
 * runs eval → tools, never the other way.
 */

/** One test method's outcome, read from the runner's XML result document. */
export interface SysTestCaseOutcome {
  name: string;
  passed: boolean;
  message?: string;
}

/**
 * Per-method outcomes from the `/xml:` document SysTestConsole writes.
 *
 * The shape is the platform's own: SysTestListenerXML builds
 * `<test-results><results><test-case name="…" success="true|false">` and adds a
 * `<failure><message>…</message></failure>` child for a failing one (the element
 * names are #define'd at the top of that class). Reading it beats the regex over
 * combined stdout that the runner used to classify with: a class named
 * …ErrorHandlingTest made "error" appear in the output of a passing run, and a
 * green run was reported as failed.
 *
 * Returns [] when the text is not such a document, so callers can fall back.
 */
export function parseSysTestXml(xml: string | null | undefined): SysTestCaseOutcome[] {
  if (!xml || !/<test-case\b/i.test(xml)) return [];

  const outcomes: SysTestCaseOutcome[] = [];
  // The SELF-CLOSING form has to be tried first. With the paired form leading, its
  // `[^>]*` happily consumed the `/` of `<test-case … />` and the lazy body then ran
  // on to the NEXT `</test-case>`, swallowing two results into one.
  const caseRe = /<test-case\b([^>]*?)\/>|<test-case\b([^>]*)>([\s\S]*?)<\/test-case>/gi;
  let m: RegExpExecArray | null;

  while ((m = caseRe.exec(xml)) !== null) {
    const attrs = m[1] ?? m[2] ?? '';
    const body = m[3] ?? '';
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '';
    const successAttr = /\bsuccess\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    const failure = /<failure\b[^>]*>([\s\S]*?)<\/failure>/i.exec(body)?.[1];
    const message = failure
      ? (/<message\b[^>]*>([\s\S]*?)<\/message>/i.exec(failure)?.[1] ?? failure)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      : undefined;

    // `success` is authoritative when present; a <failure> child decides otherwise.
    const passed = successAttr !== undefined
      ? /^(true|1)$/i.test(successAttr)
      : failure === undefined;

    outcomes.push(message ? { name, passed, message } : { name, passed });
  }

  return outcomes;
}
