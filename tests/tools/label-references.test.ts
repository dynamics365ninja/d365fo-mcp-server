/**
 * Label where-used (cross-reference) tests for find_references.
 *
 * Covers three layers:
 *   1. resolveLabelTarget — normalizing "@WAX2194" / "@File:Id" / "/Labels/…" / bare-id
 *      into the "/Labels/@…" xref path (and rejecting non-labels).
 *   2. tryBridgeReferences(formatAs='label') — grouping references by SOURCE object
 *      type across both xref path conventions (code "/Classes/…" and declarative
 *      metadata "Table/…", "EdtString/…", …), surfacing the referencing property.
 *   3. findReferencesTool — end-to-end routing of a label target to the xref bridge,
 *      plus the graceful message when the xref DB is unavailable.
 */

import { describe, it, expect, vi } from 'vitest';
import { findReferencesTool, resolveLabelTarget } from '../../src/tools/analysis/findReferences';
import { tryBridgeReferences } from '../../src/bridge/bridgeAdapter';
import type { BridgeClient } from '../../src/bridge/bridgeClient';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Source paths mirror the real DYNAMICSXREFDB shapes for label references:
// code refs use "/Classes/…/Methods/…"; declarative metadata refs use singular,
// slash-free containers ("Table/…", "EdtString/…") with a trailing "?Property".
const SAMPLE_REFS = [
  { sourcePath: '/Classes/WhsWorkManualComplete/Methods/performValidation', sourceModule: 'ApplicationSuite', line: 753, column: 43 },
  { sourcePath: '/Classes/WHSControlSortLicensePlateId/Methods/process', sourceModule: 'ApplicationSuite', line: 36, column: 26 },
  { sourcePath: '/Tables/AccountantLogisticsLocation_BR/Methods/validateDelete', sourceModule: 'ApplicationSuite', line: 12, column: 9 },
  { sourcePath: 'Form/AbatementCertificate_IN/FormDesign/FormDesign/FormButtonControl/ShowData?Text', sourceModule: 'ApplicationSuite', line: 0, column: 0 },
  { sourcePath: 'EdtString/ABNControllingCorporation_AU?HelpText', sourceModule: 'ApplicationSuite', line: 0, column: 0 },
  { sourcePath: 'Enum/ABC/EnumValue/A?Label', sourceModule: 'ApplicationSuite', line: 0, column: 0 },
  { sourcePath: 'MenuItemDisplay/AbatementCertificate_IN?Label', sourceModule: 'ApplicationSuite', line: 0, column: 0 },
];

function makeXrefBridge(refs = SAMPLE_REFS): BridgeClient {
  return {
    isReady: true,
    metadataAvailable: true,
    xrefAvailable: true,
    findReferences: vi.fn(async (_target: string) => ({ count: refs.length, references: refs })),
  } as unknown as BridgeClient;
}

// ─── resolveLabelTarget ────────────────────────────────────────────────────────

describe('resolveLabelTarget', () => {
  it('normalizes a concatenated "@WAX2194" id to a /Labels/ path', () => {
    expect(resolveLabelTarget('@WAX2194')).toBe('/Labels/@WAX2194');
  });

  it('normalizes a "@LabelFile:LabelId" id verbatim (keeps the colon)', () => {
    expect(resolveLabelTarget('@ApplicationPlatform:AbortButtonText')).toBe('/Labels/@ApplicationPlatform:AbortButtonText');
  });

  it('passes through an explicit /Labels/ AOT path unchanged', () => {
    expect(resolveLabelTarget('/Labels/@WAX2194')).toBe('/Labels/@WAX2194');
  });

  it('accepts a bare id only when targetType is "label"', () => {
    expect(resolveLabelTarget('WAX2194', 'label')).toBe('/Labels/@WAX2194');
    expect(resolveLabelTarget('WAX2194')).toBeNull();          // no @, no targetType → not a label
  });

  it('does not misclassify a normal symbol as a label', () => {
    expect(resolveLabelTarget('SalesTable')).toBeNull();
    expect(resolveLabelTarget('SalesTable.find', 'method')).toBeNull();
  });
});

// ─── tryBridgeReferences (label formatter) ─────────────────────────────────────

