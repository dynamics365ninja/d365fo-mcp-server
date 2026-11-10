/**
 * Capture the PLATFORM form pattern definitions into
 * src/knowledge/formPatterns/platform.generated.ts.
 *
 * Why this exists
 * ---------------
 * The form pattern catalog (src/knowledge/formPatterns/catalog) was curated by
 * hand from the Microsoft Learn guideline pages. The compiler does not read those
 * pages. It runs Microsoft.Dynamics.AX.Metadata.Patterns.PatternAnalyzer against
 * the definitions embedded in Microsoft.Dynamics.AX.Metadata.Patterns.dll
 * (FormPatterns.*.xml, SubPatterns.*.xml, schema FormPatterns.xsd). Where the
 * curated catalog and those definitions disagreed, the validator blocked forms
 * the compiler accepts and passed forms the compiler rejects:
 *
 *   - the catalog knew `TaskSingle`, the platform pattern is `Task` (1.2);
 *   - sub-pattern `FillText` is version "UX7 1.0" and takes StaticText OR String;
 *   - `ToolbarList` is 1.2, the catalog thought 1.1 was newest;
 *   - a CustomFilters group must have ViewEditMode Edit, a FillText child
 *     HeightMode SizeToAvailable — property rules the catalog never checked.
 *
 * So the structure (names, versions, parts, counts, order, allowed sub-patterns
 * and required property values) is now generated from the same definitions the
 * compiler uses, and the curated catalog only adds guidance on top of it.
 *
 * Usage (Windows dev box with a D365FO install, from the repo root):
 *   npx tsx scripts/capture-form-pattern-definitions.ts
 *   PACKAGES_ROOT=K:/AosService/PackagesLocalDirectory npx tsx scripts/capture-form-pattern-definitions.ts
 *   npx tsx scripts/capture-form-pattern-definitions.ts --xml-dir <folder with the extracted *.xml>
 *
 * Without --xml-dir the script asks PowerShell to read the embedded resources
 * of bin/Microsoft.Dynamics.AX.Metadata.Patterns.dll into a temporary folder.
 * Nothing under PackagesLocalDirectory is written.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Parser } from '../src/utils/xml.js';
import { buildProbe, defaults as probeDefaults } from './oracles/patternAnalyzer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUT = path.join(REPO_ROOT, 'src', 'knowledge', 'formPatterns', 'platform.generated.ts');
const OUT_DEFAULTS = path.join(REPO_ROOT, 'src', 'knowledge', 'formPatterns', 'platformDefaults.generated.ts');

function defaultPackagesRoot(): string {
  if (process.env.PACKAGES_ROOT) return process.env.PACKAGES_ROOT;
  const local = process.env.LOCALAPPDATA ?? '';
  const current = path.join(local, 'Microsoft', 'Dynamics365', 'Current', 'PackagesLocalDirectory');
  if (fs.existsSync(current)) return current;
  return 'K:/AosService/PackagesLocalDirectory';
}

/** Read the embedded *.xml resources of the Patterns DLL into a temp folder (read only on the DLL). */
function extractResources(packagesRoot: string): { dir: string; dllVersion: string } {
  const dll = path.join(packagesRoot, 'bin', 'Microsoft.Dynamics.AX.Metadata.Patterns.dll');
  if (!fs.existsSync(dll)) throw new Error(`Patterns DLL not found: ${dll}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365fo-form-patterns-'));
  const ps = [
    `$asm = [System.Reflection.Assembly]::LoadFile('${dll.replace(/'/g, "''")}')`,
    `foreach ($n in $asm.GetManifestResourceNames()) {`,
    `  if ($n -notlike '*.xml') { continue }`,
    `  $s = $asm.GetManifestResourceStream($n)`,
    `  $f = [System.IO.File]::Create((Join-Path '${dir.replace(/'/g, "''")}' $n))`,
    `  $s.CopyTo($f); $f.Close(); $s.Close()`,
    `}`,
    `(Get-Item '${dll.replace(/'/g, "''")}').VersionInfo.FileVersion`,
  ].join('\n');
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const dllVersion = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
  return { dir, dllVersion };
}

// Model (mirrors src/knowledge/formPatterns/platform.ts)

interface PropertyRule {
  name: string;
  value: string;
  op?: 'Not' | 'Contains';
  when?: 'WhenExists';
}
interface PNode {
  type: string;
  part?: string;
  alias?: string;
  count?: string;
  children?: string;
  props?: PropertyRule[];
  subPatterns?: string[];
  nodes?: Array<PNode | { oneOf: PNode[] }>;
}
interface PDef {
  name: string;
  version: string;
  alias?: string;
  active: boolean;
  category?: string;
  kind: 'form' | 'sub';
  file: string;
  root: PNode;
}

function attr(el: any, name: string): string | undefined {
  const v = el?.$?.[name];
  return typeof v === 'string' ? v : undefined;
}

function toNode(el: any): PNode {
  const node: PNode = { type: attr(el, 'Type') ?? '' };
  const part = attr(el, 'Part');
  if (part) node.part = part;
  // Alias only where no Part names the node (e.g. the TaskParentChild splitter)
  const alias = attr(el, 'Alias');
  if (alias && !part) node.alias = alias;
  const count = attr(el, 'Count');
  if (count) node.count = count;
  const children = attr(el, 'Children');
  if (children) node.children = children;
  for (const child of el.$$ ?? []) {
    const tag = child['#name'];
    if (tag === 'Property') {
      const rule: PropertyRule = { name: attr(child, 'Name') ?? '', value: typeof child._ === 'string' ? child._ : '' };
      const op = attr(child, 'Op');
      if (op && op !== 'Equals') rule.op = op as PropertyRule['op'];
      const cond = attr(child, 'Condition');
      if (cond) rule.when = cond as PropertyRule['when'];
      (node.props ??= []).push(rule);
    } else if (tag === 'SubPattern') {
      (node.subPatterns ??= []).push(attr(child, 'Name') ?? '');
    } else if (tag === 'Control') {
      (node.nodes ??= []).push(toNode(child));
    } else if (tag === 'OneOf') {
      const alts = (child.$$ ?? []).filter((c: any) => c['#name'] === 'Control').map(toNode);
      (node.nodes ??= []).push({ oneOf: alts });
    }
  }
  return node;
}

