/**
 * The member oracle — what a framework class actually exposes, read from its own
 * AOT XML rather than from documentation or memory.
 *
 * Most knowledge defects this repo has shipped were of one shape: a method name
 * that sounds right and does not exist (`SysRunnable::run()`,
 * `assertExpectedException`, `initArgs()` on a report controller). The fix is not
 * to be more careful; it is to read the class before naming its members. This
 * makes that a one-liner.
 *
 * It also answers "is this kernel or AOT?", which decides whether a name needs an
 * entry in the knowledge-audit allow-list: a class with no AOT XML anywhere is
 * implemented in the kernel and the audit cannot resolve it (`FormEventArgs`,
 * `XppPrePostArgs`, `Uncheck`).
 *
 * Usage:
 *   npm run oracle:members -- SysTestCase SysTestAssert
 *   npm run oracle:members -- SrsReportRunController --grep parm
 *   npm run oracle:members -- Global --names-only
 *   npm run oracle:members -- Box Debug xInfo xUserInfo --json members.json
 *
 * Names are matched case-insensitively, and the reported spelling comes from the
 * `<Name>` element — never from the file name, which disagrees with it in real
 * cases (`SRSReportParameterAttribute.xml` holds `SrsReportParameterAttribute`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGES_ROOT, parseArgs } from './aotSource.js';

interface MemberReport {
  requested: string;
  found: boolean;
  /** Spelling from <Name>, which is authoritative. */
  name?: string;
  packageName?: string;
  type?: string;
  file?: string;
  declaration?: string;
  extends?: string;
  implements?: string[];
  attributes?: string[];
  methods?: { name: string; signature: string; attributes: string[] }[];
  /** For AxEnum: the literal names, in declaration order. */
  enumValues?: string[];
  /** Other AOT elements sharing this name, e.g. the form behind a table. */
  alsoFoundAs?: string[];
}

/** AOT folders that can hold a named element with members. */
const TYPE_DIRS = [
  'AxClass', 'AxTable', 'AxForm', 'AxQuery', 'AxView', 'AxMap', 'AxDataEntityView',
  // Enums answer a question the class list cannot: which members a rule may name
  // (Exception::, SRSPrintMediumType::, BarcodeType::) without inventing one.
  'AxEnum',
];

interface Location { file: string; packageName: string; type: string }

let index: Map<string, Location[]> | undefined;

/**
 * file-name → EVERY location, built once per process (a few seconds over ~105k
 * files).
 *
 * All of them, not the first: one name commonly denotes several elements
 * (`CompanyImage` is both a table and a form), and answering with whichever the
 * directory walk reached first is how a lookup silently reports a form's methods
 * as a class's. The same defect was found in the server's own resolver.
 */
function buildIndex(): Map<string, Location[]> {
  if (index) return index;
  const map = new Map<string, Location[]>();
  const dirs = (p: string) => {
    try { return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
    catch { return []; }
  };
  for (const pkg of dirs(PACKAGES_ROOT)) {
    for (const model of dirs(path.join(PACKAGES_ROOT, pkg))) {
      for (const type of TYPE_DIRS) {
        const dir = path.join(PACKAGES_ROOT, pkg, model, type);
        let entries: string[];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const entry of entries) {
          if (!entry.toLowerCase().endsWith('.xml')) continue;
          const key = entry.slice(0, -4).toLowerCase();
          const list = map.get(key) ?? [];
          list.push({ file: path.join(dir, entry), packageName: pkg, type });
          map.set(key, list);
        }
      }
    }
  }
  index = map;
  return map;
}

/**
 * Read one element's declaration and member list.
 *
 * When the name denotes several elements, `preferType` decides and the others are
 * reported in `alsoFoundAs` — never silently dropped.
 */
