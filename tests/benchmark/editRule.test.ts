/**
 * The write fence of a sandbox cell. It must be absolute: a relative `./**`
 * follows the session's current directory, which a read-only `cd` (run without
 * asking even in dontAsk mode) moves — and every later write into the sandbox
 * was refused. Found in the reference v2 run on the VM, 2026-10-09.
 */
import { describe, it, expect } from 'vitest';
import { sandboxEditRule } from '../../src/cli/commands/benchmark.js';

describe('sandboxEditRule', () => {
  it('turns a Windows package path into the absolute //drive/… form', () => {
    expect(sandboxEditRule('K:\\AosService\\PackagesLocalDirectory\\fm-mcp')).toBe('Edit(//k/AosService/PackagesLocalDirectory/fm-mcp/**)');
    expect(sandboxEditRule('K:/AosService/PackagesLocalDirectory/fm-mcp/')).toBe('Edit(//k/AosService/PackagesLocalDirectory/fm-mcp/**)');
  });

  it('keeps a POSIX path absolute', () => {
    expect(sandboxEditRule('/srv/pld/fm-mcp')).toBe('Edit(//srv/pld/fm-mcp/**)');
  });

  it('is never relative', () => {
    expect(sandboxEditRule('K:\\x')).not.toContain('./');
  });
});
