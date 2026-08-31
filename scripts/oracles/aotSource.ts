/**
 * Shared reader for the ORACLE that outranks every document: Microsoft's own
 * shipped X++.
 *
 * `PackagesLocalDirectory` holds ~105k AOT XML files whose `<![CDATA[ … ]]>`
 * blocks are real X++ that really compiles. Any claim about the language can be
 * checked against it — "does anyone write this?", "how often?", "what shape?" —
 * and a validator rule that fires on it is, by construction, our bug: Microsoft's
 * code compiles.
 *
 * Two consumers today: `census.ts` (what the language actually looks like) and
 * `validatorSweep.ts` (what our rules say about it). Both need the same walk,
 * the same CDATA extraction and the same filters, so it lives here once.
 *
 * `--dry` swaps the VM for `tests/fixtures/oracles/`, a small corpus that carries
 * the exact shapes which once produced false positives. That is what lets the
 * sweep run in CI on a machine with no D365FO installed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Where the shipped source lives on a VM. */
export const PACKAGES_ROOT = process.env.PACKAGES_ROOT ?? 'K:/AosService/PackagesLocalDirectory';

/** The offline stand-in used by `--dry` (and therefore by CI). */
export const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'oracles');

/** AOT element folders that carry X++ source worth scanning. */
export const SOURCE_TYPES = [
  'AxClass', 'AxTable', 'AxForm', 'AxQuery', 'AxView', 'AxMap', 'AxDataEntityView',
  'AxTableExtension', 'AxFormExtension', 'AxReport', 'AxMacro',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export interface AotFile {
  /** Absolute path of the XML file. */
  file: string;
  /** Owning package, e.g. `ApplicationSuite`. */
  packageName: string;
  /** AOT folder, e.g. `AxClass`. */
  type: string;
  /** Element name taken from the file name (see the casing caveat below). */
  name: string;
  /** Raw file text. */
  xml: string;
}

export interface CdataBlock extends AotFile {
  /** One `<![CDATA[ … ]]>` payload. */
  source: string;
  /** Offset of the payload inside `xml`, so line numbers can be recovered. */
  offset: number;
}

export interface WalkOptions {
  /** Use the offline fixture corpus instead of the platform install. */
  dry?: boolean;
  /** Restrict to these AOT folders (default: all of SOURCE_TYPES). */
  types?: readonly string[];
  /** Restrict to these packages (default: all). */
  packages?: readonly string[];
  /** Stop after this many files (0 = no limit). Applied after filtering. */
  limit?: number;
  /** Root override; defaults to PACKAGES_ROOT (or FIXTURE_ROOT when `dry`). */
  root?: string;
}

/**
 * Enumerate AOT XML files.
 *
 * The layout is `<root>/<Package>/<Model>/<AxType>/<Name>.xml`, and a package can
 * hold several models, so the walk is depth-limited rather than fully recursive —
 * a full recursive walk of 2.5 GB costs minutes and finds nothing extra.
 *
 * Caveat inherited from a real defect: the FILE NAME is not authoritative for
 * casing (`SRSReportParameterAttribute.xml` holds `<Name>SrsReportParameterAttribute</Name>`).
 * Callers that need the exact spelling must read the `<Name>` element.
 */
export function* walkAot(options: WalkOptions = {}): Generator<AotFile> {
  const root = options.root ?? (options.dry ? FIXTURE_ROOT : PACKAGES_ROOT);
  const wantTypes = new Set<string>(options.types ?? SOURCE_TYPES);
  const wantPackages = options.packages ? new Set(options.packages) : undefined;
  const limit = options.limit ?? 0;
  let emitted = 0;

  if (!fs.existsSync(root)) {
    throw new Error(
      `AOT root not found: ${root}\n` +
      (options.dry
        ? 'The fixture corpus is missing — did tests/fixtures/oracles/ get deleted?'
        : 'Set PACKAGES_ROOT, or pass --dry to run against tests/fixtures/oracles/.'),
    );
  }

  // The fixture corpus is flat: <root>/<AxType>/<Name>.xml.
  const packageDirs = options.dry
    ? [{ packageName: 'fixtures', dir: root }]
    : safeDirs(root)
      .filter(p => !wantPackages || wantPackages.has(p))
      .map(p => ({ packageName: p, dir: path.join(root, p) }));

  for (const { packageName, dir } of packageDirs) {
    // A package holds one or more model folders; the fixture corpus holds the
    // AxType folders directly.
    const modelDirs = options.dry ? [dir] : safeDirs(dir).map(m => path.join(dir, m));
    for (const modelDir of modelDirs) {
      for (const type of safeDirs(modelDir)) {
        if (!wantTypes.has(type)) continue;
        const typeDir = path.join(modelDir, type);
        for (const entry of safeFiles(typeDir)) {
          if (!entry.toLowerCase().endsWith('.xml')) continue;
          let xml: string;
          try {
            xml = fs.readFileSync(path.join(typeDir, entry), 'utf-8');
          } catch {
            continue; // locked or vanished mid-walk; not our problem to fix here
          }
          yield {
            file: path.join(typeDir, entry),
            packageName,
            type,
            name: entry.replace(/\.xml$/i, ''),
            xml,
          };
          emitted++;
          if (limit && emitted >= limit) return;
        }
      }
    }
  }
}

/** Every `<![CDATA[ … ]]>` payload in the walked files. */
export function* walkXppSource(options: WalkOptions = {}): Generator<CdataBlock> {
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  for (const file of walkAot(options)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.xml)) !== null) {
      yield { ...file, source: m[1], offset: m.index + '<![CDATA['.length };
    }
  }
}

/** All X++ of one file, concatenated — what a per-file rule sweep wants. */
export function xppOf(file: AotFile): string {
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.xml)) !== null) parts.push(m[1]);
  return parts.join('\n');
}

function safeDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

function safeFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);
  } catch {
    return [];
  }
}

/** Minimal `--flag value` / `--flag=value` / `--flag` parser shared by the CLIs. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

/** Shared `--dry --types --packages --limit` handling. */
export function walkOptionsFromArgs(args: Record<string, string | true>): WalkOptions {
  return {
    dry: args.dry === true || args.dry === 'true',
    types: typeof args.types === 'string' ? args.types.split(',') : undefined,
    packages: typeof args.packages === 'string' ? args.packages.split(',') : undefined,
    limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
    root: typeof args.root === 'string' ? args.root : undefined,
  };
}
