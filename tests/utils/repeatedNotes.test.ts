/**
 * Workspace-level advisories must be stated once, not on every write.
 *
 * Measured on this VM: in a project-less, non-git workspace every single write
 * carried a ~230-char "no projectPath could be resolved" block and a ~200-char
 * forced-backup line. Both describe the tree being written into, not the object
 * being written, so a twenty-edit session paid ~8 KB to learn two facts twenty
 * times — and tool results are re-read by every later request in the session,
 * so those bytes are billed again and again.
 *
 * The rule this pins: the FIRST occurrence stays whole (a caller seeing it for
 * the first time needs the explanation), later ones shrink, and anything that
 * genuinely differs per write — a backup path is a new file every time — must
 * survive into the short form.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sayOncePerSession, resetRepeatedNoteMemory } from '../../src/utils/repeatedNotes.js';

describe('sayOncePerSession', () => {
  beforeEach(() => resetRepeatedNoteMemory());

  it('says the whole thing the first time and shortens afterwards', () => {
    expect(sayOncePerSession('git-backup', 'K:/model', 'FULL', 'SHORT')).toBe('FULL');
    expect(sayOncePerSession('git-backup', 'K:/model', 'FULL', 'SHORT')).toBe('SHORT');
    expect(sayOncePerSession('git-backup', 'K:/model', 'FULL', 'SHORT')).toBe('SHORT');
  });

  it('keeps separate memory per scope, so a second model still gets the full text', () => {
    expect(sayOncePerSession('git-backup', 'K:/modelA', 'FULL-A', 'SHORT-A')).toBe('FULL-A');
    expect(sayOncePerSession('git-backup', 'K:/modelB', 'FULL-B', 'SHORT-B')).toBe('FULL-B');
    expect(sayOncePerSession('git-backup', 'K:/modelA', 'FULL-A', 'SHORT-A')).toBe('SHORT-A');
  });

  it('keeps separate memory per kind, so two advisories do not silence each other', () => {
    expect(sayOncePerSession('git-backup', 'K:/model', 'BACKUP', 'b')).toBe('BACKUP');
    expect(sayOncePerSession('no-project-path', 'K:/model', 'PROJECT', 'p')).toBe('PROJECT');
  });

  it('treats scope case-insensitively — Windows hands back both spellings of a path', () => {
    expect(sayOncePerSession('git-backup', 'K:/Model/Fm', 'FULL', 'SHORT')).toBe('FULL');
    expect(sayOncePerSession('git-backup', 'k:/model/fm', 'FULL', 'SHORT')).toBe('SHORT');
  });

  it('passes the per-write detail through the short form', () => {
    // The backup path is the one part of that advisory a caller may still need:
    // it is a different file on every write, so collapsing must not drop it.
    const first = sayOncePerSession('git-backup', 'K:/m', 'long explanation, backup at /a.bak', 'Backup: /a.bak');
    const second = sayOncePerSession('git-backup', 'K:/m', 'long explanation, backup at /b.bak', 'Backup: /b.bak');
    expect(first).toContain('/a.bak');
    expect(second).toBe('Backup: /b.bak');
  });

  it('is reset by the test seam, so one suite cannot silence the next', () => {
    expect(sayOncePerSession('k', 's', 'FULL', 'SHORT')).toBe('FULL');
    resetRepeatedNoteMemory();
    expect(sayOncePerSession('k', 's', 'FULL', 'SHORT')).toBe('FULL');
  });
});
