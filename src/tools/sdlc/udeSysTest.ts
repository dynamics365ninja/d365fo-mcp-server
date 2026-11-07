/**
 * Running SysTest classes on a UDE environment, through its cloud runtime.
 *
 * A UDE machine has no local AOS, so SysTestConsole cannot run there. Visual Studio's test
 * adapter sends the tests to the cloud runtime instead, through the Dataverse environment the
 * UDE belongs to, and this module does the same, with the same Dataverse calls:
 *
 *   1. create an `msprov_unittestsuite` row and upload a test request (a `.tsx` TestSuite
 *      document naming the module assembly and every test method) to its
 *      `msprov_unittestsuiteconfig` file column;
 *   2. call the global custom API `msprov_unittestexecutiononfinopsasync` with that row and
 *      poll the `asyncoperation` it returns;
 *   3. poll the row until it is Completed, then download `msprov_unittestresult`: a zip that
 *      holds the `.trx` (VSTest) results of the run.
 *
 * None of this is documented; it was read from Power Platform Tools for Visual Studio and
 * checked against a UDE environment. Facts the server side insists on, found by trying:
 *   - AssemblyPath must be the module assembly's path under the runtime packages folder
 *     (RuntimePackagesDirectory in the XPP config); the bare file name fails the job with
 *     "FailedDependency".
 *   - Every test method must be listed. RunAll=true with no test cases runs nothing, so the
 *     methods are read from the class here. A single listed method runs alone, which is what
 *     makes `testMethod` work on UDE.
 *   - TestKey only has to be a GUID: the results name each test by its `Class.method` too.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  blankCommentsAndStrings,
  parseXppClassHeader,
  parseXppDeclaration,
  visibilityFromModifiers,
} from '../../metadata/xppDeclaration.js';
import type { SysTestCaseOutcome } from './sysTestXml.js';

// ── test methods ────────────────────────────────────────────────────────────

export interface TestMethodInfo {
  name: string;
  /** Carries [SysTestInactiveTest]: listed in the results as skipped, never sent to run. */
  inactive: boolean;
}

export interface TestClassInfo {
  name: string;
  extends?: string;
  isAbstract: boolean;
  methods: TestMethodInfo[];
}

/** Every `<Method>` of an AxClass document: its name and X++ source. */
function readAxClassMethods(xml: string): { name: string; source: string }[] {
  const methods: { name: string; source: string }[] = [];
  const methodRe = /<Method>\s*<Name>([^<]+)<\/Name>\s*<Source><!\[CDATA\[([\s\S]*?)\]\]><\/Source>/g;
  for (const m of xml.matchAll(methodRe)) methods.push({ name: m[1].trim(), source: m[2] });
  return methods;
}

/**
 * The code above a method's declaration — its attributes and modifiers — with comments and
 * string contents blanked. Searching the blanked copy matters twice over: a doc comment that
 * mentions `name(` must not end the slice early (hiding the attributes below it), and an
 * attribute named only in a comment must not count.
 */
function attributesOf(source: string, name: string): string {
  const blanked = blankCommentsAndStrings(source);
  const at = blanked.search(new RegExp(`(^|[^\\w.:])${name}\\s*\\(`, 'i'));
  return at < 0 ? '' : blanked.slice(0, at);
}

/**
 * The test methods a class declares, by SysTest's own rule: public instance methods that
 * return void and take no parameters, named `test…` or marked [SysTestMethod].
 */
export function readTestClass(xml: string): TestClassInfo | null {
  const declaration = /<Declaration><!\[CDATA\[([\s\S]*?)\]\]><\/Declaration>/.exec(xml)?.[1];
  const header = declaration ? parseXppClassHeader(declaration) : null;
  if (!header) return null;

  const methods: TestMethodInfo[] = [];
  for (const { name, source } of readAxClassMethods(xml)) {
    const decl = parseXppDeclaration(source, name);
    if (!decl) continue;
    const visibility = visibilityFromModifiers(decl.modifiers) ?? 'public';
    if (visibility !== 'public' || decl.modifiers.includes('static')) continue;
    if (decl.returnType.toLowerCase() !== 'void' || decl.parameters.length > 0) continue;
    const attributes = attributesOf(source, name);
    const marked = /\bSysTestMethod(Attribute)?\b/i.test(attributes);
    if (!marked && !/^test/i.test(decl.name)) continue;
    methods.push({ name: decl.name, inactive: /\bSysTestInactiveTest(Attribute)?\b/i.test(attributes) });
  }
  return { name: header.name, extends: header.extends, isAbstract: header.isAbstract, methods };
}

