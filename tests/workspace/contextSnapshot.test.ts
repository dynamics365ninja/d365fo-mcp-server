/**
 * Context snapshot rendering + class-URI dispatch (Phase 1 context pipeline).
 * Covers the pure, dependency-free pieces of the new context layer.
 */

import { describe, it, expect } from 'vitest';
import {
  renderContextSnapshotSection,
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
    index: { totalSymbols: 0, byType: {}, indexedModels: [], lastIndexedAt: null },
    activeObject: null,
    recentObjects: [],
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

describe('isClassUri', () => {
  it('matches xpp://class/ URIs only', () => {
    expect(isClassUri(`${CLASS_URI_PREFIX}CustTable`)).toBe(true);
    expect(isClassUri('workspace://context')).toBe(false);
    expect(isClassUri('xpp://table/CustTable')).toBe(false);
  });
});
