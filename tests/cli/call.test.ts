/**
 * `d365fo-mcp tools` / `d365fo-mcp call` — the server's tools from a shell.
 *
 * The argument parser decides what reaches a tool, so most of these pin it: a
 * misspelt key must be refused rather than dropped, and a value must arrive
 * with the type the schema asks for. The last block runs both commands against
 * the server's own HTTP transport, because the SDK client and our hand-written
 * transport have to agree on the protocol, and only a real round trip shows it.
 */

import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  callCommand, describeConnectFailure, describeTool, EXIT_NOT_CALLED, EXIT_TOOL_ERROR, formatToolResult,
  localServerUrl, output, parseToolArgs, resolveServer, summarizeTools, toolsCommand, type ArgSchema,
} from '../../src/cli/commands/call';
import { createStreamableHttpTransport } from '../../src/server/transport';
import type { XppServerContext } from '../../src/types/context';

const SEARCH_SCHEMA: ArgSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look for.' },
    limit: { type: 'integer', description: 'Most results to return.' },
    score: { type: 'number' },
    includeWorkspace: { type: 'boolean' },
    types: { type: 'array', items: { type: 'string' } },
    sizes: { type: 'array', items: { type: 'integer' } },
    model: { type: ['string', 'null'] },
    options: {
      type: 'object',
      properties: { method: { type: 'string' }, depth: { type: 'integer' } },
    },
    filter: { type: 'object' },
  },
  required: ['query'],
};

describe('parseToolArgs', () => {
  it('passes one JSON object through unchanged', () => {
    expect(parseToolArgs(['{"query":"CustTable","limit":"5"}'], SEARCH_SCHEMA)).toEqual({ query: 'CustTable', limit: '5' });
  });

  it('refuses JSON that is not an object', () => {
    expect(() => parseToolArgs(['{"query":'], SEARCH_SCHEMA)).toThrow(/not valid JSON/);
  });

  it('types key=value words from the schema', () => {
    expect(parseToolArgs(
      ['query=1001', 'limit=5', 'score=0.5', 'includeWorkspace=TRUE', 'types=table, class', 'sizes=1,2', 'model=ContosoExt'],
      SEARCH_SCHEMA,
    )).toEqual({
      query: '1001', limit: 5, score: 0.5, includeWorkspace: true, types: ['table', 'class'], sizes: [1, 2], model: 'ContosoExt',
    });
  });

  it('keeps everything after the first = as the value', () => {
    expect(parseToolArgs(['query=a=b'], SEARCH_SCHEMA)).toEqual({ query: 'a=b' });
  });

  it('builds nested objects from dotted keys, typed by the nested schema', () => {
    expect(parseToolArgs(['query=SalesLine', 'options.method=insert', 'options.depth=2'], SEARCH_SCHEMA))
      .toEqual({ query: 'SalesLine', options: { method: 'insert', depth: 2 } });
  });

  it('reads JSON for object and array values', () => {
    expect(parseToolArgs(['filter={"kind":"table"}', 'types=["a,b"]'], SEARCH_SCHEMA))
      .toEqual({ filter: { kind: 'table' }, types: ['a,b'] });
    expect(() => parseToolArgs(['filter=table'], SEARCH_SCHEMA)).toThrow(/must be a JSON object/);
  });

  it('refuses a key the schema does not list, and names the ones it does', () => {
    expect(() => parseToolArgs(['qery=CustTable'], SEARCH_SCHEMA)).toThrow(/Unknown argument 'qery'\. Known: query, limit/);
    expect(() => parseToolArgs(['options.mehtod=x'], SEARCH_SCHEMA)).toThrow(/Unknown argument 'mehtod' in 'options'/);
  });

  it('refuses values of the wrong type instead of sending them', () => {
    expect(() => parseToolArgs(['limit=five'], SEARCH_SCHEMA)).toThrow(/'limit' must be an integer/);
    expect(() => parseToolArgs(['limit=2.5'], SEARCH_SCHEMA)).toThrow(/'limit' must be an integer/);
    expect(() => parseToolArgs(['score='], SEARCH_SCHEMA)).toThrow(/'score' must be a number/);
    expect(() => parseToolArgs(['includeWorkspace=yes'], SEARCH_SCHEMA)).toThrow(/true or false/);
  });

  it('refuses malformed words, repeats and prototype keys', () => {
    expect(() => parseToolArgs(['CustTable'], SEARCH_SCHEMA)).toThrow(/Expected key=value/);
    expect(() => parseToolArgs(['=x'], SEARCH_SCHEMA)).toThrow(/Expected key=value/);
    expect(() => parseToolArgs(['query=a', 'query=b'], SEARCH_SCHEMA)).toThrow(/given twice/);
    expect(() => parseToolArgs(['query=a', 'query.x=b'], SEARCH_SCHEMA)).toThrow(/conflicts/);
    expect(() => parseToolArgs(['__proto__.polluted=1'])).toThrow(/Bad argument name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('where the schema names no type, sends JSON values as values and the rest as text', () => {
    expect(parseToolArgs(['flag=true', 'n=25', 'x=-1.5e2', 'none=null', 'id=0012', 'name=CustTable', 'list=[1,2]']))
      .toEqual({ flag: true, n: 25, x: -150, none: null, id: '0012', name: 'CustTable', list: [1, 2] });
  });

  it('types the fields of a free-form options object, and cannot check their names', () => {
    const schema: ArgSchema = { type: 'object', properties: { options: { type: 'object', description: 'Reader flags.' } } };
    expect(parseToolArgs(['options.compact=true', 'options.methodOffset=25', 'options.fieldFilter=Cust'], schema))
      .toEqual({ options: { compact: true, methodOffset: 25, fieldFilter: 'Cust' } });
  });

  it('a string-typed argument stays text even when it looks like a number', () => {
    expect(parseToolArgs(['query=1001'], SEARCH_SCHEMA)).toEqual({ query: '1001' });
  });

  it('takes the single type out of anyOf', () => {
    const schema: ArgSchema = { type: 'object', properties: { n: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } };
    expect(parseToolArgs(['n=3'], schema)).toEqual({ n: 3 });
  });
});

describe('formatToolResult', () => {
  it('prints the text items in order, as the model would see them', () => {
    expect(formatToolResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })).toBe('one\n\ntwo');
  });

  it('describes binary content instead of dumping it', () => {
    const text = formatToolResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] });
    expect(text).toMatch(/\[image image\/png, 3 bytes — use --json/);
  });

  it('falls back to structured content when there is no text', () => {
    expect(formatToolResult({ content: [], structuredContent: { total: 2 } })).toBe('{\n  "total": 2\n}');
  });

  it('prints an embedded text resource', () => {
    expect(formatToolResult({ content: [{ type: 'resource', resource: { uri: 'x://y', text: 'body' } }] })).toBe('body');
  });
});

