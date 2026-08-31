/**
 * Two eval cases must not pin the same AOT object name.
 *
 * They share one sandbox model and each rolls it back, so a collision is
 * invisible while the cases run apart and corrupting when they do not: whichever
 * ran last owns the name, and `prepare(mode="create")` cannot warn about it
 * because it consults the LIVE sandbox index, which the previous case emptied.
 *
 * Found the honest way — an implementer picked the natural name
 * `ConDemoNoteArchive` for a new class and noticed it was already the table
 * output of `L2-performance-set-based`, whose build residue was still on disk.
 * It renamed before capturing, so the goldens are clean today; this keeps them
 * that way without anyone having to remember.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const GOLDENS = path.join(process.cwd(), 'eval', 'goldens');

/** Artifact name → the cases whose golden contains it. */
function ownersByArtifact(): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  if (!fs.existsSync(GOLDENS)) return owners;

  for (const caseId of fs.readdirSync(GOLDENS)) {
    const dir = path.join(GOLDENS, caseId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.toLowerCase().endsWith('.xml')) continue;
      const artifact = file.replace(/\.metadata\.xml$/i, '').replace(/\.xml$/i, '');
      const set = owners.get(artifact) ?? new Set<string>();
      set.add(caseId);
      owners.set(artifact, set);
    }
  }
  return owners;
}

describe('golden artifact names are owned by exactly one case', () => {
  it('no AOT object name appears in two cases', () => {
    const clashes = [...ownersByArtifact().entries()]
      .filter(([, cases]) => cases.size > 1)
      .map(([artifact, cases]) => `${artifact} → ${[...cases].sort().join(', ')}`);

    expect(
      clashes,
      'Two cases pin the same object name. They share one sandbox model, so the one that runs ' +
      'second overwrites the first, and prepare(create) cannot warn — it only sees the live ' +
      'sandbox, which the previous rollback emptied. Rename one of them.',
    ).toEqual([]);
  });

  it('scans a corpus large enough for the check to mean something', () => {
    // A guard that silently found no files would pass forever.
    expect(ownersByArtifact().size).toBeGreaterThan(50);
  });
});
