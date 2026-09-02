/**
 * The construct probe — match every construct in `termMap.ts` against what this
 * repo actually contains, and report the zeros.
 *
 * This is the measurement that produced the v4 coverage plan. `eval/COVERAGE.md`
 * counts one leaf per artifact kind and read 100% while, one level below it, 147
 * of 266 reporting constructs and 120 of 178 testing constructs had no line
 * anywhere in the knowledge base. Neither number is wrong; they measure different
 * things, and this one is the one a developer feels.
 *
 * Four source groups, matched independently so a gap can be attributed:
 *   K  knowledge, op-specs, prepare, prompts   — does the server TEACH it?
 *   V  validators + the lexer                  — does the server CHECK it?
 *   T  generators, writers, XML, metadata      — can the server WRITE it?
 *   E  eval case specs + goldens               — is there PROOF it works?
 *
 * It runs with no D365FO install: the sources are this repo. What it cannot do is
 * tell you whether a zero matters — that is triage, and the header of
 * `termMap.ts` lists the three ways a zero lies. Treat the output as a candidate
 * list, the way `oracle:kernel-enums` output is a candidate list.
 *
 * Usage:
 *   npm run oracle:terms                       # summary table + gap lists
 *   npm run oracle:terms -- --axis M           # one axis, every term
 *   npm run oracle:terms -- --core             # hide `exotic` terms
 *   npm run oracle:terms -- --json terms.json  # the full 1,800-row table
 *
 * Exit code is always 0: a gap is not a failure, it is a plan item.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AXES, type Axis, type Term, TERM_COUNT } from './termMap.js';
import { parseArgs, REPO_ROOT } from './aotSource.js';

type Group = 'K' | 'V' | 'T' | 'E';

/**
 * What each group reads.
 *
 * Directories, not globs, so adding a knowledge file cannot silently fall outside
 * the measurement. `E` reaches into `eval/`, which biome ignores and tsc does not
 * compile — it is data, and it is read as data here.
 */
const GROUP_SOURCES: Record<Group, { dirs: string[]; files?: string[]; exts: string[] }> = {
  K: {
    dirs: ['src/tools/knowledge', 'src/knowledge', 'src/tools/specs', 'src/tools/prepare', 'src/prompts'],
    exts: ['.ts'],
  },
  V: {
    dirs: ['src/tools/analysis', 'src/validation'],
    files: ['src/tools/write/inlineXppValidation.ts', 'src/utils/xppLexer.ts', 'src/utils/xppSelectLint.ts'],
    exts: ['.ts'],
  },
  T: {
    dirs: ['src/tools/write', 'src/tools/xml', 'src/tools/smart', 'src/tools/sdlc', 'src/metadata'],
    files: ['src/tools/generateObject.ts', 'src/tools/d365foFile.ts'],
    exts: ['.ts'],
  },
  E: {
    dirs: ['eval/cases', 'eval/goldens', 'eval/systests'],
    exts: ['.json', '.xml', '.md', '.xpp'],
  },
};

interface Row {
  axis: string;
  axisTitle: string;
  term: string;
  weight: 'core' | 'exotic';
  K: number;
  V: number;
  T: number;
  E: number;
}

function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, exts, acc);
    } else if (exts.includes(path.extname(e.name))) {
      acc.push(p);
    }
  }
  return acc;
}

/** One concatenated blob per group — the probe asks "does this string occur", not "where". */
function readGroup(group: Group): { text: string; files: number } {
  const spec = GROUP_SOURCES[group];
  const files = [
    ...spec.dirs.flatMap(d => walk(path.join(REPO_ROOT, d), spec.exts)),
    ...(spec.files ?? []).map(f => path.join(REPO_ROOT, f)),
  ];
  const parts: string[] = [];
  let read = 0;
  for (const f of files) {
    try {
      parts.push(fs.readFileSync(f, 'utf-8'));
      read++;
    } catch {
      // A file that vanished between the walk and the read tells us nothing.
    }
  }
  return { text: parts.join('\n'), files: read };
}