describe('where the server is', () => {
  it('reaches a local server on the loopback address', () => {
    expect(localServerUrl(8080, undefined)).toBe('http://127.0.0.1:8080/mcp/');
    expect(localServerUrl(8080, '0.0.0.0')).toBe('http://127.0.0.1:8080/mcp/');
    expect(localServerUrl(9000, 'localhost')).toBe('http://127.0.0.1:9000/mcp/');
    expect(localServerUrl(9000, '10.0.0.5')).toBe('http://10.0.0.5:9000/mcp/');
    expect(localServerUrl(9000, '::1')).toBe('http://[::1]:9000/mcp/');
  });

  it('takes --url, then D365FO_MCP_URL, and normalises either to the endpoint', () => {
    expect(resolveServer({ url: 'http://127.0.0.1:9100' }, {}).url).toBe('http://127.0.0.1:9100/mcp/');
    expect(resolveServer({}, { D365FO_MCP_URL: 'http://127.0.0.1:9200/mcp' }).url).toBe('http://127.0.0.1:9200/mcp/');
  });

  it('sends a key to an explicit URL only when the key is explicit too', () => {
    expect(resolveServer({ url: 'https://example.test' }, {}).apiKey).toBeUndefined();
    expect(resolveServer({ url: 'https://example.test' }, { D365FO_MCP_API_KEY: 'k1' }).apiKey).toBe('k1');
    expect(resolveServer({ url: 'https://example.test', apiKey: 'k2' }, { D365FO_MCP_API_KEY: 'k1' }).apiKey).toBe('k2');
  });

  it('turns connect failures into what to do', () => {
    expect(describeConnectFailure('u', new Error('fetch failed'))).toMatch(/No server answers at u\. Start one with `d365fo-mcp start`/);
    expect(describeConnectFailure('u', new Error('Error POSTing to endpoint (HTTP 401): no'))).toMatch(/--api-key/);
    expect(describeConnectFailure('u', new Error('Error POSTing to endpoint (HTTP 503): starting'))).toMatch(/still starting/);
  });
});

