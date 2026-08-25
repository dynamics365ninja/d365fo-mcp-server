/**
 * Phase C of the 2026-08-25 audit: three tools folded into the tools that
 * already owned their subject, taking the published surface 23 -> 20.
 *
 * Two things have to hold for a fold to be worth its bytes, and neither is
 * visible to `tsc`:
 *  1. the capability is still REACHABLE — through the new discriminator, and
 *     (for anything an agent may still be holding from an earlier session)
 *     through the old tool name, which stays routable;
 *  2. the discriminator is a CLOSED value on the published schema, so the model
 *     never has to guess at it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const undoSpy = vi.hoisted(() => vi.fn());
const reviewSpy = vi.hoisted(() => vi.fn());

vi.mock('../../src/tools/sdlc/undoLastModification', () => ({
  undoLastModificationTool: undoSpy,
}));
vi.mock('../../src/tools/sdlc/reviewWorkspaceChanges', () => ({
  reviewWorkspaceChangesTool: reviewSpy,
}));

import { d365foFileTool, D365_FILE_ACTIONS } from '../../src/tools/d365foFile';
import { getWorkspaceInfoTool } from '../../src/tools/readers/getWorkspaceInfo';
import { toolSchemas } from '../../src/server/toolSchemas/index';

const schema = (name: string) => {
  const tool = toolSchemas.find(t => t.name === name);
  expect(tool, `${name} is not published`).toBeDefined();
  return tool!;
};

describe('fold: undo_last_modification -> d365fo_file(action="undo")', () => {
  beforeEach(() => {
    undoSpy.mockReset();
    undoSpy.mockResolvedValue({ content: [{ type: 'text', text: 'undone' }] });
  });

  it('publishes `undo` as a closed enum value on d365fo_file', () => {
    const props = (schema('d365fo_file').inputSchema as any).properties;
    expect(props.action.enum).toContain('undo');
    expect(props.filePath.description).toMatch(/\[undo\]/);
  });

  it('keeps the safety warning that was the whole content of the retired tool', () => {
    // "git checkout HEAD" discards every uncommitted change to the file, not
    // only the edit the agent is thinking of. Losing that sentence in the fold
    // would be losing the only reason the tool needed a description at all.
    expect(schema('d365fo_file').description).toMatch(
      /discards ALL uncommitted changes to that file, not just the last edit/,
    );
  });

  it('reaches the undo handler, with filePath, and never the write path', async () => {
    const result = await d365foFileTool(
      { method: 'tools/call', params: { name: 'd365fo_file', arguments: { action: 'undo', filePath: 'K:/repo/a.xml' } } } as any,
      {} as any,
    );
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(undoSpy.mock.calls[0][0]).toMatchObject({ filePath: 'K:/repo/a.xml' });
    expect(result.content[0].text).toBe('undone');
  });

  it('accepts undo in the handler-side action union', () => {
    expect(D365_FILE_ACTIONS).toContain('undo');
  });
});

describe('fold: review_workspace_changes -> get_workspace_info(changes=true)', () => {
  beforeEach(() => {
    reviewSpy.mockReset();
    reviewSpy.mockResolvedValue({ content: [{ type: 'text', text: 'Code Review Target (Git Diff):' }] });
  });

  it('publishes `changes` as a boolean knob on get_workspace_info', () => {
    const props = (schema('get_workspace_info').inputSchema as any).properties;
    expect(props.changes.type).toBe('boolean');
    // The retired tool advertised "BP violations, missing labels, CoC patterns"
    // and delivered `git diff HEAD`. The folded knob says what it returns.
    expect(props.changes.description).toMatch(/git diff HEAD/);
    expect(props.changes.description).not.toMatch(/BP violations/);
  });

  it('answers with the diff instead of the configuration dump', async () => {
    const result = await getWorkspaceInfoTool(
      { method: 'tools/call', params: { name: 'get_workspace_info', arguments: { changes: true } } } as any,
      {} as any,
    );
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Code Review Target');
  });
});

describe('fold: trigger_db_sync -> build_d365fo_project(dbSync)', () => {
  it('publishes `dbSync` and keeps the partial-sync list reachable', () => {
    const props = (schema('build_d365fo_project').inputSchema as any).properties;
    // Boolean for "sync what this project changed", array for "sync exactly
    // these" — the partial sync the retired tool existed for.
    expect(props.dbSync.type).toEqual(['boolean', 'array']);
    expect(props.dbSync.items).toEqual({ type: 'string' });
  });

  it('mirrors the bpCheck precedent it was modelled on', () => {
    const props = (schema('build_d365fo_project').inputSchema as any).properties;
    for (const knob of ['bpCheck', 'dbSync']) {
      expect(props[knob].description, `${knob} must say it runs on a SUCCESSFUL build`)
        .toMatch(/SUCCESSFUL build/);
    }
  });
});

describe('the three retired tools', () => {
  it('are no longer published', () => {
    const published = new Set(toolSchemas.map(t => t.name));
    for (const name of ['undo_last_modification', 'review_workspace_changes', 'trigger_db_sync']) {
      expect(published.has(name), `${name} is still published`).toBe(false);
    }
  });

  it('still have a dispatcher route under their old name', () => {
    // An agent holding the old name from an earlier session must get its answer,
    // not an "unknown tool" it cannot recover from. trigger_db_sync additionally
    // stays the only way to run a partial sync with no rebuild in front of it.
    const dispatcher = readFileSync('src/tools/toolHandler.ts', 'utf8');
    for (const name of ['undo_last_modification', 'review_workspace_changes', 'trigger_db_sync']) {
      expect(dispatcher, `${name} lost its route`).toContain(`case '${name}':`);
    }
  });
});
