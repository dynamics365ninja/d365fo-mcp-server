/**
 * Locating an executable that ships in the D365FO framework `bin` directory
 * (xppc.exe, labelc.exe, …).
 *
 * The same three-step probe applies to every one of them: the configured
 * Microsoft packages path first, then any UDE install under %LOCALAPPDATA%
 * (newest version first), then whichever volume this image put AosService on.
 * It lived inline in buildProject.ts as `findXppcExe` until label compilation
 * needed the identical lookup for labelc.exe.
 */

import path from 'path';
import { access, readdir } from 'fs/promises';
import { packagesRootCandidates } from './packagesRoot.js';

/**
 * Absolute path to `exeName` in a D365FO framework bin directory, or null when
 * no probed location holds it.
 *
 * @param microsoftPackagesPath Configured framework directory, when known.
 * @param exeName               File name, e.g. `xppc.exe`.
 */
export async function findFrameworkTool(
  microsoftPackagesPath: string | null,
  exeName: string,
): Promise<string | null> {
  const candidates: string[] = [];

  if (microsoftPackagesPath) {
    candidates.push(path.join(microsoftPackagesPath, 'bin', exeName));
  }

  // Search AppData for any installed UDE version
  const appDataLocal = process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
  const d365Base = path.join(appDataLocal, 'Microsoft', 'Dynamics365');
  try {
    const versions = await readdir(d365Base);
    for (const ver of versions.sort().reverse()) {
      candidates.push(path.join(d365Base, ver, 'PackagesLocalDirectory', 'bin', exeName));
    }
  } catch { /* ignore */ }

  // CHE: whichever volume this image put AosService on (C:, J:, K:, …)
  candidates.push(...packagesRootCandidates('bin', exeName));

  for (const c of candidates) {
    try { await access(c); return c; } catch { /* next */ }
  }
  return null;
}
