/**
 * Kernel-enum audit — which enums does shipped code use that the AOT cannot prove?
 *
 * `src/knowledge/kernelEnums.ts` exists because "absent from the AOT" is not
 * "does not exist": a kernel enum has no `AxEnum/*.xml` anywhere, so the symbol
 * index, the C# bridge and a disk probe all answer "not found" for a name that
 * compiles perfectly. Reporting that as an error sends an agent to "correct"
 * correct code, and `get_object_info` then advises re-indexing a file that
 * cannot exist — a loop with no exit.
 *
 * The module was right about the mechanism and incomplete in its DATA, which is
 * a harder failure to notice: it was hand-written from the names someone
 * remembered. An eval run tripped over `AccessType` and `MenuItemType` — two
 * names a single L2 case happened to touch — and the fact that BOTH were missing
 * is the signal that the list was never derived from anything.
 *
 * This derives it. Every `Name::Member` in shipped X++ that is used at least once
 * WITHOUT a call parenthesis (so it reads as an enum literal, not a static call)
 * and has no AOT element of any kind is a kernel-enum candidate, ordered by how
 * often the product itself writes it.
 *
 * Usage:
 *   npm run oracle:kernel-enums                 # candidates missing from ENTRIES
 *   npm run oracle:kernel-enums -- --all        # every candidate, listed or not
 *   npm run oracle:kernel-enums -- --limit 20000
 *
 * The output is a CANDIDATE list, not an answer: a misspelled class name also
 * has no AOT element. Confirm a name with an xppc probe (`npm run oracle:probe`)
 * before adding it, exactly as `DialogButton` was confirmed.
 */
import { KERNEL_ENUM_NAMES } from '../../src/knowledge/kernelEnums.js';
import { maskXpp } from '../../src/utils/xppLexer.js';
import { parseArgs, walkAot, walkOptionsFromArgs, walkXppSource } from './aotSource.js';

/**
 * Every AOT element name on disk, lowercased — the "can be proven" set.
 *
 * The type list is spelled out rather than defaulted. `SOURCE_TYPES` is the set
 * that carries X++ SOURCE and deliberately excludes `AxEnum`; using it here made
 * every enum in the product look kernel-implemented and the audit reported 750+
 * candidates, `SRSReportFileFormat` and `SortOrder` among them. An audit whose
 * "unknown" set is wrong is worse than none: it buries the two real answers.
 */
const PROVABLE_TYPES = [
  'AxEnum', 'AxClass', 'AxTable', 'AxForm', 'AxQuery', 'AxView', 'AxMap',
  'AxDataEntityView', 'AxEdt', 'AxMenu', 'AxMenuItemDisplay', 'AxMenuItemAction',
  'AxMenuItemOutput', 'AxReport', 'AxMacro', 'AxService', 'AxWorkflowType',
];

function aotNames(dry: boolean | undefined): Set<string> {
  const names = new Set<string>();
  for (const f of walkAot({ dry, types: PROVABLE_TYPES })) names.add(f.name.toLowerCase());
  return names;
}

interface Candidate {
  name: string;
  /** Uses that read as an enum literal (no call parenthesis). */
  literalUses: number;
  /** Uses that read as a static call. */
  callUses: number;
  members: Map<string, number>;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const walkOptions = walkOptionsFromArgs(args);

  process.stderr.write('  indexing AOT element names…\n');
  const known = aotNames(walkOptions.dry);
  process.stderr.write(`  ${known.size} AOT element names\n`);

  const seen = new Map<string, Candidate>();
  const re = /\b([A-Z][A-Za-z0-9_]*)::([A-Za-z_]\w*)\s*(\()?/g;
  let blocks = 0;

  for (const block of walkXppSource({ ...walkOptions, types: walkOptions.types ?? ['AxClass', 'AxTable', 'AxForm'] })) {
    blocks++;
    const masked = maskXpp(block.source);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const [, name, member, paren] = m;
      if (known.has(name.toLowerCase())) continue;
      const c = seen.get(name) ?? { name, literalUses: 0, callUses: 0, members: new Map() };
      if (paren) c.callUses++;
      else {
        c.literalUses++;
        c.members.set(member, (c.members.get(member) ?? 0) + 1);
      }
      seen.set(name, c);
    }
    if (blocks % 50000 === 0) process.stderr.write(`  …${blocks} blocks\n`);
  }

  // An enum is used as a literal. A name seen ONLY with parentheses is a kernel
  // CLASS (Global, DictTable, …) — a different allow-list's problem.
  const candidates = [...seen.values()]
    .filter(c => c.literalUses > 0)
    .sort((a, b) => b.literalUses - a.literalUses);

  const showAll = args.all === true;
  const rows = showAll ? candidates : candidates.filter(c => !KERNEL_ENUM_NAMES.has(c.name.toLowerCase()));

  console.log(
    `\n${candidates.length} enum-like names with no AOT element; ` +
    `${candidates.length - rows.length} already in kernelEnums.ts.\n`,
  );
  if (!rows.length) {
    console.log('Nothing missing — every kernel enum shipped code uses is listed.');
    return;
  }

  console.log('MISSING from kernelEnums.ts (confirm with an xppc probe before adding):\n');
  for (const c of rows.slice(0, 60)) {
    const members = [...c.members.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => `${k}(${v})`)
      .join(' ');
    console.log(`  ${c.name.padEnd(34)} ${String(c.literalUses).padStart(6)} literal uses  ${members}`);
  }
  if (rows.length > 60) console.log(`  …and ${rows.length - 60} more`);
}

main();