// ── test request ────────────────────────────────────────────────────────────

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface TestRequestCase {
  key: string;
  /** `Class.method`, the name the results come back under. */
  name: string;
}

/** The `.tsx` TestSuite document the cloud runtime reads, in the shape Visual Studio writes. */
export function buildTestSuiteXml(
  assemblyPath: string,
  className: string,
  methodNames: readonly string[],
  testSource: string,
): { xml: string; cases: TestRequestCase[] } {
  const cases = methodNames.map(m => ({ key: randomUUID(), name: `${className}.${m}` }));
  const body = cases.map(c => [
    '    <TestCaseInformation>',
    `      <TestKey>${c.key}</TestKey>`,
    `      <TestCaseName>${xmlEscape(c.name)}</TestCaseName>`,
    `      <FullyQualifiedName>Dynamics.AX.Application.${xmlEscape(c.name)}</FullyQualifiedName>`,
    '      <ExpectedRuntime>0</ExpectedRuntime>',
    `      <TestSource>${xmlEscape(testSource)}</TestSource>`,
    '      <ExecutorURI>executor://systestexecutor/v1</ExecutorURI>',
    '    </TestCaseInformation>',
  ].join('\n'));
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TestSuite xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <AssemblyPath>${xmlEscape(assemblyPath)}</AssemblyPath>`,
    '  <RunAll>false</RunAll>',
    '  <TestCases>',
    ...body,
    '  </TestCases>',
    '  <TestFramework>xpptest</TestFramework>',
    '</TestSuite>',
    '',
  ].join('\n');
  return { xml, cases };
}

/**
 * The module assembly under the runtime packages folder. That folder holds junctions —
 * `PackagesLocalDirectory` and `bin` to the framework, one per custom root (named like
 * `ZZZZ__Metadata`) — so a custom package is one level below one of its entries.
 */
export async function findRuntimeAssembly(runtimeDir: string, packageName: string): Promise<string | null> {
  const dll = `Dynamics.AX.${packageName}.dll`;
  const candidates = [path.join(runtimeDir, packageName, 'bin', dll)];
  try {
    for (const entry of await fs.readdir(runtimeDir, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        candidates.push(path.join(runtimeDir, entry.name, packageName, 'bin', dll));
      }
    }
  } catch { /* unreadable: only the direct candidate */ }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

// ── results ─────────────────────────────────────────────────────────────────

/** Largest file accepted out of the result zip; a .trx for thousands of tests is a few MB. */
const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;

/**
 * The files of a zip archive (stored or deflated entries — what the result zip holds). Throws
 * on anything that is not a whole archive. Names are only matched, never used as paths.
 */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  if (zip.length < 22) throw new Error('The test result is not a zip archive.');
  // End of central directory: the last 0x06054b50 within the trailing 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The test result is not a zip archive.');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('The test result zip is damaged.');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeader = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
    // subarray would clamp silently, handing back a truncated .trx as if it were whole.
    if (dataStart + compressedSize > zip.length) throw new Error('The test result zip is damaged.');
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (!name.endsWith('/')) {
      if (method === 0) entries.set(name, Buffer.from(data));
      else if (method === 8) entries.set(name, inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES }));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A character reference as text; one naming no valid code point stays as written. */
const fromCodePoint = (ref: string, code: number) =>
  Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ref;

const decodeXml = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (ref, h) => fromCodePoint(ref, Number.parseInt(h, 16)))
  .replace(/&#(\d+);/g, (ref, d) => fromCodePoint(ref, Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** Per-method outcomes from a VSTest `.trx` document; [] when it is not one. */
export function parseTrxResults(trx: string): SysTestCaseOutcome[] {
  const outcomes: SysTestCaseOutcome[] = [];
  const resultRe = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  for (const m of trx.matchAll(resultRe)) {
    const attrs = m[1];
    const body = m[2] ?? '';
    const name = decodeXml(/\btestName="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const outcome = /\boutcome="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const passed = outcome === 'Passed';
    const raw = /<ErrorInfo>[\s\S]*?<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1];
    let message = raw ? decodeXml(raw).replace(/\s+/g, ' ').trim() : undefined;
    if (!passed && !message && outcome && outcome !== 'Failed') message = `Outcome: ${outcome}`;
    outcomes.push(message ? { name, passed, message } : { name, passed });
  }
  return outcomes;
}

// ── Dataverse calls ─────────────────────────────────────────────────────────

export interface DataverseClient {
  url: string;
  /** Called again on every request, so a long run is not cut off by an expiring token. */
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
}

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

/** Statuses worth asking again for: service-protection throttling and passing server trouble. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 6;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The wait a 429/503 asks for (Retry-After, in seconds), capped; undefined when it names none. */
function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 60_000) : undefined;
}

async function call(client: DataverseClient, method: string, relative: string, init: {
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  formatted?: boolean;
  /**
   * Ask again after a network error or a transient status. Only for requests that are safe to
   * repeat (the polls and the download): repeating a POST could create a second suite or start a
   * second run.
   */
  retryDelayMs?: number;
} = {}): Promise<Response> {
  const label = `${method} ${relative.split('?')[0]}`;
  for (let attempt = 1; ; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await client.getToken()}`,
      'OData-Version': '4.0',
      'OData-MaxVersion': '4.0',
      Accept: 'application/json',
      ...(init.formatted ? { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } : {}),
      ...init.headers,
    };
    const retry = init.retryDelayMs !== undefined && attempt < MAX_ATTEMPTS;
    const backoff = () => Math.min((init.retryDelayMs ?? 0) * 2 ** (attempt - 1), 30_000);
    let response: Response;
    try {
      response = await (client.fetch ?? fetch)(`${client.url}/api/data/v9.2/${relative}`, { method, headers, body: init.body });
    } catch (error: any) {
      if (retry) { await sleep(backoff()); continue; }
      throw new DataverseError(`${label} failed: ${error?.message ?? error}`);
    }
    if (response.ok) return response;
    if (retry && TRANSIENT_STATUS.has(response.status)) {
      await sleep(retryAfterMs(response) ?? backoff());
      continue;
    }
    let detail = '';
    try {
      const json = await response.json() as { error?: { message?: string } };
      detail = json?.error?.message ?? '';
    } catch { /* not JSON */ }
    throw new DataverseError(`${label} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`, response.status);
  }
}

