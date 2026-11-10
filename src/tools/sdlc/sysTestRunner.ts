import { execFile } from 'child_process';
import { parseSysTestXml, type SysTestCaseOutcome } from './sysTestXml.js';
import util from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { getConfigManager } from '../../utils/configManager.js';
import { defaultPackagesRoot } from '../../utils/packagesRoot.js';
import { readAppSetting } from '../../utils/appSettings.js';
import { withOperationLock } from '../../utils/operationLocks.js';
import { wasCreatedThisSession } from '../../workspace/createdArtifactLedger.js';
import { findD365FileOnDisk } from '../../utils/objectFileLookup.js';
import { DEFAULT_DATAVERSE_CLIENT_ID, getDataverseAccessToken, readDataverseSettings } from '../../utils/dataverseAuth.js';
import {
  buildTestSuiteXml,
  type DataverseClient,
  findRuntimeAssembly,
  parseTrxResults,
  readTestClass,
  runTestRequestInCloud,
  saveTrx,
} from './udeSysTest.js';

const execFileAsync = util.promisify(execFile);

/**
 * Guard against shell-injection characters in values that are embedded in
 * execFile argument arrays.  execFile() does NOT use a shell, but embedded
 * newlines or quotes can still corrupt the argument stream on some platforms.
 */
function assertSafePath(value: string, label: string): void {
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a command: ${value}`
    );
  }
}

/** The four settings that decide which database SysTestConsole opens. */
const DATA_ACCESS_KEYS = [
  'DataAccess.Database',
  'DataAccess.SqlUser',
  'DataAccess.SqlPwd',
  'DataAccess.DbServer',
] as const;

export { readAppSetting };

export interface DataAccessDrift {
  key: string;
  /** Never the secret itself — a password is described, not quoted. */
  runner: string;
  aos: string;
}

/**
 * Describe a DataAccess value without leaking it. The password is an encrypted
 * blob hundreds of characters long; what a reader needs to know is whether it
 * is the shipped placeholder, and whether the two files carry the same one.
 */
function describeSetting(key: string, value: string | undefined): string {
  if (value === undefined) return 'absent';
  if (!/pwd|password/i.test(key)) return value === '' ? '(empty)' : `\`${value}\``;
  if (value === '$CREDENTIAL_PLACEHOLDER$') return 'the shipped `$CREDENTIAL_PLACEHOLDER$` — never filled in';
  return value === '' ? '(empty)' : `set (${value.length} chars, not shown)`;
}

/**
 * Compare the test runner's connection settings with the AOS's own.
 *
 * Read-only, and it never returns a secret: the password contributes only
 * "placeholder" / "set" / "differs". Returns undefined when either file cannot
 * be read, so the caller falls back to generic advice rather than inventing a
 * diagnosis from a missing file.
 */
export async function compareSysTestDataAccess(
  packagesRoot: string,
  webConfigPath = path.join(packagesRoot, '..', 'WebRoot', 'web.config'),
  /** The .config of the binary that ran: a versioned SysTestConsole has its own. */
  runnerConfigPath = path.join(packagesRoot, 'Bin', 'SysTestConsole.exe.config'),
): Promise<DataAccessDrift[] | undefined> {
  try {
    const [runnerXml, aosXml] = await Promise.all([
      fs.readFile(runnerConfigPath, 'utf-8'),
      fs.readFile(webConfigPath, 'utf-8'),
    ]);

    const drift: DataAccessDrift[] = [];
    for (const key of DATA_ACCESS_KEYS) {
      const runner = readAppSetting(runnerXml, key);
      const aos = readAppSetting(aosXml, key);
      // A key the AOS does not carry says nothing about the runner's copy.
      if (aos === undefined || runner === aos) continue;
      drift.push({ key, runner: describeSetting(key, runner), aos: describeSetting(key, aos) });
    }
    return drift;
  } catch {
    return undefined;
  }
}

/** `SysTestConsole.exe`, or a versioned `SysTestConsole.17.0.exe`; group 1 is the version. */
const SYSTEST_CONSOLE_RE = /^SysTestConsole((?:\.\d+)+)?\.exe$/i;

