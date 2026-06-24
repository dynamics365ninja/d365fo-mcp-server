import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Integration tests (*.integration.test.ts) are run separately via
    // vitest.integration.config.ts (npm run test:integration) — keep them out
    // of the default unit run so the two tiers stay distinct.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        'scripts/',
      ],
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
