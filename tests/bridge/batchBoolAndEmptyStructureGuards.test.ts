/**
 * Regression test — C# bridge batch-path health.
 *
 * Three defects the repo's own tests structurally cannot see, because every TS
 * test mocks BridgeClient and therefore asserts what Node SENDS, never what C#
 * READS or WRITES:
 *
 *  (a) HandleBatchModify's `B()` helper called Convert.ToBoolean(value). The batch
 *      params arrive as Dictionary<string, object> whose values System.Text.Json
 *      boxes as JsonElement, and JsonElement does not implement IConvertible — so
 *      EVERY batch op carrying a bool (mandatory, allowDuplicates, alternateKey,
 *      extendBaseFieldGroup) died with "Object must implement IConvertible",
 *      reported by the per-op catch as that operation's reason for failing. The
 *      single-op arms never had the bug: they read through GetBoolParam. Both
 *      paths must now go through the shared ParamCoercion.
 *
 *  (b) BatchOperationRequest.GetTypedParam swallowed deserialization failures into
 *      null, so a wrongly-SHAPED parameter was indistinguishable from an absent one
 *      and the dispatcher answered "Missing: fields" for a key that was right there
 *      — the param-shape contract bug this project keeps re-living. It also
 *      deserialized without JsonOptions.Default, i.e. under different property-name
 *      rules than the single-op GetParam<T>.
 *
 *  (c) MetadataWriteService wrote structurally useless objects and returned success:
 *      AddIndex with fields == null serialized <Fields /> (an index that compiles,
 *      warns about nothing and indexes nothing), and the relation builders wrote
 *      `Field = c.Field ?? ""` — a nameless constraint whose damage only shows at
 *      compile time. Same "silent empty write" family as the security-privilege
 *      create defect: builds clean, 0 warnings, non-functional.
 *
 * These are source greps rather than behavioural assertions because the behaviour
 * lives in a C# process that the TS suite does not start.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const BRIDGE_DIR = path.join(
  path.resolve(__dirname, '..', '..'),
  'bridge', 'D365MetadataBridge',
);
const DISPATCHER_CS = path.join(BRIDGE_DIR, 'Protocol', 'RequestDispatcher.cs');
const PROTOCOL_CS = path.join(BRIDGE_DIR, 'Protocol', 'BridgeProtocol.cs');
const MODELS_CS = path.join(BRIDGE_DIR, 'Models', 'Models.cs');
const WRITE_SERVICE_CS = path.join(BRIDGE_DIR, 'Services', 'MetadataWriteService.cs');

let dispatcher: string;
let protocol: string;
let models: string;
let writeService: string;

/**
 * Drops comments. Every fix here is deliberately DOCUMENTED by naming the old broken
 * construct ("Convert.ToBoolean(v) therefore threw…", "`Field = c.Field ?? \"\"` wrote
 * a nameless…"), so a raw grep would match the explanation and pass — or fail — for
 * the wrong reason.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** Body of HandleBatchModify — from its signature to the end of the file's last method. */
function batchModifyBody(source: string): string {
  const start = source.indexOf('private Task<BridgeResponse> HandleBatchModify');
  expect(start, 'HandleBatchModify not found — the batch path was renamed').toBeGreaterThan(0);
  return source.slice(start);
}

/** Body of a C# method, from its signature to the start of the next member (any visibility). */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `method not found: ${signature}`).toBeGreaterThan(0);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {8}(?:public|private|internal|protected)\s/);
  return next === -1 ? source.slice(start) : rest.slice(0, next);
}

describe('bridge batch path — boolean coercion (finding a)', () => {
  beforeAll(() => {
    dispatcher = fs.readFileSync(DISPATCHER_CS, 'utf8');
    protocol = fs.readFileSync(PROTOCOL_CS, 'utf8');
  });

  it('never calls Convert.ToBoolean on a batch parameter', () => {
    expect(
      code(batchModifyBody(dispatcher)),
      'Convert.ToBoolean(JsonElement) throws InvalidCastException ("Object must ' +
        'implement IConvertible") — every batch op with a bool parameter fails with ' +
        'that nonsense message instead of running',
    ).not.toContain('Convert.ToBoolean');
  });

  it('routes batch booleans through the shared ParamCoercion helper', () => {
    const body = code(batchModifyBody(dispatcher));
    const helper = body.match(/bool\?\s*B\(string key\)\s*=>([^;]+);/);
    expect(helper, "the batch path's B() bool helper is gone or was reshaped").not.toBeNull();
    expect(
      helper![1],
      'the batch bool helper must use the same coercion as the single-op arms, or the ' +
        'two paths disagree about what "mandatory": "true" means',
    ).toContain('ParamCoercion.ToBool');
  });

  it('routes single-op booleans through the same helper', () => {
    expect(code(protocol)).toMatch(/public bool\?\s*GetBoolParam\(string name\)[\s\S]*?ParamCoercion\.ToBool/);
  });

  it('ParamCoercion reads booleans by JSON kind and refuses anything else', () => {
    const coercion = code(protocol.slice(protocol.indexOf('public static class ParamCoercion')));
    expect(coercion).toContain('JsonValueKind.True');
    expect(coercion).toContain('JsonValueKind.False');
    // A present-but-unreadable value must throw, not degrade to false: a silent false
    // writes a non-mandatory field / a duplicate-allowing index and reports success.
    expect(coercion).toContain('throw new ArgumentException');
  });

  it('still passes the bool params of the batch ops that carry them', () => {
    const body = batchModifyBody(dispatcher);
    for (const param of ['mandatory', 'allowDuplicates', 'alternateKey', 'extendBaseFieldGroup']) {
      expect(body, `batch path stopped forwarding '${param}'`).toContain(`B("${param}")`);
    }
  });
});