export class DataverseError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const SUITE_SET = 'msprov_unittestsuites';

/**
 * msprov_unittestsuite's own state and status codes (read from the environment's option
 * metadata). Compared as numbers: the formatted labels are in the caller's UI language.
 */
const SUITE_STATE = { active: 0, inactive: 1, completed: 2 } as const;
const SUITE_STATUS_SUCCEEDED = 3;

export interface CloudRunOptions {
  /** Polling interval, first retry delay and overall limit; small values for tests. */
  pollMs?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Status lines for the server log. */
  log?: (line: string) => void;
}

export interface CloudRunResult {
  suiteId: string;
  /** The `.trx` of the run. */
  trx: string;
}

/**
 * Send one test request to the cloud runtime and wait for its results. Throws when the run
 * fails to start or finish; a run whose tests FAIL is a success here (the .trx says so).
 */
export async function runTestRequestInCloud(
  client: DataverseClient,
  fileName: string,
  suiteXml: string,
  options: CloudRunOptions = {},
): Promise<CloudRunResult> {
  const pollMs = options.pollMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  const log = options.log ?? (() => {});

  // 1. The suite row, with the request in its file column.
  const created = await call(client, 'POST', SUITE_SET, {
    body: JSON.stringify({ msprov_unittestsuitename: fileName }),
    headers: { 'Content-Type': 'application/json' },
  });
  const suiteId = /\(([0-9a-f-]{36})\)/i.exec(created.headers.get('OData-EntityId') ?? '')?.[1];
  if (!suiteId) throw new DataverseError('Creating the test suite record returned no id.');
  log(`suite ${suiteId} created`);
  await call(client, 'PATCH', `${SUITE_SET}(${suiteId})/msprov_unittestsuiteconfig`, {
    body: Buffer.from(suiteXml, 'utf8'),
    headers: { 'Content-Type': 'application/octet-stream', 'x-ms-file-name': fileName },
  });

  // 2. Start the run.
  const started = await call(client, 'POST', 'msprov_unittestexecutiononfinopsasync', {
    body: JSON.stringify({
      unittestsuiteentitycollection: [{ '@odata.type': 'Microsoft.Dynamics.CRM.msprov_unittestsuite', msprov_unittestsuiteid: suiteId }],
      verbose: false,
      waitfordebugger: false,
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  const jobId = ((await started.json()) as { asyncoperationid?: string })?.asyncoperationid;
  if (!jobId) throw new DataverseError('Starting the test run returned no asynchronous operation.');
  log(`job ${jobId} started`);

  // 3. The asynchronous operation: statecode 3 is Completed, statuscode 30 Succeeded.
  for (;;) {
    if (Date.now() > deadline) throw new DataverseError(`The test run did not finish in time (job ${jobId}).`);
    const job = await (await call(client, 'GET',
      `asyncoperations(${jobId})?$select=statecode,statuscode,message,friendlymessage`, { formatted: true, retryDelayMs })).json() as Record<string, any>;
    if (job.statecode === 3) {
      if (job.statuscode !== 30) {
        const why = [job.friendlymessage, job.message].filter(Boolean).join(' — ');
        throw new DataverseError(`The cloud runtime could not run the tests (${job[`statuscode${FORMATTED}`] ?? job.statuscode})${why ? `: ${why}` : '.'}`);
      }
      break;
    }
    await sleep(pollMs);
  }

  // 4. The suite row carries the outcome of fetching the results.
  for (;;) {
    if (Date.now() > deadline) throw new DataverseError(`The test results did not arrive in time (suite ${suiteId}).`);
    const suite = await (await call(client, 'GET', `${SUITE_SET}(${suiteId})?$select=statecode,statuscode`, { formatted: true, retryDelayMs })).json() as Record<string, any>;
    const named = (field: string) => suite[`${field}${FORMATTED}`] ?? suite[field] ?? 'unknown';
    if (suite.statecode === SUITE_STATE.completed) {
      if (suite.statuscode !== SUITE_STATUS_SUCCEEDED) {
        throw new DataverseError(`The test suite record ended as ${named('statuscode')}; no results to read.`);
      }
      break;
    }
    if (suite.statecode !== SUITE_STATE.active) throw new DataverseError(`The test suite record ended in state ${named('statecode')}.`);
    await sleep(pollMs);
  }

  // 5. The results.
  const download = await call(client, 'GET', `${SUITE_SET}(${suiteId})/msprov_unittestresult/$value`, {
    headers: { Accept: 'application/octet-stream' },
    retryDelayMs,
  });
  const entries = readZipEntries(Buffer.from(await download.arrayBuffer()));
  const trxName = [...entries.keys()].find(n => n.toLowerCase().endsWith('.trx'));
  if (!trxName) throw new DataverseError('The test results hold no .trx file.');
  return { suiteId, trx: entries.get(trxName)!.toString('utf8') };
}

/** Keep the .trx where the user can open it; best-effort. */
export async function saveTrx(className: string, trx: string): Promise<string | undefined> {
  const file = path.join(os.tmpdir(), `systest-${className}-${Date.now()}.trx`);
  try {
    await fs.writeFile(file, trx, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}
