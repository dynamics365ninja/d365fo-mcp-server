/**
 * Path containment guard for D365FO write operations.
 *
 * All D365FO XML objects live at the canonical path:
 *   <PackagesLocalDirectory>/<Package>/<Model>/Ax<Type>/<Name>.xml
 *
 * UDE layout is analogous under the custom packages root.
 *
 * This guard ensures that any file path the server is asked to write to
 * actually resolves underneath one of the configured package roots AND
 * contains the expected `/<Package>/<Model>/Ax*` segment shape. It prevents:
 *   - path traversal via explicit filePath / sourcePath JSON
 *   - writes to arbitrary locations on the host (repos, system dirs, etc.)
 *   - silent drift between the "resolved model" and the actual on-disk model
 *
 * Security-wise this is the single authoritative place that decides whether
 * a given absolute path is an acceptable write target.
 */

import * as path from 'path';
import { realpathSync } from 'fs';
import { getConfigManager, fallbackPackagePath } from './configManager.js';

export interface PathContainmentResult {
  ok: boolean;
  /** When ok=false, human-readable reason. */
  reason?: string;
  /** When ok=true, the canonical absolute path with on-disk casing applied. */
  canonicalPath?: string;
  /** Matched root (for diagnostics). */
  matchedRoot?: string;
  /** `<Package>` segment of the canonical layout, when ok. */
  packageSegment?: string;
  /**
   * `<Model>` segment of the canonical layout, when ok — the model that actually
   * OWNS the file. Package and model differ whenever one package carries several
   * models, so ownership decisions (see crossModelWriteGuard) must read this and
   * not the package name.
   */
  modelSegment?: string;
}

/**
 * True when `p` looks absolute on either POSIX or Windows, regardless of host
 * OS. The server routinely runs on Windows but tests (and Azure proxy) run on
 * Linux/macOS against Windows-style paths — using only `path.isAbsolute` would
 * reject valid production paths in those cross-platform contexts.
 */
function isAbsoluteCrossPlatform(p: string): boolean {
  if (!p) return false;
  if (path.isAbsolute(p)) return true;
  // Windows drive letter (C:\...) or UNC (\\server\share\...)
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
}

function toAbsolute(p: string): string {
  // Already-absolute input is NOT handed to path.resolve: on POSIX it would treat
  // a Windows-style "C:\…" path as relative and prefix the cwd, and this server is
  // routinely asked about Windows paths from a Linux host (tests, Azure proxy).
  // `..` collapsing is therefore done lexically by lexicalResolve below, which is
  // what actually neutralises traversal — see the note there.
  return isAbsoluteCrossPlatform(p) ? p : path.resolve(p);
}

/** Split an absolute path into its root prefix (`C:/`, `//server/share/`, `/`) and the rest. */
function splitRoot(p: string): { root: string; rest: string } {
  const s = p.replace(/\\/g, '/');
  const unc = /^(\/\/[^/]+\/[^/]+)(?:\/|$)/.exec(s);
  if (unc) return { root: unc[1] + '/', rest: s.slice(unc[0].length) };
  const drive = /^([a-zA-Z]:)\//.exec(s);
  if (drive) return { root: drive[1] + '/', rest: s.slice(drive[0].length) };
  if (s.startsWith('/')) return { root: '/', rest: s.slice(1) };
  return { root: '', rest: s };
}

/**
 * Absolute, POSIX-separated, with `.` and `..` segments collapsed lexically.
 *
 * This is the step that makes containment sound. Without it an already-absolute
 * path kept its `..` segments all the way through both the root check and the
 * AOT-shape check — `<root>/Pkg/Model/AxTable/a.xml/../../../../../evil/x.xml`
 * starts under an allowed root and its first four segments are shaped like a
 * valid AOT path, so it passed every guard and Win32 collapsed it only at the
 * moment of the write, landing anywhere on disk.
 *
 * Returns null when the path climbs above its own root: such a path has no
 * meaning as a target here and is rejected outright rather than clamped.
 */
