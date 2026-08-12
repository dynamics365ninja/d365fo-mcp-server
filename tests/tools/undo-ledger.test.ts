/**
 * Finding A (TOOL_DEFECT): undo_last_modification could not roll back files
 * created in the D365FO sandbox because that directory is not a git repository —
 * `git rev-parse --show-toplevel` fails and the tool returned
 * "File is not inside a git repository" for every sandbox write.
 *
 * These tests run against a REAL temp directory outside any git repo (so real
 * `git` genuinely fails, reproducing the sandbox), with the real filesystem.
 * They prove the non-git ledger fallback:
 *   - deletes a file the create tool recorded creating this session,
 *   - refuses to delete a file that was NOT recorded (safety),
 *   - cleans the file's <Content Include> from the .rnrproj, dropping the
 *     <Folder Include> only when addToProject is recorded as having added it.
 *
 * Corpus: eval/corpus/runs/2026-07-21T__L3-custom-service-basic__a2a4131.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { undoLastModificationTool } from '../../src/tools/sdlc/undoLastModification';
import {
  recordCreatedArtifact,
  lookupCreatedArtifact,
  _clearCreatedArtifactLedger,
} from '../../src/workspace/createdArtifactLedger';

let tmpDir: string;

beforeEach(() => {
  _clearCreatedArtifactLedger();
  // os.tmpdir() is not a git repo on the build/VM host, so the tool's
  // `git rev-parse` fails exactly as it does in K:\AosService\PackagesLocalDirectory.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-ledger-'));
});

afterEach(() => {
  _clearCreatedArtifactLedger();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * `git init` in `dir`, returning the path git itself will report as the repo
 * root. On Windows os.tmpdir() comes back as an 8.3 short path (ADMIN7~1) while
 * `git rev-parse --show-toplevel` answers with the long one, and the tool's
 * containment check — correctly — refuses a target that appears to sit outside
 * its repo. Resolving here keeps that a real check rather than a test artefact.
 */
function gitRepoIn(dir: string): string {
  const root = fs.realpathSync.native(dir);
  execFileSync('git', ['init'], { cwd: root, windowsHide: true });
  return root;
}

