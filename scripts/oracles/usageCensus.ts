/**
 * The usage oracle — how often shipped X++ actually writes a construct.
 *
 * The member oracle answers "does this exist". This one answers the question that
 * turned out to matter more: "does anyone use it". H2 learned the difference the
 * expensive way. The coverage plan's SysTest attribute list was written by reading
 * the class inventory, and a usage census inverted it — the two most-written
 * attributes were missing from the list, and most of the list has ZERO shipped
 * occurrences. A catalogue built from an inventory teaches the wrong idiom with
 * complete confidence.
 *
 * Walks with aotSource, so every model folder is covered. A hand-rolled
 * `<root>/<pkg>/<pkg>/<AxType>` walk looks right and silently skips the 12 models
 * whose folder is not named after their package, `ApplicationSuite/Foundation`
 * among them — that is a real defect this file exists to stop repeating.
 *
 * Usage:
 *   npm run oracle:usage -- --pattern 'SysTest\w*' --types AxClass --name-filter test
 *   npm run oracle:usage -- --pattern 'element\.(\w+)\s*\(' --types AxForm --group 1
 *   npm run oracle:usage -- --pattern '(\w+_ds)\.(\w+)\s*\(' --types AxForm --group 2 --top 40
 *
 * Options:
 *   --pattern <re>     JavaScript regex, applied to each file's XML.
 *   --group <n>        Capture group to count (default 1, or 0 for the whole match).
 *   --types <a,b>      AOT folders to walk (default AxClass).
 *   --name-filter <s>  Only files whose NAME contains this, case-insensitive.
 *   --declaration      Count class-level (in <Declaration>) and member-level
 *                      (in <Source>) hits separately. AxClass only.
 *   --top <n>          Rows to print (default 30).
 *   --json <path>      Also write the full counts.
 */

import * as fs from 'node:fs';
import { walkAot } from './aotSource.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);

const patternSrc = arg('pattern');
if (!patternSrc) {
  console.error('--pattern is required. See the header for examples.');
  process.exit(2);
}
const group = Number(arg('group') ?? 1);
const types = (arg('types') ?? 'AxClass').split(',').map(t => t.trim()).filter(Boolean);
const nameFilter = arg('name-filter')?.toLowerCase();
const splitDeclaration = flag('declaration');
const top = Number(arg('top') ?? 30);
const jsonOut = arg('json');

const make = () => new RegExp(patternSrc, 'g');

/** hit → [files it appears in, total occurrences, class-level, member-level] */
const counts = new Map<string, { files: number; uses: number; decl: number; member: number }>();
const bump = (key: string, where: 'decl' | 'member' | 'any', firstInFile: boolean) => {
  const row = counts.get(key) ?? { files: 0, uses: 0, decl: 0, member: 0 };
  row.uses++;
  if (firstInFile) row.files++;
  if (where === 'decl') row.decl++;
  if (where === 'member') row.member++;
  counts.set(key, row);
};

let scanned = 0;
let matched = 0;
for (const file of walkAot({ types })) {
  if (nameFilter && !file.name.toLowerCase().includes(nameFilter)) continue;
  scanned++;

  const seen = new Set<string>();
  const collect = (text: string, where: 'decl' | 'member' | 'any') => {
    for (const m of text.matchAll(make())) {
      const key = (group === 0 ? m[0] : m[group])?.trim();
      if (!key) continue;
      bump(key, where, !seen.has(key));
      seen.add(key);
    }
  };

  if (splitDeclaration) {
    // <Declaration> carries the class-level attributes, each <Source> a member.
    // Counting the file as one blob cannot tell "on the class" from "on a method",
    // and that distinction is the whole answer for attributes.
    const decl = /<Declaration><!\[CDATA\[([\s\S]*?)\]\]>/.exec(file.xml)?.[1] ?? '';
    collect(decl, 'decl');
    for (const m of file.xml.matchAll(/<Source><!\[CDATA\[([\s\S]*?)\]\]>/g)) collect(m[1], 'member');
  } else {
    collect(file.xml, 'any');
  }
  if (seen.size > 0) matched++;
}

const rows = [...counts.entries()].sort((a, b) => b[1].uses - a[1].uses);
console.log(`files walked: ${scanned}  ·  files with a hit: ${matched}  ·  distinct: ${rows.length}`);
console.log('');
console.log(splitDeclaration
  ? '  uses  files  class  member  what'
  : '  uses  files  what');
for (const [key, r] of rows.slice(0, top)) {
  console.log(splitDeclaration
    ? `${String(r.uses).padStart(6)}${String(r.files).padStart(7)}${String(r.decl).padStart(7)}${String(r.member).padStart(8)}  ${key}`
    : `${String(r.uses).padStart(6)}${String(r.files).padStart(7)}  ${key}`);
}
if (rows.length > top) console.log(`  … ${rows.length - top} more`);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(
    { pattern: patternSrc, types, nameFilter, scanned, matched, rows: rows.map(([k, r]) => ({ key: k, ...r })) },
    null, 2), 'utf-8');
  console.log(`\nWrote ${jsonOut}`);
}
