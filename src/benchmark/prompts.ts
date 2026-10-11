/**
 * The prompt catalogue — eval/benchmark/prompts/<id>.json, one experiment each.
 *
 * A prompt is identified by its id AND the hash of its text: the report groups
 * by id, and flags a hash change, because a run made against last month's
 * wording is not comparable with one made against today's. Edit the text and
 * the old runs stay where they are, visibly older.
 *
 * `expects` is the cheap correctness signal for headless runs: regexes the final
 * answer must (or must not) match. It cannot judge an X++ answer the way the
 * eval loop's golden + build oracle does, but it catches the failures that
 * matter for a model comparison — the model that answered the wrong EDT, or
 * wrote `today()` after being told not to — and it costs nothing to run.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckResult, FileExpectation, PromptSpec } from './types.js';
import { readJsonLenient } from '../utils/jsonRecords.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function promptHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
}

export function isPromptSpec(x: unknown): x is PromptSpec {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  if (typeof s.id !== 'string' || !ID_PATTERN.test(s.id)) return false;
  if (typeof s.title !== 'string' || typeof s.prompt !== 'string' || s.prompt.trim().length === 0) return false;
  if (s.tags !== undefined && !(Array.isArray(s.tags) && s.tags.every(t => typeof t === 'string'))) return false;
  if (s.expects !== undefined) {
    if (!s.expects || typeof s.expects !== 'object') return false;
    const e = s.expects as Record<string, unknown>;
    for (const key of ['mustMatch', 'mustNotMatch']) {
      if (e[key] !== undefined && !isStringArray(e[key])) return false;
    }
    if (e.files !== undefined) {
      if (!Array.isArray(e.files) || !e.files.every(isFileExpectation)) return false;
      // File checks read the sandbox — a prompt without one has nothing to read.
      if (e.files.length > 0 && s.workspace === undefined) return false;
    }
  }
  if (s.workspace !== undefined) {
    if (!s.workspace || typeof s.workspace !== 'object') return false;
    const w = s.workspace as Record<string, unknown>;
    if (w.build !== undefined && typeof w.build !== 'boolean') return false;
  }
  if (s.timeoutSeconds !== undefined && !(typeof s.timeoutSeconds === 'number' && Number.isInteger(s.timeoutSeconds) && s.timeoutSeconds > 0)) {
    return false;
  }
  return true;
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(r => typeof r === 'string');
}

function isFileExpectation(x: unknown): x is FileExpectation {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  if (typeof f.path !== 'string' || f.path.length === 0) return false;
  if (f.name !== undefined && typeof f.name !== 'string') return false;
  if (f.contains !== undefined && !isStringArray(f.contains)) return false;
  if (f.notContains !== undefined && !isStringArray(f.notContains)) return false;
  return true;
}

/** Values the `{{…}}` placeholders of a workspace prompt are filled with. */
export interface PromptVars {
  /** Model name, e.g. fm-mcp. */
  model: string;
  /** <packageDir>/<model> — where the model's Ax* folders live. */
  modelDir: string;
  /** The sandbox package folder (Descriptor, the model folder, bin). */
  packageDir: string;
  /** PackagesLocalDirectory — where the standard application's metadata is. */
  packagesRoot: string;
  /**
   * The shell command that builds the sandbox (labels + xppc full build) and
   * prints the errors. Both variants get it: without it the plain agent cannot
   * check its work at all and "cheaper" only means "stopped sooner".
   */
  buildCommand: string;
}

const PLACEHOLDER = /\{\{\s*(model|modelDir|packageDir|packagesRoot|buildCommand)\s*\}\}/g;

/**
 * The text a cell actually sends. Without vars (no --sandbox, or a dry run) the
 * placeholders stay visible rather than turning into empty strings — a prompt
 * that says "write into the model ``" is a different experiment.
 */
export function renderPrompt(spec: PromptSpec, vars: PromptVars | null): string {
  if (!vars) return spec.prompt;
  return spec.prompt.replace(PLACEHOLDER, (_, key: keyof PromptVars) => vars[key]);
}

export function usesPlaceholders(text: string): boolean {
  return new RegExp(PLACEHOLDER.source).test(text);
}

/** One changed file of the sandbox, as the file checks see it. */
export interface ChangedFile {
  /** Relative to the sandbox package, forward slashes. */
  path: string;
  /** Reads the content on demand; null when it is gone or unreadable. */
  read: () => string | null;
}

