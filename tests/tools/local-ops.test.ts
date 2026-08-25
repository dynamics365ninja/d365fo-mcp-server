import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted to the top of the file before const declarations
// are initialised — use vi.hoisted() so the mocks are available in time.
const { execFilePromisified, execFileMock } = vi.hoisted(() => {
  const execFilePromisified = vi.fn();
  const execFileMock: any = vi.fn();
  // util.promisify.custom === Symbol.for('nodejs.util.promisify.custom')
  execFileMock[Symbol.for('nodejs.util.promisify.custom')] = (
    file: string,
    args: string[],
    opts: any,
  ) => execFilePromisified(file, args, opts);
  return { execFilePromisified, execFileMock };
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('fs', () => {
  const existsSync = vi.fn();
  const unlinkSync = vi.fn();
  const stat = vi.fn();
  const promises = { stat };
  return {
    default: { existsSync, unlinkSync, promises },
    existsSync,
    unlinkSync,
    promises,
  };
});

import { undoLastModificationTool } from '../../src/tools/sdlc/undoLastModification';
import { reviewWorkspaceChangesTool } from '../../src/tools/sdlc/reviewWorkspaceChanges';

const getFs = async () => await import('fs');

describe('local tools - undo_last_modification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns error for invalid filePath', async () => {
    const result = await undoLastModificationTool({ filePath: '' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid filepath/i);
  });

  it('returns error when file is not inside a git repository', async () => {
    execFilePromisified.mockRejectedValueOnce(new Error('not a git repository'));

    const result = await undoLastModificationTool({ filePath: '/tmp/a.txt' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not inside a git repository/i);
  });

  it('reverts tracked file via git checkout', async () => {
    execFilePromisified
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/a.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const fsMod = await getFs();
    const result = await undoLastModificationTool({ filePath: '/repo/src/a.ts' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/reverted tracked file/i);
    expect((fsMod.unlinkSync as any)).not.toHaveBeenCalled();

    expect(execFilePromisified).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: '/repo/src' }),
    );
    expect(execFilePromisified).toHaveBeenNthCalledWith(
      2,
      'git',
      ['ls-files', '--error-unmatch', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(execFilePromisified).toHaveBeenNthCalledWith(
      3,
      'git',
      ['checkout', 'HEAD', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('deletes file only when it is git-untracked', async () => {
    execFilePromisified
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
      .mockRejectedValueOnce(new Error('not tracked'))
      .mockResolvedValueOnce({ stdout: 'src/new-file.ts\n', stderr: '' });

    const fsMod = await getFs();
    (fsMod.existsSync as any).mockReturnValue(true);
    ((fsMod as any).promises.stat as any).mockResolvedValue({ isFile: () => true });

    const result = await undoLastModificationTool({ filePath: '/repo/src/new-file.ts' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/deleted untracked file/i);
    expect((fsMod.unlinkSync as any)).toHaveBeenCalledWith('/repo/src/new-file.ts');
  });

  it('refuses deletion when target is not a file', async () => {
    execFilePromisified
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
      .mockRejectedValueOnce(new Error('not tracked'));

    const fsMod = await getFs();
    (fsMod.existsSync as any).mockReturnValue(true);
    ((fsMod as any).promises.stat as any).mockResolvedValue({ isFile: () => false });

    const result = await undoLastModificationTool({ filePath: '/repo/src/folder' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-file path/i);
    expect((fsMod.unlinkSync as any)).not.toHaveBeenCalled();
  });

  it('refuses deletion when file is not untracked', async () => {
    execFilePromisified
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
      .mockRejectedValueOnce(new Error('not tracked'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const fsMod = await getFs();
    (fsMod.existsSync as any).mockReturnValue(true);
    ((fsMod as any).promises.stat as any).mockResolvedValue({ isFile: () => true });

    const result = await undoLastModificationTool({ filePath: '/repo/src/not-untracked.ts' }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a git-untracked file/i);
    expect((fsMod.unlinkSync as any)).not.toHaveBeenCalled();
  });
});

describe('local tools - review_workspace_changes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns no changes message for empty diff', async () => {
    execFilePromisified
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await reviewWorkspaceChangesTool({ directoryPath: '/repo/subfolder' }, {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/no uncommitted changes/i);
    expect(execFilePromisified).toHaveBeenNthCalledWith(
      1,
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: '/repo/subfolder' }),
    );
    expect(execFilePromisified).toHaveBeenNthCalledWith(
      2,
      'git',
      ['diff', 'HEAD', '--unified=3'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('includes resolved changed file paths in output', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/src/removed.ts b/src/removed.ts',
      'deleted file mode 100644',
      '--- a/src/removed.ts',
      '+++ /dev/null',
    ].join('\n');

    execFilePromisified
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: diff, stderr: '' });

    const result = await reviewWorkspaceChangesTool({ directoryPath: '/repo' }, {});

    expect(result.isError).toBeFalsy();
    const output = result.content[0].text;
    // The header names the repository it diffed. It did not, and the tool can
    // resolve a root the caller did not expect — that is the failure mode worth
    // making visible, so it is pinned rather than merely allowed.
    expect(output).toContain('Code Review Target (Git Diff) — repository: /repo');
    expect(output).toContain('/repo/src/a.ts');

    // /dev/null is valid inside raw git diff for deleted files.
    // We only require that it is not listed as an actionable changed file.
    const changedFilesSection = output.split('## Changed files')[1] ?? '';
    expect(changedFilesSection).not.toContain('/dev/null');
  });
});
