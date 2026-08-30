/**
 * Capture what the X++ COMPILER says about the language, into
 * eval/compiler-facts.snapshot.json.
 *
 * VM-only. Three sources, in order of authority:
 *
 *  1. The compiler's own tables, read by reflection (no guessing, no parsing):
 *       Bin/Microsoft.Dynamics.AX.Framework.Xlnt.XppParser.dll
 *         → XppParser.Keywords.KeywordHashSet   (reserved words)
 *         → XppParser.ExemptedKeywords.Keywords (reserved but usable as identifiers)
 *       Bin/Microsoft.Dynamics.AX.Framework.Xlnt.XppCore.dll
 *         → Metadata.XppCompiler.Intrinsics.IntrinsicFunctionInfo (name → arg count)
 *
 *  2. Compile probes for run-time function arity: a class calling `fn(1×9)` makes
 *     xppc answer "'fn' expects N argument(s), but 9 specified" (N = declared count,
 *     optional trailing parameters included), and a class calling `fn(1×k)` for
 *     k < N answers "'fn' is missing argument K of type 'T'" — the largest K over
 *     all failing k is the minimum arity. A function that answers neither is
 *     variadic; one that answers "does not denote a predefined function…" does not
 *     exist on this platform version.
 *
 *  3. Nothing else. Microsoft Learn is not an input: the X++ reference is
 *     incomplete and parts of it still describe AX 2012 behaviour.
 *
 * Usage (VM, from the repo root):
 *   npx tsx scripts/capture-compiler-facts.ts            # full capture
 *   npx tsx scripts/capture-compiler-facts.ts --tables   # reflection only (fast, no build)
 *
 * The snapshot is the ratchet for src/knowledge/compilerFacts.ts — see
 * tests/knowledge/compilerFacts.test.ts, which fails when the two disagree.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT = path.join(REPO_ROOT, 'eval', 'compiler-facts.snapshot.json');
const PACKAGES = process.env.PACKAGES_ROOT ?? 'K:/AosService/PackagesLocalDirectory';
const BIN = `${PACKAGES}/Bin`;
const MODEL = process.env.PROBE_MODEL ?? 'fm-mcp';
const CLASS_DIR = `${PACKAGES}/${MODEL}/${MODEL}/AxClass`;
const XPPC = `${PACKAGES}/bin/xppc.exe`;
const TMP = path.join(REPO_ROOT, '.compiler-facts');

/** Run a PowerShell snippet and return stdout. */
function ps(script: string): string {
  const proc = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`powershell failed: ${proc.stderr?.slice(0, 400)}`);
  return proc.stdout ?? '';
}

