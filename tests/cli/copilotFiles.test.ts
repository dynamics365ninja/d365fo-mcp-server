/**
 * The copilot-instructions half of client setup.
 *
 * Both files (.mcp.json and .github\copilot-instructions.md) have to be placed
 * for Copilot to route through the MCP tools at all, so the wizard's copy step
 * is load-bearing rather than a convenience: when it silently does nothing the
 * user ends up with a server the agent never uses. The README is what tells
 * them where the files go, which makes "was a README written" part of the
 * contract, not decoration.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpRoot: string;
let packageRoot: string;
let installDir: string;
let confirmAnswer = true;

vi.mock('../../src/cli/context.js', () => ({
  get repoRoot() { return packageRoot; },
  dataRoot: () => installDir,
  paths: { get mcpSuggestion() { return resolve(installDir, '.mcp.json'); } },
}));

vi.mock('../../src/cli/ui.js', () => ({
  askConfirm: () => Promise.resolve(confirmAnswer),
  p: { log: { warn: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), step: vi.fn() } },
}));

const { finalizeStagedCopilotFiles, maybePrepareCopilotInstructions } = await import('../../src/cli/copilotFiles.js');

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(resolve(os.tmpdir(), 'copilot-files-'));
  packageRoot = resolve(tmpRoot, 'package');
  installDir = resolve(tmpRoot, 'installation');
  fs.mkdirSync(resolve(packageRoot, '.github'), { recursive: true });
  fs.writeFileSync(resolve(packageRoot, '.github', 'copilot-instructions.md'), '# rules\n');
  fs.mkdirSync(installDir, { recursive: true });
  confirmAnswer = true;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('maybePrepareCopilotInstructions', () => {
  it('copies the instructions and writes a README into the solutions folder', async () => {
    const solutions = resolve(tmpRoot, 'repos');
    fs.mkdirSync(solutions);

    const plan = await maybePrepareCopilotInstructions(solutions);

    expect(plan.stagingDir).toBeUndefined();
    expect(fs.readFileSync(resolve(solutions, '.github', 'copilot-instructions.md'), 'utf8')).toBe('# rules\n');
    const readme = fs.readFileSync(resolve(solutions, 'README.md'), 'utf8');
    expect(readme).toContain('Already placed here');
    expect(readme).toContain(resolve(installDir, '.mcp.json'));
  });

  it('creates the solutions folder when it does not exist yet', async () => {
    const solutions = resolve(tmpRoot, 'repos', 'nested');

    await maybePrepareCopilotInstructions(solutions);

    expect(fs.existsSync(resolve(solutions, '.github', 'copilot-instructions.md'))).toBe(true);
  });

  it('stages the files when no solutions folder is configured', async () => {
    const plan = await maybePrepareCopilotInstructions('   ');

    expect(plan.stagingDir).toBe(resolve(installDir, 'copilot-setup'));
    expect(fs.existsSync(resolve(plan.stagingDir!, '.github', 'copilot-instructions.md'))).toBe(true);
    expect(fs.readFileSync(resolve(plan.stagingDir!, 'README.md'), 'utf8')).toContain('a parent folder');
  });

  it('stages the files when the user declines the copy', async () => {
    confirmAnswer = false;
    const solutions = resolve(tmpRoot, 'repos');
    fs.mkdirSync(solutions);

    const plan = await maybePrepareCopilotInstructions(solutions);

    expect(plan.stagingDir).toBe(resolve(installDir, 'copilot-setup'));
    expect(fs.existsSync(resolve(solutions, '.github'))).toBe(false);
  });

  it('skips without asking when the installation does not ship the file', async () => {
    // What an npm install looked like while .github was missing from `files`:
    // the wizard asked nothing and the user never learned a file was needed.
    fs.rmSync(resolve(packageRoot, '.github'), { recursive: true });

    const plan = await maybePrepareCopilotInstructions(resolve(tmpRoot, 'repos'));

    expect(plan.stagingDir).toBeUndefined();
    expect(fs.existsSync(resolve(installDir, 'copilot-setup'))).toBe(false);
  });
});

describe('finalizeStagedCopilotFiles', () => {
  it('adds the generated .mcp.json to the staging folder and updates the README', async () => {
    const plan = await maybePrepareCopilotInstructions('');
    fs.writeFileSync(resolve(installDir, '.mcp.json'), '{"servers":{}}\n');

    finalizeStagedCopilotFiles(plan);

    expect(fs.readFileSync(resolve(plan.stagingDir!, '.mcp.json'), 'utf8')).toBe('{"servers":{}}\n');
    expect(fs.readFileSync(resolve(plan.stagingDir!, 'README.md'), 'utf8')).toContain('prepared here');
  });

  it('does nothing when the copy went straight to the solutions folder', () => {
    expect(() => finalizeStagedCopilotFiles({})).not.toThrow();
  });
});
