/**
 * `d365fo-mcp session --host` finding logs, and the chained-turn count (#1329).
 *
 * The directory trees are built by hand in a temp dir, never from the real
 * `%APPDATA%` or `~/.claude`, and every folder name is a generic Contoso one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeProjectFolderName, locateSessionLogs, MIN_LOG_BYTES, pathKey, workspaceFolder,
} from '../../src/cli/session/locate.js';
import { chainedSingleCallTurns } from '../../src/cli/session/analyze.js';
import { valueTokens, type SessionToolCall } from '../../src/cli/session/sessionLog.js';

let root: string;
let home: string;
let appData: string;

beforeEach(() => {
  // Not os.tmpdir() itself: nothing in this suite may ever remove that.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'locate-test-'));
  home = path.join(root, 'home');
  appData = path.join(root, 'appdata');
  fs.mkdirSync(home);
  fs.mkdirSync(appData);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A log of the given size, with an mtime `ageSeconds` ago. */
function writeLog(file: string, bytes: number, ageSeconds: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(bytes));
  const t = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, t, t);
}

describe('claudeProjectFolderName', () => {
  it('turns every character that is not a letter or digit into a dash', () => {
    expect(claudeProjectFolderName('K:\\repos\\contoso-app')).toBe('K--repos-contoso-app');
    expect(claudeProjectFolderName('/home/dev/contoso.app')).toBe('-home-dev-contoso-app');
  });
});

describe('pathKey / workspaceFolder', () => {
  it('compares a VS Code folder URI with a Windows path', () => {
    const folder = workspaceFolder('{"folder":"file:///k%3A/repos/Contoso%20App"}');
    expect(folder).toBe('/k:/repos/Contoso App');
    expect(pathKey(folder!)).toBe(pathKey('K:\\repos\\Contoso App\\'));
  });

  it('gives no folder for a multi-root or remote workspace, or for junk', () => {
    expect(workspaceFolder('{"workspace":"file:///c%3A/x.code-workspace"}')).toBeNull();
    expect(workspaceFolder('{"folder":"vscode-remote://ssh-remote%2Bbox/home/x"}')).toBeNull();
    expect(workspaceFolder('not json')).toBeNull();
  });
});

describe('locateSessionLogs — Claude Code', () => {
  const project = 'K:\\repos\\ContosoApp';
  const dir = () => path.join(home, '.claude', 'projects', 'K--repos-ContosoApp');

  it('returns the newest sessions first and stops at --last', () => {
    writeLog(path.join(dir(), 'old.jsonl'), 5000, 300);
    writeLog(path.join(dir(), 'new.jsonl'), 5000, 10);
    writeLog(path.join(dir(), 'mid.jsonl'), 5000, 100);
    const found = locateSessionLogs({ host: 'claude', project, last: 2, homeDir: home });
    expect(found.files.map(f => path.basename(f))).toEqual(['new.jsonl', 'mid.jsonl']);
  });

  it('matches the folder whatever the case of the drive letter, and reads both', () => {
    writeLog(path.join(home, '.claude', 'projects', 'k--repos-ContosoApp', 'lower.jsonl'), 5000, 10);
    writeLog(path.join(dir(), 'upper.jsonl'), 5000, 50);
    const found = locateSessionLogs({ host: 'claude', project, last: 5, homeDir: home });
    expect(found.files.map(f => path.basename(f))).toEqual(['lower.jsonl', 'upper.jsonl']);
  });

  it("skips logs that are too small to be a session, and says how many", () => {
    writeLog(path.join(dir(), 'empty.jsonl'), MIN_LOG_BYTES - 1, 1);
    writeLog(path.join(dir(), 'real.jsonl'), MIN_LOG_BYTES, 100);
    const found = locateSessionLogs({ host: 'claude', project, last: 5, homeDir: home });
    expect(found.files.map(f => path.basename(f))).toEqual(['real.jsonl']);
    expect(found.skippedSmall).toBe(1);
  });

  it("ignores another project's sessions and the helper-agent folders", () => {
    writeLog(path.join(home, '.claude', 'projects', 'K--repos-ContosoOther', 'other.jsonl'), 5000, 1);
    writeLog(path.join(dir(), 'session-1', 'subagents', 'agent-a.jsonl'), 5000, 1);
    writeLog(path.join(dir(), 'session-1.jsonl'), 5000, 20);
    const found = locateSessionLogs({ host: 'claude', project, last: 5, homeDir: home });
    expect(found.files.map(f => path.basename(f))).toEqual(['session-1.jsonl']);
  });

  it('finds nothing, without throwing, when the host was never used', () => {
    const found = locateSessionLogs({ host: 'claude', project, last: 1, homeDir: home });
    expect(found.files).toEqual([]);
    expect(found.searched[0]).toContain(path.join('.claude', 'projects'));
  });
});

