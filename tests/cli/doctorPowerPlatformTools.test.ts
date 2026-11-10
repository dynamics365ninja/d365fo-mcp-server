import { describe, expect, it } from 'vitest';
import { checkPowerPlatformTools } from '../../src/cli/commands/doctor.js';

describe('doctor: Power Platform Tools on UDE', () => {
  it('reports the extension folder deploy will use', () => {
    const r = checkPowerPlatformTools(['C:\\VS\\Common7\\IDE\\Extensions\\abc']);
    expect(r).toMatchObject({ severity: 'ok', message: expect.stringContaining('Extensions\\abc') });
  });

  it('warns, with the install as the fix, when it is missing', () => {
    const r = checkPowerPlatformTools([]);
    expect(r.severity).toBe('warn');
    expect(r.message).toContain('cannot deploy');
    expect(r.fix).toContain('Power Platform Tools');
  });
});
