/**
 * The bridge attestation gate is only useful if it fails for the RIGHT reason.
 *
 * It is written on a Windows D365FO VM and verified on a Linux runner, so the one way it
 * could become a nuisance rather than a gate is a digest that depends on the platform:
 * a CRLF/LF difference handed out by git, or a path separator baked into the manifest.
 * Either would fail every PR for a reason that has nothing to do with the C#, and the
 * team would learn to ignore it — which is worse than not having the gate at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashSources, collectSources } from '../../scripts/bridgeAttest.mjs';

let root: string;

const write = (rel: string, content: string) => {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bridge-attest-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bridge attestation digest', () => {
  it('is identical for LF and CRLF checkouts of the same source', () => {
    write('Services/Write.cs', 'class A\n{\n    void M() { }\n}\n');
    write('D365MetadataBridge.csproj', '<Project>\n  <PropertyGroup />\n</Project>\n');
    const lf = hashSources(root, root).hash;

    write('Services/Write.cs', 'class A\r\n{\r\n    void M() { }\r\n}\r\n');
    write('D365MetadataBridge.csproj', '<Project>\r\n  <PropertyGroup />\r\n</Project>\r\n');
    const crlf = hashSources(root, root).hash;

    expect(crlf).toBe(lf);
  });

  it('changes when a single character of C# changes', () => {
    write('Services/Write.cs', 'class A { void M() { } }\n');
    const before = hashSources(root, root).hash;

    write('Services/Write.cs', 'class A { void N() { } }\n');
    expect(hashSources(root, root).hash).not.toBe(before);
  });

  it('changes when the csproj changes — references are compiler input too', () => {
    write('Services/Write.cs', 'class A { }\n');
    write('D365MetadataBridge.csproj', '<Project><PropertyGroup /></Project>\n');
    const before = hashSources(root, root).hash;

    write('D365MetadataBridge.csproj', '<Project><PropertyGroup><Nullable>enable</Nullable></PropertyGroup></Project>\n');
    expect(hashSources(root, root).hash).not.toBe(before);
  });

  it('ignores build output, so a stale obj/ or bin/ cannot invalidate the attestation', () => {
    write('Services/Write.cs', 'class A { }\n');
    const clean = hashSources(root, root).hash;

    write('obj/Debug/AssemblyInfo.cs', '// generated\n');
    write('bin/Release/leftover.cs', '// stale\n');
    expect(hashSources(root, root).hash).toBe(clean);
    expect(collectSources(root)).toHaveLength(1);
  });

  it('covers every C# file, not just the ones at the top level', () => {
    write('Program.cs', 'class P { }\n');
    write('Services/Write.cs', 'class W { }\n');
    write('Protocol/Dispatch.cs', 'class D { }\n');
    expect(hashSources(root, root).fileCount).toBe(3);
  });
});