/**
 * Every SysTestConsole binary in `binDir`, in the order to try them; empty when there is none.
 *
 * Current platforms ship it named after the test platform it targets — `SysTestConsole.17.0.exe`
 * (#1143) — and an upgraded box keeps the plain `SysTestConsole.exe` of the platform it started on.
 * Seen on a 7.0.7858 dev VM: `SysTestConsole.17.0.exe` at 7.0.7858.111, the same build as xppc.exe,
 * beside a `SysTestConsole.exe` at 7.0.7452.66 left from December 2024. So the highest versioned
 * name comes first, compared as numbers, and the plain name last.
 *
 * Last, not dropped: on another 7.0.7858 VM the versioned one cannot start at all (System.ValueTuple
 * 4.0.3.0 is not in Bin) and its .config is the unconfigured template, while the plain one beside it
 * was configured and runs green. The caller falls back along this list when a runner cannot start.
 */
export async function findSysTestConsoles(binDir: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(binDir);
  } catch { /* unreadable: only the plain name can still be probed */ }
  const found = names
    .map(name => ({ name, version: SYSTEST_CONSOLE_RE.exec(name)?.[1] }))
    .filter((c): c is { name: string; version: string } => !!c.version)
    .map(c => ({ name: c.name, parts: c.version.slice(1).split('.').map(Number) }))
    .sort((a, b) => compareVersionParts(b.parts, a.parts))
    .map(c => path.join(binDir, c.name));
  const plain = path.join(binDir, 'SysTestConsole.exe');
  try {
    await fs.access(plain);
    found.push(plain);
  } catch { /* none */ }
  return found;
}

/** The SysTestConsole to try first in `binDir`, or null when there is none. */
export async function findSysTestConsole(binDir: string): Promise<string | null> {
  return (await findSysTestConsoles(binDir))[0] ?? null;
}

/**
 * Why a SysTestConsole run never got as far as a test, or null when it did (or failed some other
 * way). Only these two are worth retrying with another SysTestConsole: both live in the binary's
 * own .config and Bin, which a second binary does not share.
 */
function runnerStartupFault(error: any): string | null {
  const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join('\n');
  const assembly = /Could not load file or assembly '([^']+?),\s*Version=([\d.]+)/i.exec(output);
  if (assembly) return `${assembly[1]} ${assembly[2]} would not load`;
  const login = /Login failed for user '([^']+)'/i.exec(output);
  if (login) return `its .config could not log in as '${login[1]}'`;
  return null;
}

function compareVersionParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// This handler has no schema of its own — it is reached through a unified
// tool. Tool registration (name, description, inputSchema) lives in
// src/server/toolSchemas/, one file per published tool, aggregated by
// toolSchemas/index.ts. It is NOT in mcpServer.ts; that file only spreads
// the aggregated array into the ListTools response.

/**
 * The red-first commentary — the half of the TDD loop a result line cannot carry.
 *
 * "2/2 passed" is ordinary news for a test that has existed for weeks and a RED
 * FLAG for one written minutes ago: a test that passes the first time it runs has
 * proven nothing about the assertion inside it. The scaffold emits
 * `this.fail('… is not implemented yet.')` in every method precisely so the first
 * run is red, and the failure mode is a developer who deletes those lines while
 * writing the behaviour and never sees a red phase at all.
 *
 * Both signals are derived, not asked for. The session ledger already knows which
 * objects this process created, and the scaffold's own failure text identifies an
 * unwritten assertion — so there is no `expectRed` parameter to publish, nothing
 * for a strict MCP client to drop, and no ListTools bytes spent (headroom at the
 * time of writing: 49 chars of 45,000).
 */
const sawFailingRun = new Set<string>();

/** Test-only: forget which classes have been seen red in this process. */
export function _clearRedPhaseMemory(): void {
  sawFailingRun.clear();
}

