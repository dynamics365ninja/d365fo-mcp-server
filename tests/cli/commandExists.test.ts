/**
 * Prerequisite probing.
 *
 * `commandExists` gates the bridge build. Both mistakes it could make are
 * user-visible and unhelpful: a false negative tells someone with a working
 * .NET SDK to go install one, and a false positive lets the wizard spawn a
 * binary that is not there, producing `spawn dotnet ENOENT` — which names
 * nothing a user can act on.
 *
 * Deliberately probes `node` rather than `dotnet`: this suite runs on Linux CI
 * where no .NET SDK exists, and the property under test is the probe, not the
 * machine.
 */
import { describe, it, expect } from 'vitest';
import { commandExists } from '../../src/cli/exec.js';

describe('commandExists', () => {
  it('finds an executable that is on PATH', async () => {
    await expect(commandExists('node')).resolves.toBe(true);
  });

  it('reports a missing executable rather than throwing', async () => {
    // The spawn fails with ENOENT; surfacing that as an exception would abort
    // a wizard that only wanted to know whether to offer the build.
    await expect(commandExists('d365fo-definitely-not-installed')).resolves.toBe(false);
  });

  it('counts a non-zero exit as present', async () => {
    // Presence is the question, not health: an SDK that errors on a bad flag
    // is still an SDK, and reporting it missing would send the user to
    // reinstall something they already have.
    await expect(commandExists('node', '--not-a-real-flag')).resolves.toBe(true);
  });
});
