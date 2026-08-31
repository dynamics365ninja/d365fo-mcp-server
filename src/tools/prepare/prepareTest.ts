/**
 * prepare(mode="test") — everything needed to write a SysTest for a class,
 * before writing it.
 *
 * The other two modes answer "how do I change this" and "how do I create this".
 * This one answers "how do I TEST this", and it exists because the answer was
 * the part of the loop the server could not give: the method list to write tests
 * for lives in the index, the tests that already cover the target live in the
 * index too, and the one thing that reliably breaks a first test run — the model
 * not referencing TestEssentials — is visible in the descriptor and nowhere else
 * until the build fails.
 *
 * It deliberately states the RED-first order. A test written after the code, that
 * passes on its first run, has proven nothing about the assertion inside it.
 */
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

import type { XppServerContext } from '../../types/context.js';
import { createProvenanceToken } from '../../utils/provenanceStore.js';
import { getConfigManager } from '../../utils/configManager.js';
import { lookupSymbolsNocase } from '../../utils/symbolLookup.js';

const prepareTestArgsSchema = z.object({
  goal: z.string().optional(),
  objectName: z.string().min(1, 'objectName (the class or table under test) is required'),
  methodName: z.string().optional(),
  modelName: z.string().optional(),
}).passthrough();

interface ClassMember {
  name: string;
  signature?: string;
  visibility?: string;
}

/**
 * Is the target a class or a table?
 *
 * It decides the whole answer: a table's rules run on a BUFFER and report through
 * the infolog, so `new X()` and "expect an exception" are the wrong shape for
 * them. The distinction used to be unaskable here — this mode resolved classes
 * only — which left the most-requested X++ task in real sessions (a validateWrite
 * CoC) with no red-first path through the server at all.
 */