/**
 * Score the files a cell wrote. A regex that does not compile fails its check
 * rather than throwing, as in {@link evaluateChecks}: the cell already ran.
 */
export function evaluateFileChecks(spec: PromptSpec, changed: ChangedFile[]): CheckResult[] {
  const expectations = spec.expects?.files ?? [];
  const compile = (pattern: string, flags: string): RegExp | null => {
    try {
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  };
  return expectations.map(exp => {
    const name = `file ${exp.name ?? exp.path}`;
    const pathRe = compile(exp.path, 'i');
    const contains = (exp.contains ?? []).map(p => compile(p, 'is'));
    const notContains = (exp.notContains ?? []).map(p => compile(p, 'is'));
    if (!pathRe || contains.includes(null) || notContains.includes(null)) return { name, passed: false };
    const passed = changed.some(f => {
      if (!pathRe.test(f.path)) return false;
      if (contains.length + notContains.length === 0) return true;
      const text = f.read();
      if (text === null) return false;
      return contains.every(re => re!.test(text)) && !notContains.some(re => re!.test(text));
    });
    return { name, passed };
  });
}

/** Every spec in `dir`, sorted by id. Throws, naming the file, on the first invalid one — a silently skipped prompt is a run that never happens. */
export function loadPromptSpecs(dir: string): PromptSpec[] {
  if (!fs.existsSync(dir)) return [];
  const specs: PromptSpec[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    let parsed: unknown;
    try {
      parsed = readJsonLenient(file);
    } catch (err) {
      throw new Error(`Prompt spec ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isPromptSpec(parsed)) {
      throw new Error(
        `Prompt spec ${file} is invalid — needs id (letters/digits/._-), title, prompt; optional tags[], ` +
          'expects{mustMatch[],mustNotMatch[],files[{path,contains[],notContains[]}]} (files need workspace{}), workspace{build}, timeoutSeconds',
      );
    }
    const base = path.basename(f, '.json');
    if (base !== parsed.id) {
      throw new Error(`Prompt spec ${file}: id '${parsed.id}' must equal the file name '${base}'`);
    }
    specs.push({ ...parsed, tags: parsed.tags ?? [] });
  }
  return specs;
}

export function loadPromptSpec(dir: string, id: string): PromptSpec {
  const spec = loadPromptSpecs(dir).find(s => s.id === id);
  if (!spec) {
    const known = loadPromptSpecs(dir).map(s => s.id);
    throw new Error(`No prompt '${id}' in ${dir}. Known prompts: ${known.length ? known.join(', ') : '(none)'}`);
  }
  return spec;
}

/** An ad-hoc spec for a prompt given on the command line (never written to the catalogue). */
export function adHocPromptSpec(id: string, prompt: string): PromptSpec {
  if (!ID_PATTERN.test(id)) throw new Error(`Prompt id '${id}' may contain only letters, digits, '.', '_' and '-'`);
  return { id, title: id, prompt, tags: ['ad-hoc'] };
}

/**
 * Score the final answer against the spec's expectations.
 *
 * Flags `is`: X++ identifiers are case-insensitive, so a check written as
 * `CustAccount` must accept `custAccount`. A regex that does not compile is a
 * failed check named after itself rather than a crash — the run already
 * happened and cost money; the record must still be written.
 */
export function evaluateChecks(spec: PromptSpec, answer: string | null): { checks: CheckResult[]; score: number | null } {
  const must = spec.expects?.mustMatch ?? [];
  const mustNot = spec.expects?.mustNotMatch ?? [];
  if (must.length + mustNot.length === 0) return { checks: [], score: null };
  const text = answer ?? '';
  const checks: CheckResult[] = [];
  const test = (pattern: string): boolean | null => {
    try {
      return new RegExp(pattern, 'is').test(text);
    } catch {
      return null;
    }
  };
  for (const pattern of must) {
    const hit = test(pattern);
    checks.push({ name: `matches ${pattern}`, passed: hit === true });
  }
  for (const pattern of mustNot) {
    const hit = test(pattern);
    checks.push({ name: `avoids ${pattern}`, passed: hit === false });
  }
  const passed = checks.filter(c => c.passed).length;
  return { checks, score: passed / checks.length };
}