export function renderRedPhaseNote(
  className: string,
  outcomes: readonly { name: string; passed: boolean; message?: string }[],
): string {
  if (outcomes.length === 0) return '';
  const key = className.trim().toLowerCase();

  if (outcomes.some(o => !o.passed)) {
    sawFailingRun.add(key);
    const unwritten = outcomes.filter(o => !o.passed && /not implemented yet/i.test(o.message ?? ''));
    if (unwritten.length > 0) {
      return `\n\n🔴 **Red phase confirmed.** ${unwritten.length} of ${outcomes.length} method(s) still carry the ` +
        'scaffold\'s `this.fail(...)` — replace each one with the assertion the test exists for, then run again.';
    }
    // A failure carrying a real assertion message is the assertion doing its job.
    // Saying anything here would be commentary on a result that speaks for itself.
    return '';
  }

  // All green. Whether that deserves a warning depends entirely on what came
  // before it — and getting this wrong was a real defect, found by running the
  // loop rather than by testing it. An all-green run on a session-created class
  // is exactly what the GREEN half of red→green looks like, so warning about it
  // fires on the developer who did the right thing. The warning is only for a
  // class this process created and has NEVER seen fail.
  if (sawFailingRun.has(key)) return '';
  if (wasCreatedThisSession(className)) {
    return `\n\n⚠️ **Every method passed, and \`${className}\` has never failed in this session.** A test that ` +
      'passes the first time it runs has proven nothing about its assertion. Check that each method actually ' +
      'asserts something, then break the behaviour on purpose once and watch this go red.';
  }
  return '';
}

/**
 * Counts, then the failures, then the passes: which test failed and why is the answer being
 * asked for, and the response cap keeps the head of the text. '' when there is nothing to list.
 */
export function renderOutcomeList(outcomes: readonly SysTestCaseOutcome[]): string {
  if (outcomes.length === 0) return '';
  const failed = outcomes.filter(o => !o.passed);
  const passed = outcomes.filter(o => o.passed);
  return `\n\n${passed.length}/${outcomes.length} passed` +
    (failed.length > 0 ? `, ${failed.length} failed.` : '.') +
    '\n\n' + [...failed, ...passed]
    .map(o => `${o.passed ? '✅' : '❌'} ${o.name}${o.message ? ` — ${o.message}` : ''}`)
    .join('\n');
}

const notRun = (text: string) => ({ content: [{ type: 'text', text: `❌ ${text}` }], isError: true });

/** How many base classes up the test methods of a class are looked for. */
const MAX_TEST_BASE_DEPTH = 5;

/** An X++ class or method name. They become file paths here, so nothing else is accepted. */
const XPP_IDENTIFIER = /^[A-Za-z_]\w*$/;

/** For a box wrongly detected as UDE: the setup replies point at UDE-only settings otherwise. */
const NOT_UDE_HINT = '\n\nIf this machine is not a UDE box, set `environment.type` (D365FO_DEV_ENVIRONMENT_TYPE) to ' +
  '"traditional": UDE is detected from the XPP config files in %LOCALAPPDATA%\\Microsoft\\Dynamics365\\XPPConfig.';

/**
 * A test class on a UDE box, run in the cloud runtime (see udeSysTest.ts for the protocol).
 *
 * SysTestConsole cannot be used there at all: it runs tests against a local AOS, and a UDE
 * machine has none — started from the framework Bin it dies with "Failed to obtain app setting
 * from for: Common.HostingEnvironment" before the first test. Visual Studio's test adapter sends
 * UDE tests to the cloud runtime through the environment's Dataverse instead, and so does this.
 *
 * Tests run against the code DEPLOYED to the environment, not the local build, so the reply says
 * which environment ran them and that an undeployed change is not in the result.
 */
