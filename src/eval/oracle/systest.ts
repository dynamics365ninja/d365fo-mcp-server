/**
 * SysTest runtime-oracle adapter (docs/AGENT_EVAL_LOOP.md §6.3, §5 `systest`).
 *
 * The loop's golden oracle judges metadata *shape*; it cannot judge a method
 * body. The runtime signal comes from running a SysTest class via the
 * `run_systest_class` MCP tool. This module parses that tool's text output into
 * the structured `{ ran, passed, failures }` the corpus record carries, so a
 * code-heavy case can be scored on behaviour, not just compilation.
 *
 * `run_systest_class` emits one of these header forms (src/tools/sysTestRunner.ts):
 *   ✅ Tests passed              → ran, passed
 *   ❌ Tests FAILED             → ran, failed (+ failure lines in the body)
 *   ⚠️ Tests completed ...       → ran, indeterminate (passed=null)
 *   ❌ Tests failed:\n\n<err>    → could NOT run (exec/exception) → ran=false
 *   ❌ Cannot determine model… / Neither SysTestConsole… / Invalid parameter…
 *   ❌ SysTestConsole.exe requires an interactive console session…
 *                                → could NOT run → ran=false
 */

export interface SysTestFailure {
  /** Best-effort test/method identifier; '' when not recoverable from the line. */
  test: string;
  message: string;
}

export interface SysTestResult {
  ran: boolean;
  passed: boolean | null;
  failures: SysTestFailure[];
}

/** Signals that the runner never executed any test (infra/invocation problem). */
const NOT_RUN_PATTERNS = [
  /Cannot determine model/i,
  /Neither SysTestConsole\.exe nor SysTestRunner\.exe found/i,
  /Invalid parameter/i,
  /\bENOENT\b/i,
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /spawn .* (ENOENT|EACCES)/i,
  /timed out|ETIMEDOUT/i,
  /requires an interactive console session/i,
  /WaitForDebugger/i,
];

/** A line that looks like a concrete test failure (not the status header). */
const FAILURE_LINE = /\b(fail(?:ed|ure)?|assert\w*|exception|unhandled)\b/i;

/** A count-summary line ("3 tests run, 2 passed, 1 failed") — evidence, not a failure. */
const COUNT_SUMMARY = /\b\d+\s+(?:tests?\s+)?(?:run|passed|failed)\b/i;

/** Try to pull a `Class::method` or `method` identifier out of a failure line. */
function extractTestName(line: string): string {
  const qualified = /\b([A-Za-z]\w*::[A-Za-z]\w*)\b/.exec(line);
  if (qualified) return qualified[1];
  const named = /\b(?:test|method)\s+['"]?([A-Za-z]\w*)['"]?/i.exec(line);
  if (named) return named[1];
  return '';
}

/** Parse a `N passed, M failed` style summary, if present. */
function parseCounts(text: string): { passed?: number; failed?: number } {
  const failed = /(\d+)\s+(?:tests?\s+)?fail/i.exec(text);
  const passed = /(\d+)\s+(?:tests?\s+)?pass/i.exec(text);
  return {
    failed: failed ? Number(failed[1]) : undefined,
    passed: passed ? Number(passed[1]) : undefined,
  };
}

export function parseSysTestResult(output: string | null | undefined): SysTestResult {
  const text = (output ?? '').trim();
  if (text === '') return { ran: false, passed: null, failures: [] };

  // Infrastructure / invocation problems → never ran.
  if (NOT_RUN_PATTERNS.some(re => re.test(text))) {
    return { ran: false, passed: null, failures: [] };
  }
  // The catch-block form "❌ Tests failed:\n\n<exception>" is a runner error, not a
  // test failure. Distinguish it from the "❌ Tests FAILED" status header (capital).
  if (/❌\s*Tests failed:/.test(text) && !/❌\s*Tests FAILED/.test(text)) {
    return { ran: false, passed: null, failures: [] };
  }

  const counts = parseCounts(text);

  let passed: boolean | null;
  if (/✅\s*Tests passed/i.test(text)) passed = true;
  else if (/❌\s*Tests FAILED/.test(text)) passed = false;
  else if (typeof counts.failed === 'number') passed = counts.failed === 0;
  else if (/⚠️\s*Tests completed/i.test(text)) passed = null;
  else passed = null;

  const failures: SysTestFailure[] = [];
  if (passed === false) {
    const headerSkip = /^(✅|❌|⚠️|Class:|Model:)/;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || headerSkip.test(line)) continue;
      // A count summary ("N passed, M failed") is evidence, not an individual
      // failure — skip it unless it also names a specific test (Class::method).
      if (COUNT_SUMMARY.test(line) && !/::/.test(line)) continue;
      if (FAILURE_LINE.test(line)) {
        failures.push({ test: extractTestName(line), message: line });
      }
    }
  }

  return { ran: true, passed, failures };
}
