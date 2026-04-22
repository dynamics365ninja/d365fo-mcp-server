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
async function getAllowedRoots(): Promise<string[]> {
  const cfg = getConfigManager();
  await cfg.ensureLoaded();
  const roots = new Set<string>();
  const add = (r: string | null | undefined) => { if (r && r.trim()) roots.add(normalise(r)); };

  add(cfg.getPackagePath());
  try { add(await cfg.getCustomPackagesPath()); } catch { /* optional */ }
  try { add(await cfg.getMicrosoftPackagesPath()); } catch { /* optional */ }

  // Fallback only if nothing was configured — prevents writing to unrelated drives
  // when config is silently missing (better to error out than guess).
  if (roots.size === 0) add(fallbackPackagePath());
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
): Promise<PathContainmentResult> {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, reason: 'filePath is empty' };
  }
  if (!isAbsoluteCrossPlatform(filePath)) {
    return { ok: false, reason: `filePath must be absolute: "${filePath}"` };
  }

  const canonical = normalise(filePath);

  // 1. Root containment
  const roots = await getAllowedRoots();
  const matchedRoot = roots.find(r => isUnder(canonical, r));
  if (!matchedRoot) {
    return {
      ok: false,
      reason:
        `Refusing to write outside configured D365FO package roots.\n` +
        `  path:    ${filePath}\n` +
        `  allowed: ${roots.join(' | ') || '(none configured)'}`,
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
export async function ensureWritePathAllowed(filePath: string, modelHint?: string): Promise<string> {
  const r = await assertWritePathAllowed(filePath, modelHint);
  if (!r.ok) throw new Error(`⛔ Path containment check failed: ${r.reason}`);
  return r.canonicalPath!;
}
