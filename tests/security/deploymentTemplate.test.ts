/**
 * Deployment template guard — regression cover for GHSA / CVE.
 *
 * The reported defect was not in the server logic but in the one-click deploy
 * path: `apiKey` carried `defaultValue: ""`, so the portal wizard completed
 * happily and produced an App Service with authentication switched off. These
 * tests fail the build if that default ever comes back.
 *
 * They also pin bicep ↔ ARM agreement. The two files drifted once already
 * (`azuredeploy.json` had a hand-edited location fallback that `main.bicep`
 * did not), which is how a template can look reviewed and still ship wrong.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INFRA = join(__dirname, '..', '..', 'infrastructure');
const arm = JSON.parse(readFileSync(join(INFRA, 'azuredeploy.json'), 'utf8'));
const bicep = readFileSync(join(INFRA, 'main.bicep'), 'utf8');

describe('azuredeploy.json — apiKey must be required', () => {
  it('declares apiKey as a securestring', () => {
    expect(arm.parameters.apiKey.type).toBe('securestring');
  });

  it('has NO defaultValue — a blank key disables auth entirely', () => {
    expect(arm.parameters.apiKey).not.toHaveProperty('defaultValue');
  });

  it('enforces a minimum key length so "test" is not accepted', () => {
    expect(arm.parameters.apiKey.minLength).toBeGreaterThanOrEqual(32);
  });

  it('wires the parameter into the App Service API_KEY setting', () => {
    const site = arm.resources.find((r: any) => r.type === 'Microsoft.Web/sites');
    const setting = site.properties.siteConfig.appSettings
      .find((s: any) => s.name === 'API_KEY');
    expect(setting.value).toBe("[parameters('apiKey')]");
  });

  it('keeps the App Service pinned to read-only mode', () => {
    const site = arm.resources.find((r: any) => r.type === 'Microsoft.Web/sites');
    const setting = site.properties.siteConfig.appSettings
      .find((s: any) => s.name === 'MCP_SERVER_MODE');
    expect(setting.value).toBe('read-only');
  });
});

describe('main.bicep — stays in sync with the ARM output', () => {
  it('declares apiKey without a default', () => {
    expect(bicep).toMatch(/^param apiKey string$/m);
    expect(bicep).not.toMatch(/param apiKey string\s*=/);
  });

  it('marks apiKey secure and length-constrained', () => {
    expect(bicep).toMatch(/@secure\(\)\s*\n\s*@minLength\(\d+\)\s*\n\s*param apiKey string/);
  });

  it('declares every parameter the ARM template exposes', () => {
    for (const name of Object.keys(arm.parameters)) {
      expect(bicep, `param ${name} missing from main.bicep`)
        .toMatch(new RegExp(`^param ${name}\\b`, 'm'));
    }
  });
});
