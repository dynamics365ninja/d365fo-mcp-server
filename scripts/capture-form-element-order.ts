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
 * For every control element in the corpus — `<AxFormControl i:type="…">` in a
 * form, `<FormControl i:type="…">` in a form EXTENSION — record the sequence of
 * its DIRECT child element names, and from each sequence every pairwise "A
 * appears before B" constraint. Per control type the constraints are then
 * resolved into one order (see `resolveOrder`).
 *
 * A pairwise census rather than "the longest observed sequence" because no single
 * shipped control carries every property; the constraints compose across
 * hundreds of thousands of partial observations.
 *
 * Elements a type never carries are simply absent, and the checker treats an
 * unranked element as its weaker `unknown` finding — which is why the corpus has
 * to be the WHOLE AOT and not a sample. On 949 hand-picked forms that rule
 * produced 41 false positives against shipped form extensions; on all 10,676
 * files it produces none.
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
 * Every AxForm and AxFormExtension directory under the packages root.
 *
 * This started as two hand-picked packages (Foundation + ApplicationPlatform,
 * forms only), which was enough to derive the order but NOT enough to know which
 * properties a control type can carry: validating shipped FORM EXTENSIONS against
 * that table produced 41 `unknown` findings — AllowEdit on a menu button,
 * ImageLocation on a menu function button, CountryRegionCodes on a reference
 * group — every one of them a real property the sample simply never contained.
 * A rule about to gate a WRITE cannot be built on a partial sample.
 *
 * Extensions are included for a second reason: they spell the control element
 * `<FormControl i:type="…">` rather than `<AxFormControl>`, and their controls
 * carry property combinations forms rarely do.
 */
function formDirs(root: string): string[] {
  const dirs: string[] = [];
  let packages: string[];
  try {
    packages = fs.readdirSync(root).sort();
  } catch {
    return dirs;
  }
  for (const pkg of packages) {
    const pkgPath = path.join(root, pkg);
    let subs: string[];
    try {
      if (!fs.statSync(pkgPath).isDirectory()) continue;
      subs = fs.readdirSync(pkgPath);
    } catch {
      continue;
    }
    for (const sub of subs) {
      for (const kind of ['AxForm', 'AxFormExtension']) {
        const dir = path.join(pkgPath, sub, kind);
        try {
          if (fs.statSync(dir).isDirectory()) dirs.push(dir);
        } catch {
          /* not a directory — skip */
        }
      }
    }
  }
  return dirs;
}

const TAG = /<(\/?)([A-Za-z_][\w.]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
const ITYPE = /i:type="([^"]+)"/;

/** A form writes `<AxFormControl i:type>`; a form EXTENSION writes `<FormControl i:type>`. */
const CONTROL_ELEMENTS = new Set(['AxFormControl', 'FormControl']);

interface Frame {
  tag: string;
  itype: string | null;
  children: string[];
}

/** itype → "A>B" → how many controls put A before B. */
type WeightedEdges = Map<string, Map<string, number>>;

function censusFile(xml: string, before: Map<string, WeightedEdges>, counts: Map<string, number>): void {
  const stack: Frame[] = [];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(xml)) !== null) {
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      if (stack.length > 0 && stack[stack.length - 1].tag === name) {
        const frame = stack.pop()!;
        if (CONTROL_ELEMENTS.has(frame.tag) && frame.itype) {
          counts.set(frame.itype, (counts.get(frame.itype) ?? 0) + 1);
          let g = before.get(frame.itype);
          if (!g) { g = new Map(); before.set(frame.itype, g); }
          const kids = frame.children;
          for (let i = 0; i < kids.length; i++) {
            for (let j = i + 1; j < kids.length; j++) {
              if (kids[i] === kids[j]) continue;
              let row = g.get(kids[i]);
              if (!row) { row = new Map(); g.set(kids[i], row); }
              row.set(kids[j], (row.get(kids[j]) ?? 0) + 1);
            }
          }
        }
      }
      continue;
    }
    const isSelfClosing = selfClose === '/' || attrs.trimEnd().endsWith('/');
    if (stack.length > 0) stack[stack.length - 1].children.push(name);
    if (!isSelfClosing) {
      const itype = CONTROL_ELEMENTS.has(name) ? (ITYPE.exec(attrs)?.[1] ?? null) : null;
      stack.push({ tag: name, itype, children: [] });
    }
  }
}

/**
 * Resolve the observed constraints into one order per control type.
 *
 * The corpus is not perfectly self-consistent: over 300k control elements, three
 * pairs appear in BOTH directions (AxFormComboBoxControl VerticalSpacing/Visible,
 * AxFormTabPageControl Caption/PanelStyle, AxFormIntegerControl AllowEdit/Type).
 * That is not a flaw in the method — it means some shipped files have an element
 * in a position the deserializer drops, which is the very defect this table
 * exists to catch. Microsoft has it too.
 *
 * Dropping a contradictory pair outright is not enough: for
 * AxFormTabPageControl a 13-element CYCLE survived it, and the type was
 * discarded from the table entirely — losing a rule for one of the most common
 * control types because a handful of files disagree with tens of thousands.
 *
 * So contradictions are resolved by WEIGHT: keep the direction more controls
 * actually use, and break any remaining cycle by removing its lightest edge.
 * Every removal is reported with both counts, so a 51/49 split can never pass
 * for consensus unnoticed.
 */
