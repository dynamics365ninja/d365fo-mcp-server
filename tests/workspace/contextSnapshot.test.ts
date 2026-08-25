/**
 * Context snapshot rendering + class-URI dispatch (Phase 1 context pipeline).
 * Covers the pure, dependency-free pieces of the new context layer.
 */

import { describe, it, expect } from 'vitest';
import {
  renderContextSnapshotSection,
  renderContextSnapshotCompact,
  type ContextSnapshot,
} from '../../src/workspace/contextSnapshot.js';
import { isClassUri, CLASS_URI_PREFIX } from '../../src/resources/classResource.js';

function makeSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    model: 'ContosoExt',
    modelSource: 'config',
    projectPath: null,
    workspacePath: 'K:\\ws',
    envType: 'ude',
    roots: [],
    index: { totalSymbols: 0, byType: {}, indexedModels: [], lastIndexedAt: null, countsPending: false },
    activeObject: null,
    recentObjects: [],
    recentPending: false,
    uncommittedFiles: [],
    generatedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('renderContextSnapshotSection', () => {
  it('reports empty state when nothing is in flight', () => {
    const out = renderContextSnapshotSection(makeSnapshot()).join('\n');
    expect(out).toContain('## Context Snapshot');
    expect(out).toContain('Recently edited objects: _none detected');
    expect(out).toContain('Uncommitted X++ changes: _none');
  });

  it('shows the active object when present', () => {
    const out = renderContextSnapshotSection(
      makeSnapshot({
        activeObject: {
          name: 'CustTable',
          type: 'table',
          path: 'K:\\ws\\CustTable.xml',
          modifiedAt: '2026-06-23T09:15:00.000Z',
        },
      })
    ).join('\n');
    expect(out).toContain('Active object (most recently modified): CustTable [table]');
    expect(out).toContain('2026-06-23 09:15');
  });

  it('lists recent objects and uncommitted changes when present', () => {
    const out = renderContextSnapshotSection(
      makeSnapshot({
        recentObjects: [
          {
            name: 'MyTable',
            type: 'table',
            path: 'K:\\ws\\MyTable.xml',
            modifiedAt: '2026-06-23T10:30:00.000Z',
          },
        ],
        uncommittedFiles: ['AxTable/MyTable.xml'],
      })
    ).join('\n');

    expect(out).toContain('MyTable');
    expect(out).toContain('2026-06-23 10:30');
    expect(out).toContain('Uncommitted X++ changes (1)');
    expect(out).toContain('AxTable/MyTable.xml');
    expect(out).toContain('review_workspace_changes');
  });
});

describe('renderContextSnapshotSection — symbol counts (audit 2026-08-25)', () => {
  // The counts come from a full index scan (30-60 s cold, per the comment on
  // getSymbolCount) and the default snapshot no longer waits for it. A rendered
  // snapshot with no count line reads as "the index is empty", so the pending
  // state is stated rather than omitted.
  it('says the counts are still being computed', () => {
    const out = renderContextSnapshotSection(
      makeSnapshot({ index: { totalSymbols: 0, byType: {}, indexedModels: [], lastIndexedAt: null, countsPending: true } })
    ).join('\n');

    expect(out).toContain('still being computed');
    expect(out).toContain('diagnostics=true');
  });

  it('prints the number once it is known', () => {
    const out = renderContextSnapshotSection(
      makeSnapshot({ index: { totalSymbols: 1_170_432, byType: {}, indexedModels: ['Foundation'], lastIndexedAt: null, countsPending: false } })
    ).join('\n');

    expect(out).toContain('1,170,432');
    expect(out).not.toContain('still being computed');
  });
});

describe('renderContextSnapshotCompact', () => {
  const recent = (name: string) => ({
    name,
    type: 'table' as const,
    path: `K:\\ws\\${name}.xml`,
    modifiedAt: '2026-06-23T10:30:00.000Z',
  });

  it('emits nothing when there is nothing in flight', () => {
    // get_workspace_info runs at every session start; "none detected" twice is
    // two lines that tell the agent nothing it can act on.
    expect(renderContextSnapshotCompact(makeSnapshot())).toEqual([]);
  });

  it('names the first few recent objects and counts the rest', () => {
    const out = renderContextSnapshotCompact(
      makeSnapshot({
        recentObjects: ['A', 'B', 'C', 'D', 'E'].map(recent),
        uncommittedFiles: ['AxTable/A.xml', 'AxTable/B.xml'],
      })
    );

    expect(out).toEqual([
      'Recent edits: A [table], B [table], C [table] (+2 more)',
      'Uncommitted : 2 X++ file(s) — review_workspace_changes',
    ]);
  });

  it('omits the "+N more" tail when everything fits', () => {
    const out = renderContextSnapshotCompact(makeSnapshot({ recentObjects: [recent('A')] }));

    expect(out).toEqual(['Recent edits: A [table]']);
  });
});

describe('isClassUri', () => {
  it('matches xpp://class/ URIs only', () => {
    expect(isClassUri(`${CLASS_URI_PREFIX}CustTable`)).toBe(true);
    expect(isClassUri('workspace://context')).toBe(false);
    expect(isClassUri('xpp://table/CustTable')).toBe(false);
  });
});
