/**
 * Output validity and the rework path: the two things a final "builds clean"
 * hides. A server that writes content the model has to diagnose and repair is
 * visible only in the stream (tool errors, failed builds, rewrites); content
 * that builds but is still wrong is visible only to xppbp.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseStreamJson, summarizeRework } from '../../src/benchmark/claudeCode.js';
import { bpDelta, clearBuildState, malformedXml, parseBpOutput, type SandboxInfo } from '../../src/benchmark/sandbox.js';

const ev = (o: unknown) => JSON.stringify(o);
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const res = (id: string, content: unknown, isError = false) => ({ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });
const assistant = (...content: unknown[]) => ev({ type: 'assistant', message: { content } });
const user = (...content: unknown[]) => ev({ type: 'user', message: { content } });

describe('rework trace from the stream', () => {
  it('counts tool errors (MCP ❌ results too), failed builds and repeated writes to one target', () => {
    const stream = [
      assistant(use('a', 'mcp__d365fo-eval__d365fo_file', { action: 'create', objectType: 'table', objectName: 'ConVendCertificate' })),
      user(res('a', [{ type: 'text', text: '❌ Could not resolve EDT ConVendCertificateId' }])),
      assistant(use('b', 'mcp__d365fo-eval__d365fo_file', { action: 'create', objectType: 'table', objectName: 'ConVendCertificate' })),
      user(res('b', '✅ Created')),
      assistant(use('c', 'mcp__d365fo-eval__build_d365fo_project', {})),
      user(res('c', '❌ Build FAILED\nErrors: 2', true)),
      assistant(use('d', 'Edit', { file_path: 'K:\\PLD\\fm-mcp\\fm-mcp\\AxForm\\ConVendCertificate.xml' }), use('e', 'Edit', { file_path: 'K:/PLD/fm-mcp/fm-mcp/AxForm/ConVendCertificate.xml' })),
      user(res('d', 'ok'), res('e', 'ok')),
      assistant(use('f', 'PowerShell', { command: '& K:\\PLD\\bin\\xppc.exe -modelmodule=fm-mcp' })),
      user(res('f', 'Permission to use PowerShell has been denied because Claude Code is running in don\'t ask mode.', true)),
      // Mentions xppc, runs nothing: not a build.
      assistant(use('f2', 'Bash', { command: 'ls fm-mcp/bin | grep -iE "xppc|\\.exe"' })),
      user(res('f2', 'xppc.exe')),
      assistant(use('g', 'mcp__d365fo-eval__build_d365fo_project', {})),
      user(res('g', '✅ Build succeeded\nErrors: 0')),
      assistant(use('h', 'mcp__d365fo-eval__search', { query: 'x' })),
      user(res('h', 'Found 0 matches — ❌ not a failure marker at the start')),
    ].join('\n');
    const s = parseStreamJson(stream);
    expect(s.rework.toolErrors).toEqual({ 'mcp__d365fo-eval__d365fo_file': 1, 'mcp__d365fo-eval__build_d365fo_project': 1, PowerShell: 1 });
    // The refused PowerShell xppc never ran, and the grep only mentions xppc: two real builds, one failed.
    expect(s.rework.buildAttempts).toBe(2);
    expect(s.rework.buildFailures).toBe(1);
    const r = summarizeRework(s.rework);
    expect(r).toMatchObject({ toolErrors: 3, mcpToolErrors: 2, buildAttempts: 2, buildFailures: 1, writeOps: 4, rewrites: 1 });
  });

  it('counts a repeated write as a repair only after a failure, not when an object is built in steps', () => {
    const file = (id: string, action: string) => use(id, 'mcp__s__d365fo_file', { action, objectType: 'table', objectName: 'ConT' });
    const steps = [
      // The server's normal flow: create, then add a field, then a field group. Not repair.
      assistant(file('a', 'create')), user(res('a', '✅ created')),
      assistant(file('b', 'modify')), user(res('b', '✅ field added')),
      assistant(file('c', 'modify')), user(res('c', '✅ group added')),
      // A build fails; the next write to the table repairs it.
      assistant(use('d', 'mcp__s__build_d365fo_project', {})), user(res('d', '❌ Build FAILED', true)),
      assistant(file('e', 'modify')), user(res('e', '✅ fixed')),
      // A write that fails, then the same write again: repair.
      assistant(file('f', 'modify')), user(res('f', '❌ invalid property', true)),
      assistant(file('g', 'modify')), user(res('g', '✅')),
    ].join('\n');
    const r = summarizeRework(parseStreamJson(steps).rework);
    expect(r.writeOps).toBe(6);
    expect(r.rewrites).toBe(2);
  });

  it('is all zeros for a stream with no tool use', () => {
    expect(summarizeRework(parseStreamJson(ev({ type: 'result', subtype: 'success' })).rework)).toEqual({
      toolErrors: 0, mcpToolErrors: 0, toolErrorsByTool: {}, buildAttempts: 0, buildFailures: 0, writeOps: 0, rewrites: 0,
    });
  });
});

describe('xppbp output', () => {
  // Shape captured from xppbp over the fm-mcp sandbox, 2026-10-09.
  const baseline = [
    'BestPractices Warning: AxTable dynamics://Table/ConDemoNoteHeader: BPErrorTableNoCaching: No caching is set up for the table.',
    'BestPractices Warning: AxTable dynamics://Table/ConDemoNoteHeader: BPErrorTableMissingFormRef: No form ref is specified.',
    '',
    'BPErrorTableNoCaching: 1',
    'Warnings: 6',
    'Errors: 0',
  ].join('\r\n');

  it('reads the detail lines and the totals, and says when it did not run', () => {
    const b = parseBpOutput(baseline);
    expect(b).toMatchObject({ ran: true, errors: 0, warnings: 6 });
    expect(b.lines).toHaveLength(2);
    expect(parseBpOutput('Usage: xppbp.exe -metadata …').ran).toBe(false);
  });

  it('charges a cell only with findings the clean sandbox did not have', () => {
    const after = parseBpOutput([
      baseline.split('\r\n')[0],
      baseline.split('\r\n')[1],
      'BestPractices Error: AxReport dynamics://Report/ConCustOverdueReport/Design: [(1,1),(1,9)]: BPErrorLabelIsText: The text "Customer" should be a label.',
      'BestPractices Warning: AxClass dynamics://Class/ConCustOverdueReportDP/Method/processReport: [(3,5),(9,6)]: BPXmlDocNoDocumentationComments: No XML documentation headers.',
      'Warnings: 7',
      'Errors: 1',
    ].join('\n'));
    const d = bpDelta(parseBpOutput(baseline), after);
    expect(d.errors).toBe(1);
    expect(d.warnings).toBe(1);
    expect(d.findings[0]).toBe('Error BPErrorLabelIsText Report/ConCustOverdueReport/Design');
    expect(d.findings[1]).toMatch(/^Warning BPXmlDocNoDocumentationComments Class\/ConCustOverdueReportDP\/Method\/processReport$/);
  });
});

describe('malformed XML and build state', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-quality-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('names the written XML files that do not parse, ignoring other files', async () => {
    fs.mkdirSync(path.join(root, 'm', 'AxTable'), { recursive: true });
    fs.writeFileSync(path.join(root, 'm', 'AxTable', 'Good.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<AxTable><Name>Good</Name></AxTable>');
    fs.writeFileSync(path.join(root, 'm', 'AxTable', 'Bad.xml'), '<AxTable><Name>Bad</Name>');
    fs.writeFileSync(path.join(root, 'm', 'notes.txt'), '<not xml');
    expect(await malformedXml(root, ['m/AxTable/Good.xml', 'm/AxTable/Bad.xml', 'm/notes.txt'])).toEqual(['m/AxTable/Bad.xml']);
  });

  it("removes only the sandbox module's build state file", () => {
    fs.writeFileSync(path.join(root, 'd365build_state_aaaa111111.json'), JSON.stringify({ targetModel: 'fm-mcp' }));
    fs.writeFileSync(path.join(root, 'd365build_state_bbbb222222.json'), JSON.stringify({ targetModel: 'AslCore' }));
    fs.writeFileSync(path.join(root, 'd365build_log_aaaa111111.log'), 'log');
    const info = { packageName: 'fm-mcp', model: 'fm-mcp' } as SandboxInfo;
    expect(clearBuildState(info, root)).toBe(1);
    expect(fs.readdirSync(root).sort()).toEqual(['d365build_log_aaaa111111.log', 'd365build_state_bbbb222222.json']);
  });
});
