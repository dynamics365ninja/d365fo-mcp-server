/**
 * The ATL oracle — what the Acceptance Test Library actually offers, read from
 * its own AOT XML.
 *
 * ATL is the platform's answer to "arrange": instead of hand-building a customer,
 * an item and a sales order with raw buffers, a test asks a tree of data nodes for
 * one. The tree is the part nobody can guess, and it is not written down anywhere
 * a developer can grep:
 *
 *   AtlDataRootNode data = AtlDataRootNode::construct();
 *   CustTable customer = data.cust().customers().default().record();
 *
 * The `.record()` is not decoration. 107 of the nodes hand back an `AtlEntity*`
 * wrapper rather than a buffer, and the wrapper is where the fluent setters live;
 * `.record()` is what turns it into the table buffer. This file's first draft
 * omitted it — the same mistake it exists to prevent.
 *
 * `AtlDataRootNode` itself declares exactly ONE accessor (`system()`). Every module
 * — `invent()`, `sales()`, `cust()` — arrives on an EXTENSION class in a different
 * package (`AtlDataRootApplicationSuite_Extension` in ATLApplicationSuite,
 * `AtlDataRootHCM_Extension` in AtlPersonnel, …). That is why a model missing the
 * package reference fails on the METHOD, not on the class: the class resolves and
 * `data.invent()` does not exist. Reading the root class alone would have produced
 * a knowledge entry claiming ATL has one module.
 *
 * Emits src/knowledge/atlNodes.generated.ts:
 *   ATL_ROOT_MODULES  — accessor → node class → the package that defines it
 *   ATL_TABLE_NODES   — table/entity → the accessor PATH that produces one
 *
 * Usage:
 *   npm run oracle:atl                 # rewrite the generated file
 *   npm run oracle:atl -- --dry-run    # print the summary, write nothing
 */

import * as fs from 'node:fs';
import { walkAot } from './aotSource.js';

const OUT = 'src/knowledge/atlNodes.generated.ts';
const DRY = process.argv.includes('--dry-run');

interface AtlClass {
  name: string;
  pkg: string;
  /** accessor name → returned AtlData* class */
  children: Map<string, string>;
  /** return type of default()/enclosure() — the demo-data record, reused */
  produces?: string;
  /** return type of createDefault() — a NEW record. Not every node has both. */
  creates?: string;
}

/** AtlEntity* → the buffer its record() hands back. */
const entityRecord = new Map<string, string>();

/**
 * Every AxClass in every package, restricted to the ATL data tree.
 *
 * Walked with the shared aotSource oracle rather than by hand. A hand-rolled
 * `<root>/<pkg>/<pkg>/AxClass` walk looks right and silently skips every model
 * whose folder is not named after its package — 12 of them here, including
 * `ApplicationSuite/Foundation`, which is one of the largest. This file's first
 * version did exactly that.
 */