describe('bridge batch path — typed parameter shape errors (finding b)', () => {
  beforeAll(() => {
    models = fs.readFileSync(MODELS_CS, 'utf8');
  });

  it('GetTypedParam does not swallow a deserialization failure into null', () => {
    const body = code(methodBody(models, 'public T? GetTypedParam<T>(string key)'));
    expect(
      body,
      'a bare `catch { return null; }` makes a wrongly-shaped parameter look absent, and ' +
        'the dispatcher then reports "Missing: <key>" for a key the caller did supply',
    ).not.toMatch(/catch\s*\{\s*return null;\s*\}/);
    expect(body).toContain('catch (System.Text.Json.JsonException');
    expect(body).toContain('throw new System.ArgumentException');
  });

  it('GetTypedParam names the offending parameter in the error', () => {
    const body = methodBody(models, 'public T? GetTypedParam<T>(string key)');
    expect(
      body,
      'the whole point of the error is telling the caller WHICH parameter is misshapen',
    ).toMatch(/throw new System\.ArgumentException\([\s\S]*?\{key\}/);
  });

  it('GetTypedParam deserializes with JsonOptions.Default, like the single-op GetParam', () => {
    const body = code(methodBody(models, 'public T? GetTypedParam<T>(string key)'));
    const deserializeCalls = body.match(/JsonSerializer\.Deserialize<T>\([^)]*\)/g) ?? [];
    expect(deserializeCalls.length).toBeGreaterThan(0);
    for (const call of deserializeCalls) {
      expect(
        call,
        'deserializing without JsonOptions.Default gives the batch path different ' +
          'property-name rules than the single-op path — a second way for the two to drift',
      ).toContain('JsonOptions.Default');
    }
  });
});

describe('bridge write service — empty structure gates (finding c)', () => {
  beforeAll(() => {
    writeService = fs.readFileSync(WRITE_SERVICE_CS, 'utf8');
  });

  it('declares the shared gates', () => {
    expect(writeService).toContain('private static List<string> RequireIndexFields(');
    expect(writeService).toContain('private static AxTableRelationConstraintField NewRelationConstraint(');
    expect(writeService).toContain(
      'private static List<WriteRelationConstraint> RequireRelationConstraints(',
    );
  });

  it('AddIndex refuses an index with no fields instead of writing <Fields />', () => {
    const body = methodBody(
      writeService,
      'public object AddIndex(string tableName, string indexName, List<string>? fields',
    );
    expect(
      body,
      'AddIndex with fields == null wrote an index with zero fields and returned ' +
        'success — it compiles, raises no BP warning and indexes nothing',
    ).toContain('RequireIndexFields(');
  });

  it('AddFullTextIndex refuses a full-text index with no fields', () => {
    const body = methodBody(
      writeService,
      'public object AddFullTextIndex(string tableName, string indexName, List<string>? fields',
    );
    expect(body).toContain('RequireIndexFields(');
  });

  it('AddRelation refuses missing constraints and blank constraint field names', () => {
    const body = methodBody(writeService, 'public object AddRelation(string tableName, string relationName');
    expect(body).toContain('RequireRelationConstraints(');
    expect(body).toContain('NewRelationConstraint(');
  });

  it('no relation builder writes a nameless constraint any more', () => {
    // `Field = c.Field ?? ""` produced an <AxTableRelationConstraintField> with an
    // empty <Field>/<Name>: the relation reports as added, joins nothing, and only
    // fails at compile time. Its usual cause is the {fieldName} vs {field} param-shape
    // mismatch, i.e. BOTH sides deserialize to null.
    expect(code(writeService)).not.toMatch(/Field\s*=\s*c\.Field\s*\?\?/);
    expect(code(writeService)).not.toMatch(/RelatedField\s*=\s*c\.RelatedField\s*\?\?/);
  });

  it('every index/relation builder is gated, including the create paths', () => {
    const source = code(writeService);
    // One gate call per construction site: AddIndex, AddFullTextIndex, CreateTable,
    // CreateSmartTable, CreateTableExtension.
    expect((source.match(/RequireIndexFields\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
    // AddRelation, CreateTable, CreateSmartTable, CreateTableExtension (+ declaration).
    expect((source.match(/RequireRelationConstraints\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    // Every AxTableRelationConstraintField now comes from the gate, so the type is
    // constructed in exactly one place.
    expect((source.match(/new AxTableRelationConstraintField/g) ?? []).length).toBe(1);
  });
});
