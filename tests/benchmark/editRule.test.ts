/**
 * The write fence of a sandbox cell. It must be absolute: a relative `./**`
 * follows the session's current directory, which a read-only `cd` (run without
 * asking even in dontAsk mode) moves — and every later write into the sandbox
 * was refused. Found in the reference v2 run on the VM, 2026-10-09.
 */
import { describe, it, expect } from 'vitest';
import { sandboxBuildCommand, sandboxBuildRules, sandboxEditRule } from '../../src/cli/commands/benchmark.js';

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

/**
 * Both variants get one shell command: the sandbox build. Without it the plain
 * agent cannot check its work and "cheaper" only meant "stopped sooner"
 * (reference v2: 0 builds in 9 plain cells, 2 of 9 valid). Verified on the VM:
 * these two rules let Bash and PowerShell run the command and refuse any other.
 */
describe('sandbox build command', () => {
  it('is one unquoted node command with forward slashes, allowed in both shells', () => {
    const cmd = sandboxBuildCommand('K:\\repos\\d365fo-mcp-server', 'K:\\AosService\\PackagesLocalDirectory\\fm-mcp\\');
    expect(cmd).toBe('node K:/repos/d365fo-mcp-server/scripts/benchmarkSandboxBuild.mjs K:/AosService/PackagesLocalDirectory/fm-mcp');
    expect(sandboxBuildRules(cmd)).toEqual([`Bash(${cmd})`, `PowerShell(${cmd})`]);
  });
});
