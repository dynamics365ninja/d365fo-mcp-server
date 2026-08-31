/**
 * The shipped-source census — count what Microsoft's X++ actually contains.
 *
 * A compile probe answers "is this legal?". The census answers the question that
 * decides whether a rule or a knowledge entry is worth writing: **does anyone
 * write it, and how?** Both answers have overturned plans here. `forceLiterals`
 * is legal AND used 57 times in 19 Microsoft files, so a rule calling it
 * forbidden was wrong; `#globaldefine` is legal and used 0 times, so teaching it
 * first would have been noise.
 *
 * Counting runs on MASKED source (`src/utils/xppLexer.ts`), so a keyword inside a
 * string literal or a comment is not counted — the same masker the validator
 * uses, which keeps the two measurements comparable.
 *
 * Usage:
 *   npm run oracle:census                                   # built-in pattern set
 *   npm run oracle:census -- --dry                          # fixture corpus (CI)
 *   npm run oracle:census -- --types AxReport --patterns rdl
 *   npm run oracle:census -- --grep "SysComputedColumn::\\w+" --examples 5
 *   npm run oracle:census -- --sample 500 --out sample.json  # blocks for the lexer test
 *
 * `--examples N` prints N real excerpts per pattern: a count says "used", an
 * excerpt says "used LIKE THIS", and the second is what a knowledge rule needs.
 */
import * as fs from 'fs';
import { maskXpp } from '../../src/utils/xppLexer.js';
import { parseArgs, walkOptionsFromArgs, walkXppSource } from './aotSource.js';

interface Pattern {
  name: string;
  re: RegExp;
  /** Count matches on the raw source instead of the masked copy (RDL, XML). */
  raw?: boolean;
}

/**
 * Pattern sets. Each set answers one open question from the coverage plan, so a
 * probe result can be checked against real usage in the same run.
 */