describe('tryBridgeReferences — label formatting', () => {
  it('groups references by source object type across both path conventions', async () => {
    const bridge = makeXrefBridge();
    const outcome = await tryBridgeReferences(bridge, '/Labels/@WAX2194', 50, '@WAX2194', 'label');
    expect(outcome.status).toBe('ok');
    const text = (outcome as any).result.content[0].text as string;

    expect(text).toContain('References to label `@WAX2194`');
    expect(text).toContain('**Total:** 7 reference(s)');
    // Both code paths and declarative-metadata paths are classified:
    expect(text).toContain('**Class**: 2');
    expect(text).toContain('**Table**: 1');
    expect(text).toContain('**Form**: 1');
    expect(text).toContain('**EDT**: 1');                       // EdtString → EDT
    expect(text).toContain('**Enum**: 1');
    expect(text).toContain('**Menu item (display)**: 1');
  });

  it('surfaces the referencing member (method) and property', async () => {
    const bridge = makeXrefBridge();
    const outcome = await tryBridgeReferences(bridge, '/Labels/@WAX2194', 50, '@WAX2194', 'label');
    const text = (outcome as any).result.content[0].text as string;

    expect(text).toContain('WhsWorkManualComplete');
    expect(text).toContain('performValidation');               // X++ method (code ref)
    // Declarative refs name the member the property sits on, not just the leaf
    // property — so "which field/control/value" survives, not only "Label"/"Text".
    expect(text).toContain('ShowData › Text');                 // form control › caption property
    expect(text).toContain('A › Label');                       // enum value › label property
    // …except when the property is on the object itself (no redundant member).
    expect(text).toContain('ABNControllingCorporation_AU** › HelpText');
  });

  it('marks a per-type group as truncated when limit cuts into it', async () => {
    // 6 refs, all Class, but limit=4 → the Class group must read "4 of 6",
    // reconciling with the summary count above it.
    const many = Array.from({ length: 6 }, (_, i) => ({
      sourcePath: `/Classes/Cls${i}/Methods/m${i}`, sourceModule: 'ApplicationSuite', line: i + 1, column: 1,
    }));
    const bridge = makeXrefBridge(many);
    const outcome = await tryBridgeReferences(bridge, '/Labels/@WAX2194', 4, '@WAX2194', 'label');
    const text = (outcome as any).result.content[0].text as string;

    expect(text).toContain('**Class**: 6 reference(s)');       // summary: full population
    expect(text).toContain('### Class (4 of 6)');              // detail: truncated marker
    expect(text).toContain('Showing first 4 of 6 references');
  });

  it('reports xref bridge unavailable', async () => {
    const bridge = { isReady: true, xrefAvailable: false } as unknown as BridgeClient;
    const outcome = await tryBridgeReferences(bridge, '/Labels/@WAX2194', 50, '@WAX2194', 'label');
    expect(outcome.status).toBe('unavailable');
  });
});

// ─── findReferencesTool (end-to-end routing) ───────────────────────────────────

function labelRequest(targetName: string, targetType?: string): CallToolRequest {
  return {
    method: 'tools/call',
    params: { name: 'find_references', arguments: { targetName, ...(targetType ? { targetType } : {}) } },
  };
}

describe('findReferencesTool — label routing', () => {
  it('routes an "@…" target to the xref bridge with a /Labels/ path and label formatting', async () => {
    const bridge = makeXrefBridge();
    const ctx: any = { symbolIndex: {}, bridge };
    const result = await findReferencesTool(labelRequest('@WAX2194'), ctx);
    const text = (result.content[0] as { text: string }).text;

    // Bridge queried with the normalized label path
    expect((bridge.findReferences as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('/Labels/@WAX2194');
    // Label-specific output (not the generic caller-oriented format)
    expect(text).toContain('By source object type');
    expect(text).toContain('**Form**: 1');
  });

  it('explains that label where-used needs the xref DB when the bridge is unavailable', async () => {
    const bridge = { isReady: true, xrefAvailable: false } as unknown as BridgeClient;
    const ctx: any = { symbolIndex: {}, bridge };
    const result = await findReferencesTool(labelRequest('@WAX2194'), ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('requires the cross-reference database');
    expect(text).toContain('DYNAMICSXREFDB');
  });

  it('returns an authoritative zero (with guidance) on a clean empty from the bridge', async () => {
    const bridge = {
      isReady: true, xrefAvailable: true,
      findReferences: vi.fn(async () => ({ count: 0, references: [] })),
    } as unknown as BridgeClient;
    const ctx: any = { symbolIndex: {}, bridge };
    const result = await findReferencesTool(labelRequest('@ApplicationPlatform:DoesNotExist'), ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**Total References Found:** 0');
    expect(text).toContain('exactly as stored');
  });
});
