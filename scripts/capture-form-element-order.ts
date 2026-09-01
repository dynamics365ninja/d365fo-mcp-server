/**
 * Capture the CANONICAL child-element order of every AxFormControl subtype, by
 * census of the AxForm XML Microsoft ships, into
 * src/validation/formControlElementOrder.generated.ts.
 *
 * Why this exists
 * ---------------
 * AOT metadata XML is order-sensitive, and the deserializer does not complain:
 * an element written out of sequence is DROPPED, silently. A form scaffold that
 * emitted `<DataGroup>`/`<DataSource>` before `<Controls>` on a group control
 * produced a file whose two child controls the metadata provider could not see —
 * `get_object_info` reported 14 controls where the file held 16, and it was the
 * file that was wrong (issue #979, proven against the live provider by reading
 * the same form before and after re-ordering the two lines).
 *
 * So the order is not guessed and not read off the C# writer — it is mined from
 * the corpus of forms the platform itself wrote.
 *
 * Method
 * ------
 * For every `<AxFormControl i:type="…">` element in the sampled forms, record the
 * sequence of its DIRECT child element names, and from each sequence every
 * pairwise "A appears before B" constraint. Per control type, the constraints
 * form a DAG (verified: over 25k control elements, zero contradictions), and its
 * topological order is the canonical order for that type. Elements a type never
 * carries are simply absent — the checker treats an unknown element as unranked
 * and never fails on it.
 *
 * A pairwise census rather than "the longest observed sequence" because no single
 * shipped control carries every property; the constraints compose across
 * thousands of partial observations.
 *
 * Usage (VM, from the repo root):
 *   npx tsx scripts/capture-form-element-order.ts
 *   PACKAGES_ROOT=D:/AosService/PackagesLocalDirectory npx tsx scripts/capture-form-element-order.ts
 *
 * The generated table is the ratchet for the scaffold: every pattern template's
 * output is checked against it in tests/validation/formControlElementOrder.test.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PACKAGES = process.env.PACKAGES_ROOT ?? 'K:/AosService/PackagesLocalDirectory';
const OUT = path.join(REPO_ROOT, 'src', 'validation', 'formControlElementOrder.generated.ts');

/**
 * Packages to census. Foundation and ApplicationPlatform between them hold the
 * forms every pattern template was modelled on; adding more packages adds
 * observations of the same properties, not new ones.
 */
const FORM_DIRS = [
  path.join(PACKAGES, 'ApplicationSuite', 'Foundation', 'AxForm'),
  path.join(PACKAGES, 'ApplicationPlatform', 'ApplicationPlatform', 'AxForm'),
];

/** Cap per directory — the census saturates long before this. */
const MAX_FILES_PER_DIR = 900;

const TAG = /<(\/?)([A-Za-z_][\w.]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
const ITYPE = /i:type="([^"]+)"/;

interface Frame {
  tag: string;
  itype: string | null;
  children: string[];
}

function censusFile(xml: string, before: Map<string, Map<string, Set<string>>>, counts: Map<string, number>): void {
  const stack: Frame[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(xml)) !== null) {
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      if (stack.length > 0 && stack[stack.length - 1].tag === name) {
        const frame = stack.pop()!;
        if (frame.tag === 'AxFormControl' && frame.itype) {
          counts.set(frame.itype, (counts.get(frame.itype) ?? 0) + 1);
          let g = before.get(frame.itype);
          if (!g) { g = new Map(); before.set(frame.itype, g); }
          const kids = frame.children;
          for (let i = 0; i < kids.length; i++) {
            for (let j = i + 1; j < kids.length; j++) {
              if (kids[i] === kids[j]) continue;
              let s = g.get(kids[i]);
              if (!s) { s = new Set(); g.set(kids[i], s); }
              s.add(kids[j]);
            }
          }
        }
      }
      continue;
    }
    const isSelfClosing = selfClose === '/' || attrs.trimEnd().endsWith('/');
    if (stack.length > 0) stack[stack.length - 1].children.push(name);
    if (!isSelfClosing) {
      const itype = name === 'AxFormControl' ? (ITYPE.exec(attrs)?.[1] ?? null) : null;
      stack.push({ tag: name, itype, children: [] });
    }
  }
}

