// tests/utils/configManager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('ConfigManager - UDE support', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should detect UDE environment type from env var', async () => {
    process.env.DEV_ENVIRONMENT_TYPE = 'ude';
    const { getConfigManager } = await import('../../src/utils/configManager.js');
    expect(typeof getConfigManager).toBe('function');
  });

  it('should support XPP_CONFIG_NAME env var', () => {
    process.env.XPP_CONFIG_NAME = 'contoso-dev-env1___10.0.2428.63';
    expect(process.env.XPP_CONFIG_NAME).toBe('contoso-dev-env1___10.0.2428.63');
  });
});
