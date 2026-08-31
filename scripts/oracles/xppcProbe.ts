/**
 * The compile probe — ask xppc directly, in a real model, and read its own words.
 *
 * The rule this harness exists to enforce: **a probe that reports nothing is not
 * a probe that passed.** An earlier probe "cleared" `display static` because the
 * method's name inside the X++ did not match its XML `<Name>`, so the body was
 * never compiled and the log was silent. Silence looked like success. Two things
 * prevent a repeat:
 *
 *  1. The `<Name>` element is DERIVED from the method source (never passed in),
 *     and a source whose signature cannot be parsed is refused before the build.
 *  2. Every batch carries a negative control that must fail. If the control's
 *     diagnostic is missing from the log, the run is declared INVALID and no
 *     probe result is reported — because the build, the model or the grep is
 *     broken, and every "compiles" in that log is meaningless.
 *
 * Probe classes are written into the sandbox model's AxClass folder, compiled in
 * one build (~90-170 s regardless of count, so batch generously), then deleted.
 * Semantic errors do not cascade between methods, so many probes can share a
 * class; a PARSE-level probe must be alone, because it kills the whole file.
 *
 * Usage:
 *   npx tsx scripts/oracles/xppcProbe.ts --file scripts/oracles/probes/p05-queryrange.ts
 *   npx tsx scripts/oracles/xppcProbe.ts --inline "int i = 1.5;" --id ConvReal
 *
 * A probe file default-exports `Probe[]`. Results print as a table and, with
 * `--json out.json`, land in a file the plan can cite.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGES_ROOT, parseArgs, REPO_ROOT } from './aotSource.js';

export interface Probe {
  /** Short id; the class becomes `ConProbe<id>`. Letters and digits only. */
  id: string;
  /** What this probe decides — printed with the result, so a log is self-explaining. */
  question: string;
  /** Method body. Wrapped in `public void run()` unless `methods` is given. */
  body?: string;
  /** Full method sources, for probes about signatures/modifiers. Names are derived. */
  methods?: string[];
  /** Class declaration LINE (no braces); defaults to `public class <ConProbeX>`. */
  declaration?: string;
  /**
   * Class-level members — fields and macro definitions — placed inside the
   * declaration's braces. `pack()`/`unpack()` probes need both, and a `#define`
   * only resolves when it is declared here.
   */
  fields?: string;
  /** Variables declared before the body (a typed CLR catch needs one, for instance). */
  locals?: string;
  /** Isolate this probe in its own build pass — parse errors kill the whole file. */
  parseLevel?: boolean;
  /** What the author expects, so the report can flag a surprise. */
  expect?: 'compiles' | 'fails';
}

export interface ProbeResult extends Probe {
  compiled: boolean;
  diagnostics: string[];
  surprise: boolean;
}

const MODEL = process.env.PROBE_MODEL ?? 'fm-mcp';
const CLASS_DIR = `${PACKAGES_ROOT}/${MODEL}/${MODEL}/AxClass`;
const XPPC = `${PACKAGES_ROOT}/bin/xppc.exe`;
const TMP = path.join(REPO_ROOT, '.oracle-probes');

/**
 * The negative control. It must produce a diagnostic naming a symbol that cannot
 * exist; if it does not, the log is not telling us about this build.
 */
const CONTROL: Probe = {
  id: 'NegativeControl',
  question: 'CONTROL — must fail, proving the build compiled these files at all',
  body: 'ConProbeNoSuchSymbolAnywhere::definitelyNotAMethod();',
  expect: 'fails',
};

/** Derive the X++ method name from its source. Refuses anything it cannot read. */
export function methodNameOf(source: string): string {
  // Skip attributes and doc comments, then read the identifier before the '('.
  const cleaned = source
    .replace(/\/\/\/[^\n]*/g, '')
    .replace(/^\s*\[[^\]]*\]\s*$/gm, '');
  const m = /(?:^|\n)\s*(?:[A-Za-z_][\w:<>.]*\s+)*?([A-Za-z_]\w*)\s*\(/.exec(cleaned);
  if (!m) {
    throw new Error(
      `cannot derive a method name from this source — the XML <Name> would not match ` +
      `and the body would never be compiled:\n${source.slice(0, 200)}`,
    );
  }
  return m[1];
}

/**
 * The class name the artifact must carry.
 *
 * Derived from the declaration when it names one, because xppc refuses a file
 * whose `<Name>` disagrees with its source ("the name in the source code
 * declaration 'X_Extension' does not match the artifact name 'X'") — and a probe
 * that cannot be written is better than one written under a name whose body the
 * compiler then ignores.
 */
export function classNameOf(probe: Probe): string {
  const declared = probe.declaration ? /\b(?:class|interface)\s+([A-Za-z_]\w*)/.exec(probe.declaration) : null;
  return declared ? declared[1] : `ConProbe${probe.id}`;
}

function classXml(probe: Probe): string {
  const cls = classNameOf(probe);
  const methods = probe.methods ?? [
    `    public void run()\n    {\n        ${probe.locals ? `${probe.locals}\n        ` : ''}${probe.body ?? ''}\n    }`,
  ];
  const methodXml = methods.map(source => {
    const name = methodNameOf(source);
    return `\t\t\t<Method>\n\t\t\t\t<Name>${name}</Name>\n\t\t\t\t<Source><![CDATA[\n${source}\n]]></Source>\n\t\t\t</Method>`;
  }).join('\n');

  const declaration = probe.declaration ?? `public class ${cls}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${cls}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
${declaration}
{
${probe.fields ?? ''}
}
]]></Declaration>
\t\t<Methods>
${methodXml}
\t\t</Methods>
\t</SourceCode>
</AxClass>
`;
}

