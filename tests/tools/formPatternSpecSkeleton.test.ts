import { describe, it, expect } from 'vitest';
import { getFormPatternSpecTool } from '../../src/tools/specs/getFormPatternSpec.js';

async function specText(pattern: string): Promise<string> {
  const r: any = await getFormPatternSpecTool({ params: { arguments: { pattern } } });
  expect(r.isError).not.toBe(true);
  return r.content[0].text as string;
}

describe('getFormPatternSpec — copy-paste XML skeleton', () => {
  it('emits a Design subtree with the DetailsTransaction container shape', async () => {
    const text = await specText('DetailsTransaction');
    expect(text).toContain('Copy-paste XML skeleton');

    // The skeleton block, isolated from the abstract structure tree above it.
    const skeleton = text.slice(text.indexOf('Copy-paste XML skeleton'));

    // Design-level pattern + style come from the catalog entry.
    expect(skeleton).toContain('<Pattern xmlns="">DetailsTransaction</Pattern>');
    expect(skeleton).toContain('<Style xmlns="">DetailsFormTransaction</Style>');

    // The required containers the validator enforces (FP003/FP004) are present
    // with their concrete i:types — the thing an abstract tree forced agents to
    // translate by hand and get wrong.
    expect(skeleton).toContain('i:type="AxFormActionPaneControl"');
    expect(skeleton).toContain('i:type="AxFormTabControl"');
    expect(skeleton).toContain('i:type="AxFormTabPageControl"');

    // The FastTabs Style sits on the Tab, and the TabPage nests under it (order).
    const tabIdx = skeleton.indexOf('i:type="AxFormTabControl"');
    const fastTabsIdx = skeleton.indexOf('<Style>FastTabs</Style>');
    const tabPageIdx = skeleton.indexOf('i:type="AxFormTabPageControl"');
    expect(fastTabsIdx).toBeGreaterThan(tabIdx);
    expect(tabPageIdx).toBeGreaterThan(fastTabsIdx);
  });

  it('renders a sub-pattern hint on containers that require one', async () => {
    const skeleton = await specText('DetailsTransaction');
    // The optional CustomFilterGroup carries its sub-pattern declaration.
    expect(skeleton).toContain('<Pattern>CustomAndQuickFilters</Pattern>');
  });

  it('resolves the bare "FactBox" alias to the grid variant', async () => {
    const text = await specText('FactBox');
    expect(text).toContain('Form Part FactBox Grid');
    expect(text).toContain('FormPartFactboxGrid');
  });
});
