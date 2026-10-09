/**
 * Which servers a sandbox cell may get: the one that writes into the sandbox
 * model, never one that writes into a customer's model — read from the config
 * the way the server itself reads it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveMcpTargets,
  resolveServerTarget,
  sandboxTargetProblems,
  staleServerScripts,
  writeFilteredMcpConfig,
} from '../../src/benchmark/mcpTarget.js';

let root: string;

function write(rel: string, value: unknown): string {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-mcp-target-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sandboxModel = () => path.join(root, 'PLD', 'fm-mcp', 'fm-mcp');

function vmLikeConfig(): string {
  // The repo layout: config/<name>.json, data/ next to config/.
  const evalCfg = write('repo/config/eval.json', { version: 1, workspace: { modelName: 'fm-mcp', path: sandboxModel() } });
  const mainCfg = write('repo/config/main.json', { version: 1, workspace: { path: path.join(root, 'customer', 'AslCore') } });
  write('repo/data/xpp-metadata.db', '');
  return write('repo/.mcp.json', {
    mcpServers: {
      'd365fo-mcp-tools': { command: 'node', args: [path.join(root, 'repo', 'dist', 'index.js')], env: { D365FO_CONFIG: mainCfg } },
      'd365fo-eval': { command: 'node', args: [path.join(root, 'repo', 'dist', 'index.js')], env: { D365FO_CONFIG: evalCfg } },
    },
  });
}

describe('resolveServerTarget', () => {
  it('reads the workspace and the index from the config file the entry names, defaults anchored to the repo', () => {
    const targets = resolveMcpTargets(vmLikeConfig(), {});
    const evalT = targets.find(t => t.name === 'd365fo-eval')!;
    expect(evalT.workspacePath).toBe(sandboxModel());
    expect(evalT.dbPath).toBe(path.join(root, 'repo', 'data', 'xpp-metadata.db'));
    expect(evalT.labelsDbPath).toBe(path.join(root, 'repo', 'data', 'xpp-metadata-labels.db'));
    expect(targets.find(t => t.name === 'd365fo-mcp-tools')!.workspacePath).toBe(path.join(root, 'customer', 'AslCore'));
  });

  it('lets the entry env beat the inherited env, which beats the config file', () => {
    const cfg = write('repo/config/x.json', { version: 1, workspace: { path: 'C:\\from-config' } });
    const entry = { command: 'node', args: ['dist/index.js'], env: { D365FO_CONFIG: cfg, DB_PATH: 'C:\\own.db' } };
    const t = resolveServerTarget('x', entry, { D365FO_WORKSPACE_PATH: 'C:\\inherited', DB_PATH: 'C:\\inherited.db' });
    expect(t.workspacePath).toBe('C:\\inherited');
    expect(t.dbPath).toBe('C:\\own.db');
  });

  it('falls back to <dist>/../data for an entry with no config and no paths', () => {
    const t = resolveServerTarget('bare', { command: 'node', args: [path.join(root, 'srv', 'dist', 'index.js')] }, {});
    expect(t.dbPath).toBe(path.join(root, 'srv', 'data', 'xpp-metadata.db'));
    expect(t.workspacePath).toBeNull();
  });
});

describe('sandboxTargetProblems', () => {
  it('passes the sandbox server and names the one that writes elsewhere', () => {
    const targets = resolveMcpTargets(vmLikeConfig(), {});
    expect(sandboxTargetProblems(targets.filter(t => t.name === 'd365fo-eval'), sandboxModel())).toEqual([]);
    // Case and a trailing separator do not matter on Windows paths.
    expect(sandboxTargetProblems(targets.filter(t => t.name === 'd365fo-eval'), `${sandboxModel().toUpperCase()}${path.sep}`)).toEqual([]);
    const problems = sandboxTargetProblems(targets, sandboxModel());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/'d365fo-mcp-tools' writes to .*AslCore \(its config file\), not the sandbox/);
  });

  it('refuses a server with no provable workspace or no index to clean', () => {
    const problems = sandboxTargetProblems([{ name: 's', configPath: null, workspacePath: null, workspaceSource: null, dbPath: path.join(root, 'none.db'), labelsDbPath: null }], sandboxModel());
    expect(problems.join('\n')).toMatch(/names no workspace/);
    expect(problems.join('\n')).toMatch(/symbol index .* cannot be found/);
  });

  it('names the shell as the culprit when an inherited D365FO_WORKSPACE_PATH beats the config', () => {
    // Seen on the VM: the session environment carried D365FO_WORKSPACE_PATH=K:\AosService.
    const targets = resolveMcpTargets(vmLikeConfig(), { D365FO_WORKSPACE_PATH: path.join(root, 'AosService') });
    const evalT = targets.find(t => t.name === 'd365fo-eval')!;
    expect(evalT.workspaceSource).toBe('inherited');
    expect(sandboxTargetProblems([evalT], sandboxModel())[0]).toMatch(/set in the environment the benchmark runs in.*Unset it/);
  });
});

describe('staleServerScripts', () => {
  it('names a dist/index.js older than the commit it would be recorded under', () => {
    const script = write('repo/dist/index.js', '// built');
    const cfg = write('repo/mcp.json', { mcpServers: { a: { command: 'node', args: [script] }, b: { command: 'node', args: [script] }, c: { url: 'http://x' } } });
    const built = fs.statSync(script).mtime;
    expect(staleServerScripts(cfg, new Date(built.getTime() - 60_000))).toEqual([]);
    expect(staleServerScripts(cfg, new Date(built.getTime() + 60_000))).toEqual([path.resolve(script)]);
  });
});

describe('writeFilteredMcpConfig', () => {
  it('keeps only the named servers and refuses a name the file does not have', () => {
    const src = vmLikeConfig();
    const out = path.join(root, 'out', 'mcp.json');
    writeFilteredMcpConfig(src, ['d365fo-eval'], out);
    expect(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).mcpServers)).toEqual(['d365fo-eval']);
    expect(() => writeFilteredMcpConfig(src, ['d365fo-evl'], out)).toThrow(/d365fo-evl not in .*it has: d365fo-mcp-tools, d365fo-eval/);
  });
});
