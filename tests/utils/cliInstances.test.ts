import { describe, expect, it } from 'vitest';
import { suggestPort } from '../../src/cli/instances.js';

const inst = (name: string, port: number | null) =>
  ({ name, dir: `/x/${name}`, envFile: `/x/${name}/.env`, port });

describe('cli suggestPort', () => {
  it('defaults to 3001 with no instances', () => {
    expect(suggestPort([])).toBe(3001);
  });

  it('suggests max used port + 1', () => {
    expect(suggestPort([inst('a', 3001), inst('b', 3005), inst('c', 3002)])).toBe(3006);
  });

  it('ignores instances without a parseable port', () => {
    expect(suggestPort([inst('a', null)])).toBe(3001);
  });
});