function lexicalResolve(p: string): string | null {
  if (!p) return null;
  const { root, rest } = splitRoot(toAbsolute(p));
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // escapes above the root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return (root + out.join('/')).replace(/\/+$/, '');
}

/** Absolute + POSIX separators, WITHOUT symlink resolution (the as-given form). */
function lexicalNorm(p: string): string {
  return lexicalResolve(p) ?? '';
}

/**
 * Absolute + POSIX separators WITH symlink resolution (realpath).
 *
 * A write target usually does not exist yet, so realpathSync throws on the full
 * path; we then resolve the deepest ancestor that DOES exist and re-append the
 * remainder, so a new file under a symlinked model directory still resolves
 * through that symlink instead of silently falling back to the lexical form.
 */
function realNorm(p: string): string {
  const lex = lexicalResolve(p);
  if (lex === null) return '';
  const posix = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  try { return posix(realpathSync(lex)); } catch { /* target may not exist yet */ }
  const { root, rest } = splitRoot(lex);
  const segs = rest.split('/').filter(Boolean);
  for (let i = segs.length - 1; i > 0; i--) {
    try {
      const real = posix(realpathSync(root + segs.slice(0, i).join('/')));
      return [real, ...segs.slice(i)].join('/');
    } catch { /* keep climbing */ }
  }
  return lex;
}

/** Back-compat alias — defaults to the realpath form. */
function normalise(p: string): string {
  return realNorm(p);
}

function startsUnder(child: string, parent: string): boolean {
  if (!parent) return false;
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p + '/');
}

/**
 * True when `child` is equal to or nested under `parent`, comparing BOTH the
 * lexical (as-given) and realpath (symlink-resolved) forms of each side.
 *
 * A D365FO model directory is commonly a symlink (e.g.
 * `…/PackagesLocalDirectory/<Model>` → a repo checkout), so a realpath-only
 * comparison would wrongly reject a legitimate path reached through it.
 * `..` traversal is still neutralised by path.resolve in both forms.
 */
function isUnder(child: string, parent: string): boolean {
  if (!parent) return false;
  const cl = lexicalNorm(child), cr = realNorm(child);
  const pl = lexicalNorm(parent), pr = realNorm(parent);
  return startsUnder(cl, pl) || startsUnder(cr, pr) || startsUnder(cl, pr) || startsUnder(cr, pl);
}

/**
 * Build the list of allowed root directories for D365FO writes from config.
 * Order: configured package path → UDE custom packages → UDE Microsoft packages → fallback.
 * Empty/undefined entries are skipped.
 */
async function getAllowedRoots(extraRoots?: (string | null | undefined)[]): Promise<string[]> {
  const cfg = getConfigManager();
  await cfg.ensureLoaded();
  const roots = new Set<string>();
  // Store roots in lexical (as-configured) form; realpath form is derived per-comparison.
  const add = (r: string | null | undefined) => { if (r && r.trim()) roots.add(lexicalNorm(r)); };

  add(cfg.getPackagePath());
  try { add(await cfg.getCustomPackagesPath()); } catch { /* optional */ }
  try { add(await cfg.getMicrosoftPackagesPath()); } catch { /* optional */ }

  // Caller-supplied roots (e.g. `packagePath` pointing at a repo checkout outside
  // PackagesLocalDirectory) carry the same trust as a configured root; the
  // canonical AOT-shape and model-hint checks below still apply to them.
  for (const r of extraRoots ?? []) add(r);

  // Fallback only if nothing was configured — prevents writing to unrelated
  // drives when config is silently missing.
  if (roots.size === 0) add(fallbackPackagePath());

  // Broaden any package-level root up to its PackagesLocalDirectory base: a
  // custom object commonly lives in a sibling package under the same PLD as an
  // explicit single-package root. The canonical-AOT-shape and standard-model
  // guards downstream still block writes into Microsoft-owned models.
  for (const r of [...roots]) {
    const m = r.match(/^(.*\/PackagesLocalDirectory)(?:\/|$)/i);
    if (m && m[1] !== r) roots.add(m[1]);
  }
  return [...roots];
}