const PATTERN_SETS: Record<string, Pattern[]> = {
  /** Language constructs whose FREQUENCY decides teaching order. */
  language: [
    { name: 'using-statement', re: /\busing\s*\(/g },
    { name: 'throw-rethrow', re: /\bthrow\s*;/g },
    { name: 'typed-clr-catch', re: /\bcatch\s*\(\s*\w+\s*\)/g },
    { name: 'select-expression', re: /\(\s*select\s+(firstonly\s+)?\w+/gi },
    { name: 'crossCompany-literal', re: /crossCompany\s*:\s*\[/gi },
    { name: 'forceLiterals', re: /\bforceLiterals\b/gi },
    { name: 'firstonly1', re: /\bfirstonly1\b/gi },
    { name: 'in-operator', re: /\)\s*\bin\b\s+\w+/gi },
    { name: 'compound-mul-assign', re: /[^*]\*=[^=]/g },
    { name: 'compound-div-assign', re: /\/=[^=]/g },
    { name: 'verbatim-string', re: /@["']/g },
    { name: 'at-identifier', re: /(?<![\w"'])@[A-Za-z_]\w*(?![\w"'])/g },
    { name: 'array-decl', re: /\b(int|real|str|boolean)\s+\w+\s*\[\s*\d*\s*[,\d]*\s*\]/g },
    { name: 'local-function', re: /^\s{4,}\w[\w\s]*\s+\w+\s*\([^)]*\)\s*$/gm },
    { name: 'prmIsDefault', re: /\bprmIsDefault\s*\(/gi },
    { name: 'pack-unpack', re: /\b(pack|unpack)\s*\(\s*\)/g },
    { name: 'CurrentVersion-macro', re: /#CurrentVersion\b/g },
    { name: 'SysPackable', re: /\bSysPackable\b/g },
  ],
  /** Data access — the shapes SEL* rules key on. */
  select: [
    { name: 'while-select', re: /\bwhile\s+select\b/gi },
    { name: 'orderby-then-where', re: /\border\s+by\b[\s\S]{0,200}?\bwhere\b/gi },
    { name: 'where-then-orderby', re: /\bwhere\b[\s\S]{0,200}?\border\s+by\b/gi },
    { name: 'insert_recordset', re: /\binsert_recordset\b/gi },
    { name: 'update_recordset', re: /\bupdate_recordset\b/gi },
    { name: 'delete_from', re: /\bdelete_from\b/gi },
    { name: 'set-based-no-where', re: /\b(update_recordset|delete_from)\b(?:(?!\bwhere\b|;)[\s\S]){0,300}?;/gi },
    { name: 'skip-methods', re: /\bskip(DataMethods|DatabaseLog|Events|AosValidation|DeleteActions|DeleteMethod)\b/g },
    { name: 'RecordInsertList', re: /\bRecordInsertList\b/g },
    { name: 'validTimeState', re: /\bvalidTimeState\s*\(/gi },
    { name: 'QueryFilter', re: /\bQueryFilter\b/g },
    { name: 'addLink', re: /\.addLink\s*\(/g },
    { name: 'SysQuery-statics', re: /\bSysQuery::\w+/g },
    { name: 'SysQueryRangeUtil', re: /\bSysQueryRangeUtil\b/g },
    { name: 'QueryRangeFunction-attr', re: /\[\s*QueryRangeFunction/g },
    { name: 'SysComputedColumn', re: /\bSysComputedColumn::\w+/g },
  ],
  /** Reporting — P10/P11/P14 of the plan's probe list. */
  reporting: [
    { name: 'rdl-Fields', re: /=Fields!/g, raw: true },
    { name: 'rdl-Parameters', re: /=Parameters!/g, raw: true },
    { name: 'rdl-Labels', re: /=Labels!/g, raw: true },
    { name: 'rdl-ReportItems', re: /=ReportItems!/g, raw: true },
    { name: 'rdl-Code-block', re: /<Code>/g, raw: true },
    { name: 'AX_CompanyName', re: /AX_CompanyName/g, raw: true },
    { name: 'AX_RenderingCulture', re: /AX_RenderingCulture/g, raw: true },
    { name: 'AX_ReportContext', re: /AX_ReportContext/g, raw: true },
    { name: 'AX_UserContext', re: /AX_UserContext/g, raw: true },
    { name: 'AX_PartitionKey', re: /AX_PartitionKey/g, raw: true },
    { name: 'AutoDesign', re: /AutoDesign/g, raw: true },
    { name: 'PrecisionDesign', re: /PrecisionDesign/g, raw: true },
    { name: 'DynamicFilters', re: /Dynamic\s*Filters/gi, raw: true },
    { name: 'SRSReportQueryAttribute', re: /SRSReportQueryAttribute/g },
    { name: 'parmQueryContracts', re: /parmQueryContracts/g },
    { name: 'parmEMailContract', re: /parmEMailContract/g },
    { name: 'parmPrintToArchive', re: /parmPrintToArchive/g },
    { name: 'SRSPrintMediumType', re: /SRSPrintMediumType::\w+/g },
    { name: 'SRSReportFileFormat', re: /SRSReportFileFormat::\w+/g },
    { name: 'renderReportToByteArray', re: /renderReportToByteArray/g },
    { name: 'SRSReportRunService', re: /\bSRSReportRunService\b/g },
    { name: 'SRSProxy', re: /\bSRSProxy\b/g },
    { name: 'CompanyImage', re: /\bCompanyImage::\w+/g },
    { name: 'DocuBrand', re: /\bDocuBrand\w*/g },
    { name: 'Barcode-construct', re: /\bBarcode::construct\s*\(/g },
    { name: 'BarcodeType', re: /\bBarcodeType::\w+/g },
  ],
  /** Macro libraries — H1.9 teaches the top of this list, not all of it. */
  macros: [
    { name: 'macrolib-include', re: /^\s*#\w+/gm },
    { name: 'InventDimDevelop', re: /#InventDimDevelop\b/g },
    { name: 'ISOCountryRegionCodes', re: /#ISOCountryRegionCodes\b/g },
    { name: 'Properties', re: /#Properties\b/g },
    { name: 'AOT', re: /#AOT\b/g },
    { name: 'File', re: /#File\b/g },
    { name: 'Excel', re: /#Excel\b/g },
    { name: 'SysFormLookup', re: /#SysFormLookup\b/g },
    { name: 'define-dot', re: /#define\.\w+/g },
    { name: 'localmacro', re: /#localmacro\.\w+/g },
    { name: 'globaldefine', re: /#globaldefine/g },
    { name: 'defInc', re: /#defInc\b/g },
  ],
  /** System objects and dialogs — H1.1's evidence base. */
  system: [
    { name: 'Box-statics', re: /\bBox::\w+/g },
    { name: 'Debug-statics', re: /\bDebug::\w+/g },
    { name: 'infolog-instance', re: /\binfolog\.\w+/g },
    { name: 'xSession', re: /\bnew\s+xSession\b|\bxSession\b/g },
    { name: 'xInfo', re: /\bxInfo\b/g },
    { name: 'xUserInfo', re: /\bxUserInfo\b/g },
    { name: 'xGlobal', re: /\bxGlobal\b/g },
    { name: 'classFactory', re: /\bclassFactory\b/g },
    { name: 'SysInfoAction', re: /\bSysInfoAction\w*/g },
    { name: 'setPrefix', re: /\bsetPrefix\s*\(/g },
    { name: 'SysOperationProgress', re: /\bSysOperationProgress\b/g },
    { name: 'RunbaseProgress', re: /\bRunbaseProgress\b/g },
    { name: 'SysTableLookup', re: /\bSysTableLookup\b/g },
    { name: 'SysReferenceTableLookup', re: /\bSysReferenceTableLookup\b/g },
    { name: 'SysLookupMultiSelect', re: /\bSysLookupMultiSelect\w*/g },
    { name: 'registerOverrideMethod', re: /\bregisterOverrideMethod\s*\(/g },
    { name: 'SuppressBPWarning', re: /\bSuppressBPWarning\b/g },
    { name: 'AifQueryTypeAttribute', re: /\bAifQueryTypeAttribute\b/g },
    { name: 'SysOperationHelper', re: /\bSysOperationHelper::\w+/g },
    { name: 'HttpClient', re: /\bSystem\.Net\.Http\.HttpClient\b|\bHttpClient\b/g },
    { name: 'FormJsonSerializer', re: /\bFormJsonSerializer::\w+/g },
    { name: 'Newtonsoft', re: /\bNewtonsoft\b/g },
    { name: 'DocumentManagement', re: /\bDocumentManagement::\w+/g },
    { name: 'DocuRef', re: /\bDocuRef\b/g },
    { name: 'SysMailerMessageBuilder', re: /\bSysMailerMessageBuilder\b/g },
    { name: 'SysMailerFactory', re: /\bSysMailerFactory::\w+/g },
    { name: 'SecurityRights', re: /\bSecurityRights::\w+/g },
    { name: 'hasMenuItemAccess', re: /\bhasMenuItemAccess\s*\(/g },
    { name: 'isSystemAdministrator', re: /\bisSystemAdministrator\s*\(/g },
  ],
};

interface Tally {
  pattern: string;
  hits: number;
  files: number;
  examples: { file: string; excerpt: string }[];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const walkOptions = walkOptionsFromArgs(args);
  const exampleCount = typeof args.examples === 'string' ? Number(args.examples) : 2;

  // --sample writes raw CDATA blocks for the lexer conformance test (H0.3).
  if (typeof args.sample === 'string') {
    sample(Number(args.sample), typeof args.out === 'string' ? args.out : 'sample.json', walkOptions);
    return;
  }

  let patterns: Pattern[];
  if (typeof args.grep === 'string') {
    patterns = [{ name: args.grep, re: new RegExp(args.grep, 'g'), raw: args.raw === true }];
  } else if (typeof args.patterns === 'string' && args.patterns !== 'builtin') {
    patterns = args.patterns.split(',').flatMap(set => {
      const found = PATTERN_SETS[set];
      if (!found) throw new Error(`unknown pattern set '${set}' (have: ${Object.keys(PATTERN_SETS).join(', ')})`);
      return found;
    });
  } else {
    patterns = Object.values(PATTERN_SETS).flat();
  }

  const tallies = new Map<string, Tally>();
  for (const p of patterns) tallies.set(p.name, { pattern: p.name, hits: 0, files: 0, examples: [] });

  const started = Date.now();
  let blocks = 0;
  let bytes = 0;
  const seenFilesPerPattern = new Map<string, Set<string>>();

  for (const block of walkXppSource(walkOptions)) {
    blocks++;
    bytes += block.source.length;
    const masked = maskXpp(block.source);
    for (const p of patterns) {
      const haystack = p.raw ? block.source : masked;
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let matched = false;
      while ((m = p.re.exec(haystack)) !== null) {
        const t = tallies.get(p.name);
        if (!t) break;
        t.hits++;
        matched = true;
        if (t.examples.length < exampleCount) {
          // Excerpt from the RAW source: the masked copy would show blanks.
          t.examples.push({
            file: `${block.packageName}/${block.type}/${block.name}`,
            excerpt: block.source.slice(Math.max(0, m.index - 40), m.index + 90).replace(/\s+/g, ' ').trim(),
          });
        }
        if (m.index === p.re.lastIndex) p.re.lastIndex++; // zero-length guard
      }
      if (matched) {
        const set = seenFilesPerPattern.get(p.name) ?? new Set<string>();
        set.add(block.file);
        seenFilesPerPattern.set(p.name, set);
      }
    }
    if (blocks % 20000 === 0) process.stderr.write(`  …${blocks} blocks\n`);
  }

  for (const [name, set] of seenFilesPerPattern) {
    const t = tallies.get(name);
    if (t) t.files = set.size;
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `censused ${blocks} CDATA blocks (${(bytes / 1024 / 1024).toFixed(1)} MB) in ${seconds}s` +
    `${walkOptions.dry ? ' [dry: fixture corpus]' : ''}\n`,
  );

  const rows = [...tallies.values()].sort((a, b) => b.hits - a.hits);
  const width = Math.max(...rows.map(r => r.pattern.length));
  for (const r of rows) {
    console.log(`${r.pattern.padEnd(width)}  ${String(r.hits).padStart(7)} hits  ${String(r.files).padStart(6)} files`);
    for (const ex of r.examples) console.log(`${' '.repeat(width + 2)}  ${ex.file}: ${ex.excerpt.slice(0, 130)}`);
  }

  if (typeof args.out === 'string') {
    fs.writeFileSync(args.out, `${JSON.stringify({
      censusedAt: new Date().toISOString(),
      dry: Boolean(walkOptions.dry),
      blocks,
      bytes,
      tallies: rows,
    }, null, 2)}\n`, 'utf8');
    console.log(`\n→ ${args.out}`);
  }
}

/**
 * Write N CDATA blocks chosen for lexical DIVERSITY, not at random: the lexer
 * conformance test needs the awkward literals (verbatim strings, doubled quotes,
 * escapes, `#macro` text, `/* *\/` inside strings), and uniform sampling of
 * 1.1M blocks mostly returns plumbing.
 */
function sample(n: number, out: string, walkOptions: Parameters<typeof walkXppSource>[0]): void {
  const interesting = [
    /@["']/, /\\\\/, /''/, /""/, /\/\*/, /#\w+/, /'[^']*"/, /"[^"]*'/, /\\"/, /\\'/,
  ];
  const picked: { file: string; source: string }[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const block of walkXppSource(walkOptions)) {
    scanned++;
    if (block.source.length > 8000) continue;
    const score = interesting.filter(re => re.test(block.source)).length;
    if (score < 2) continue;
    const key = `${block.packageName}/${block.type}/${block.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ file: key, source: block.source });
    if (picked.length >= n) break;
  }

  fs.writeFileSync(out, `${JSON.stringify({
    sampledAt: new Date().toISOString(),
    scanned,
    picked: picked.length,
    blocks: picked,
  }, null, 2)}\n`, 'utf8');
  console.log(`sampled ${picked.length} lexically interesting blocks out of ${scanned} scanned → ${out}`);
}

main();