async function runSysTestOnUde(
  params: { className: string; testMethod?: string; modelName?: string },
  configManager: ReturnType<typeof getConfigManager>,
) {
  const className = String(params.className ?? '').trim();
  // `Class::method` and `Class.method` are what the results print; accept them as well.
  const focus = params.testMethod?.trim().replace(/^.*(::|\.)/, '') || undefined;
  const fallback = `Until then, run \`${className}\` from Visual Studio Test Explorer and ask the user for the result.`;

  if (!XPP_IDENTIFIER.test(className)) return notRun(`Invalid parameter: className "${className}" is not an X++ class name.`);
  if (focus && !XPP_IDENTIFIER.test(focus)) return notRun(`Invalid parameter: testMethod "${focus}" is not an X++ method name.`);

  const modelName = params.modelName || configManager.getModelName() || await configManager.getAutoDetectedModelName();
  if (!modelName) return notRun('Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.');
  try {
    assertSafePath(modelName, 'modelName');
  } catch (error: any) {
    return notRun(`Invalid parameter: ${error.message}`);
  }

  // The class file names the package, which names the module assembly the runtime loads.
  const classFile = await findD365FileOnDisk('class', className, modelName);
  if (!classFile) {
    return notRun(`Class \`${className}\` was not found in model \`${modelName}\`, so no test ran.\n\n` +
      'Check the class name, or pass modelName when the test class lives in another model.');
  }
  const packageName = path.basename(path.resolve(classFile, '..', '..', '..'));

  // The test methods: the cloud runtime runs only the methods a request lists.
  const own = readTestClass(await fs.readFile(classFile, 'utf-8'));
  if (!own) return notRun(`The declaration of \`${className}\` could not be read, so no test ran.`);
  if (own.isAbstract) return notRun(`\`${className}\` is abstract; SysTest runs only concrete test classes. No test ran.`);
  const methods = new Map(own.methods.map(m => [m.name.toLowerCase(), m]));
  const notes: string[] = [];
  let base = own.extends;
  for (let depth = 0; base && !/^SysTest/i.test(base) && depth < MAX_TEST_BASE_DEPTH; depth++) {
    const baseFile = await findD365FileOnDisk('class', base, modelName);
    const baseClass = baseFile ? readTestClass(await fs.readFile(baseFile, 'utf-8')) : null;
    if (!baseClass) {
      notes.push(`Test methods inherited from \`${base}\` were not looked for: it is not in model \`${modelName}\`.`);
      break;
    }
    // A method the class overrides is already listed under the class's own spelling.
    for (const m of baseClass.methods) if (!methods.has(m.name.toLowerCase())) methods.set(m.name.toLowerCase(), m);
    base = baseClass.extends;
  }

  let selected = [...methods.values()];
  if (focus) {
    selected = selected.filter(m => m.name.toLowerCase() === focus.toLowerCase());
    if (selected.length === 0) {
      const names = [...methods.values()].map(m => m.name).join(', ') || '(none)';
      return notRun(`\`${className}\` has no test method named "${focus}", so no test ran.\n\nIts test methods: ${names}.`);
    }
  }
  const inactive = selected.filter(m => m.inactive);
  const toRun = selected.filter(m => !m.inactive);
  if (inactive.length > 0) {
    notes.push(`Skipped, marked [SysTestInactiveTest]: ${inactive.map(m => m.name).join(', ')}.`);
  }
  if (toRun.length === 0) {
    return notRun(`\`${className}\` has no test method to run, so no test ran.\n\n` +
      'A test method is public, returns void, takes no parameters and is named test… or marked [SysTestMethod].' +
      (notes.length ? `\n\n${notes.join('\n')}` : ''));
  }

  // The built module assembly, under the runtime packages folder the cloud runtime knows it by.
  const runtimeDir = (await configManager.getActiveXppConfig())?.runtimePackagesDirectory;
  if (!runtimeDir) {
    return notRun('The XPP config names no RuntimePackagesDirectory, so the test request cannot name the module ' +
      `assembly. No test ran.\n\n${fallback}${NOT_UDE_HINT}`);
  }
  const assemblyPath = await findRuntimeAssembly(runtimeDir, packageName);
  if (!assemblyPath) {
    return notRun(`Dynamics.AX.${packageName}.dll was not found under ${runtimeDir}. Build the model ` +
      `and deploy it to the environment (build_d365fo_project with deploy: true), then run the tests again. No test ran.`);
  }

  const dataverse = readDataverseSettings();
  if (!dataverse) {
    return notRun('Tests on UDE run in the cloud runtime, which this server reaches through the Dataverse ' +
      'environment the UDE belongs to — and no Dataverse URL is configured. No test ran.\n\n' +
      'Set `environment.dataverseUrl` (D365FO_DATAVERSE_URL) to that environment\'s URL, e.g. ' +
      'https://contoso-dev.crm.dynamics.com — not the Finance and Operations URL. `pac org list` or the Power ' +
      'Platform admin center shows it. Then restart the server. The first run opens a sign-in page in the browser.' +
      `\n\n${fallback}${NOT_UDE_HINT}`);
  }

  // Signed in before the lock is taken: a sign-in can take minutes, and a second run of the same
  // class waiting on the lock should not spend its wait on someone else's browser tab.
  try {
    await getDataverseAccessToken(dataverse);
  } catch (error: any) {
    return notRun(`Signing in to ${dataverse.url} failed: ${error?.message ?? error}\n\nNo test ran. ` +
      'Run the tool again to get a new sign-in page.' +
      (dataverse.clientId === DEFAULT_DATAVERSE_CLIENT_ID
        ? ' If your tenant blocks the default client, set `environment.dataverseClientId` to your own public ' +
          'client (redirect URI http://localhost).'
        : '') +
      `\n\n${fallback}`);
  }

  const { xml, cases } = buildTestSuiteXml(assemblyPath, className, toRun.map(m => m.name), classFile);
  let trx: string;
  try {
    const client: DataverseClient = { url: dataverse.url, getToken: () => getDataverseAccessToken(dataverse) };
    ({ trx } = await withOperationLock(`systest:${modelName}:${className}`, () =>
      runTestRequestInCloud(client, `${packageName}_${className}_${Date.now()}.tsx`, xml, {
        log: line => console.error(`[run_systest_class] ${line}`),
      })));
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (/Timeout waiting for filesystem lock/i.test(message)) {
      return notRun(`Another run of \`${className}\` was still in progress and did not finish in time, so this one ` +
        'did not start. No test ran. Run it again once the other run has reported.');
    }
    return notRun(`The tests could not be run in the cloud runtime of ${dataverse.url}: ${message}\n\n` +
      'No test result came back, and this says nothing about the test class itself. A run that cannot start often ' +
      'means the model is not deployed to the environment (build_d365fo_project with deploy: true deploys it), or ' +
      'the sign-in has no access to it.' +
      `\n\n${fallback}`);
  }

  const resultFile = await saveTrx(className, trx);
  const returned = parseTrxResults(trx);
  if (returned.length === 0) {
    return notRun(`The cloud runtime of ${dataverse.url} finished, but its results name no test. No test result ` +
      `came back for ${cases.length} requested method(s).` + (resultFile ? `\n\nResult file: ${resultFile}` : ''));
  }
  // A requested method missing from the results did not pass, whatever the others did: count
  // it as failed, so a run cut short can never read as green.
  const outcomes: SysTestCaseOutcome[] = [
    ...returned,
    ...cases
      .filter(c => !returned.some(o => o.name.toLowerCase() === c.name.toLowerCase()))
      .map(c => ({ name: c.name, passed: false, message: 'No result came back for this test.' })),
  ];
  const status = outcomes.some(o => !o.passed) ? '❌ Tests FAILED' : '✅ Tests passed';

  return {
    content: [{
      type: 'text',
      text: `${status}\n\nClass: ${className}${focus ? `::${toRun[0].name}` : ''}\nModel: ${modelName}` +
        `\nRan in the cloud runtime of ${dataverse.url}, against the code deployed there — a change that is not ` +
        'deployed yet is not in this result (build_d365fo_project with deploy: true deploys it).' +
        notes.map(n => `\n⚠️ ${n}`).join('') +
        renderOutcomeList(outcomes) +
        renderRedPhaseNote(className, outcomes) +
        (resultFile ? `\n\nResult file: ${resultFile}` : ''),
    }],
  };
}

