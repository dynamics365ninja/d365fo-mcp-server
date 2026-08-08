import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.integration.{test,spec}.ts'],
    // `.claude/worktrees/**` holds full checkouts of this repo for parallel
    // sessions — same reason vitest.config.ts excludes them. Without this a run
    // from the main tree collects every integration test once per worktree.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/worktrees/**'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