function readAtlClasses(): Map<string, AtlClass> {
  const out = new Map<string, AtlClass>();
  for (const { name, packageName: pkg, xml: src } of walkAot({ types: ['AxClass'] })) {
    {
      const isEntity = name.startsWith('AtlEntity');
      if (!name.startsWith('AtlData') && !isEntity) continue;

      if (isEntity) {
        const rec = /public\s+final\s+(\w+)\s+record\s*\([^)]*\)/.exec(src);
        if (rec) entityRecord.set(name, rec[1]);
        continue;
      }

      const children = new Map<string, string>();
      // `[Hookable(false)] public final AtlDataInvent invent()` — the accessor
      // shape the whole tree is built from. `public  final` (two spaces) occurs in
      // shipped code, so the separator has to be \s+, not ' '.
      for (const m of src.matchAll(/public\s+final\s+(AtlData\w+)\s+(\w+)\s*\(\s*\)/g)) {
        children.set(m[2], m[1]);
      }
      // `default()` very often takes DEFAULTED parameters
      // (`default(CustAccount _custAccount = this.demoDataCust().customerDefault())`),
      // so an empty-parens regex silently drops the biggest nodes — AtlDataCustomers
      // among them. Match any parameter list; the accessor is still called with none.
      const produced = /public\s+final\s+(\w+)\s+default\s*\([^)]*\)/.exec(src)
        ?? /public\s+final\s+(\w+)\s+enclosure\s*\([^)]*\)/.exec(src);
      // The API is NOT uniform, and the split is semantic: `default()` hands back
      // the demo-data record (reused across tests), `createDefault()` makes a new
      // one. Master data mostly has the first, transactions mostly the second —
      // AtlDataSalesOrders has no `default()` at all. Flattening the two would
      // claim ATL hands you an existing sales order, which it does not.
      const created = /public\s+final\s+(\w+)\s+createDefault\s*\([^)]*\)/.exec(src);
      out.set(name, {
        name, pkg, children,
        produces: produced && !produced[1].startsWith('AtlData') ? produced[1] : undefined,
        creates: created && !created[1].startsWith('AtlData') ? created[1] : undefined,
      });
    }
  }
  return out;
}

const classes = readAtlClasses();

// ── the root: AtlDataRootNode plus every AtlDataRoot*_Extension ──────────────
// The extensions are what make a module reachable, so the package they live in is
// the package the caller's model must reference. Merged in name order so the
// generated file is stable across runs.
const rootModules = new Map<string, { node: string; pkg: string }>();
for (const [name, c] of [...classes].sort(([a], [b]) => a.localeCompare(b))) {
  if (name !== 'AtlDataRootNode' && !/^AtlDataRoot\w*_Extension$/.test(name)) continue;
  for (const [accessor, node] of c.children) {
    if (!rootModules.has(accessor)) rootModules.set(accessor, { node, pkg: c.pkg });
  }
}

// ── walk the tree, shortest path wins ────────────────────────────────────────
const pathOf = new Map<string, string>();
const queue: Array<{ node: string; path: string }> = [];
for (const [accessor, { node }] of rootModules) {
  if (!pathOf.has(node)) { pathOf.set(node, `${accessor}()`); queue.push({ node, path: `${accessor}()` }); }
}
while (queue.length > 0) {
  const cur = queue.shift()!;
  const c = classes.get(cur.node);
  if (!c) continue;
  for (const [accessor, child] of c.children) {
    if (pathOf.has(child)) continue;
    const p = `${cur.path}.${accessor}()`;
    pathOf.set(child, p);
    queue.push({ node: child, path: p });
  }
}

// ── table → path ─────────────────────────────────────────────────────────────
const tableNodes: Array<{ produces: string; path: string; node: string; pkg: string; record?: string; kind: 'default' | 'createDefault' }> = [];
for (const [name, c] of classes) {
  const p = pathOf.get(name);
  if (!p) continue;             // unreachable from the root: not usable as arrange
  for (const [kind, produces] of [['default', c.produces], ['createDefault', c.creates]] as const) {
    if (!produces) continue;
    tableNodes.push({
      produces, path: `${p}.${kind}()`, node: name, pkg: c.pkg,
      record: entityRecord.get(produces), kind,
    });
  }
}
// Deterministic, and ordered so the FIRST row for a buffer is the likeliest one:
// the reused demo record before a created one, then the shortest path.
tableNodes.sort((a, b) =>
  a.produces.localeCompare(b.produces)
  || (a.kind === b.kind ? 0 : a.kind === 'default' ? -1 : 1)
  || a.path.length - b.path.length
  || a.path.localeCompare(b.path));

const unreachable = [...classes.values()].filter(c => (c.produces || c.creates) && !pathOf.has(c.name)).length;

console.log(`ATL classes read      : ${classes.size}`);
console.log(`root modules          : ${rootModules.size} (${new Set([...rootModules.values()].map(m => m.pkg)).size} package(s))`);
console.log(`reachable data nodes  : ${pathOf.size}`);
console.log(`table/entity producers: ${tableNodes.length}  (${unreachable} produce something but are unreachable from the root)`);