function captureTables(): {
  compilerVersion: string;
  keywords: string[];
  exemptedKeywords: string[];
  intrinsics: Record<string, number>;
} {
  const version = ps(
    `(Get-Item '${BIN}/xppc.exe').VersionInfo.FileVersion`,
  ).trim();

  const kw = ps(
    `$a=[Reflection.Assembly]::LoadFrom('${BIN}/Microsoft.Dynamics.AX.Framework.Xlnt.XppParser.dll');` +
    `$t=$a.GetType('Microsoft.Dynamics.AX.Framework.Xlnt.XppParser.Keywords');` +
    `$f=$t.GetField('KeywordHashSet',[Reflection.BindingFlags]'Public,NonPublic,Static');` +
    `($f.GetValue($null)) -join "\`n"`,
  );
  const exempt = ps(
    `$a=[Reflection.Assembly]::LoadFrom('${BIN}/Microsoft.Dynamics.AX.Framework.Xlnt.XppParser.dll');` +
    `$t=$a.GetType('Microsoft.Dynamics.AX.Framework.Xlnt.XppParser.ExemptedKeywords');` +
    `$f=$t.GetField('Keywords',[Reflection.BindingFlags]'Public,NonPublic,Static');` +
    `($f.GetValue($null)) -join "\`n"`,
  );
  const intr = ps(
    `[void][Reflection.Assembly]::LoadFrom('${BIN}/Microsoft.Dynamics.AX.Framework.Xlnt.XppCore.dll');` +
    `$a=[Reflection.Assembly]::LoadFrom('${BIN}/Microsoft.Dynamics.AX.Framework.Xlnt.XppCore.dll');` +
    `$t=$a.GetType('Microsoft.Dynamics.AX.Metadata.XppCompiler.Intrinsics');` +
    `$f=$t.GetField('IntrinsicFunctionInfo',[Reflection.BindingFlags]'Public,NonPublic,Static');` +
    `$d=$f.GetValue($null); foreach($k in $d.Keys){ "$k|" + $d[$k].Item2 }`,
  );

  const lines = (s: string) => s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const intrinsics: Record<string, number> = {};
  for (const l of lines(intr)) {
    const [name, count] = l.split('|');
    if (name) intrinsics[name] = Number(count);
  }
  return {
    compilerVersion: version,
    keywords: lines(kw).sort(),
    exemptedKeywords: lines(exempt).sort(),
    intrinsics: Object.fromEntries(Object.entries(intrinsics).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Candidate run-time functions to probe. Names only — the compiler decides the rest. */
const PROBE_FUNCTIONS = `
abs acos asin atan cos cosh sin sinh tan tanh exp exp10 frac log10 logN max min power round decRound trunc
corrFlagGet corrFlagSet cTerm ddb dg fV idg intvMax intvName intvNo intvNorm pmt pt pv rate sln syd term
conDel conFind conIns conLen conNull conPeek conPoke con2Str str2Con
any2Date any2Enum any2Guid any2Int any2Int64 any2Real any2Str char2Num date2Num date2Str datetime2Str enum2Str
guid2Str int2Str int642Str num2Char num2Date num2Str str2Date str2Datetime str2Enum str2Guid str2Int str2Int64
str2Num str2Time time2Str uint2Str enum2Symbol symbol2Enum enum2int enum2Value int2Enum
dayName dayOfMth dayOfWk dayOfYr endMth mkDate mthName mthOfYr nextMth nextQtr nextYr prevMth prevQtr prevYr
systemDateGet systemDateSet timeNow today wkOfYr year dateNull dateMax dateMin dateMthFwd dateEndMth dateStartMth
dateStartYr dateEndYr dateStartQtr dateEndQtr dateStartWk dateEndWk
classIdGet dimOf fieldId2Name fieldId2PName fieldName2Id indexId2Name indexName2Id refPrintAll tableId2Name
tableId2PName tableName2Id typeOf className2Id classId2Name enumName2Id typeName2Id
curExt curUserId funcName getCurrentPartition getCurrentPartitionRecId getPrefix sessionId runAs setPrefix
match strAlpha strCmp strColSeq strDel strFind strFmt strIns strKeep strLen strLine strLTrim strLwr strNFind
strPoke strPrompt strRem strRep strRTrim strScan strUpr subStr strReplace strSplit strStartsWith strEndsWith
strContains strLRTrim strRFix strLFix
beep newGuid sleep info warning error checkFailed
`.split(/\s+/).filter(Boolean);

const MAX_PROBE_ARGS = 9;

function classXml(name: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
\t<Name>${name}</Name>
\t<SourceCode>
\t\t<Declaration><![CDATA[
public class ${name}
{
}
]]></Declaration>
\t\t<Methods>
\t\t\t<Method>
\t\t\t\t<Name>run</Name>
\t\t\t\t<Source><![CDATA[
    public void run()
    {
        ${body}
    }
]]></Source>
\t\t\t</Method>
\t\t</Methods>
\t</SourceCode>
</AxClass>
`;
}

function build(logPath: string): string {
  try { fs.unlinkSync(logPath); } catch { /* fresh run */ }
  spawnSync(XPPC, [
    `-metadata=${PACKAGES}`, `-compilermetadata=${PACKAGES}`, `-modelmodule=${MODEL}`,
    `-referenceFolder=${PACKAGES}`, `-output=${PACKAGES}/${MODEL}/bin`, `-log=${logPath}`, '-verbose',
  ], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  try { return fs.readFileSync(logPath, 'utf-8'); } catch { return ''; }
}

function captureArities(): {
  runtimeFunctions: Record<string, { min: number; max: number | 'variadic' }>;
  unknownFunctions: string[];
  obsoleteFunctions: string[];
} {
  fs.mkdirSync(TMP, { recursive: true });
  const written: string[] = [];
  const write = (name: string, body: string) => {
    const p = path.join(CLASS_DIR, `${name}.xml`);
    fs.writeFileSync(p, classXml(name, body), 'utf8');
    written.push(p);
  };

  // Pass 1 — max arity + existence.
  for (const fn of PROBE_FUNCTIONS) {
    write(`ConFactsMax_${fn}`, `${fn}(${Array(MAX_PROBE_ARGS).fill('1').join(', ')});`);
  }
  const log1 = build(path.join(TMP, 'pass1.log'));
  for (const p of written.splice(0)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

  const max: Record<string, number | 'variadic'> = {};
  const unknown: string[] = [];
  const obsolete: string[] = [];
  for (const fn of PROBE_FUNCTIONS) {
    const own = log1.split(/\r?\n/).filter(l => l.includes(`ConFactsMax_${fn}/`));
    if (own.some(l => /does not denote a predefined function/.test(l))) { unknown.push(fn); continue; }
    if (own.some(l => /is obsolete/.test(l))) obsolete.push(fn);
    const m = own.map(l => /expects (\d+) argument\(s\)/.exec(l)).find(Boolean);
    max[fn] = m ? Number(m[1]) : 'variadic';
  }

  // Pass 2 — minimum arity: call with k < max args and read "is missing argument K".
  for (const [fn, mx] of Object.entries(max)) {
    if (mx === 'variadic') continue;
    for (let k = 0; k < mx; k++) {
      write(`ConFactsMin_${fn}_${k}`, `${fn}(${Array(k).fill('1').join(', ')});`);
    }
  }
  const log2 = build(path.join(TMP, 'pass2.log'));
  for (const p of written.splice(0)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

  const runtimeFunctions: Record<string, { min: number; max: number | 'variadic' }> = {};
  for (const [fn, mx] of Object.entries(max)) {
    if (mx === 'variadic') { runtimeFunctions[fn] = { min: 0, max: 'variadic' }; continue; }
    let min = 0;
    const re = new RegExp(`ConFactsMin_${fn}_\\d+/[\\s\\S]*?is missing argument (\\d+)`);
    for (const line of log2.split(/\r?\n/)) {
      if (!line.includes(`ConFactsMin_${fn}_`)) continue;
      const m = re.exec(line) ?? /is missing argument (\d+)/.exec(line);
      if (m) min = Math.max(min, Number(m[1]));
    }
    runtimeFunctions[fn] = { min, max: mx };
  }

  return {
    runtimeFunctions: Object.fromEntries(Object.entries(runtimeFunctions).sort(([a], [b]) => a.localeCompare(b))),
    unknownFunctions: unknown.sort(),
    obsoleteFunctions: [...new Set(obsolete)].sort(),
  };
}

/** Emit the runtime module from the snapshot, so nothing is hand-typed twice. */
function emitModule(snapshot: Record<string, unknown>): void {
  const target = path.join(REPO_ROOT, 'src', 'knowledge', 'compilerFacts.generated.ts');
  const j = (v: unknown) => JSON.stringify(v, null, 2);
  const body = `/**
 * GENERATED by scripts/capture-compiler-facts.ts — do not edit.
 *
 * What the X++ compiler itself says about the language, captured on a VM from
 * xppc ${snapshot.compilerVersion} (${String(snapshot.capturedAt).slice(0, 10)}):
 * the parser's reserved-word set and the compiler's intrinsic table by reflection,
 * run-time function arities by compile probe. See src/knowledge/compilerFacts.ts
 * for the helpers and eval/compiler-facts.snapshot.json for the raw capture.
 */

export const COMPILER_VERSION = ${j(snapshot.compilerVersion)};
export const COMPILER_FACTS_CAPTURED_AT = ${j(snapshot.capturedAt)};

/** Reserved words the parser rejects as identifiers. */
export const XPP_KEYWORDS: readonly string[] = ${j(snapshot.keywords)};

/** Reserved words the parser nevertheless accepts as identifiers. */
export const XPP_EXEMPTED_KEYWORDS: readonly string[] = ${j(snapshot.exemptedKeywords)};

/** Compile-time (intrinsic) functions → the number of arguments the compiler expects. */
export const XPP_INTRINSICS: Readonly<Record<string, number>> = ${j(snapshot.intrinsics)};

/** Run-time (predefined/Global) functions → the argument counts the compiler accepts. */
export const XPP_RUNTIME_FUNCTIONS: Readonly<Record<string, { min: number; max: number | 'variadic' }>> = ${j(snapshot.runtimeFunctions)};

/** Names that look like predefined functions but do not exist on this platform. */
export const XPP_UNKNOWN_FUNCTIONS: readonly string[] = ${j(snapshot.unknownFunctions)};

/** Predefined functions the compiler reports as obsolete. */
export const XPP_OBSOLETE_FUNCTIONS: readonly string[] = ${j(snapshot.obsoleteFunctions)};
`;
  fs.writeFileSync(target, body, 'utf8');
  console.log(`→ ${target}`);
}

function main(): void {
  if (process.argv.includes('--emit-only')) {
    emitModule(JSON.parse(fs.readFileSync(OUT, 'utf-8')));
    return;
  }
  const tablesOnly = process.argv.includes('--tables');
  const tables = captureTables();
  const previous = fs.existsSync(OUT)
    ? JSON.parse(fs.readFileSync(OUT, 'utf-8'))
    : { runtimeFunctions: {}, unknownFunctions: [], obsoleteFunctions: [] };
  const arity = tablesOnly
    ? {
      runtimeFunctions: previous.runtimeFunctions,
      unknownFunctions: previous.unknownFunctions,
      obsoleteFunctions: previous.obsoleteFunctions,
    }
    : captureArities();

  const snapshot = {
    capturedAt: new Date().toISOString(),
    compilerVersion: tables.compilerVersion,
    packagesRoot: PACKAGES,
    method: tablesOnly
      ? 'reflection only (--tables); run-time arities carried over from the previous capture'
      : 'reflection (keywords, intrinsics) + xppc probe builds (run-time function arities)',
    ...tables,
    ...arity,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(
    `compiler facts captured from xppc ${snapshot.compilerVersion}: ` +
    `${snapshot.keywords.length} keywords, ${Object.keys(snapshot.intrinsics).length} intrinsics, ` +
    `${Object.keys(snapshot.runtimeFunctions).length} run-time functions ` +
    `(${snapshot.unknownFunctions.length} unknown, ${snapshot.obsoleteFunctions.length} obsolete)`,
  );
  console.log(`→ ${OUT}`);
  emitModule(snapshot as unknown as Record<string, unknown>);
}

main();
