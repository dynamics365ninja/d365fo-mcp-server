/**
 * Benchmark of the xref SQLite provider on a real export:
 *
 *   npm run xref:bench -- <xref.db> [--runs N] [--cold] [--target ID] [--name PATH]
 *
 * Opens the file through the provider (src/xref/sqliteXrefProvider.ts) exactly as
 * the server does, and prints for each query the first call and the median of N
 * warm calls, plus the time to open the file and the process RSS before and
 * after. The query mix is the sqlite3-CLI host bench's (busiest target, an
 * ordinary target, a name, the names under a prefix, callers, a per-module
 * aggregate) in the provider's bounded form, plus extension classes and event
 * subscriptions.
 *
 * Inputs come from the file itself and are picked before anything is timed
 * (picking scans the whole References index and warms the cache, so --cold
 * drops the page cache after it). Nothing read from the file is printed: no
 * path, name or module — only ids, counts, lengths and times — because the file
 * holds customer code. The file is opened read-only and immutable; it is never
 * changed.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { openXrefSqliteReadOnly, SqliteXrefProvider } from '../src/xref/sqliteXrefProvider.js';
import { xrefSqliteCounting } from '../src/xref/xrefSource.js';

const USAGE = `Usage: npm run xref:bench -- <xref.db> [--runs N] [--cold] [--target ID] [--name PATH]
  <xref.db>    the export to measure (opened read-only; the live file is fine)
  --runs N     warm repetitions per query (default 5, 1..999; the median is reported)
  --cold       drop the page cache after picking the inputs (root, passwordless sudo, or a prompt);
               affects the whole host, so only while it is not serving. Without it, "first" is not cold
  --target ID  use this TargetId as the busy target instead of the most referenced one
  --name PATH  use this Names.Path for the name lookups instead of an arbitrary class method`;

type Row = Record<string, unknown>;

function parseArgs(argv: string[]) {
  const a = {
    file: '',
    runs: 5,
    cold: false,
    target: undefined as number | undefined,
    name: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--runs') a.runs = Number(argv[++i]);
    else if (v === '--cold') a.cold = true;
    else if (v === '--target') a.target = Number(argv[++i]);
    else if (v === '--name') a.name = argv[++i];
    else if (v === '-h' || v === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (v.startsWith('-') || a.file) {
      console.error(USAGE);
      process.exit(2);
    } else a.file = v;
  }
  if (!a.file) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!Number.isInteger(a.runs) || a.runs < 1 || a.runs > 999) {
    console.error('--runs must be 1..999');
    process.exit(2);
  }
  if (a.target !== undefined && !Number.isInteger(a.target)) {
    console.error('--target must be a number');
    process.exit(2);
  }
  return a;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`;
const rss = () => process.memoryUsage().rss;
function cachedKb(): number | undefined {
  try {
    const m = /^Cached:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Inputs, picked through a read-only connection of their own that is closed before timing. */
function pickInputs(file: string, target?: number, name?: string) {
  const db = openXrefSqliteReadOnly(file);
  try {
    const one = (sql: string, ...p: Array<string | number>) => db.prepare(sql).get(...p) as Row | undefined;
    const busy =
      target ??
      Number(one('SELECT TargetId AS t FROM "References" GROUP BY TargetId ORDER BY count(*) DESC LIMIT 1')?.t);
    let ordinary = Number(
      one('SELECT TargetId AS t FROM "References" GROUP BY TargetId HAVING count(*) BETWEEN 10 AND 200 LIMIT 1')?.t,
    );
    if (!Number.isFinite(ordinary)) {
      console.log('WARN: no target with 10..200 references, the "ordinary" rows use the busy target');
      ordinary = busy;
    }
    const methodName = (offset: number) =>
      one(`SELECT Path AS p FROM Names WHERE Path LIKE '/Classes/%/Methods/%' LIMIT 1 OFFSET ${offset}`)?.p as
        | string
        | undefined;
    const nameLookup = name ?? methodName(100_000) ?? methodName(0);
    // The object extended by the most [ExtensionOf] classes: a real CoC and event target.
    const extended = one(`
      SELECT t.Path AS p, COUNT(DISTINCT ra.SourceId) AS n
      FROM Names att
      CROSS JOIN "References" ra ON ra.TargetId = att.Id
      CROSS JOIN "References" rc ON rc.SourceId = ra.SourceId
      CROSS JOIN Names t ON t.Id = rc.TargetId
      WHERE att.Path = '/Classes/ExtensionOf' COLLATE NOCASE AND ra.Kind = 7
        AND rc.Line = ra.Line AND rc.Kind = 2
        AND (t.Path LIKE '/Tables/%' OR t.Path LIKE '/Classes/%') AND t.Path NOT LIKE '/%/%/%'
      GROUP BY t.Path ORDER BY n DESC LIMIT 1`);
    const pathOf = (id: number) => one('SELECT Path AS p FROM Names WHERE Id = ?', id)?.p as string | undefined;
    const refCount = (id: number) => Number(one('SELECT count(*) AS n FROM "References" WHERE TargetId = ?', id)?.n);
    const meta = Object.fromEntries(
      (db.prepare('SELECT key, value FROM meta').all() as Row[]).map(r => [String(r.key), String(r.value)]),
    );
    const modules = Number(one('SELECT count(*) AS n FROM Modules')?.n);
    return {
      busy,
      busyPath: pathOf(busy),
      busyRefs: refCount(busy),
      ordinary,
      ordinaryPath: pathOf(ordinary),
      ordinaryRefs: refCount(ordinary),
      name: nameLookup,
      extendedBase: extended ? String(extended.p).split('/')[2] : undefined,
      extendedBy: extended ? Number(extended.n) : 0,
      meta,
      modules,
    };
  } finally {
    db.close();
  }
}