describe('undo_last_modification — non-git ledger fallback', () => {
  it('deletes a file the create tool recorded creating (main: returns git-repo error, file survives)', async () => {
    const filePath = path.join(tmpDir, 'ConDemoNoteLookupService.xml');
    fs.writeFileSync(filePath, '<AxClass><Name>ConDemoNoteLookupService</Name></AxClass>', 'utf-8');
    recordCreatedArtifact({ filePath, objectType: 'class', objectName: 'ConDemoNoteLookupService' });

    const result = await undoLastModificationTool({ filePath }, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/deleted session-created file outside git/i);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(lookupCreatedArtifact(filePath)).toBeUndefined();
  });

  it('refuses to delete a file that was NOT recorded (safety — arbitrary files are never touched)', async () => {
    const filePath = path.join(tmpDir, 'PreexistingUnrelated.xml');
    fs.writeFileSync(filePath, '<AxClass/>', 'utf-8');

    const result = await undoLastModificationTool({ filePath }, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not inside a git repository/i);
    expect(fs.existsSync(filePath)).toBe(true); // untouched
  });

  it('also removes the created object\'s <Content Include> from the .rnrproj', async () => {
    const filePath = path.join(tmpDir, 'ConDemoNoteService.xml');
    fs.writeFileSync(filePath, '<AxService><Name>ConDemoNoteService</Name></AxService>', 'utf-8');

    const projectPath = path.join(tmpDir, 'Contoso.rnrproj');
    fs.writeFileSync(projectPath, [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      '  <ItemGroup>',
      '    <Folder Include="Services\\" />',
      '  </ItemGroup>',
      '  <ItemGroup>',
      '    <Content Include="AxService\\ConDemoNoteService">',
      '      <SubType>Content</SubType>',
      '      <Name>ConDemoNoteService</Name>',
      '      <Link>Services\\ConDemoNoteService</Link>',
      '    </Content>',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n'), 'utf-8');

    recordCreatedArtifact({
      filePath,
      objectType: 'service',
      objectName: 'ConDemoNoteService',
      projectPath,
    });

    const result = await undoLastModificationTool({ filePath }, {} as any);

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(filePath)).toBe(false);

    const proj = fs.readFileSync(projectPath, 'utf-8');
    expect(proj).not.toContain('AxService\\ConDemoNoteService');
    // The folder entry stays: nothing recorded adding it, so it may predate the run.
    // Corpus 2026-07-30T11__L3-dualwrite-entity-mapping — pruning it on the
    // "no Content of this type remains" test alone deleted three pre-existing orphans.
    expect(proj).toContain('Services\\"');
  });

  it('cleans the .rnrproj on the GIT path too — PackagesLocalDirectory usually is a repo', async () => {
    // The two undo paths did not agree: the ledger one removed the project entry,
    // the git-untracked one deleted the file and stopped there. A model directory
    // under source control takes the git path, so the run that undid a class
    // extension and a form extension left both <Content Include> entries behind,
    // pointing at files that no longer exist (run 81803f01).
    const repoDir = gitRepoIn(tmpDir);

    const filePath = path.join(repoDir, 'ConDemoNoteService.xml');
    fs.writeFileSync(filePath, '<AxService><Name>ConDemoNoteService</Name></AxService>', 'utf-8');

    const projectPath = path.join(repoDir, 'Contoso.rnrproj');
    fs.writeFileSync(projectPath, [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      '  <ItemGroup>',
      '    <Content Include="AxService\\ConDemoNoteService">',
      '      <SubType>Content</SubType>',
      '      <Name>ConDemoNoteService</Name>',
      '    </Content>',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n'), 'utf-8');

    recordCreatedArtifact({ filePath, objectType: 'service', objectName: 'ConDemoNoteService', projectPath });

    const result = await undoLastModificationTool({ filePath }, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/deleted untracked file/i);   // the git path, not the ledger one
    expect(result.content[0].text).toMatch(/Removed its project entry from Contoso\.rnrproj/);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readFileSync(projectPath, 'utf-8')).not.toContain('AxService\\ConDemoNoteService');
    expect(lookupCreatedArtifact(filePath)).toBeUndefined();
  });

  it('leaves the project alone on the git path when the ledger never saw the file', async () => {
    // Safety: an untracked file this session did not create carries no project
    // entry to reverse, and undo must not go looking for one to delete.
    const repoDir = gitRepoIn(tmpDir);

    const filePath = path.join(repoDir, 'Unrecorded.xml');
    fs.writeFileSync(filePath, '<AxClass/>', 'utf-8');

    const result = await undoLastModificationTool({ filePath }, {} as any);

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/project entry/i);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('drops the <Folder Include> when addToProject added it in this session', async () => {
    const filePath = path.join(tmpDir, 'ConDemoNoteService.xml');
    fs.writeFileSync(filePath, '<AxService><Name>ConDemoNoteService</Name></AxService>', 'utf-8');

    const projectPath = path.join(tmpDir, 'Contoso.rnrproj');
    fs.writeFileSync(projectPath, [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      '  <ItemGroup />',
      '</Project>',
    ].join('\n'), 'utf-8');

    const { ProjectFileManager } = await import('../../src/workspace/projectFile');
    await new ProjectFileManager().addToProject(projectPath, 'service', 'ConDemoNoteService', filePath);
    expect(fs.readFileSync(projectPath, 'utf-8')).toContain('Services\\');

    recordCreatedArtifact({ filePath, objectType: 'service', objectName: 'ConDemoNoteService', projectPath });
    await undoLastModificationTool({ filePath }, {} as any);

    const proj = fs.readFileSync(projectPath, 'utf-8');
    expect(proj).not.toContain('AxService\\ConDemoNoteService');
    expect(proj).not.toContain('Services\\');
  });
});