function build(logPath: string): string {
  try { fs.unlinkSync(logPath); } catch { /* fresh run */ }
  spawnSync(XPPC, [
    `-metadata=${PACKAGES_ROOT}`, `-compilermetadata=${PACKAGES_ROOT}`, `-modelmodule=${MODEL}`,
    `-referenceFolder=${PACKAGES_ROOT}`, `-output=${PACKAGES_ROOT}/${MODEL}/bin`,
    `-log=${logPath}`, '-verbose',
  ], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, timeout: 45 * 60 * 1000 });
  try { return fs.readFileSync(logPath, 'utf-8'); } catch { return ''; }
}

/** Compile one batch of probes and read the diagnostics back per probe. */
export function runProbeBatch(probes: Probe[], passName: string): ProbeResult[] {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(CLASS_DIR, { recursive: true });
  const batch = [...probes, CONTROL];
  const written: string[] = [];

  try {
    for (const probe of batch) {
      const file = path.join(CLASS_DIR, `${classNameOf(probe)}.xml`);
      fs.writeFileSync(file, classXml(probe), 'utf8');
      written.push(file);
    }

    process.stderr.write(`  building ${batch.length} probe classes (${passName})…\n`);
    const log = build(path.join(TMP, `${passName}.log`));
    const lines = log.split(/\r?\n/);

    /**
     * Diagnostics belonging to ONE probe.
     *
     * The marker must be followed by a delimiter. A plain `includes` let
     * `ConProbePrmIsDefault` collect `ConProbePrmIsDefaultArity`'s errors and
     * report the first probe as failing on the second's code — the wrong-object
     * failure mode this whole harness exists to avoid.
     */
    const diagnosticsFor = (probe: Probe): string[] => {
      const marker = new RegExp(`\\b${classNameOf(probe)}(?![A-Za-z0-9_])`);
      return lines
        .filter(l => marker.test(l) && /error|warning/i.test(l))
        // A "compiling …" progress line names the file too; keep only diagnostics.
        .filter(l => !/^\s*(Compiling|Building|Loading)/i.test(l))
        .map(l => l.trim());
    };

    const controlDiagnostics = diagnosticsFor(CONTROL);
    if (!controlDiagnostics.length) {
      throw new Error(
        `INVALID RUN: the negative control produced no diagnostic in ${passName}.log.\n` +
        'The build did not compile these files (wrong model? xppc failed? log path?), ' +
        'so every "compiles" in this batch would be a silence, not a pass.',
      );
    }

    return probes.map(probe => {
      const diagnostics = diagnosticsFor(probe);
      const compiled = !diagnostics.some(d => /\berror\b/i.test(d));
      return {
        ...probe,
        compiled,
        diagnostics,
        surprise: probe.expect ? (probe.expect === 'compiles') !== compiled : false,
      };
    });
  } finally {
    for (const file of written) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
  }
}

/** Run probes, isolating the parse-level ones into their own pass. */
export function runProbes(probes: Probe[]): ProbeResult[] {
  const semantic = probes.filter(p => !p.parseLevel);
  const parse = probes.filter(p => p.parseLevel);
  const results: ProbeResult[] = [];
  if (semantic.length) results.push(...runProbeBatch(semantic, 'semantic'));
  // Each parse-level probe kills its own file, so they can still share a build.
  if (parse.length) results.push(...runProbeBatch(parse, 'parse'));
  return results;
}

function report(results: ProbeResult[]): void {
  console.log('');
  for (const r of results) {
    const verdict = r.compiled ? 'COMPILES' : 'FAILS';
    const flag = r.surprise ? '  ⚠ SURPRISE (expected ' + r.expect + ')' : '';
    console.log(`${verdict.padEnd(9)} ${r.id}${flag}`);
    console.log(`          ${r.question}`);
    for (const d of r.diagnostics.slice(0, 4)) console.log(`          · ${d.slice(0, 220)}`);
  }
  const surprises = results.filter(r => r.surprise).length;
  console.log(`\n${results.length} probes, ${results.filter(r => r.compiled).length} compile, ${surprises} surprise(s).`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let probes: Probe[];

  if (typeof args.file === 'string') {
    const mod = await import(`file:///${path.resolve(args.file).replace(/\\/g, '/')}`);
    probes = (mod.default ?? mod.probes) as Probe[];
    if (!Array.isArray(probes)) throw new Error(`${args.file} must default-export an array of probes`);
  } else if (typeof args.inline === 'string') {
    probes = [{ id: typeof args.id === 'string' ? args.id : 'Inline', question: 'ad-hoc', body: args.inline }];
  } else {
    console.error('usage: xppcProbe.ts --file <probes.ts> | --inline "<x++ statement>" [--id Name] [--json out.json]');
    process.exit(2);
    return;
  }

  const results = runProbes(probes);
  report(results);
  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, `${JSON.stringify({
      probedAt: new Date().toISOString(),
      model: MODEL,
      packagesRoot: PACKAGES_ROOT,
      results,
    }, null, 2)}\n`, 'utf8');
    console.log(`→ ${args.json}`);
  }
}

// Only run the CLI when invoked directly, so the module can be imported.
if (process.argv[1] && /xppcProbe\.ts$/.test(process.argv[1])) {
  main().catch(err => { console.error(err.message ?? err); process.exit(1); });
}