const TOOLS: Tool[] = [
  {
    name: 'search',
    description: '**Find** X++ objects by name. Searches the index.\nSecond line.',
    inputSchema: SEARCH_SCHEMA as Tool['inputSchema'],
  },
  {
    name: 'get_knowledge',
    description: 'Rules and patterns.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['rules', 'op-spec'], default: 'rules' } } },
  },
];

describe('tool listings', () => {
  it('prints one line per tool with the first sentence of its description', () => {
    const text = summarizeTools(TOOLS);
    expect(text).toContain('search         Find X++ objects by name.');
    expect(text).toContain('get_knowledge  Rules and patterns.');
    expect(text).not.toContain('Second line');
  });

  it('prints one tool in full, with nested arguments and a call line', () => {
    const text = describeTool(TOOLS[0]);
    expect(text).toContain('Second line.');
    expect(text).toContain('  query (string, required)  What to look for.');
    expect(text).toContain('  options.method (string)');
    expect(text).toContain('  types (array of string)');
    expect(text).toContain('Call: d365fo-mcp call search query=…');
    expect(describeTool(TOOLS[1])).toContain("kind (string)  one of: rules, op-spec · default: \"rules\"");
  });
});

describe('against the server\'s HTTP transport', () => {
  let http: HttpServer;
  let url: string;
  const received: unknown[] = [];
  let out = '';
  let err = '';

  beforeAll(async () => {
    const server = new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      received.push(request.params.arguments);
      if (request.params.name === 'get_knowledge') {
        return { content: [{ type: 'text', text: 'kind not found' }], isError: true };
      }
      return { content: [{ type: 'text', text: `found ${JSON.stringify(request.params.arguments)}` }] };
    });
    const app = express();
    app.use(express.json());
    const context = { symbolIndex: { getCachedSymbolCounts: () => ({ total: 0 }) } } as unknown as XppServerContext;
    createStreamableHttpTransport(server, app, context);
    http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => http.close(() => resolve()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    out = '';
    err = '';
    received.length = 0;
  });

  function capture(): void {
    // Through `output`, not process.stdout: the transport in this same process
    // logs every request to stdout too.
    vi.spyOn(output, 'answer').mockImplementation(text => { out += text; });
    vi.spyOn(output, 'problem').mockImplementation(text => { err += text; });
  }

  it('calls a tool with typed key=value arguments and prints its text', async () => {
    capture();
    await callCommand('search', ['query=CustTable', 'limit=3'], { url });
    expect(received).toEqual([{ query: 'CustTable', limit: 3 }]);
    // The HTTP transport puts a progress line first, for every HTTP client alike.
    expect(out).toBe('🔍 Searching D365FO index: "CustTable"\n\nfound {"query":"CustTable","limit":3}\n');
    expect(process.exitCode).toBeUndefined();
  });

  it('passes a JSON object through unchanged', async () => {
    capture();
    await callCommand('search', ['{"query":"SalesLine"}'], { url, json: true });
    expect(received).toEqual([{ query: 'SalesLine' }]);
    expect(JSON.parse(out).content[0].text).toMatch(/\n\nfound \{"query":"SalesLine"\}$/);
  });

  it('exits 1 when the tool answers with an error, still printing it', async () => {
    capture();
    await callCommand('get_knowledge', [], { url });
    expect(out).toMatch(/\n\nkind not found\n$/);
    expect(process.exitCode).toBe(EXIT_TOOL_ERROR);
  });

  it('exits 2 without calling anything for an unknown tool or a misspelt argument', async () => {
    capture();
    await callCommand('serch', ['query=x'], { url });
    expect(err).toMatch(/Unknown tool 'serch'\. This server publishes: search, get_knowledge/);
    expect(process.exitCode).toBe(EXIT_NOT_CALLED);
    err = '';
    await callCommand('serch', [], { url });
    expect(err).toMatch(/Unknown tool 'serch'/);
    err = '';
    await callCommand('search', ['qery=x'], { url });
    expect(err).toMatch(/Unknown argument 'qery'/);
    expect(received).toEqual([]);
  });

  it('lists the tools, and shows one in full', async () => {
    capture();
    await toolsCommand(undefined, { url });
    expect(out).toContain('get_knowledge  Rules and patterns.');
    out = '';
    await toolsCommand('search', { url });
    expect(out).toContain('query (string, required)');
  });

  it('says how to start a server when none answers', async () => {
    capture();
    await toolsCommand(undefined, { url: 'http://127.0.0.1:1/mcp' });
    expect(err).toMatch(/No server answers at http:\/\/127\.0\.0\.1:1\/mcp\/\. Start one with `d365fo-mcp start`/);
    expect(process.exitCode).toBe(EXIT_NOT_CALLED);
  });
});
