/**
 * Findings #33 / #41 (2026-07-21 sweep; both halves reproduced twice on the VM).
 *
 * (a) The labels tool advertised `@SYS:@SYS67433` — it built every reference as
 *     `@${labelFileId}:${labelId}` without noticing that the indexed id already
 *     carries its own `@FileId`. xppbp answers
 *     `BPErrorLabelIsText: '@SYS:@SYS67433' is not a label ID`; the accepted
 *     form is `@SYS67433`.
 * (b) It recommended labels from label files that are not deployed/referenced
 *     here (`@EnterpriseAssetManagementAppSuite:*`, `@RevenueRecognition:ItemName`
 *     → "Unknown label" / `BPErrorUnknownLabel`). Suggesting a reference the
 *     model cannot resolve is a defect, not a nicety.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  formatLabelReference,
  isLabelLikelyResolvable,
} from '../../src/utils/labelReference';
import { searchLabelsTool } from '../../src/tools/searchLabels';
import { getLabelInfoTool } from '../../src/tools/getLabelInfo';

// ── (a) reference syntax ─────────────────────────────────────────────────────

describe('formatLabelReference (#33/#41a)', () => {
  it('never doubles the @FileId prefix — the exact string xppbp rejected', () => {
    expect(formatLabelReference('SYS', '@SYS67433')).toBe('@SYS67433');
    expect(formatLabelReference('SYS', '@SYS71455')).toBe('@SYS71455');
    expect(formatLabelReference('SYS', '@SYS:@SYS67433')).not.toContain(':@');
  });

  it('collapses the legacy id-embeds-file-id form to @SYS67433', () => {
    expect(formatLabelReference('SYS', 'SYS67433')).toBe('@SYS67433');
  });

  it('keeps the @File:Id form for a real custom label', () => {
    expect(formatLabelReference('ContosoExt', 'MyLabel')).toBe('@ContosoExt:MyLabel');
  });

  it('leaves an already-complete reference alone', () => {
    expect(formatLabelReference('ContosoExt', '@ContosoExt:MyLabel')).toBe('@ContosoExt:MyLabel');
  });
});

// ── (b) deployability ────────────────────────────────────────────────────────

describe('isLabelLikelyResolvable (#33/#41b)', () => {
  it('treats core label files as resolvable', () => {
    expect(isLabelLikelyResolvable('SYS', 'ApplicationPlatform', 'Contoso')).toBe(true);
  });

  it('treats the caller\'s own model as resolvable', () => {
    expect(isLabelLikelyResolvable('ContosoExt', 'ContosoExt', 'ContosoExt')).toBe(true);
  });

  it('flags the exact label files that raised BPErrorUnknownLabel on the VM', () => {
    expect(isLabelLikelyResolvable('EnterpriseAssetManagementAppSuite', 'EnterpriseAssetManagement', 'Contoso')).toBe(false);
    expect(isLabelLikelyResolvable('RevenueRecognition', 'RevenueRecognition', 'Contoso')).toBe(false);
  });
});

// ── tool output ──────────────────────────────────────────────────────────────

function ctxWith(rows: any[]) {
  return {
    symbolIndex: {
      searchLabels: vi.fn(() => rows),
      getLabelById: vi.fn(() => rows),
    },
  } as any;
}

const searchReq = (query: string) => ({
  method: 'tools/call' as const,
  params: { name: 'search_labels', arguments: { query } },
});

describe('labels(action="search") output (#33/#41)', () => {
  it('emits @SYS67433, never @SYS:@SYS67433', async () => {
    const context = ctxWith([
      { label_id: '@SYS67433', label_file_id: 'SYS', model: 'ApplicationPlatform', language: 'en-US', text: 'Item name' },
    ]);

    const result = await searchLabelsTool(searchReq('item name'), context);
    const text = result.content[0].text as string;

    expect(text).toContain('@SYS67433');
    expect(text).not.toContain('@SYS:@SYS67433');
    expect(text).not.toContain(':@');
    expect(text).toContain('<Label>@SYS67433</Label>');
  });

  it('warns on labels whose owning package may not be referenced', async () => {
    const context = ctxWith([
      {
        label_id: 'ItemName', label_file_id: 'RevenueRecognition', model: 'RevenueRecognition',
        language: 'en-US', text: 'Item name',
      },
    ]);

    const result = await searchLabelsTool(searchReq('item name'), context);
    const text = result.content[0].text as string;

    expect(text).toContain('BPErrorUnknownLabel');
    // …and must NOT hand it over as a ready-to-paste recommendation.
    expect(text).not.toContain('<Label>@RevenueRecognition:ItemName</Label>');
  });

  it('recommends the resolvable label when the result set is mixed', async () => {
    const context = ctxWith([
      {
        label_id: 'ItemName', label_file_id: 'EnterpriseAssetManagementAppSuite',
        model: 'EnterpriseAssetManagement', language: 'en-US', text: 'Item name',
      },
      { label_id: '@SYS71455', label_file_id: 'SYS', model: 'ApplicationPlatform', language: 'en-US', text: 'Item name' },
    ]);

    const result = await searchLabelsTool(searchReq('item name'), context);
    const text = result.content[0].text as string;

    expect(text).toContain('literalStr("@SYS71455")');
  });
});

describe('labels(action="info") output (#33/#41)', () => {
  it('emits the single-@ form for a SYS label', async () => {
    const context = ctxWith([
      { labelId: '@SYS71455', labelFileId: 'SYS', model: 'ApplicationPlatform', language: 'en-US', text: 'Item name' },
    ]);

    const result = await getLabelInfoTool(
      { method: 'tools/call', params: { name: 'get_label_info', arguments: { labelId: '@SYS71455' } } } as any,
      context,
    );
    const text = result.content[0].text as string;

    expect(text).toContain('@SYS71455');
    expect(text).not.toContain(':@');
    expect(text).toContain('<Label>@SYS71455</Label>');
  });
});
