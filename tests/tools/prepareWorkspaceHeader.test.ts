/**
 * get_workspace_info was the FIRST call in 10 of 10 sampled sessions, and every
 * one of those replies was the same ~1.4 KB. prepare is the tool that starts real
 * work, so it states the target model and write path itself — once per process,
 * because repeating it on all 17 prepares in those sessions would cost more than
 * the one call it removes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const prepareChangeTool = vi.fn();
const prepareCreateTool = vi.fn();

vi.mock('../../src/tools/prepare/prepareChange.js', () => ({
  prepareChangeTool: (...a: unknown[]) => prepareChangeTool(...a),
}));
vi.mock('../../src/tools/prepare/prepareCreate.js', () => ({
  prepareCreateTool: (...a: unknown[]) => prepareCreateTool(...a),
}));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    getDetectionSummary: () => ({
      modelName: 'ContosoExt',
      source: '.mcp.json',
      projectPath: 'K:/VS/ContosoExt.rnrproj',
      solutionPath: null,
      workspacePath: 'K:/VS',
    }),
  }),
}));

const { prepareTool, resetRecentPrepares, resetWorkspaceHeader } =
  await import('../../src/tools/prepare/prepare.js');

const reply = (token: string) => ({
  content: [{ type: 'text', text: 'body\n**Grounding token:** `' + token + '`' }],
});

const call = (args: Record<string, unknown>) =>
  prepareTool({ method: 'tools/call', params: { name: 'prepare', arguments: args } } as never, {} as never);

const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;

beforeEach(() => {
  vi.clearAllMocks();
  resetRecentPrepares();
  resetWorkspaceHeader();
});

describe('prepare states the workspace once per process', () => {
  it('puts the model and write path in front of the first reply', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-1'));

    const out = text(await call({ mode: 'change', objectName: 'CustTable', methodName: 'insert' }));

    expect(out).toContain('ContosoExt');
    expect(out).toContain('ContosoExt.rnrproj');
    // And it says where the rest of the picture lives, so the tool is not lost.
    expect(out).toContain('get_workspace_info');
    // The aggregated context still comes through underneath.
    expect(out).toContain('Grounding token');
  });

  it('does not repeat it on later prepares', async () => {
    prepareChangeTool.mockResolvedValue(reply('tok-1'));
    await call({ mode: 'change', objectName: 'CustTable', methodName: 'insert' });

    prepareCreateTool.mockResolvedValue(reply('tok-2'));
    const second = text(await call({ mode: 'create', objectName: 'MyTable', objectType: 'table' }));

    expect(second).not.toContain('**Workspace**');
    expect(second).toContain('Grounding token');
  });

  it('is not spent on a failed prepare', async () => {
    prepareChangeTool.mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const failed = text(await call({ mode: 'change', objectName: 'X' }));
    expect(failed).not.toContain('**Workspace**');

    // The next good call still gets it — an error reply must not consume the banner.
    prepareChangeTool.mockResolvedValue(reply('tok-3'));
    const ok = text(await call({ mode: 'change', objectName: 'CustTable', methodName: 'insert' }));
    expect(ok).toContain('**Workspace**');
  });
});