/** Kahn's algorithm, ties broken by name so the output is stable across runs. */
function topoSort(graph: Map<string, Set<string>>): { order: string[]; cycle: string[] } {
  const nodes = new Set<string>();
  for (const [a, bs] of graph) {
    nodes.add(a);
    for (const b of bs) nodes.add(b);
  }
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n, 0);
  for (const [, bs] of graph) for (const b of bs) indeg.set(b, (indeg.get(b) ?? 0) + 1);

  const ready = [...nodes].filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const b of [...(graph.get(n) ?? [])].sort()) {
      const d = (indeg.get(b) ?? 0) - 1;
      indeg.set(b, d);
      if (d === 0) {
        // keep `ready` sorted so the result is deterministic
        const at = ready.findIndex((x) => x > b);
        if (at === -1) ready.push(b); else ready.splice(at, 0, b);
      }
    }
  }
  return { order, cycle: [...nodes].filter((n) => !order.includes(n)) };
}

function main(): void {
  const before = new Map<string, Map<string, Set<string>>>();
  const counts = new Map<string, number>();
  let filesRead = 0;

  for (const dir of FORM_DIRS) {
    if (!fs.existsSync(dir)) {
      console.warn(`[capture-form-element-order] skipping missing dir: ${dir}`);
      continue;
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml')).sort().slice(0, MAX_FILES_PER_DIR);
    for (const f of files) {
      let xml: string;
      try {
        xml = fs.readFileSync(path.join(dir, f), 'utf-8');
      } catch {
        continue;
      }
      if (!xml.includes('<AxFormControl')) continue;
      censusFile(xml, before, counts);
      filesRead++;
    }
  }

  if (filesRead === 0) {
    throw new Error(
      `No AxForm XML found under ${FORM_DIRS.join(' or ')}. ` +
      `This script must run on a machine with PackagesLocalDirectory — set PACKAGES_ROOT.`,
    );
  }

  const orders: Record<string, string[]> = {};
  const contradictions: string[] = [];

  for (const [itype, graph] of [...before].sort(([a], [b]) => a.localeCompare(b))) {
    // A pair observed in both directions means this type's own metadata is not
    // consistently ordered — report it and drop the pair rather than inventing
    // an order for it.
    for (const [a, bs] of graph) {
      for (const b of [...bs]) {
        if (graph.get(b)?.has(a)) {
          contradictions.push(`${itype}: ${a} <-> ${b}`);
          bs.delete(b);
        }
      }
    }
    const { order, cycle } = topoSort(graph);
    if (cycle.length > 0) {
      contradictions.push(`${itype}: cycle over ${cycle.sort().join(', ')}`);
      continue;
    }
    orders[itype] = order;
  }

  const totalControls = [...counts.values()].reduce((a, b) => a + b, 0);
  for (const c of contradictions) console.warn(`[capture-form-element-order] ${c}`);

  const body =
    `/**\n` +
    ` * GENERATED by scripts/capture-form-element-order.ts — do not edit.\n` +
    ` *\n` +
    ` * The canonical order of the child elements of each AxFormControl subtype, mined\n` +
    ` * from ${totalControls.toLocaleString('en-US')} control elements across ${filesRead} shipped AxForm files.\n` +
    ` * AOT metadata XML is order-sensitive and the deserializer drops an out-of-order\n` +
    ` * element without a word — see src/validation/formControlElementOrder.ts.\n` +
    ` */\n\n` +
    `export const FORM_ELEMENT_ORDER_CONTROLS_SAMPLED = ${totalControls};\n` +
    `export const FORM_ELEMENT_ORDER_FILES_SAMPLED = ${filesRead};\n\n` +
    `/** i:type → its child elements, in the order shipped metadata writes them. */\n` +
    `export const FORM_CONTROL_ELEMENT_ORDER: Readonly<Record<string, readonly string[]>> = {\n` +
    Object.entries(orders)
      .map(([itype, order]) =>
        `  ${JSON.stringify(itype)}: [\n` +
        order.map((e) => `    ${JSON.stringify(e)},`).join('\n') +
        `\n  ],\n`,
      )
      .join('') +
    `};\n`;

  fs.writeFileSync(OUT, body, 'utf-8');
  console.log(
    `[capture-form-element-order] ${Object.keys(orders).length} control types, ` +
    `${totalControls} control elements, ${filesRead} files → ${path.relative(REPO_ROOT, OUT)}`,
  );
  if (contradictions.length > 0) {
    console.warn(`[capture-form-element-order] ${contradictions.length} type(s) skipped or repaired — see warnings above.`);
  }
}

main();
