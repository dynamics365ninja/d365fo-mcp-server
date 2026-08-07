/**
 * Server mode + tool profile gating tests.
 *
 * isToolEnabled is the single predicate shared by the ListTools filter
 * (mcpServer), the runtime call gate (toolHandler) and the startup banner. It
 * composes two axes: locality (isToolAllowedInMode) and breadth
 * (isToolInProfile). These tests pin both contracts — ALWAYS_TOOLS bypass the
 * LOCAL_TOOLS partition in EVERY mode, so a tool advertised by the list filter
 * can never be refused at call time, and the 'core' profile can only ever
 * SHRINK what a mode already allowed.
 */

import { describe, it, expect } from 'vitest';
import {
  LOCAL_TOOLS,
  ALWAYS_TOOLS,
  CORE_TOOLS,
  isToolAllowedInMode,
  isToolInProfile,
  isToolEnabled,
  parseToolList,
  type ServerMode,
} from '../../src/server/serverMode';
import { toolSchemas } from '../../src/server/toolSchemas/index';

const MODES: ServerMode[] = ['full', 'read-only', 'write-only'];

describe('isToolAllowedInMode', () => {
  it('allows everything in full mode', () => {
    expect(isToolAllowedInMode('full', 'search')).toBe(true);
    expect(isToolAllowedInMode('full', 'undo_last_modification')).toBe(true);
    expect(isToolAllowedInMode('full', 'get_object_info')).toBe(true);
  });

  it('allows ALWAYS_TOOLS in every mode (regression: write-only refused get_object_info)', () => {
    for (const mode of MODES) {
      for (const tool of ALWAYS_TOOLS) {
        expect(isToolAllowedInMode(mode, tool), `${tool} in ${mode}`).toBe(true);
      }
    }
  });

  it('write-only allows get_object_info (the originally reported defect)', () => {
    expect(isToolAllowedInMode('write-only', 'get_object_info')).toBe(true);
    expect(isToolAllowedInMode('write-only', 'labels')).toBe(true);
    expect(isToolAllowedInMode('write-only', 'd365fo_file')).toBe(true);
  });

  it('write-only allows local tools and blocks search/analysis tools', () => {
    for (const tool of LOCAL_TOOLS) {
      expect(isToolAllowedInMode('write-only', tool), `${tool} in write-only`).toBe(true);
    }
    expect(isToolAllowedInMode('write-only', 'search')).toBe(false);
    expect(isToolAllowedInMode('write-only', 'analyze_code')).toBe(false);
  });

  it('read-only blocks local tools and allows the rest', () => {
    for (const tool of LOCAL_TOOLS) {
      expect(isToolAllowedInMode('read-only', tool), `${tool} in read-only`).toBe(false);
    }
    expect(isToolAllowedInMode('read-only', 'search')).toBe(true);
    expect(isToolAllowedInMode('read-only', 'analyze_code')).toBe(true);
  });
});

describe('tool profile', () => {
  const published = toolSchemas.map(t => t.name);
  const NONE = new Set<string>();

  it('full publishes every tool — the default changes nobody\'s setup', () => {
    for (const name of published) {
      expect(isToolInProfile('full', name, NONE), `${name} in full profile`).toBe(true);
    }
  });

  it('core publishes exactly the create-and-build loop', () => {
    const core = published.filter(name => isToolInProfile('core', name, NONE));
    expect(core.sort()).toEqual([...CORE_TOOLS].sort());
    expect(core).toHaveLength(18);
  });

  it('every CORE_TOOLS entry is a published tool (no ghosts after a rename)', () => {
    for (const name of CORE_TOOLS) {
      expect(published, `CORE_TOOLS names '${name}', which is not published`).toContain(name);
    }
  });

  it('leaves out the specialist tools the audit never called', () => {
    const excluded = published.filter(name => !isToolInProfile('core', name, NONE));
    expect(excluded.sort()).toEqual([
      'analyze_code', 'batch_get_info', 'extension_info', 'get_method',
      'run_systest_class', 'security_info', 'suggest_edt', 'validate_code',
    ]);
  });

  it('MCP_EXTRA_TOOLS adds individual tools back on top of core', () => {
    const extras = parseToolList('security_info, get_method');
    expect(isToolInProfile('core', 'security_info', extras)).toBe(true);
    expect(isToolInProfile('core', 'get_method', extras)).toBe(true);
    expect(isToolInProfile('core', 'analyze_code', extras)).toBe(false);
  });

  it('parseToolList tolerates the shapes a user actually types', () => {
    expect([...parseToolList('a,b')]).toEqual(['a', 'b']);
    expect([...parseToolList(' a , b ')]).toEqual(['a', 'b']);
    expect([...parseToolList('a b')]).toEqual(['a', 'b']);
    expect([...parseToolList(undefined)]).toEqual([]);
    expect([...parseToolList('')]).toEqual([]);
  });

  it('never widens what the server mode already refused', () => {
    for (const mode of MODES) {
      for (const name of published) {
        if (!isToolAllowedInMode(mode, name)) {
          expect(isToolEnabled(name, mode, 'core', new Set([name])), `${name} in ${mode}`).toBe(false);
        }
      }
    }
  });
});