async function dropCache(): Promise<void> {
  const cmd = 'sync; echo 3 > /proc/sys/vm/drop_caches';
  const ok = (r: ReturnType<typeof spawnSync>) => r.status === 0;
  if (process.getuid?.() === 0) {
    if (!ok(spawnSync('sh', ['-c', cmd], { stdio: 'inherit' }))) throw new Error('dropping the page cache failed');
  } else if (ok(spawnSync('sudo', ['-n', 'true']))) {
    if (!ok(spawnSync('sudo', ['sh', '-c', cmd], { stdio: 'inherit' })))
      throw new Error('dropping the page cache failed');
  } else if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(
      `no sudo here. In another terminal on this host run:  sudo sh -c '${cmd}'\npress Enter when done `,
    );
    rl.close();
  } else {
    throw new Error(
      'cannot drop the page cache (not root, no passwordless sudo, no terminal): run it yourself, then start without --cold',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.file)) {
    console.error(`cannot read ${args.file}`);
    process.exit(1);
  }

  const size = fs.statSync(args.file).size;
  const inputs = pickInputs(args.file, args.target, args.name);
  if (!inputs.busyPath || !inputs.ordinaryPath || !inputs.name) {
    console.error('could not pick inputs (empty file?)');
    process.exit(1);
  }
  const prefix = `${inputs.name.slice(0, inputs.name.lastIndexOf('/'))}/`;
  // Never print a name from the file, not even inside an error message.
  const secrets = [inputs.busyPath, inputs.ordinaryPath, inputs.name, prefix, inputs.extendedBase].filter(
    Boolean,
  ) as string[];
  const scrub = (s: string) => secrets.reduce((t, x) => t.split(x).join('<name>'), s);

  console.log(
    `file: ${mb(size)}, node ${process.version}, schema ${inputs.meta.schema ?? '?'}, exported ${inputs.meta.exported_at ?? '?'}`,
  );
  console.log(
    `tables: ${inputs.modules} modules, ${inputs.meta.names ?? '?'} names, ${inputs.meta.references ?? '?'} references (meta)`,
  );
  console.log(
    `inputs: busy target ${inputs.busy} (${inputs.busyRefs} refs), ordinary target ${inputs.ordinary} (${inputs.ordinaryRefs} refs)`,
  );
  console.log(
    `        name length ${inputs.name.length}, prefix length ${prefix.length}, ` +
      `most extended object: ${inputs.extendedBase ? `${inputs.extendedBy} extension classes` : 'none found'}`,
  );
  console.log('        (the names themselves are not printed: they may be customer code)');

  if (args.cold) {
    const before = cachedKb();
    await dropCache();
    const after = cachedKb();
    if (before !== undefined && after !== undefined) {
      console.log(`page cache: Cached ${(before / 1024).toFixed(0)} MB -> ${(after / 1024).toFixed(0)} MB`);
      if (after > before / 2) console.log('WARN: the cache was not (fully) dropped: the "cold" column is not cold');
    }
  }

  const c0 = cachedKb();
  const rss0 = rss();
  const t0 = performance.now();
  const provider = new SqliteXrefProvider(args.file, () => {
    /* the status is printed below */
  });
  const status = provider.status();
  const openMs = performance.now() - t0;
  if (status.state !== 'ok') {
    console.error(`the provider refuses the file: ${scrub(status.reason)}`);
    process.exit(1);
  }
  console.log('');
  console.log(`open + validate through the provider: ${openMs.toFixed(1)} ms (${status.modules} modules)`);
  console.log(`totals: ${xrefSqliteCounting(status)}`);
  console.log(`process RSS before open: ${mb(rss0)}`);

  const mode = args.cold ? 'cold' : 'first';
  console.log('');
  console.log(
    `${'query (bounded as the provider runs it)'.padEnd(44)} ${mode.padStart(10)} ${`warm median/${args.runs}`.padStart(16)}  result`,
  );

  const bench = (label: string, fn: () => string) => {
    let result = '';
    const time = () => {
      const s = performance.now();
      result = fn();
      return performance.now() - s;
    };
    try {
      const first = time();
      const warm = Array.from({ length: args.runs }, time).sort((a, b) => a - b);
      const median = warm[Math.floor((warm.length - 1) / 2)];
      console.log(
        `${label.padEnd(44)} ${`${first.toFixed(1)} ms`.padStart(10)} ${`${median.toFixed(1)} ms`.padStart(16)}  ${result}`,
      );
    } catch (e) {
      console.log(`${label.padEnd(44)} failed: ${scrub((e as Error).message)}`);
    }
  };

  const plus = (capped?: boolean) => (capped ? '+' : '');
  bench('refs of the busy target', () => {
    const r = provider.findReferencesSync(inputs.busyPath!);
    return `${r.count} rows, total ${r.total}${plus(r.totalCapped)}`;
  });
  bench('refs of an ordinary target', () => {
    const r = provider.findReferencesSync(inputs.ordinaryPath!);
    return `${r.count} rows, total ${r.total}${plus(r.totalCapped)}`;
  });
  bench('name, exact (NOCASE)', () => `${provider.lookupPath(inputs.name!).length} ids`);
  bench('names under a prefix (range, LIMIT 200)', () => `${provider.pathsUnder(prefix, 200).length} ids`);
  bench('callers of the busy target (LIMIT 200)', () => {
    const r = provider.findApiUsageCallersSync(inputs.busyPath!, { limit: 200 });
    return `${r.totalCallers}${plus(r.more)} callers, ${r.uniqueClasses} classes`;
  });
  bench('callers of an ordinary target (LIMIT 200)', () => {
    const r = provider.findApiUsageCallersSync(inputs.ordinaryPath!, { limit: 200 });
    return `${r.totalCallers}${plus(r.more)} callers, ${r.uniqueClasses} classes`;
  });
  bench('busy target, per module (bounded)', () => {
    const r = provider.referencesPerModule(inputs.busy);
    const n = [...r.modules.values()].reduce((a, b) => a + b, 0);
    return `${r.modules.size} modules, ${n}${plus(r.capped)} refs`;
  });
  if (inputs.extendedBase) {
    bench('extension classes of the most extended', () => {
      const r = provider.findExtensionClassesSync(inputs.extendedBase!);
      return `${r.count} classes, ${r.extensions.reduce((a, e) => a + (e.wrappedMethods?.length ?? 0), 0)} wraps`;
    });
    bench('event subscriptions of the same object', () => {
      const r = provider.findEventSubscribersSync(inputs.extendedBase!);
      return `${r.count} handlers${r.scanCapped ? `, scan stopped at ${r.scanned}` : ''}`;
    });
  } else {
    console.log('extension classes / event subscriptions: skipped, no [ExtensionOf] class in the file');
  }

  const c1 = cachedKb();
  console.log('');
  console.log(`process RSS after: ${mb(rss())} (before open ${mb(rss0)})`);
  if (c0 !== undefined && c1 !== undefined) {
    console.log(
      `page cache (Cached, whole host): ${(c0 / 1024).toFixed(0)} MB -> ${(c1 / 1024).toFixed(0)} MB ` +
        `(+${((c1 - c0) / 1024).toFixed(0)} MB = hot working set of this mix)`,
    );
  }
  provider.close();
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