if (DRY) {
  for (const m of [...rootModules].slice(0, 6)) console.log(`   data.${m[0]}() → ${m[1].node}  [${m[1].pkg}]`);
  process.exit(0);
}

const lit = (s: string) => JSON.stringify(s);
const body = `/**
 * GENERATED by scripts/oracles/atlNodes.ts — do not edit.
 *
 * The Acceptance Test Library's data tree, read from the AOT on a VM.
 * ${classes.size} ATL data classes, ${rootModules.size} root modules,
 * ${tableNodes.length} nodes that produce a table or an ATL entity.
 *
 * The root class declares ONE accessor of its own; every module below arrives on
 * an extension class in another package, which is why a missing package reference
 * fails on \`data.invent()\` rather than on \`AtlDataRootNode\`.
 */

/** A module hanging off \`AtlDataRootNode::construct()\`. */
export interface AtlRootModule {
  /** Accessor as written in a test: \`data.invent()\`. */
  readonly accessor: string;
  /** The node class it returns. */
  readonly node: string;
  /** The package that DEFINES it — the model must reference this one. */
  readonly package: string;
}

/** A node that hands back a record: \`data.cust().customers().default()\`. */
export interface AtlTableNode {
  /** Table or ATL entity the node produces. */
  readonly produces: string;
  /** Full accessor path from the root, excluding \`data.\`. */
  readonly path: string;
  readonly node: string;
  readonly package: string;
  /**
   * \`default\` returns the demo-data record and reuses it; \`createDefault\` makes a
   * new one. Master data mostly offers the first, transactions the second.
   */
  readonly kind: 'default' | 'createDefault';
  /**
   * When \`produces\` is an AtlEntity wrapper, the buffer \`.record()\` hands back.
   * Absent when the node already returns a table.
   */
  readonly record?: string;
}

export const ATL_ROOT_MODULES: readonly AtlRootModule[] = [
${[...rootModules].sort(([a], [b]) => a.localeCompare(b))
  .map(([accessor, m]) => `  { accessor: ${lit(accessor)}, node: ${lit(m.node)}, package: ${lit(m.pkg)} },`)
  .join('\n')}
];

export const ATL_TABLE_NODES: readonly AtlTableNode[] = [
${tableNodes
  .map(t => `  { produces: ${lit(t.produces)}, path: ${lit(t.path)}, node: ${lit(t.node)}, `
    + `package: ${lit(t.pkg)}, kind: ${lit(t.kind)}`
    + `${t.record ? `, record: ${lit(t.record)}` : ''} },`)
  .join('\n')}
];

/** The packages a model needs in its Descriptor before any of this compiles. */
export const ATL_PACKAGES: readonly string[] =
  ${JSON.stringify([...new Set([...rootModules.values()].map(m => m.pkg))].sort())};

/**
 * EVERY node that yields the given buffer, likeliest first. Several usually do,
 * and they are not interchangeable: \`SalesTable\` comes from both
 * \`sales().salesOrders()\` and \`sales().returnOrders()\`, and a helper that
 * silently returned one of them would hand a return order to a test about an
 * order. Matched on the buffer a test declares, so \`CustTable\` finds the node
 * producing an AtlEntityCustomer.
 */
export function atlNodesForTable(tableName: string): AtlTableNode[] {
  const wanted = tableName.toLowerCase();
  return ATL_TABLE_NODES.filter(
    n => n.record?.toLowerCase() === wanted || n.produces.toLowerCase() === wanted,
  );
}

/** The arrange line for one node, e.g. \`data.cust().customers().default().record()\`. */
export function atlArrangeLine(node: AtlTableNode): string {
  return \`data.\${node.path}\${node.record ? '.record()' : ''}\`;
}
`;

fs.writeFileSync(OUT, body, 'utf-8');
console.log(`\nWrote ${OUT}`);