/**
 * Validate that `filePath` points at a D365FO AOT file inside an allowed root
 * and matches the canonical `<root>/<Package>/<Model>/Ax<Type>/<Name>.xml` shape.
 *
 * `modelHint` (optional) is the model name the caller expects to modify; when
 * provided we additionally require the path's model segment to match it
 * (case-insensitive). This catches the agent-steered attack where `modelName`
 * is one value but `filePath` points into a different (standard) model.
 */
export async function assertWritePathAllowed(
  filePath: string,
  modelHint?: string,
  opts?: { extraRoots?: (string | null | undefined)[] },
): Promise<PathContainmentResult> {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, reason: 'filePath is empty' };
  }
  if (!isAbsoluteCrossPlatform(filePath)) {
    return { ok: false, reason: `filePath must be absolute: "${filePath}"` };
  }

  // Containment accepts either the lexical (as-given) or realpath form of the
  // file path; the AOT-shape check below must slice with the SAME form that
  // matched, so both are carried through instead of pre-collapsing to realpath.
  const fileLex = lexicalNorm(filePath);
  if (!fileLex) {
    return {
      ok: false,
      reason: `Refusing to write to a path that traverses above its own root: "${filePath}"`,
    };
  }
  const fileReal = realNorm(filePath);

  // 1. Root containment
  const roots = await getAllowedRoots(opts?.extraRoots);
  let matchedRoot: string | undefined;
  let canonical = fileReal;
  for (const r of roots) {
    const rReal = realNorm(r);
    if (startsUnder(fileLex, r) || startsUnder(fileLex, rReal)) {
      matchedRoot = startsUnder(fileLex, r) ? r : rReal;
      canonical = fileLex;
      break;
    }
    if (startsUnder(fileReal, rReal) || startsUnder(fileReal, r)) {
      matchedRoot = startsUnder(fileReal, rReal) ? rReal : r;
      canonical = fileReal;
      break;
    }
  }
  if (!matchedRoot) {
    // When the path still has the canonical <…>/<Package>/<Model>/Ax<Type>/<File>
    // shape, the would-be package root is everything above <Package> — surface it
    // as a copy-paste suggestion (common case: metadata outside PackagesLocalDirectory).
    const segs = canonical.split('/').filter(Boolean);
    const axIdx = segs.findIndex(s => /^Ax[A-Z]/.test(s));
    const derivedRoot =
      axIdx >= 3 && axIdx === segs.length - 2 ? segs.slice(0, axIdx - 2).join('/') : '';
    const suggestion = derivedRoot
      ? `    This object's package root looks like: ${derivedRoot}\n` +
        `    → per call:   packagePath="${derivedRoot}"\n` +
        `    → persistent: set context.customPackagesPath / D365FO_CUSTOM_PACKAGES_PATH to it (and restart).\n`
      : `    Set context.customPackagesPath / D365FO_CUSTOM_PACKAGES_PATH (and restart), ` +
        `or pass packagePath="<root that contains the model>".\n`;
    return {
      ok: false,
      reason:
        `Refusing to write outside configured D365FO package roots.\n` +
        // Normalized path shown (forward slashes) — comparison is case-insensitive
        // with separators normalized, so raw input slashes are irrelevant.
        `  resolved path: ${canonical}\n` +
        `  allowed roots:\n` +
        (roots.length ? roots.map(r => `    - ${r}`).join('\n') : '    (none configured)') + '\n' +
        `  → The file resolved under none of these roots (its model is not on an allowed root):\n` +
        suggestion +
        `    It is NOT a path-separator issue.`,
    };
  }

  // 2. Canonical AOT shape:  <root>/<Package>/<Model>/Ax<Type>/<Name>.xml
  // (UDE layout also matches because customPackagesPath is itself the <root>.)
  const relative = canonical.slice(matchedRoot.length).replace(/^\/+/, '');
  const parts = relative.split('/').filter(Boolean);
  if (parts.length < 4) {
    return {
      ok: false,
      reason:
        `Path does not match canonical AOT layout (<Package>/<Model>/Ax<Type>/<File>):\n  ${filePath}`,
    };
  }
  const [packageSeg, modelSeg, axFolder, lastSeg] = parts;
  if (!/^Ax[A-Z]/.test(axFolder)) {
    return {
      ok: false,
      reason: `Expected Ax* folder as 3rd segment, got "${axFolder}" — path: ${filePath}`,
    };
  }
  if (!lastSeg.toLowerCase().endsWith('.xml') && !lastSeg.toLowerCase().endsWith('.xpp')) {
    return {
      ok: false,
      reason: `Expected .xml/.xpp file, got "${lastSeg}" — path: ${filePath}`,
    };
  }

  // 3. Optional model-hint cross-check
  if (modelHint && modelHint.trim() && modelHint !== 'any') {
    if (modelSeg.toLowerCase() !== modelHint.toLowerCase()) {
      return {
        ok: false,
        reason:
          `Model mismatch: filePath is in model "${modelSeg}" but caller requested "${modelHint}". ` +
          `This usually means the agent passed filePath from a different object.`,
      };
    }
  }

  return {
    ok: true,
    canonicalPath: canonical,
    matchedRoot,
    packageSegment: packageSeg,
    modelSegment: modelSeg,
  };
}

