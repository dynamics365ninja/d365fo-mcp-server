import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  buildTestSuiteXml,
  findRuntimeAssembly,
  parseTrxResults,
  readTestClass,
  readZipEntries,
  runTestRequestInCloud,
  type DataverseClient,
} from '../../src/tools/sdlc/udeSysTest';

/** An AxClass document with the given declaration and methods. */
function axClass(declaration: string, methods: Record<string, string>): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance">',
    '\t<Name>ContosoInvoiceTest</Name>',
    '\t<SourceCode>',
    `\t\t<Declaration><![CDATA[\n${declaration}\n]]></Declaration>`,
    '\t\t<Methods>',
    ...Object.entries(methods).map(([name, source]) =>
      `\t\t\t<Method>\n\t\t\t\t<Name>${name}</Name>\n\t\t\t\t<Source><![CDATA[\n${source}\n]]></Source>\n\t\t\t</Method>`),
    '\t\t</Methods>',
    '\t</SourceCode>',
    '</AxClass>',
  ].join('\n');
}

describe('readTestClass', () => {
  const xml = axClass('public final class ContosoInvoiceTest extends ContosoTestBase\n{\n}', {
    testPosting: '    public void testPosting()\n    {\n    }',
    ValidatesTotals: '    [SysTestMethod]\n    public void ValidatesTotals()\n    {\n    }',
    testRetired: '    [SysTestMethod, SysTestInactiveTest]\n    public void testRetired()\n    {\n    }',
    testHelper: '    private void testHelper()\n    {\n    }',
    testWithArgument: '    public void testWithArgument(int _n)\n    {\n    }',
    testReturnsValue: '    public boolean testReturnsValue()\n    {\n        return true;\n    }',
    testStatic: '    public static void testStatic()\n    {\n    }',
    setUp: '    public void setUp()\n    {\n        super();\n    }',
    testNoModifier: '    void testNoModifier()\n    {\n    }',
    commentedAttribute: '    // [SysTestMethod]\n    public void commentedAttribute()\n    {\n    }',
  });

  it('lists the methods SysTest runs, by its own rules', () => {
    const info = readTestClass(xml)!;
    expect(info.methods.map(m => m.name)).toEqual(['testPosting', 'ValidatesTotals', 'testRetired', 'testNoModifier']);
  });

  it('marks [SysTestInactiveTest] methods instead of dropping them', () => {
    const info = readTestClass(xml)!;
    expect(info.methods.find(m => m.name === 'testRetired')?.inactive).toBe(true);
    expect(info.methods.find(m => m.name === 'testPosting')?.inactive).toBe(false);
  });

  it('reads the base class and abstractness from the declaration', () => {
    expect(readTestClass(xml)).toMatchObject({ name: 'ContosoInvoiceTest', extends: 'ContosoTestBase', isAbstract: false });
    const abstractXml = axClass('abstract class ContosoTestBase extends SysTestCase\n{\n}', {});
    expect(readTestClass(abstractXml)).toMatchObject({ isAbstract: true, extends: 'SysTestCase', methods: [] });
  });

  it('sees the attributes below a doc comment that mentions the method', () => {
    const info = readTestClass(axClass('public class ContosoInvoiceTest extends SysTestCase\n{\n}', {
      testRetired: '    /// Old variant of testRetired(); kept for reference.\n' +
        '    [SysTestInactiveTest]\n    public void testRetired()\n    {\n    }',
      checksTotals: '    /// Runs checksTotals() against USMF.\n    [SysTestMethod]\n    public void checksTotals()\n    {\n    }',
    }))!;

    expect(info.methods).toEqual([
      { name: 'testRetired', inactive: true },
      { name: 'checksTotals', inactive: false },
    ]);
  });

  it('returns null when there is no declaration to read', () => {
    expect(readTestClass('<AxClass><Name>X</Name></AxClass>')).toBeNull();
  });
});

