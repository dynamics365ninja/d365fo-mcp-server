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
