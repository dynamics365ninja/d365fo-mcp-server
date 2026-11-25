/**
 * Vitest Setup File
 * Loads environment variables for tests
 */

import 'dotenv/config';
import * as fs from 'node:fs';
// A developer's .env limits which label languages create may add; CI has none. Tests
// that need a restriction set LABEL_LANGUAGES themselves.
delete process.env.LABEL_LANGUAGES;
import * as os from 'node:os';
import { afterAll, vi } from 'vitest';
import { TMPDIR_CANARY_ENV } from './tmpdirGuard.globalSetup';

// A new project's .rnrproj comes from the Visual Studio installed on the machine (vswhere, then
// Program Files). Tests that create projects use the built-in template instead, so they don't
// depend on the machine. projectTemplate.test.ts tests the lookup through resolveProjectTemplate.
vi.mock('../src/workspace/projectTemplate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/workspace/projectTemplate.js')>();
  return {
    ...actual,
    defaultProjectTemplate: async () => ({
      text: actual.builtInTemplateText(actual.DEFAULT_BUILD_TASKS_TARGETS),
      source: 'built-in' as const, extensionFound: false, warnings: [], info: [],
    }),
  };
});

// Fails the test file during which the os.tmpdir() canary disappeared — see
// tests/tmpdirGuard.globalSetup.ts. Registered here, before the file's own
// hooks, so it runs after that file's cleanup. The canary is put back so only
// the files that were running at the time fail, not every file after them.
afterAll(() => {
  const canary = process.env[TMPDIR_CANARY_ENV];
  if (!canary || fs.existsSync(canary)) return;
  fs.writeFileSync(canary, 'Restored by tests/setup.ts after a deletion.\n');
  throw new Error(
    `A test deleted files directly in os.tmpdir() (${os.tmpdir()}) while this file was running ` +
    `(files run in parallel, so it may be a neighbour). Look for an fs.rm/rmSync whose target ` +
    `resolves to os.tmpdir() — typically path.dirname() of an mkdtemp folder — and remove only ` +
    `the folder the test created.`,
  );
});