function resolveOrder(
  edges: Map<string, number>,
  report: (message: string) => void,
): string[] {
  /** "A>B" → weight, minus the direction that lost. */
  const weight = new Map<string, Map<string, number>>();
  const nodes = new Set<string>();
  for (const [a, row] of edges as unknown as Map<string, Map<string, number>>) {
    nodes.add(a);
    for (const b of row.keys()) nodes.add(b);
  }
  const raw = edges as unknown as Map<string, Map<string, number>>;
  const w = (a: string, b: string) => raw.get(a)?.get(b) ?? 0;

  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      const ab = w(a, b);
      const ba = w(b, a);
      if (ab === 0) continue;
      if (ba > ab) continue;                       // the other direction wins
      if (ba === ab && ba > 0) {                   // a genuine tie decides nothing
        report(`tie ${a}/${b} at ${ab} each — pair dropped`);
        continue;
      }
      if (ba > 0) report(`${a} before ${b} ${ab}x vs ${ba}x the other way — keeping the majority`);
      let row = weight.get(a);
      if (!row) { row = new Map(); weight.set(a, row); }
      row.set(b, ab);
    }
  }

  // Kahn, ties broken by name so the output is stable across runs. Any node left
  // unemitted is in a cycle; drop that cycle's lightest edge and continue.
  for (;;) {
    const indeg = new Map<string, number>();
    for (const n of nodes) indeg.set(n, 0);
    for (const [, row] of weight) for (const b of row.keys()) indeg.set(b, (indeg.get(b) ?? 0) + 1);

    const ready = [...nodes].filter((n) => indeg.get(n) === 0).sort();
    const order: string[] = [];
    while (ready.length > 0) {
      const n = ready.shift()!;
      order.push(n);
      for (const b of [...(weight.get(n)?.keys() ?? [])].sort()) {
        const d = (indeg.get(b) ?? 0) - 1;
        indeg.set(b, d);
        if (d === 0) {
          const at = ready.findIndex((x) => x > b);
          if (at === -1) ready.push(b); else ready.splice(at, 0, b);
        }
      }
    }
    if (order.length === nodes.size) return order;

    const stuck = new Set([...nodes].filter((n) => !order.includes(n)));
    let lightest: { a: string; b: string; n: number } | null = null;
    for (const a of stuck) {
      for (const [b, n] of weight.get(a) ?? []) {
        if (!stuck.has(b)) continue;
        if (!lightest || n < lightest.n) lightest = { a, b, n };
      }
    }
    if (!lightest) return order; // no edge to cut — emit what resolved
    weight.get(lightest.a)!.delete(lightest.b);
    report(`cycle broken by dropping ${lightest.a} before ${lightest.b} (${lightest.n} observations)`);
  }
}

function main(): void {
  const before = new Map<string, WeightedEdges>();
  const counts = new Map<string, number>();
  let filesRead = 0;

  const dirs = formDirs(PACKAGES);
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml')).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      let xml: string;
      try {
        xml = fs.readFileSync(path.join(dir, f), 'utf-8');
      } catch {
        continue;
      }
      if (!xml.includes('Control')) continue;
      censusFile(xml, before, counts);
      filesRead++;
    }
  }

  if (filesRead === 0) {
    throw new Error(
      `No AxForm/AxFormExtension XML found under ${PACKAGES}. ` +
      `This script must run on a machine with PackagesLocalDirectory — set PACKAGES_ROOT.`,
    );
  }

  const orders: Record<string, string[]> = {};
  const notes: string[] = [];

  for (const [itype, graph] of [...before].sort(([a], [b]) => a.localeCompare(b))) {
    const order = resolveOrder(graph, (message) => notes.push(`${itype}: ${message}`));
    const nodes = new Set<string>();
    for (const [a, row] of graph) { nodes.add(a); for (const b of row.keys()) nodes.add(b); }
    if (order.length !== nodes.size) {
      notes.push(`${itype}: SKIPPED — ${nodes.size - order.length} element(s) could not be ordered`);
      continue;
    }
    orders[itype] = order;
  }

  const totalControls = [...counts.values()].reduce((a, b) => a + b, 0);
  for (const n of notes) console.warn(`[capture-form-element-order] ${n}`);

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
  if (notes.length > 0) {
    console.warn(
      `[capture-form-element-order] ${notes.length} constraint(s) resolved by weight — see warnings above. ` +
      `A pair the corpus writes both ways means some shipped file has an element the deserializer drops.`,
    );
  }
}

main();