describe('buildTestSuiteXml', () => {
  const ASSEMBLY = 'C:\\Runtime\\ZZZZ__Metadata\\ContosoExt\\bin\\Dynamics.AX.ContosoExt.dll';

  it('lists every method under the names the results come back with', () => {
    const { xml, cases } = buildTestSuiteXml(ASSEMBLY, 'ContosoInvoiceTest', ['testPosting', 'testTotals'], 'C:\\src\\ContosoInvoiceTest.xml');

    expect(cases.map(c => c.name)).toEqual(['ContosoInvoiceTest.testPosting', 'ContosoInvoiceTest.testTotals']);
    expect(xml).toContain(`<AssemblyPath>${ASSEMBLY}</AssemblyPath>`);
    expect(xml).toContain('<RunAll>false</RunAll>');
    expect(xml).toContain('<FullyQualifiedName>Dynamics.AX.Application.ContosoInvoiceTest.testTotals</FullyQualifiedName>');
    expect(xml).toContain('<TestFramework>xpptest</TestFramework>');
    for (const c of cases) {
      expect(c.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(xml).toContain(`<TestKey>${c.key}</TestKey>`);
    }
  });

  it('escapes what it embeds', () => {
    const { xml } = buildTestSuiteXml('C:\\R&D\\Dynamics.AX.ContosoExt.dll', 'ContosoTest', ['testA'], 'C:\\<src>');
    expect(xml).toContain('C:\\R&amp;D\\');
    expect(xml).toContain('C:\\&lt;src&gt;');
  });
});

describe('findRuntimeAssembly', () => {
  it('finds a custom package below one of the runtime folder entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ude-runtime-'));
    try {
      const bin = path.join(root, 'ZZZZ__Metadata', 'ContosoExt', 'bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.mkdir(path.join(root, 'PackagesLocalDirectory'));
      await fs.writeFile(path.join(bin, 'Dynamics.AX.ContosoExt.dll'), '');

      expect(await findRuntimeAssembly(root, 'ContosoExt')).toBe(path.join(bin, 'Dynamics.AX.ContosoExt.dll'));
      expect(await findRuntimeAssembly(root, 'ContosoCore')).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns null for a runtime folder that does not exist', async () => {
    expect(await findRuntimeAssembly(path.join(os.tmpdir(), 'no-such-runtime-folder'), 'ContosoExt')).toBeNull();
  });
});

/** A zip archive holding the given files, deflated or stored. */
function zip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

describe('readZipEntries', () => {
  it('reads deflated and stored entries', () => {
    for (const deflate of [true, false]) {
      const entries = readZipEntries(zip({ 'run.trx': '<TestRun/>', 'run.driver.log': 'ok' }, deflate));
      expect(entries.get('run.trx')?.toString()).toBe('<TestRun/>');
      expect(entries.get('run.driver.log')?.toString()).toBe('ok');
    }
  });

  it('refuses something that is not a zip', () => {
    expect(() => readZipEntries(Buffer.from('<html>error page</html>'))).toThrow(/not a zip/);
    expect(() => readZipEntries(Buffer.alloc(3))).toThrow(/not a zip/);
  });

  it('refuses a truncated archive instead of returning a cut-off file', () => {
    const whole = zip({ 'run.trx': '<TestRun>'.padEnd(400, 'x') }, false);
    // Move the central directory and end record forward over half of the entry's data.
    const end = whole.subarray(whole.length - 22);
    const centralSize = end.readUInt32LE(12);
    const central = whole.subarray(whole.length - 22 - centralSize, whole.length - 22);
    const cut = Buffer.concat([whole.subarray(0, 30 + 'run.trx'.length + 200), central, end]);
    cut.writeUInt32LE(30 + 'run.trx'.length + 200, cut.length - 22 + 16);

    expect(() => readZipEntries(cut)).toThrow(/damaged/);
  });
});

/** A .trx in the shape the cloud runtime returns (VSTest's TeamTest 2010 schema). */
const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" name="ContainerAdministrator@AOS1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="a" testId="11111111-1111-1111-1111-111111111111" testName="ContosoInvoiceTest.testTotals" computerName="AOS1" duration="00:00:00.1720000" outcome="Failed">
      <Output>
        <ErrorInfo>
          <Message>&#xD;
Assertion failed! (Expected: True; Actual: False) </Message>
          <StackTrace>   at Dynamics.AX.Application.SysTestAssert.fail()</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult executionId="b" testId="22222222-2222-2222-2222-222222222222" testName="ContosoInvoiceTest.testPosting" outcome="Passed" />
    <UnitTestResult executionId="c" testId="33333333-3333-3333-3333-333333333333" testName="ContosoInvoiceTest.testTimeout" outcome="Timeout"></UnitTestResult>
  </Results>
  <ResultSummary outcome="Failed"><Counters total="3" executed="3" passed="1" failed="1" /></ResultSummary>