/** Throwing wrapper — convenient in tool handlers. */
export async function ensureWritePathAllowed(
  filePath: string,
  modelHint?: string,
  opts?: { extraRoots?: (string | null | undefined)[] },
): Promise<string> {
  const r = await assertWritePathAllowed(filePath, modelHint, opts);
  if (!r.ok) throw new Error(`⛔ Path containment check failed: ${r.reason}`);
  return r.canonicalPath!;
}

/**
 * Validate that `dirPath` is a directory inside one of the configured D365FO
 * package roots. Used as the read-side equivalent of `assertWritePathAllowed`
 * for workspace-scanning operations (`workspacePath` tool parameter).
 *
 * Prevents path traversal and arbitrary directory reads: any absolute path that
 * does NOT resolve under a configured package root is rejected outright.
 */
export async function assertReadRootAllowed(dirPath: string): Promise<PathContainmentResult> {
  if (!dirPath || typeof dirPath !== 'string') {
    return { ok: false, reason: 'dirPath is empty' };
  }
  if (!isAbsoluteCrossPlatform(dirPath)) {
    return { ok: false, reason: `dirPath must be absolute: "${dirPath}"` };
  }
  if (!lexicalNorm(dirPath)) {
    return {
      ok: false,
      reason: `Refusing to scan a path that traverses above its own root: "${dirPath}"`,
    };
  }

  // dirPath is passed raw (not pre-realpath'd) so isUnder can match it lexically
  // against an allowed root reached through a model-dir symlink.
  const roots = await getAllowedRoots();
  const matchedRoot = roots.find(r => isUnder(dirPath, r));
  const canonical = normalise(dirPath);
  if (!matchedRoot) {
    return {
      ok: false,
      reason:
        `Refusing to scan outside configured D365FO package roots.\n` +
        `  resolved path: ${canonical}\n` +
        `  allowed roots:\n` +
        (roots.length ? roots.map(r => `    - ${r}`).join('\n') : '    (none configured)'),
    };
  }

  return { ok: true, canonicalPath: canonical, matchedRoot };
}

/**
 * Check that a single file path (e.g. a glob result) still resolves under
 * `rootDir` after symlink resolution. Call this on every file returned by
 * a glob that was rooted at a validated workspace path — a symlink inside
 * the workspace could otherwise redirect a read outside the allowed root.
 */
export function isFileUnderRoot(filePath: string, rootDir: string): boolean {
  return isUnder(filePath, rootDir);
}