/**
 * The matcher for a term without an explicit regex: the name as a whole word,
 * case-insensitively.
 *
 * Word boundaries are applied only where the name actually starts/ends with a
 * word character — `\b` next to `#` or `@` never matches, which is how the first
 * version of this probe reported every macro directive as absent.
 */
export function termRegex(term: Term): RegExp {
  if (term.re) return new RegExp(term.re.source, term.re.flags.includes('g') ? term.re.flags : `${term.re.flags}g`);
  const escaped = term.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(term.name) ? '\\b' : '';
  const trail = /\w$/.test(term.name) ? '\\b' : '';
  return new RegExp(`${lead}${escaped}${trail}`, 'gi');
}

function count(re: RegExp, text: string): number {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

export function probe(axes: Axis[] = AXES): { rows: Row[]; groupFiles: Record<Group, number> } {
  const groups: Group[] = ['K', 'V', 'T', 'E'];
  const text = {} as Record<Group, string>;
  const groupFiles = {} as Record<Group, number>;
  for (const g of groups) {
    const read = readGroup(g);
    text[g] = read.text;
    groupFiles[g] = read.files;
  }

  const rows: Row[] = [];
  for (const axis of axes) {
    for (const term of axis.terms) {
      const re = termRegex(term);
      rows.push({
        axis: axis.id,
        axisTitle: axis.title,
        term: term.name,
        weight: term.weight ?? 'core',
        K: count(re, text.K),
        V: count(re, text.V),
        T: count(re, text.T),
        E: count(re, text.E),
      });
    }
  }
  return { rows, groupFiles };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const wantAxis = typeof args.axis === 'string' ? args.axis.toUpperCase().split(',') : undefined;
  const coreOnly = args.core === true;

  const axes = wantAxis ? AXES.filter(a => wantAxis.includes(a.id)) : AXES;
  if (wantAxis && !axes.length) {
    console.error(`no axis matches "${args.axis}". Axes: ${AXES.map(a => a.id).join(' ')}`);
    process.exit(2);
  }

  const started = Date.now();
  const { rows: allRows, groupFiles } = probe(axes);
  const rows = coreOnly ? allRows.filter(r => r.weight === 'core') : allRows;

  console.log(
    `probed ${rows.length} of ${TERM_COUNT} constructs against ` +
    `K:${groupFiles.K} V:${groupFiles.V} T:${groupFiles.T} E:${groupFiles.E} files ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  console.log('\n| axis | title | terms | K=0 | K≤2 | K>0,E=0 |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const axis of axes) {
    const mine = rows.filter(r => r.axis === axis.id);
    if (!mine.length) continue;
    console.log(
      `| ${axis.id} | ${axis.title} | ${mine.length} | ${mine.filter(r => r.K === 0).length} | ` +
      `${mine.filter(r => r.K > 0 && r.K <= 2).length} | ${mine.filter(r => r.K > 0 && r.E === 0).length} |`,
    );
  }

  for (const axis of axes) {
    const mine = rows.filter(r => r.axis === axis.id);
    const untaught = mine.filter(r => r.K === 0);
    const thin = mine.filter(r => r.K > 0 && r.K <= 2);
    if (!untaught.length && !thin.length) continue;
    console.log(`\n## ${axis.id}. ${axis.title}`);
    if (untaught.length) {
      console.log(`  not taught (K=0): ${untaught.map(r => label(r)).join(' · ')}`);
    }
    if (thin.length) {
      console.log(`  thin (K≤2): ${thin.map(r => `${r.term}(${r.K})`).join(' · ')}`);
    }
  }

  if (typeof args.json === 'string') {
    fs.writeFileSync(
      args.json,
      `${JSON.stringify({ probedAt: new Date().toISOString(), groupFiles, rows: allRows }, null, 2)}\n`,
      'utf8',
    );
    console.log(`\n→ ${args.json}`);
  }
}

/** A K=0 row is more interesting when the other groups DO know the term. */
function label(r: Row): string {
  const marks = [r.V ? `V${r.V}` : '', r.T ? `T${r.T}` : '', r.E ? `E${r.E}` : ''].filter(Boolean).join(',');
  return marks ? `${r.term}[${marks}]` : r.term;
}

if (process.argv[1] && /termProbe\.ts$/.test(process.argv[1])) main();