</TestRun>`;

describe('parseTrxResults', () => {
  it('reads each method with its outcome and failure message', () => {
    expect(parseTrxResults(TRX)).toEqual([
      { name: 'ContosoInvoiceTest.testTotals', passed: false, message: 'Assertion failed! (Expected: True; Actual: False)' },
      { name: 'ContosoInvoiceTest.testPosting', passed: true },
      { name: 'ContosoInvoiceTest.testTimeout', passed: false, message: 'Outcome: Timeout' },
    ]);
  });

  it('leaves a character reference that names no character as written', () => {
    const [outcome] = parseTrxResults(
      '<UnitTestResult testName="ContosoTest.testA" outcome="Failed"><Output><ErrorInfo><Message>bad &#x110000; &#65; ok</Message></ErrorInfo></Output></UnitTestResult>');
    expect(outcome.message).toBe('bad &#x110000; A ok');
  });

  it('returns [] for a document with no results', () => {
    expect(parseTrxResults('<TestRun><Results/></TestRun>')).toEqual([]);
  });
});

describe('runTestRequestInCloud', () => {
  const SUITE = '0f0f0f0f-0000-0000-0000-000000000001';
  const JOB = '0f0f0f0f-0000-0000-0000-000000000002';
  const URL = 'https://contoso-dev.crm.dynamics.com';
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

  /** A fake Web API: answers each request in turn and records what was asked. */
  function fakeDataverse(jobStates: Record<string, unknown>[], suiteStates: Record<string, unknown>[], result = zip({ 'r.trx': TRX })) {
    const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, headers: init.headers as Record<string, string>, body: init.body });
      const rel = url.slice(`${URL}/api/data/v9.2/`.length);
      if (method === 'POST' && rel === 'msprov_unittestsuites') {
        return new Response(null, { status: 204, headers: { 'OData-EntityId': `${URL}/api/data/v9.2/msprov_unittestsuites(${SUITE})` } });
      }
      if (method === 'PATCH') return new Response(null, { status: 204 });
      if (method === 'POST' && rel === 'msprov_unittestexecutiononfinopsasync') return json({ asyncoperationid: JOB });
      // The last state repeats: a job that stays In Progress keeps answering so.
      if (rel.startsWith(`asyncoperations(${JOB})`)) return json(jobStates.length > 1 ? jobStates.shift() : jobStates[0]);
      if (rel.startsWith(`msprov_unittestsuites(${SUITE})?`)) return json(suiteStates.shift());
      if (rel === `msprov_unittestsuites(${SUITE})/msprov_unittestresult/$value`) return new Response(result, { status: 200 });
      return json({ error: { message: `unexpected ${method} ${rel}` } }, { status: 400 });
    }) as unknown as typeof fetch;
    const client: DataverseClient = { url: URL, getToken: async () => 'token-value', fetch: fetchImpl };
    return { client, calls };
  }

  // msprov_unittestsuite: statecode 0 Active / 2 Completed, statuscode 3 Succeeded / 4 Failed.
  // The labels are in the caller's UI language, so the ones here are deliberately not English.
  const label = '@OData.Community.Display.V1.FormattedValue';
  const ACTIVE = { statecode: 0, [`statecode${label}`]: 'Aktivní', statuscode: 1 };
  const DONE = { statecode: 2, [`statecode${label}`]: 'Dokončeno', statuscode: 3, [`statuscode${label}`]: 'Úspěch' };

  it('uploads the request, starts the run, waits for both and returns the .trx', async () => {
    const { client, calls } = fakeDataverse(
      [{ statecode: 1, statuscode: 20 }, { statecode: 3, statuscode: 30 }],
      [ACTIVE, DONE],
    );

    const result = await runTestRequestInCloud(client, 'ContosoExt_ContosoInvoiceTest.tsx', '<TestSuite/>', { pollMs: 1 });

    expect(result).toEqual({ suiteId: SUITE, trx: TRX });
    const upload = calls.find(c => c.method === 'PATCH')!;
    expect(upload.url).toContain(`msprov_unittestsuites(${SUITE})/msprov_unittestsuiteconfig`);
    expect(upload.headers['x-ms-file-name']).toBe('ContosoExt_ContosoInvoiceTest.tsx');
    const start = calls.find(c => c.url.endsWith('msprov_unittestexecutiononfinopsasync'))!;
    expect(JSON.parse(String(start.body)).unittestsuiteentitycollection[0].msprov_unittestsuiteid).toBe(SUITE);
    expect(calls.every(c => c.headers.Authorization === 'Bearer token-value')).toBe(true);
  });

  it('reports a suite record that ended Failed, by its code and in the user\'s language', async () => {
    const { client } = fakeDataverse(
      [{ statecode: 3, statuscode: 30 }],
      [{ statecode: 2, statuscode: 4, [`statuscode${label}`]: 'Chyba' }],
    );

    await expect(runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { pollMs: 1 }))
      .rejects.toThrow('The test suite record ended as Chyba; no results to read.');
  });

  it('rides out throttling and passing server errors while polling, and never repeats a POST', async () => {
    const { client, calls } = fakeDataverse([{ statecode: 3, statuscode: 30 }], [DONE]);
    const real = client.fetch!;
    let polls = 0;
    client.fetch = (async (url: string, init: RequestInit) => {
      if (url.includes('asyncoperations(') && polls++ < 2) {
        return polls === 1
          ? new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
          : Promise.reject(new TypeError('fetch failed'));
      }
      return real(url, init);
    }) as typeof fetch;

    const result = await runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { pollMs: 1, retryDelayMs: 1 });

    expect(result.trx).toBe(TRX);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(2);
  });

  it('backs off on a transient status that names no Retry-After', async () => {
    const { client } = fakeDataverse([{ statecode: 3, statuscode: 30 }], [DONE]);
    const real = client.fetch!;
    let polls = 0;
    client.fetch = (async (url: string, init: RequestInit) => {
      if (url.includes('asyncoperations(') && polls++ < 2) return new Response(null, { status: 503 });
      return real(url, init);
    }) as typeof fetch;

    const started = Date.now();
    await runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { pollMs: 1, retryDelayMs: 60 });

    // 60 ms, then 120 ms. A missing header must not read as "Retry-After: 0".
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('does not retry a refused POST', async () => {
    let posts = 0;
    const client: DataverseClient = {
      url: URL,
      getToken: async () => 't',
      fetch: (async () => { posts++; return new Response(null, { status: 503 }); }) as unknown as typeof fetch,
    };

    await expect(runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { retryDelayMs: 1 })).rejects.toThrow(/HTTP 503/);
    expect(posts).toBe(1);
  });

  it('gives up polling after repeated transient errors', async () => {
    const { client } = fakeDataverse([{ statecode: 3, statuscode: 30 }], [DONE]);
    const real = client.fetch!;
    client.fetch = (async (url: string, init: RequestInit) =>
      url.includes('asyncoperations(') ? new Response(null, { status: 502 }) : real(url, init)) as typeof fetch;

    await expect(runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { pollMs: 1, retryDelayMs: 1 }))
      .rejects.toThrow(/asyncoperations\(.*\) failed: HTTP 502/);
  });

  it('reports a job the cloud runtime failed, with its message', async () => {
    const { client } = fakeDataverse(
      [{ statecode: 3, statuscode: 31, 'statuscode@OData.Community.Display.V1.FormattedValue': 'Failed', friendlymessage: 'statusCode = FailedDependency' }],
      [],
    );

    await expect(runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { pollMs: 1 }))
      .rejects.toThrow(/could not run the tests \(Failed\): statusCode = FailedDependency/);
  });

  it('gives up when the run does not finish in time', async () => {
    const { client } = fakeDataverse([{ statecode: 1, statuscode: 20 }], []);

    await expect(runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>', { pollMs: 1, timeoutMs: 20 }))
      .rejects.toThrow(/did not finish in time/);
  });

  it('names the HTTP status and the Web API message of a refused call', async () => {
    const client: DataverseClient = {
      url: URL,
      getToken: async () => 't',
      fetch: (async () => json({ error: { message: 'Principal user is missing prvCreatemsprov_unittestsuite' } }, { status: 403 })) as unknown as typeof fetch,
    };

    await expect(runTestRequestInCloud(client, 'x.tsx', '<TestSuite/>'))
      .rejects.toThrow(/HTTP 403 — Principal user is missing prvCreatemsprov_unittestsuite/);
  });
});