export function readMembers(requested: string, preferType?: string): MemberReport {
  const all = buildIndex().get(requested.toLowerCase()) ?? [];
  if (!all.length) return { requested, found: false };

  const hit = (preferType && all.find(l => l.type.toLowerCase() === preferType.toLowerCase())) ?? all[0];
  const alsoFoundAs = all
    .filter(l => l !== hit)
    .map(l => `${l.packageName}/${l.type}`);
  if (!preferType && alsoFoundAs.length) {
    console.warn(
      `  ! ${requested} denotes ${all.length} elements (${all.map(l => l.type).join(', ')}); ` +
      `reporting the ${hit.type}. Pass --type to choose.`,
    );
  }

  const xml = fs.readFileSync(hit.file, 'utf-8');
  const nameEl = /<Name>([^<]+)<\/Name>/.exec(xml);
  const declaration = /<Declaration><!\[CDATA\[([\s\S]*?)\]\]><\/Declaration>/.exec(xml)?.[1] ?? '';

  const declLine = declaration.split('\n').find(l => /\b(class|interface)\b/.test(l) && !l.trim().startsWith('//'))?.trim();
  const extendsM = declLine ? /\bextends\s+(\w+)/.exec(declLine) : null;
  const implementsM = declLine ? /\bimplements\s+([\w\s,]+)/.exec(declLine) : null;
  const classAttributes = [...declaration.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)].map(m => m[1].trim());

  const methods: { name: string; signature: string; attributes: string[] }[] = [];
  const methodRe = /<Method>\s*<Name>([^<]+)<\/Name>\s*<Source><!\[CDATA\[([\s\S]*?)\]\]><\/Source>/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(xml)) !== null) {
    const source = m[2];
    const attributes = [...source.matchAll(/^\s*\[([^\]]+)\]\s*$/gm)].map(a => a[1].trim());
    // The signature line: first line carrying the method name followed by '('.
    const sig = source.split('\n')
      .map(l => l.trim())
      .find(l => new RegExp(`\\b${m?.[1]}\\s*\\(`).test(l) && !l.startsWith('//') && !l.startsWith('///'));
    methods.push({ name: m[1], signature: sig ?? '', attributes });
  }

  // <EnumValues><AxEnumValue><Name>…  — the members a rule is allowed to name.
  const enumValues = [...xml.matchAll(/<AxEnumValue>\s*<Name>([^<]+)<\/Name>/g)].map(e => e[1]);

  return {
    requested,
    found: true,
    name: nameEl?.[1] ?? hit.file,
    enumValues: enumValues.length ? enumValues : undefined,
    alsoFoundAs: alsoFoundAs.length ? alsoFoundAs : undefined,
    packageName: hit.packageName,
    type: hit.type,
    file: hit.file,
    declaration: declLine,
    extends: extendsM?.[1],
    implements: implementsM?.[1].split(',').map(s => s.trim()).filter(Boolean),
    attributes: classAttributes,
    methods,
  };
}

/** Element names containing `needle`, so a half-remembered name can be resolved. */
export function findElements(needle: string, preferType?: string): string[] {
  const lower = needle.toLowerCase();
  const out: string[] = [];
  for (const [key, locations] of buildIndex()) {
    if (!key.includes(lower)) continue;
    for (const l of locations) {
      if (preferType && l.type.toLowerCase() !== preferType.toLowerCase()) continue;
      out.push(`${l.packageName}/${l.type}/${path.basename(l.file, '.xml')}`);
    }
  }
  return out.sort();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // --find answers "what is this class actually called?" before --names-only
  // answers "what does it contain?". Guessing the name is how a knowledge entry
  // ends up naming an API that does not exist.
  if (typeof args.find === 'string') {
    const preferType = typeof args.type === 'string' ? args.type : undefined;
    const hits = findElements(args.find, preferType);
    for (const hit of hits) console.log(hit);
    console.log(hits.length ? `\n${hits.length} match(es)` : `no AOT element name contains "${args.find}"`);
    return;
  }
  const names = process.argv.slice(2).filter(a => !a.startsWith('--') &&
    // drop values consumed by --flag value
    !Object.values(args).includes(a));
  if (!names.length) {
    console.error('usage: aotMembers.ts <Name> [<Name>…] [--grep <substr>] [--names-only] [--json out.json]');
    process.exit(2);
  }

  const grep = typeof args.grep === 'string' ? args.grep.toLowerCase() : undefined;
  const preferType = typeof args.type === 'string' ? args.type : undefined;
  const reports = names.map(n => readMembers(n, preferType));

  for (const r of reports) {
    if (!r.found) {
      console.log(`\n${r.requested}: NOT FOUND in the AOT — kernel-implemented, or the name is wrong.`);
      continue;
    }
    console.log(`\n${r.name}  [${r.packageName}/${r.type}]  ${r.methods?.length ?? 0} methods`);
    if (r.declaration) console.log(`  ${r.declaration}`);
    if (r.enumValues) console.log(`  values: ${r.enumValues.join(' ')}`);
    if (r.alsoFoundAs) console.log(`  also an AOT element of: ${r.alsoFoundAs.join(', ')}`);
    if (r.attributes?.length) console.log(`  attributes: ${r.attributes.join(', ')}`);
    const methods = (r.methods ?? []).filter(mm => !grep || mm.name.toLowerCase().includes(grep));
    if (args['names-only'] === true) {
      console.log(`  ${methods.map(mm => mm.name).join(' ')}`);
    } else {
      for (const mm of methods) {
        console.log(`  ${mm.attributes.length ? `[${mm.attributes.join('][')}] ` : ''}${mm.signature || mm.name}`);
      }
    }
    if (grep) console.log(`  (${methods.length} of ${r.methods?.length ?? 0} match "${grep}")`);
  }

  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, `${JSON.stringify({ readAt: new Date().toISOString(), reports }, null, 2)}\n`, 'utf8');
    console.log(`\n→ ${args.json}`);
  }
}

if (process.argv[1] && /aotMembers\.ts$/.test(process.argv[1])) main();