async function parseFile(file: string): Promise<PDef[]> {
  const xml = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const parser = new Parser({
    explicitChildren: true,
    preserveChildrenOrder: true,
    explicitArray: true,
    trim: true,
    tagNameProcessors: [(n: string) => n.replace(/^.*:/, '')],
  });
  const doc = await parser.parseStringPromise(xml);
  const base = path.basename(file).replace(/^Microsoft\.Dynamics\.AX\.Metadata\.Patterns\.Guidelines\./, '');
  const kind: PDef['kind'] = base.startsWith('SubPatterns.') ? 'sub' : 'form';
  const defs: PDef[] = [];
  for (const p of doc.Patterns.Pattern ?? []) {
    const rootEl = (p.$$ ?? []).find((c: any) => c['#name'] === 'Control');
    const def: PDef = {
      name: attr(p, 'Name') ?? '',
      version: attr(p, 'Version') ?? '',
      active: (attr(p, 'Active') ?? 'true').toLowerCase() === 'true',
      kind,
      file: base,
      root: toNode(rootEl),
    };
    const alias = attr(p, 'Alias');
    if (alias) def.alias = alias;
    const category = attr(p, 'Category');
    if (category) def.category = category;
    defs.push(def);
  }
  return defs;
}

async function main(): Promise<void> {
  const argIdx = process.argv.indexOf('--xml-dir');
  let dir: string;
  let source: string;
  const root = defaultPackagesRoot();
  if (argIdx > 0) {
    dir = process.argv[argIdx + 1];
    source = `extracted resources in ${dir}`;
  } else {
    const extracted = extractResources(root);
    dir = extracted.dir;
    source = `Microsoft.Dynamics.AX.Metadata.Patterns.dll ${extracted.dllVersion}`;
  }
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xml')).sort();
  const defs: PDef[] = [];
  for (const f of files) defs.push(...(await parseFile(path.join(dir, f))));
  // Our own temp extraction (never a folder the caller passed in).
  if (argIdx < 0) fs.rmSync(dir, { recursive: true, force: true });
  defs.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || b.version.localeCompare(a.version));

  const keys = new Set<string>();
  for (const d of defs) {
    const k = `${d.name}@${d.version}`;
    if (keys.has(k)) throw new Error(`Duplicate pattern definition ${k} (${d.file})`);
    keys.add(k);
  }

  const body = defs.map((d) => `  ${JSON.stringify(d)},`).join('\n');
  const out = `/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   npx tsx scripts/capture-form-pattern-definitions.ts
 *
 * Every <Pattern> definition the X++ compiler validates forms against, read
 * from the embedded FormPatterns.*.xml / SubPatterns.*.xml resources of
 * ${source}.
 * ${defs.length} definitions (${defs.filter((d) => d.kind === 'form').length} form patterns, ${defs.filter((d) => d.kind === 'sub').length} sub-patterns, current and previous versions).
 *
 * Interpreted by src/knowledge/formPatterns/platform.ts.
 */

import type { PlatformPatternDefinition } from './platform.js';

export const PLATFORM_PATTERN_DEFINITIONS: PlatformPatternDefinition[] = [
${body}
];
`;
  fs.writeFileSync(OUT, out, 'utf8');
  console.log(`Wrote ${defs.length} definitions from ${files.length} files to ${path.relative(REPO_ROOT, OUT)}`);

  // Property defaults: the value a property has when the AxForm XML omits it.
  const propNames = new Set<string>();
  const visit = (n: PNode): void => {
    for (const r of n.props ?? []) propNames.add(r.name);
    for (const c of n.nodes ?? []) {
      if ('oneOf' in c) c.oneOf.forEach(visit);
      else visit(c);
    }
  };
  defs.forEach((d) => visit(d.root));
  const table = probeDefaults(buildProbe(root), [...propNames].sort(), root);
  const lines = Object.keys(table).sort().map((t) => `  ${JSON.stringify(t)}: ${JSON.stringify(table[t])},`);
  fs.writeFileSync(OUT_DEFAULTS, `/**
 * GENERATED FILE — do not hand-edit. Regenerate with:
 *   npx tsx scripts/capture-form-pattern-definitions.ts
 *
 * Metamodel default of every property a platform pattern definition names, per
 * control type: the value the property has when the AxForm XML omits it, read
 * from a new instance of each AxForm*Control class (AxFormDesign = FormDesign,
 * AxFormControl = Control, which is what extension controls are) in
 * Microsoft.Dynamics.AX.Metadata.dll. A property missing from a type's entry does
 * not exist on that type, and the platform skips rules about it.
 */

export const PLATFORM_CONTROL_DEFAULTS: Record<string, Record<string, string>> = {
${lines.join('\n')}
};
`, 'utf8');
  console.log(`Wrote defaults for ${Object.keys(table).length} control types to ${path.relative(REPO_ROOT, OUT_DEFAULTS)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