function targetKind(context: XppServerContext, name: string): 'class' | 'table' | 'unknown' {
  try {
    const db = context.symbolIndex.getReadDb();
    const hit = lookupSymbolsNocase(db, name, { types: ['class', 'table'], limit: 1 })[0];
    if (hit?.type === 'table' || hit?.type === 'class') return hit.type;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Public/protected instance and static methods of the target, from the index. */
function targetMethods(context: XppServerContext, className: string): ClassMember[] {
  try {
    const db = context.symbolIndex.getReadDb();
    // One `symbols` table holds every kind; a method row carries its owner in
    // parent_name. There is no is_static column — the modifier is in `signature`.
    //
    // No COLLATE NOCASE on parent_name. The index is on the column's BINARY
    // collation, so a NOCASE comparison cannot use it and the query degrades to a
    // full scan of a 2.5 GB table: measured 74 s cold and 2.4–6.9 s warm, versus
    // ~1 ms with the plain equality below. The case-insensitive half is delegated
    // to lookupSymbolsNocase, which resolves the class's canonical spelling first.
    const read = db.prepare(
      `SELECT name, signature, visibility
         FROM symbols
        WHERE type = 'method' AND parent_name = ?
        ORDER BY name
        LIMIT 60`,
    );
    let rows = read.all(className) as Array<{ name: string; signature?: string; visibility?: string }>;
    if (rows.length === 0) {
      // Both kinds: a table's methods hang off parent_name exactly like a class's,
      // and resolving only classes here is what hid table targets from this mode.
      const canonical = lookupSymbolsNocase(db, className, { types: ['class', 'table'], limit: 1 })[0]?.name;
      if (canonical && canonical !== className) {
        rows = read.all(canonical) as Array<{ name: string; signature?: string; visibility?: string }>;
      }
    }
    // `signature` holds the return type and parameters, NOT the modifiers
    // ("void assertExpectedInfoLogMessage(str _infoMessage, …)"), so static vs
    // instance cannot be read here and is not claimed. get_object_info answers it
    // when the distinction matters.
    return rows.map(r => ({ name: r.name, signature: r.signature, visibility: r.visibility }));
  } catch {
    return [];
  }
}

/** Classes that look like tests and mention the target — the coverage that exists. */
function existingTests(context: XppServerContext, className: string): string[] {
  try {
    const db = context.symbolIndex.getReadDb();
    const rows = db.prepare(
      `SELECT DISTINCT name
         FROM symbols
        WHERE type = 'class'
          AND (name LIKE ? OR name LIKE ?)
        ORDER BY name
        LIMIT 10`,
    ).all(`${className}Test%`, `%Test${className}%`) as Array<{ name: string }>;
    return rows.map(r => r.name);
  } catch {
    return [];
  }
}

/** Does the model that will hold the test reference TestEssentials? */
function testEssentialsReferenced(modelName: string | undefined): boolean | null {
  if (!modelName) return null;
  try {
    const packages = getConfigManager().getPackagePath();
    if (!packages) return null;
    const descriptorDir = path.join(packages, modelName, 'Descriptor');
    if (!fs.existsSync(descriptorDir)) return null;
    for (const file of fs.readdirSync(descriptorDir).filter(f => f.endsWith('.xml'))) {
      const xml = fs.readFileSync(path.join(descriptorDir, file), 'utf8');
      if (/<d2p1:string>TestEssentials<\/d2p1:string>/i.test(xml)) return true;
    }
    return false;
  } catch {
    return null;
  }
}

export async function prepareTestTool(request: unknown, context: XppServerContext): Promise<unknown> {
  const raw = (request as { params?: { arguments?: unknown } })?.params?.arguments ?? request;
  const parsed = prepareTestArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          '❌ prepare(mode="test") needs the class or TABLE under test:\n' +
          '  prepare(mode="test", objectName="ConSalesCalculator", goal="cover the discount rules")\n' +
          '  prepare(mode="test", objectName="CustTable.validateWrite")  — a table method, dotted form\n' +
          '  Optional: methodName (focus on one method), modelName (the model that will hold the test).',
      }],
    };
  }

  const { goal, objectName, methodName, modelName } = parsed.data;
  // "CustTable.validateWrite" is how a developer names the thing under test, and
  // how real sessions asked for it. Split it rather than failing to resolve it.
  const dotted = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(objectName.trim());
  const target = (dotted ? dotted[1] : objectName).trim();
  const testClass = `${target}Test`;

  const kind = targetKind(context, target);
  const methods = targetMethods(context, target);
  const focus = (methodName ?? dotted?.[2])?.trim();
  // Lifecycle and serialisation members are not what a unit test pins down.
  const skip = new Set(['new', 'finalize', 'typenew', 'pack', 'unpack', 'classdeclaration']);
  const testable = methods.filter(m => !skip.has(m.name.toLowerCase()));
  const suggested = (focus ? methods.filter(m => m.name.toLowerCase() === focus.toLowerCase()) : testable)
    .filter(m => (m.visibility ?? 'public').toLowerCase() !== 'private')
    .slice(0, 8);

  const tests = existingTests(context, target);
  const model = modelName ?? getConfigManager().getModelName() ?? undefined;
  const hasTestEssentials = testEssentialsReferenced(model);

  const token = createProvenanceToken({
    goal: goal ?? `unit tests for ${target}`,
    objectName: target,
    objectType: kind === 'table' ? 'table' : 'class',
    proposedName: testClass,
  });

  const lines: string[] = [];
  lines.push(`# prepare(test) — ${target}`);
  lines.push('');
  lines.push(`**Test class:** \`${testClass} extends SysTestCase\` (the platform's own convention: <Target>Test).`);
  lines.push('');

  if (methods.length === 0) {
    lines.push(`⚠️ \`${target}\` is not in the symbol index as a class or a table. Check the name, or ` +
      'run `update_symbol_index` if it was written outside this server. The rest of this answer is generic.');
  } else {
    lines.push(`**Methods worth a test** (${methods.length} found on the ${kind === 'unknown' ? 'target' : kind}` +
      `${focus ? `, focused on \`${focus}\`` : ''}):`);
    for (const m of suggested) {
      lines.push(`  • \`${m.name}\`${m.signature ? ` — ${m.signature}` : ''}`);
    }
    if (suggested.length === 0) lines.push('  • (nothing testable found — check the target name)');
    lines.push('');
    lines.push('Scaffold them in one call:');
    lines.push('```');
    lines.push(`generate_object(mode="pattern", pattern="systest", name="${target}",`);
    lines.push(`  params: { testMethods: [${suggested.map(m => `"${m.name}"`).join(', ')}]` +
      `${kind === 'table' ? ', testTargetType: "table"' : ''} })`);
    lines.push('```');
  }

  if (kind === 'table') {
    lines.push('');
    lines.push('**This is a TABLE, so the test has a different shape** — and `testTargetType: "table"` ' +
      'above is what selects it:');
    lines.push('  • Arrange a BUFFER and call `initValue()`. Table validation runs on an unsaved row, ' +
      'so most of these tests never touch the database.');
    lines.push('  • `validateWrite` / `validateField` / `validateDelete` answer with a **boolean** and ' +
      'explain themselves through the **infolog** — they do not throw. Assert both: ' +
      '`this.assertFalse(buffer.validateWrite())` and then ' +
      '`this.assertExpectedInfoLogMessage(<the text>)`.');
    lines.push('  • Pass the **resolved label text** to that assertion, not the `"@Label:Id"` the rule ' +
      'hands to `checkFailed` — it scans the infolog, which holds the resolved string.');
    lines.push('  • Write the ACCEPTING case too. A rule that refuses every row passes the rejecting ' +
      'test on its own.');
    lines.push('  • The logic under test usually lives in a CoC class, not on the table: ' +
      `\`extension_info(mode="coc", target="${target}")\` shows the wrappers, and ` +
      '`get_knowledge(topic="coc-authoring")` the `next` placement rules. The test still calls the ' +
      'TABLE method — that is the point, it proves the wrapper is in the chain.');
  }
  lines.push('');

  if (tests.length > 0) {
    lines.push(`**Tests that already exist for this target:** ${tests.map(t => `\`${t}\``).join(', ')} — ` +
      'extend one of those rather than starting a second class for the same target.');
  } else {
    lines.push('**No existing test class** found for this target.');
  }
  lines.push('');

  if (hasTestEssentials === false) {
    lines.push(`🚨 **Model \`${model}\` does not reference TestEssentials.** [SysTestMethod] and ` +
      '[SysTestCheckInTest] come from ApplicationFoundation and will compile, but [SysTestCategory], ' +
      '[SysTestOwner], [SysTestPriority] and [SysTestAreaPath] are in TestEssentials and will not. ' +
      'Add the reference to the model descriptor BEFORE the first build if you plan to use them.');
  } else if (hasTestEssentials === true) {
    lines.push(`✅ Model \`${model}\` references TestEssentials — the filtering attributes are available.`);
  }
  lines.push('');

  lines.push('**The cycle — red first.** A test that passes on its first run has proven nothing:');
  lines.push('  1. `d365fo_file(action="create", objectType="class")` — write the test class.');
  lines.push('  2. `build_d365fo_project` — it must COMPILE. Red means a failing assertion, not a broken file.');
  lines.push(`  3. \`run_systest_class(className="${testClass}")\` — expect failures. If it passes here, the ` +
    'assertion is empty and the test is worthless.');
  lines.push('  4. Implement the behaviour.');
  lines.push('  5. Build, then run again — expect green.');
  lines.push('  6. `run_bp_check` on the class you changed.');
  lines.push('');
  lines.push('**API the framework really has** (`get_knowledge(topic="unit-testing")` for the rest): asserts ' +
    'come from SysTestAssert — assertEquals, assertNotEqual, assertTrue, assertFalse, assertNull, ' +
    'assertNotNull, assertSame, assertNotSame, assertRealEquals, assertUTCDateTimeEquals, fail. There is ' +
    'no assertExpectedException: declare it with `this.parmExceptionExpected(true)` before the call that ' +
    'must throw. Every test runs in its own transaction and is rolled back, so created records need no ' +
    'cleanup and there is no SysTestCaseAutoRollback attribute to add.');
  lines.push('');
  lines.push(`**Grounding token:** \`${token}\``);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