export const sysTestRunnerTool = async (params: any, _context: any) => {
  const { className, testMethod } = params;
  // Hoisted out of the try: the failure diagnosis in the catch reads the
  // runner's own .config out of this directory, and a diagnosis that cannot
  // find the file falls back to generic advice rather than guessing.
  let packagesRoot = '';
  // The binary that ran, so messages and the .config a diagnosis reads name a
  // versioned SysTestConsole rather than the plain one.
  let runnerName = 'SysTestConsole.exe';
  // A SysTestConsole that could not start, and the one tried after it. Said in
  // every reply, so a run on the plain binary never passes for the versioned one.
  const fallbackNotes: string[] = [];
  const fallbackNote = () => fallbackNotes.map(n => `\n⚠️ ${n}`).join('');
  try {
    const configManager = getConfigManager();
    await configManager.ensureLoaded();

    // Before any Bin lookup: on UDE no SysTestConsole can run, wherever it is found.
    if (await configManager.getDevEnvironmentType() === 'ude') {
      return await runSysTestOnUde(params, configManager);
    }

    const resolvedModelName = params.modelName || configManager.getModelName();
    if (!resolvedModelName) {
      return {
        content: [{ type: 'text', text: '❌ Cannot determine model name.\n\nProvide modelName parameter or set it in .mcp.json.' }],
        isError: true
      };
    }

    packagesRoot = params.packagePath
      || configManager.getPackagePath()
      || defaultPackagesRoot();

    // SysTestConsole.exe is the binary D365FO ships for running SysTest classes from the CLI
    // (`/test:<class> /xml:<file>`). xppbp.exe is the BP checker and cannot run tests.
    // SysTestRunner.exe is a legacy/forward-compat fallback, not observed on real installs.
    const sysTestConsoles = await findSysTestConsoles(path.join(packagesRoot, 'Bin'));
    const sysTestRunnerPath = path.join(packagesRoot, 'Bin', 'SysTestRunner.exe');

    let runnerPath: string;
    if (sysTestConsoles.length > 0) {
      runnerPath = sysTestConsoles[0];
      runnerName = path.basename(runnerPath);
    } else {
      try {
        await fs.access(sysTestRunnerPath);
        runnerPath = sysTestRunnerPath;
      } catch {
        return {
          content: [{ type: 'text', text: `❌ Neither SysTestConsole.exe nor SysTestRunner.exe found in:\n${path.join(packagesRoot, 'Bin')}\n\nNo versioned SysTestConsole.<version>.exe (e.g. SysTestConsole.17.0.exe) either. Make sure PackagesLocalDirectory is correctly configured.` }],
          isError: true
        };
      }
    }

    let args: string[];
    // Validate user-supplied values before embedding them in command arguments.
    try {
      assertSafePath(className, 'className');
      assertSafePath(resolvedModelName, 'modelName');
      assertSafePath(packagesRoot, 'packagesRoot');
      if (testMethod) assertSafePath(testMethod, 'testMethod');
    } catch (validationErr: any) {
      return {
        content: [{ type: 'text', text: `❌ Invalid parameter: ${validationErr.message}` }],
        isError: true,
      };
    }

    let xmlResultPath: string | undefined;
    if (runnerPath === sysTestRunnerPath) {
      // SysTestRunner.exe (legacy/forward-compat fallback): -name:<className>[::testMethod] -packagePath:<path>
      const testTarget = testMethod ? `${className}::${testMethod}` : className;
      args = [
        `-name:${testTarget}`,
        `-packagePath:${packagesRoot}`,
        `-model:${resolvedModelName}`
      ];
    } else {
      // SysTestConsole.exe: /test:<className>[,<className2>,...] /xml:<outFile>
      // No documented per-method filter flag — testMethod is not applicable here.
      //
      // /unattended is what makes this usable from a tool at all. This runner was
      // recorded as blocked ("requires an interactive console session, a platform
      // limitation") and it is not: with /unattended the binary skips the prompt
      // and goes straight to "Executing test(s) ....". Its own /? documents the
      // flag against /devfabric, but it applies here too.
      xmlResultPath = path.join(os.tmpdir(), `systest-${className}-${Date.now()}.xml`);
      args = [`/test:${className}`, `/xml:${xmlResultPath}`, '/unattended'];
    }

    // A SysTestConsole that cannot start (an assembly its Bin lacks, a .config never
    // filled in for this machine) hands over to the next one; any other failure is
    // the answer and is not retried.
    let stdout = '';
    let stderr = '';
    let xmlResult = '';
    const readXmlResult = async () => {
      if (!xmlResultPath) return '';
      try {
        return await fs.readFile(xmlResultPath, 'utf8');
      } catch {
        return ''; // Best-effort — fall back to stdout/stderr below.
      }
    };
    for (let attempt = 0; ; attempt++) {
      console.error(`[run_systest_class] Running: "${runnerPath}" ${args.join(' ')}`);
      try {
        ({ stdout, stderr } = await withOperationLock(
          `systest:${resolvedModelName}:${className}`,
          () => execFileAsync(runnerPath, args, {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 300_000, // 5 minutes
            windowsHide: true,
          }),
        ));
        break;
      } catch (error: any) {
        // SysTestConsole exits non-zero when a test FAILS. A run that wrote its
        // results is a finished run with red tests, not a runner error. The catch
        // below never reads the XML, so it would report only the raw log.
        xmlResult = await readXmlResult();
        if (parseSysTestXml(xmlResult).length > 0) {
          stdout = error?.stdout ?? '';
          stderr = error?.stderr ?? '';
          break;
        }
        const next = sysTestConsoles[attempt + 1];
        const fault = next && runnerPath === sysTestConsoles[attempt] ? runnerStartupFault(error) : null;
        if (!fault) throw error;
        fallbackNotes.push(`${runnerName} could not start (${fault}), so ${path.basename(next)} ran instead.`);
        runnerPath = next;
        runnerName = path.basename(next);
      }
    }

    if (!xmlResult) xmlResult = await readXmlResult();

    const output = [stdout, stderr, xmlResult].filter(Boolean).join('\n').trim();

    // The XML document the runner writes is authoritative and per METHOD. The
    // regex fallback below reads the combined stdout, where the word "error" in a
    // test name is enough to report a green run as failed.
    const outcomes = parseSysTestXml(xmlResult);
    const failedOutcomes = outcomes.filter(o => !o.passed);
    const hasFailed = outcomes.length > 0
      ? failedOutcomes.length > 0
      : /failed|error|exception/i.test(output);
    const passed = outcomes.length > 0
      ? failedOutcomes.length === 0
      : /passed|success/i.test(output);

    const status = hasFailed ? '❌ Tests FAILED' : passed ? '✅ Tests passed' : '⚠️ Tests completed (check output)';
    const methodNote = testMethod && runnerPath !== sysTestRunnerPath
      ? `\n⚠️ testMethod="${testMethod}" was requested but ${runnerName} has no per-method filter — the whole class ran.`
      : '';

    const perMethod = renderOutcomeList(outcomes);
    // The document itself is rendered above, so it is named rather than repeated:
    // what is shown at the end is the console log, plus the document only when it
    // could not be read into results.
    const resultFileNote = outcomes.length > 0 ? `\n\nResult file: ${xmlResultPath}` : '';
    const displayOutput = (outcomes.length > 0 ? [stdout, stderr] : [stdout, stderr, xmlResult])
      .filter(Boolean).join('\n').trim();

    // A test method the caller asked about that never appears in the results is
    // worth saying out loud: a misspelt name otherwise reads as a clean run.
    const focus = testMethod?.trim();
    const focusNote = focus && outcomes.length > 0 && !outcomes.some(o => o.name.toLowerCase().includes(focus.toLowerCase()))
      ? `\n\n⚠️ No test named "${focus}" ran. Check the spelling against the list above.`
      : '';

    const redPhaseNote = renderRedPhaseNote(className, outcomes);

    return {
      content: [{
        type: 'text',
        text: `${status}\n\nClass: ${className}` +
          (testMethod && runnerPath === sysTestRunnerPath ? `::${testMethod}` : '') +
          `\nModel: ${resolvedModelName}` +
          fallbackNote() +
          methodNote +
          perMethod +
          focusNote +
          redPhaseNote +
          resultFileNote +
          `\n\n${displayOutput || '(no output)'}`
      }]
    };
  } catch (error: any) {
    console.error('Error running test:', error);
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    const runnerConfigName = `${runnerName}.config`;
    // What ran before the runner that failed: the reply would otherwise blame only the last one.
    const shownOutput = (fallbackNotes.length ? `${fallbackNote().slice(1)}\n\n` : '') + output;

    // A binding redirect that names a version the install does not have. Seen on
    // 10.0.4x: SysTestConsole.exe.config redirects Microsoft.ApplicationInsights
    // to 2.22.0.997 while Bin ships 2.23.0.0, so the telemetry logger the runner
    // touches on its way into ExecuteTest throws before a single test runs. The
    // message names an assembly and no test, which reads like a broken test model.
    const bindingFailure = /Could not load file or assembly '([^']+?),\s*Version=([\d.]+)/i.exec(output);
    if (bindingFailure) {
      const [, assembly, wanted] = bindingFailure;
      // Two different faults wear the same sentence. A VERSION mismatch means the
      // DLL is there and the redirect points elsewhere; a MISSING file means the
      // redirect is right and the assembly was never copied into Bin. The fixes
      // are not the same, so the message must not average them.
      const versionMismatch = /manifest definition does not match|0x80131040/i.test(output);
      const missingFile = /cannot find the file specified|FileNotFoundException/i.test(output);
      if (versionMismatch || missingFile) {
        const diagnosis = versionMismatch
          ? `PackagesLocalDirectory\\Bin\\${runnerConfigName} redirects ${assembly} to ${wanted}, ` +
            'while the DLL shipped next to it is a different version. Read the version actually ' +
            'present and point the redirect at it:\n' +
            `  [Reflection.AssemblyName]::GetAssemblyName("<PackagesLocalDirectory>\\Bin\\${assembly}.dll").Version\n` +
            '(the ASSEMBLY version, not the file version — they differ)'
          : `${assembly} ${wanted} is not in PackagesLocalDirectory\\Bin at all. The redirect is fine; ` +
            'the file was never copied there. Other copies usually exist in the install:\n' +
            `  Get-ChildItem "<PackagesLocalDirectory>" -Filter ${assembly}.dll -Recurse -Depth 4\n` +
            'Copying the matching version into Bin is what makes the runner start.';
        return {
          content: [{
            type: 'text',
            text:
              `❌ The test runner could not start: ${assembly} ${wanted}.\n\n` +
              'No test ran, and nothing is wrong with the test class — this is an assembly problem in ' +
              `the PLATFORM install, not in the model.\n\n${diagnosis}\n\n` +
              'Either fix touches the platform installation, so make it deliberately and keep a backup. ' +
              'Until then the tests still run from Visual Studio Test Explorer, which does not go ' +
              'through this binary.\n\n' + shownOutput,
          }],
          isError: true,
        };
      }
    }

    // The runner got as far as the database and could not log in. Everything about
    // the model, the test and the binary is fine at this point; the fault is in the
    // connection SysTestConsole opened, which no change to the test can fix.
    //
    // Two faults wear this same sentence, and they are not fixed the same way:
    // a credential that genuinely stopped working, and — far more often — a
    // SysTestConsole.exe.config that was never configured for this machine at
    // all. The shipped template carries `$CREDENTIAL_PLACEHOLDER$` for the
    // password and its own guesses for the database, user and server; the AOS
    // web.config beside it holds the real four. On this VM every one of the four
    // differed, and "Login failed for user 'AOSUser'" was read as a rotated
    // password for weeks when nothing had rotated. So compare them and say which.
    const sqlLogin = /Login failed for user '([^']+)'/i.exec(output);
    if (sqlLogin) {
      const drift = packagesRoot
        ? await compareSysTestDataAccess(packagesRoot, undefined, path.join(packagesRoot, 'Bin', runnerConfigName))
        : undefined;
      const diagnosis = drift?.length
        ? 'The runner\'s own configuration does not match this machine\'s AOS. ' +
          `\`Bin\\${runnerConfigName}\` disagrees with \`WebRoot\\web.config\` on ` +
          `${drift.length} of the four DataAccess settings:\n\n` +
          drift.map(d => `  • \`${d.key}\` — runner: ${d.runner}, AOS: ${d.aos}`).join('\n') +
          '\n\nThat is a template that was never filled in for this install, not a credential that ' +
          `stopped working. Copy the four values from web.config into ${runnerConfigName} ` +
          '(keep a backup beside it). It touches the PLATFORM install, so make it deliberately — ' +
          'and note that the password there is an encrypted blob: copy it verbatim, do not retype it.'
        : 'SysTestConsole opens the AOS connection itself, using its own configuration in ' +
          `\`Bin\\${runnerConfigName}\`. Compare its DataAccess.Database / SqlUser / SqlPwd / ` +
          'DbServer against `WebRoot\\web.config`: the shipped template ships a placeholder password ' +
          'and its own guesses for the rest, and a mismatch there reads exactly like a rotated ' +
          'credential. If they already agree, the login itself is the problem — check that SQL Server ' +
          'still has it and that the AOS service account can decrypt the stored password.';

      return {
        content: [{
          type: 'text',
          text:
            `❌ The test runner reached the database and could not log in as '${sqlLogin[1]}'.\n\n` +
            'No test ran, and nothing is wrong with the test class or the model.\n\n' +
            `${diagnosis}\n\n` +
            'Until then the tests still run from Visual Studio Test Explorer, which uses the ' +
            'developer session\'s own connection and does not go through this binary.\n\n' + shownOutput,
        }],
        isError: true,
      };
    }

    if (/WaitForDebugger|Cannot read keys when/i.test(output)) {
      return {
        content: [{
          type: 'text',
          text: `❌ ${runnerName} stopped at its debugger-attach prompt (Console.ReadKey).\n\n` +
            'This tool already passes /unattended, which is what normally skips that prompt. If it ' +
            'still appears, run the test from an interactive RDP/console session on the dev VM, or ' +
            'from Visual Studio Test Explorer.\n\n' + shownOutput,
        }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: '❌ Tests failed:\n\n' + shownOutput }],
      isError: true
    };
  }
};
