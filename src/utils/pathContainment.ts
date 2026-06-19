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

/** Normalise a path to absolute + POSIX separators for comparison. */
function normalise(p: string): string {
  if (!p) return '';
  let abs = isAbsoluteCrossPlatform(p) ? p : path.resolve(p);
  try { abs = realpathSync(abs); } catch { /* may not exist yet — ok */ }
  return abs.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** True when `child` is equal to or nested under `parent` (case-insensitive). */
function isUnder(child: string, parent: string): boolean {
  if (!parent) return false;
  const c = normalise(child).toLowerCase();
  const p = normalise(parent).toLowerCase();
  return c === p || c.startsWith(p + '/');
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
  const add = (r: string | null | undefined) => { if (r && r.trim()) roots.add(normalise(r)); };

  add(cfg.getPackagePath());
  try { add(await cfg.getCustomPackagesPath()); } catch { /* optional */ }
  try { add(await cfg.getMicrosoftPackagesPath()); } catch { /* optional */ }

  // Caller-supplied roots (e.g. the `packagePath` tool param pointing at a repo
  // checkout outside PackagesLocalDirectory). These are operator/agent-declared
  // metadata roots and carry the same trust as a configured root; the canonical
  // AOT-shape and model-hint checks below still apply to anything under them.
  for (const r of extraRoots ?? []) add(r);

  // Fallback only if nothing was configured — prevents writing to unrelated drives
  // when config is silently missing (better to error out than guess).
  if (roots.size === 0) add(fallbackPackagePath());

  // Broaden any *package-level* root up to its PackagesLocalDirectory base. An
  // explicit context.packagePath may point at a single package (e.g.
  // …/PackagesLocalDirectory/ApplicationSuite), but a custom object commonly
  // lives in a sibling package under the same PLD. Without this, the file is
  // found on disk yet rejected by containment because it sits beside — not
  // under — the configured root. The PLD base IS the legitimate D365FO write
  // boundary; the canonical-AOT-shape and standard-model guards downstream
  // still block writes into Microsoft-owned models.
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

  const canonical = normalise(filePath);

  // 1. Root containment
  const roots = await getAllowedRoots(opts?.extraRoots);
  const matchedRoot = roots.find(r => isUnder(canonical, r));
  if (!matchedRoot) {
    // When the path still has the canonical <…>/<Package>/<Model>/Ax<Type>/<File>
    // shape, the would-be package root is everything above <Package>. Surfacing
    // the exact value turns a generic "configure a root" into a copy-paste fix —
    // this is the common repo-checkout case (metadata outside PackagesLocalDirectory).
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
        // Show the *normalized* path (forward slashes, the form actually compared)
        // so the mismatch is apples-to-apples — the raw input slashes are irrelevant,
        // comparison is case-insensitive with separators normalized.
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
  const [, modelSeg, axFolder, lastSeg] = parts;
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

  return { ok: true, canonicalPath: canonical, matchedRoot };
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

  const canonical = normalise(dirPath);
  const roots = await getAllowedRoots();
  const matchedRoot = roots.find(r => isUnder(canonical, r));
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