describe('locateSessionLogs — Copilot Chat', () => {
  const project = 'K:\\repos\\ContosoApp';
  const storage = (product = 'Code') => path.join(appData, product, 'User', 'workspaceStorage');

  function workspace(hash: string, folderUri: string, product = 'Code'): string {
    const dir = path.join(storage(product), hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ folder: folderUri }));
    return path.join(dir, 'GitHub.copilot-chat', 'debug-logs');
  }

  it('finds the workspace by its folder, not by its hash', () => {
    const mine = workspace('aaaa', 'file:///k%3A/repos/ContosoApp');
    const other = workspace('bbbb', 'file:///k%3A/repos/ContosoOther');
    writeLog(path.join(mine, 's1', 'main.jsonl'), 5000, 200);
    writeLog(path.join(mine, 's2', 'main.jsonl'), 5000, 20);
    writeLog(path.join(other, 's3', 'main.jsonl'), 5000, 1);
    const found = locateSessionLogs({ host: 'copilot', project, last: 5, appDataDir: appData });
    expect(found.files.map(f => path.basename(path.dirname(f)))).toEqual(['s2', 's1']);
  });

  it('does not take a workspace opened on a sub-folder for the project', () => {
    const sub = workspace('cccc', 'file:///k%3A/repos/ContosoApp/src');
    writeLog(path.join(sub, 's1', 'main.jsonl'), 5000, 1);
    expect(locateSessionLogs({ host: 'copilot', project, last: 1, appDataDir: appData }).files).toEqual([]);
  });

  it('reads the Insiders storage too, and leaves out a session with no main.jsonl', () => {
    const insiders = workspace('dddd', 'file:///k%3A/repos/ContosoApp', 'Code - Insiders');
    writeLog(path.join(insiders, 's1', 'main.jsonl'), 5000, 5);
    fs.mkdirSync(path.join(insiders, 's2'), { recursive: true });
    const found = locateSessionLogs({ host: 'copilot', project, last: 5, appDataDir: appData });
    expect(found.files.map(f => path.basename(path.dirname(f)))).toEqual(['s1']);
  });

  it('survives a storage folder with no workspace.json', () => {
    fs.mkdirSync(path.join(storage(), 'eeee'), { recursive: true });
    expect(locateSessionLogs({ host: 'copilot', project, last: 1, appDataDir: appData }).files).toEqual([]);
  });
});

describe('valueTokens', () => {
  it('keeps GUIDs and numbers of four or more digits, and nothing else', () => {
    const found = valueTokens('line 40189 of 61D9ACF8-6DD9-4C4D-BE75-17ACECAB0552, row 12 in TaxTable');
    expect([...found].sort()).toEqual(['40189', '61d9acf8-6dd9-4c4d-be75-17acecab0552']);
  });
});

describe('chainedSingleCallTurns', () => {
  const call = (args: string[], results: string[]): SessionToolCall => ({
    ts: 0, name: 'tool', durationMs: 0, resultChars: 0, failed: false, argTokens: args, resultTokens: results,
  });

  it('counts a single-call turn that uses a value the turn before printed first', () => {
    // grep prints line 40189; the next turn reads exactly there.
    expect(chainedSingleCallTurns([[call([], ['40189'])], [call(['40189'], [])]])).toBe(1);
  });

  it('does not count a value an earlier turn had already shown — it could have been used sooner', () => {
    expect(chainedSingleCallTurns([
      [call([], ['40189'])],
      [call([], [])],
      [call(['40189'], [])],
    ])).toBe(0);
  });

  it('does not count a value the model already had in its own arguments', () => {
    expect(chainedSingleCallTurns([[call(['40189'], ['40189'])], [call(['40189'], [])]])).toBe(0);
  });

  it('counts only single-call turns: a parallel turn is already batched', () => {
    expect(chainedSingleCallTurns([
      [call([], ['40189'])],
      [call(['40189'], []), call([], [])],
    ])).toBe(0);
  });

  it('is null when the log carries no call arguments at all', () => {
    const bare: SessionToolCall = { ts: 0, name: 'tool', durationMs: 0, resultChars: 0, failed: false };
    expect(chainedSingleCallTurns([[bare], [bare]])).toBeNull();
  });
});
