/**
 * operations[] with atomic: true restores the file when an operation fails.
 *
 * A batch stops at the first failure and keeps what applied before it ("4/13
 * operation(s) applied, failed at #5"), leaving the object half-changed and the
 * caller to re-send the rest by hand — 11 such batches in one project's sessions.
 * With atomic, the batch keeps the first pre-batch image of each file it changed and
 * writes it back on failure. Without it, behaviour is unchanged, and the failure
 * text now says the option exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

const { mockModify } = vi.hoisted(() => ({ mockModify: vi.fn() }));

vi.mock('../../src/tools/write/modifyD365File', () => ({ modifyD365FileTool: mockModify }));
vi.mock('../../src/tools/write/createD365File', () => ({ handleCreateD365File: vi.fn() }));
vi.mock('../../src/tools/xml/generateD365Xml', () => ({ handleGenerateD365Xml: vi.fn() }));
vi.mock('../../src/tools/write/inlineIndexUpsert', () => ({ upsertWrittenFileIntoIndex: vi.fn(async () => '') }));

import { d365foFileTool } from '../../src/tools/d365foFile';

const ORIGINAL = '<AxTable>\r\n\t<Name>ContosoSetting</Name>\r\n</AxTable>\r\n';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-batch-'));
  file = path.join(dir, 'ContosoSetting.xml');
  await fs.writeFile(file, ORIGINAL, 'utf-8');
  mockModify.mockReset();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>): CallToolRequest => ({
  method: 'tools/call',
  params: {
    name: 'd365fo_file',
    arguments: { action: 'modify', objectType: 'table', objectName: 'ContosoSetting', ...args },
  },
});

/** A modify that appends a line to the file, capturing its pre-image the way runModify does. */
const writingModify = (line: string, reportPath: boolean) => async (_req: unknown, _ctx: unknown, outcome: any) => {
  if (outcome?.captureOriginal && outcome.originalBytes === undefined) outcome.originalBytes = await fs.readFile(file);
  if (reportPath) outcome.filePath = file;
  await fs.appendFile(file, line, 'utf-8');
  return { content: [{ type: 'text', text: `✅ ${line.trim()}` }] };
};
const failingModify = async () => ({
  content: [{ type: 'text', text: '❌ EDT "Iteger" does not exist' }],
  isError: true,
});

const operations = [
  { operation: 'add-field', fieldName: 'A' },
  { operation: 'add-field', fieldName: 'B' },
  { operation: 'add-field', fieldName: 'C' },
];

describe('atomic operations[]', () => {
  it('restores the file to its bytes from before the call when an operation fails', async () => {
    mockModify
      .mockImplementationOnce(writingModify('<!-- A -->\r\n', true))
      .mockImplementationOnce(writingModify('<!-- B -->\r\n', true))
      .mockImplementationOnce(failingModify);

    const result = await d365foFileTool(call({ atomic: true, operations }), {} as any);
    const text = (result as any).content[0].text as string;

    expect(await fs.readFile(file, 'utf-8')).toBe(ORIGINAL);
    expect(text).toContain('0/3 operation(s) applied (2 rolled back)');
    expect(text).toContain('failed at #3');
    expect(text).toContain('restored 1 file(s)');
    expect(text).not.toMatch(/ARE applied/);
  });

  it('does not pass atomic on to the operations', async () => {
    mockModify.mockImplementation(writingModify('<!-- x -->\r\n', true));
    await d365foFileTool(call({ atomic: true, operations: [operations[0]] }), {} as any);
    const forwarded = (mockModify.mock.calls[0][0] as CallToolRequest).params.arguments as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty('atomic');
  });

  it('keeps what applied without atomic, and says the option exists', async () => {
    mockModify.mockImplementationOnce(writingModify('<!-- A -->\r\n', false)).mockImplementationOnce(failingModify);

    const result = await d365foFileTool(call({ operations: operations.slice(0, 2) }), {} as any);
    const text = (result as any).content[0].text as string;

    expect(await fs.readFile(file, 'utf-8')).toBe(`${ORIGINAL}<!-- A -->\r\n`);
    expect(text).toContain('1/2 operation(s) applied');
    expect(text).toMatch(/ARE applied/);
    expect(text).toContain('atomic: true');
  });
});
