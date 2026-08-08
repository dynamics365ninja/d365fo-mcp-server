import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Integration tests (*.integration.test.ts) are run separately via
    // vitest.integration.config.ts (npm run test:integration) — keep them out
    // of the default unit run so the two tiers stay distinct.
    // `.claude/worktrees/**` holds full checkouts of this repo for parallel
    // sessions. Without excluding them, a run from the main tree collects every
    // test twice and reports another branch's failures as this branch's.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        'scripts/',
        // NOTE: do NOT add '.claude/worktrees/**' here. The v8 provider matches
        // these against absolute paths, and a parallel-session worktree lives
        // *under* that path — the pattern then excludes every source file and
        // coverage reports "Unknown% (0/0)", which satisfies the thresholds
        // below vacuously. The test `exclude` above is a different matcher and
        // does need it.
      ],
      // RATCHET, not a target. Measured on the full suite at the commit that
      // introduced these numbers: 62.12 statements / 52.92 branches /
      // 67.59 functions / 63.77 lines. Each threshold sits ~2 points below its
      // measurement so ordinary churn does not turn CI red, while a real drop
      // (deleting tests, adding a large untested module) does.
      //
      // Coverage was configured and @vitest/coverage-v8 installed long before
      // anything ran it, so these numbers were invisible and unenforceable.
      // The .github/workflows/ci.yml `coverage` job is what makes them bite.
      //
      // Raise these when coverage rises. Never lower them to make a build green
      // — lowering the floor is how a ratchet silently becomes decoration.
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 65,
        lines: 61,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
