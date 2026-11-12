/**
 * Inline post-write verification for the create/modify paths.
 *
 * The conventional loop is create → verify_d365fo_project → run_bp_check: two
 * extra round trips per object, both asking questions the writing call already
 * had the answers to. It knows the path it wrote and the project it registered
 * the file in; checking that the bytes are on disk and that the .rnrproj really
 * references them is two filesystem reads, not a round trip.
 *
 * Kept deliberately narrow. This is NOT verify_d365fo_project — that tool sweeps
 * a whole project and cross-checks every object, which is a different job and
 * still worth its own call. This answers only "did the thing I just claimed to
 * do actually land", which is precisely the question the follow-up call was
 * being spent on.
 */

import * as fs from 'fs/promises';
import {
  resolveMembership, renderMembership, axFolderForObjectType, hasAxFolder, type Membership,
} from '../../workspace/projectMembership.js';
import { getConfigManager } from '../../utils/configManager.js';
import {
  findControlElementOrderViolations,
  formatElementOrderViolations,
} from '../../validation/formControlElementOrder.js';
import { createXmlTokenScanner, scanXmlLeaves } from '../../utils/xmlScan.js';

/**
 * The model's other .rnrproj, or none — never a throw.
 *
 * Everything in this module is advisory: the write has already happened and
 * succeeded by the time any of it runs, so a diagnostic that raises turns a good
 * write into a reported failure. That is not hypothetical — this call is
 * evaluated as an ARGUMENT to verifyWrittenFile, outside its try, so an
 * exception here skips the verification entirely and surfaces as the write
 * failing. Degrading to "no siblings known" costs a less specific message and
 * nothing else.
 */
function projectsForModelSafe(modelName: string | null | undefined): string[] {
  try {
    return getConfigManager().getProjectsForModel?.(modelName) ?? [];
  } catch {
    return [];
  }
}

/**
 * The membership question for an object, with the model's other projects filled
 * in. Call sites pass the model they just wrote into; everything else is looked
 * up here so a caller cannot forget the siblings and silently get the old
 * active-project-only answer back.
 */
export function membershipOf(
  objectType: string,
  objectName: string,
  modelName: string | null | undefined,
): { axFolder: string; objectName: string; siblingProjectPaths: string[] } | undefined {
  // A type with no Ax* folder has no membership question to answer. Gating HERE
  // rather than at each call site is deliberate: the first fix for this put the
  // guard in modifyD365File's single-operation path only, and the batch wrapper
  // in d365foFile.ts asked the same question again and reported the same
  // invented "no .rnrproj references AxClass\<Model>" on the very next run.
  // verifyWrittenFile already takes this optional, so returning undefined
  // silences every caller at once — present and future.
  if (!hasAxFolder(objectType)) return undefined;
  return {
    axFolder: axFolderForObjectType(objectType),
    objectName,
    siblingProjectPaths: projectsForModelSafe(modelName),
  };
}

export interface WriteVerification {
  /** The file exists on disk and is non-empty. */
  onDisk: boolean;
  /** Byte length written, when readable. */
  bytes?: number;
  /**
   * Where the object is registered across the projects of its model. Undefined
   * when no project could be read — see projectMembership.ts for why this is a
   * membership question and not a path comparison.
   */
  membership?: Membership;
  /** AOT folder and name the membership answer is about, for the message. */
  axFolder?: string;
  objectName?: string;
}

/**
 * Check that a just-written file is where it should be. Never throws.
 *
 * `siblingProjectPaths` are the other .rnrproj of the same model. Supply them
 * and an object referenced by one of those is reported as such rather than as
 * missing — the distinction matters, because only one of the two stops the
 * build, and they call for different fixes.
 */
export async function verifyWrittenFile(
  filePath: string | undefined,
  projectPath?: string,
  membershipOf?: { axFolder: string; objectName: string; siblingProjectPaths?: readonly string[] },
): Promise<WriteVerification> {
  if (!filePath) return { onDisk: false };
  try {
    const stat = await fs.stat(filePath);
    const result: WriteVerification = { onDisk: stat.isFile() && stat.size > 0, bytes: stat.size };
    if (membershipOf && (projectPath || membershipOf.siblingProjectPaths?.length)) {
      result.membership = await resolveMembership(
        membershipOf.axFolder,
        membershipOf.objectName,
        projectPath,
        membershipOf.siblingProjectPaths ?? [],
      );
      result.axFolder = membershipOf.axFolder;
      result.objectName = membershipOf.objectName;
    }
    return result;
  } catch {
    return { onDisk: false };
  }
}

/**
 * Opt-in best-practice check on the object just written.
 *
 * Off by default and deliberately so: xppbp needs the compiler and takes
 * seconds, which is the wrong trade for the common case. But when the caller
 * knows it wants one — the last object of a feature, say — running it here
 * saves the round trip that the separate run_bp_check call costs, and this call
 * already knows the object's type and name.
 *
 * `bpCheck` is not in the wire schema; it is accepted nested in `params` like
 * every other d365fo_file knob, and documented in the op-spec. It costs no
 * schema bytes and the budget has none to spare.
 */
export async function runInlineBpCheck(
  bpCheck: unknown,
  objectType: string,
  objectName: string,
  context: unknown,
): Promise<string> {
  if (bpCheck !== true && bpCheck !== 'true') return '';
  try {
    const { runBpCheckTool } = await import('../sdlc/runBpCheck.js');
    const result: any = await runBpCheckTool({ objects: [{ objectType, objectName }] }, context as any);
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n')
      .trim();
    return text ? `\n\n### Best-practice check (bpCheck=true)\n${text}` : '';
  } catch (e: any) {
    // Never turn a successful write into a failure over an advisory check.
    return `\n⚠️ bpCheck requested but could not run: ${e?.message ?? e}`;
  }
}

/**
 * What a bridge or XML-writer result message adds to a write reply, or '' when
 * it only restates the headline.
 *
 * Every successful write used to carry a `🔧 API: ✅ Field 'X' added via
 * IMetaTableProvider.Update` line under a headline that already said the field
 * was added, and the create path's `✅ Created via … — file: <path>` repeated the
 * path printed one line above it. The API name is the same for every call of an
 * operation, so the agent learns nothing from it. Dropped: a first line that is a
 * bare `✅ … via <Api>` confirmation, and a `File: <path>` the reply already
 * prints. Kept: everything else — a reason, defaults the bridge chose
 * (`(Cardinality=…)`), a `⚠️ NOT applied` suffix, an idempotent `already present`.
 */
export function bridgeMessageNote(message: string | undefined, filePath?: string): string {
  if (!message) return '';
  const lines = message.split('\n');
  if (/^✅ .* via [\w.()]+$/.test(lines[0]) || /^✅ Created via \S+ — file: .*$/.test(lines[0])) lines.shift();
  let rest = lines.join('\n');
  if (filePath) {
    rest = rest.split(`. File: ${filePath}`).join('.').split(` File: ${filePath}`).join('');
  }
  rest = rest.replace(/^\n+/, '').trimEnd();
  return rest ? `\n${rest}` : '';
}

/**
 * The verification's verdict for a write reply, or '' when there is nothing
 * worth saying.
 *
 * A clean result is silent. `✅ Verified: on disk (N bytes), referenced by the
 * .rnrproj.` rode on every successful write and said only what the ✅ headline
 * already claims; the byte count changes nothing the agent does next. What the
 * agent must act on is still said: the file missing after a reported success,
 * and a .rnrproj that does not reference the object.
 */
export function renderWriteVerification(v: WriteVerification): string {
  if (!v.onDisk) {
    return `\n❌ Verification: the file is NOT on disk after a reported success — treat this write as failed.`;
  }
  // Only 'other' and 'missing' have something to add; 'active' and 'unknown'
  // are the quiet cases, and quiet is what makes the loud ones mean anything.
  return v.membership
    ? renderMembership(v.membership, v.axFolder ?? '', v.objectName ?? '')
    : '';
}

/**
 * Post-write element-order check for a form document (#989).
 *
 * `create` can only pass through a defect the caller supplied, and it is gated
 * BEFORE the write. `modify` is different in kind: the direct XML writers insert
 * elements into an existing document, and an insertion at the wrong offset IS
 * this defect — the same class as the nesting-scope trap behind #927/#928. So
 * the interesting failure here is one this server just introduced, and it can
 * only be seen after the operation has applied (through IMetadataProvider.Update()
 * or the XML fallback, neither of which can be dry-run).
 *
 * Hence a report rather than a gate. The write has happened; the caller needs to
 * know the file on disk now contains something the compiler will not see, and
 * which tool undoes it.
 *
 * Advisory like everything else in this module: a check that throws must not
 * turn a successful write into a reported failure.
 */
export async function verifyFormElementOrder(
  filePath: string | undefined,
  objectType: string,
): Promise<string> {
  if (!filePath || (objectType !== 'form' && objectType !== 'form-extension')) return '';
  try {
    const xml = await fs.readFile(filePath, 'utf-8');
    const dropped = findControlElementOrderViolations(xml).filter(v => v.kind === 'order');
    if (dropped.length === 0) return '';
    return (
      `\n\n⛔ **The file on disk now has ${dropped.length} element(s) the metadata deserializer ` +
      `will DROP silently** — they are in the file and the compiler will not see them:\n` +
      `${formatElementOrderViolations(dropped)}\n` +
      `This is a defect in the write, not in your request. Undo it with ` +
      `\`undo_last_modification\`, and please report the operation that produced it.`
    );
  } catch {
    return '';
  }
}

// ── Read-back comparison: is what the operation asked for in the file? (#1161) ──

/** The collections a named child can live in, by the kind an operation names. */
const CHILD_COLLECTIONS = {
  field: 'Fields',
  method: 'Methods',
  index: 'Indexes',
  'field-group': 'FieldGroups',
  relation: 'Relations',
  'enum-value': 'EnumValues',
  'data-source': 'DataSources',
  control: 'Controls',
} as const;

export type IntentChildKind = keyof typeof CHILD_COLLECTIONS;

export interface IntentChild {
  kind: IntentChildKind;
  name: string;
}

/**
 * What a write meant to leave in the file. Built by the caller from the
 * operation's own arguments, AFTER any renaming (prefixes, derived method names),
 * so the names here are the ones the writer was actually given.
 */
export interface WriteIntent {
  /** Top-level scalar properties: element name (any case) → requested value. */
  properties?: Record<string, string>;
  /**
   * Property names (any case) whose ABSENCE is a miss. Every other property is
   * compared only when its element is in the file: a serializer omits a value
   * that equals the default, and this module does not know every type's defaults.
   */
  mustExist?: readonly string[];
  /** Named children the operation added: each must be in the file. */
  present?: readonly IntentChild[];
  /** Named children the operation removed: none may still be in the file. */
  absent?: readonly IntentChild[];
}

/** One thing the operation asked for that the file does not show. */
export interface ReadBackMiss {
  kind: 'property-absent' | 'property-differs' | 'child-absent' | 'child-still-present';
  /** What was asked for, e.g. `ConfigurationKey=ContosoKey` or `field "ContosoAmount"`. */
  what: string;
  /** What the file shows instead. */
  found: string;
}

/**
 * Properties whose value a writer legitimately replaces: raw text becomes a label
 * id. Compared only when the caller passed a label id (`@File:Id`) to begin with.
 */
const LABEL_VALUED_PROPERTIES = new Set([
  'label', 'helptext', 'developerdocumentation', 'caption', 'description', 'singularlabel', 'text',
]);

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A value in the one spelling both sides are compared in: trimmed, any case, Yes/No for booleans. */
function canonicalValue(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === 'true') return 'yes';
  if (v === 'false') return 'no';
  return v;
}

function sameValue(requested: string, written: string): boolean {
  const a = canonicalValue(requested);
  const b = canonicalValue(written);
  if (a === b) return true;
  // 1/0 is a third boolean spelling, but only against a value that IS a boolean.
  const asBool = (x: string, other: string) =>
    other === 'yes' || other === 'no' ? (x === '1' ? 'yes' : x === '0' ? 'no' : x) : x;
  return asBool(a, b) === asBool(b, a);
}

const clip = (v: string) => (v.length > 80 ? `${v.slice(0, 77)}...` : v);

interface NamedChild {
  /** The collection element the child sits in (`Fields`, `Methods`, ...). */
  collection: string;
  name: string;
  /** In the object's OWN collection, not one nested in another child. */
  primary: boolean;
}

/**
 * Every `<Collection><Item><Name>x</Name>` in the document, or null when the
 * document does not close every element it opens.
 *
 * Walked with the token scanner the write guards already use (utils/xmlScan.ts),
 * so a `<Name>` inside a comment or an X++ CDATA block is not a child.
 */
function scanNamedChildren(xml: string): NamedChild[] | null {
  const children: NamedChild[] = [];
  const stack: string[] = [];
  let contentAt = -1;
  const scanner = createXmlTokenScanner();
  let token: RegExpExecArray | null;
  while ((token = scanner.exec(xml)) !== null) {
    const closing = token[1];
    const starting = token[2];
    if (closing) {
      if (stack[stack.length - 1] !== closing) return null;
      if (contentAt >= 0 && closing === 'Name' && stack.length >= 4) {
        children.push({
          collection: stack[stack.length - 3],
          name: decodeXmlText(xml.slice(contentAt, token.index)).trim(),
          // <Root><Fields><Item><Name>, or <Root><SourceCode><Methods><Method><Name>.
          primary: stack.length === 4 || (stack.length === 5 && stack[1] === 'SourceCode'),
        });
      }
      contentAt = -1;
      stack.pop();
      continue;
    }
    if (starting) {
      if (token[4] === '/') {
        contentAt = -1;
        continue;
      }
      stack.push(starting);
      contentAt = token.index + token[0].length;
    }
  }
  return stack.length === 0 ? children : null;
}

/**
 * Compare a written document with what the operation meant to leave in it.
 *
 * Pure, and the same for every object type: it reads top-level leaf elements and
 * named children of collections, which every AOT document has in the same shape.
 * Conservative on purpose, because a false "NOT in the file" is worse than a miss:
 *   - a document it cannot read (no top-level <Name>, unbalanced) yields no misses,
 *   - names compare without case, values trimmed, without case, Yes/No = true/false,
 *   - an absent property is a miss only when the caller listed it in `mustExist`,
 *   - a label-valued property is compared only when a label id was requested,
 *   - an added child counts as present anywhere in a collection of its kind,
 *   - a removed child counts as still present only in the object's own collection.
 */
export function findReadBackMisses(xml: string, intent: WriteIntent | null | undefined): ReadBackMiss[] {
  if (!intent || !xml) return [];
  const misses: ReadBackMiss[] = [];

  const topLevel = new Map<string, { name: string; text: string }>();
  for (const leaf of scanXmlLeaves(xml)) {
    const key = leaf.name.toLowerCase();
    if (leaf.depth === 1 && !topLevel.has(key)) topLevel.set(key, { name: leaf.name, text: decodeXmlText(leaf.text) });
  }
  // Every AOT object carries its name at the top. Without one this is not a
  // document this check understands, and saying nothing is the honest answer.
  if (!topLevel.has('name')) return [];

  const mustExist = new Set((intent.mustExist ?? []).map(n => n.toLowerCase()));
  for (const [name, raw] of Object.entries(intent.properties ?? {})) {
    const requested = String(raw ?? '').trim();
    const key = name.trim().toLowerCase();
    if (!key || !requested) continue;
    if (LABEL_VALUED_PROPERTIES.has(key) && !requested.startsWith('@')) continue;
    const written = topLevel.get(key);
    if (!written) {
      if (mustExist.has(key)) {
        const element = name.trim();
        misses.push({
          kind: 'property-absent',
          what: `${element}=${clip(requested)}`,
          found: `the file has no top-level <${element[0].toUpperCase()}${element.slice(1)}> element`,
        });
      }
      continue;
    }
    if (!sameValue(requested, written.text)) {
      misses.push({
        kind: 'property-differs',
        what: `${written.name}=${clip(requested)}`,
        found: `the file holds "${clip(written.text.trim())}"`,
      });
    }
  }

  const present = (intent.present ?? []).filter(c => c.name?.trim());
  const absent = (intent.absent ?? []).filter(c => c.name?.trim());
  if (present.length === 0 && absent.length === 0) return misses;

  const children = scanNamedChildren(xml);
  if (!children) return misses;
  const has = (child: IntentChild, primaryOnly: boolean) => {
    const collection = CHILD_COLLECTIONS[child.kind];
    const wanted = child.name.trim().toLowerCase();
    return children.some(c =>
      c.collection === collection && c.name.toLowerCase() === wanted && (!primaryOnly || c.primary));
  };
  for (const child of present) {
    if (!has(child, false)) {
      misses.push({
        kind: 'child-absent',
        what: `${child.kind} "${child.name.trim()}"`,
        found: `no <${CHILD_COLLECTIONS[child.kind]}> entry of that name`,
      });
    }
  }
  for (const child of absent) {
    if (has(child, true)) {
      misses.push({
        kind: 'child-still-present',
        what: `removal of ${child.kind} "${child.name.trim()}"`,
        found: `it is still in <${CHILD_COLLECTIONS[child.kind]}>`,
      });
    }
  }
  return misses;
}

/** The warning block a read-back miss earns in the write's reply. Empty when there is none. */
export function renderReadBackMisses(misses: readonly ReadBackMiss[]): string {
  if (misses.length === 0) return '';
  return (
    `\n\n⚠️ Read-back: ${misses.length} requested item(s) are NOT in the file after a reported success:\n` +
    misses.map(m => `  ⚠️ ${m.what}: ${m.found}`).join('\n') +
    `\nNothing was rolled back. Re-read the object and apply what is listed again, or correct it.`
  );
}

/**
 * Read the file just written and report what the operation asked for and the file
 * does not show. Advisory like everything else in this module: never throws, and
 * an unreadable file or an operation with no checkable intent says nothing.
 */
export async function verifyWriteIntent(
  filePath: string | undefined,
  intent: WriteIntent | null | undefined,
): Promise<string> {
  if (!filePath || !intent) return '';
  try {
    const xml = await fs.readFile(filePath, 'utf-8');
    return renderReadBackMisses(findReadBackMisses(typeof xml === 'string' ? xml : '', intent));
  } catch {
    return '';
  }
}

const MODIFY_CHILD_OPERATIONS: Record<string, { kind: IntentChildKind; arg: string; removes: boolean }> = {
  'add-field': { kind: 'field', arg: 'fieldName', removes: false },
  'remove-field': { kind: 'field', arg: 'fieldName', removes: true },
  'remove-method': { kind: 'method', arg: 'methodName', removes: true },
  'add-index': { kind: 'index', arg: 'indexName', removes: false },
  'remove-index': { kind: 'index', arg: 'indexName', removes: true },
  'add-field-group': { kind: 'field-group', arg: 'fieldGroupName', removes: false },
  'remove-field-group': { kind: 'field-group', arg: 'fieldGroupName', removes: true },
  'add-relation': { kind: 'relation', arg: 'relationName', removes: false },
  'remove-relation': { kind: 'relation', arg: 'relationName', removes: true },
  'add-enum-value': { kind: 'enum-value', arg: 'enumValueName', removes: false },
  'remove-enum-value': { kind: 'enum-value', arg: 'enumValueName', removes: true },
};

/**
 * The intent of one modify operation, or null when it has none this check can be
 * sure of. `args` are the operation's arguments as the writer received them.
 * `addedMethodNames` are the methods an add-method wrote: the caller derives them,
 * because the name can come from the source rather than from an argument.
 */
export function modifyIntentFor(
  operation: string,
  objectType: string,
  args: Record<string, unknown>,
  addedMethodNames?: readonly string[],
): WriteIntent | null {
  const text = (key: string): string | null => {
    const v = args[key];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  if (operation === 'modify-property') {
    // A form's properties live on its Design, a descriptor is not an AOT object,
    // and a control or a dotted path addresses something below the top level.
    if (objectType === 'form' || objectType === 'form-extension' || objectType === 'model-descriptor') return null;
    const name = text('propertyPath');
    const value = args.propertyValue;
    if (!name || text('controlName') || /[./]/.test(name) || value === undefined || value === null) return null;
    // Written as child elements, one per permission, never as the text passed in.
    if (name.toLowerCase() === 'subscriberaccesslevel') return null;
    const requested = String(value).trim();
    // An empty value removes the property, so there is no value to find.
    return requested ? { properties: { [name]: requested } } : null;
  }

  if (operation === 'add-method') {
    // "Control.method" is written as <Name>method</Name> under that control, and the
    // class declaration is not a <Method> at all: neither is a name to look for.
    const names = (addedMethodNames ?? [])
      .map(n => (n ?? '').trim())
      .filter(n => n && !n.includes('.') && n.toLowerCase() !== 'classdeclaration');
    return names.length ? { present: names.map(name => ({ kind: 'method' as const, name })) } : null;
  }

  const spec = MODIFY_CHILD_OPERATIONS[operation];
  const name = spec ? text(spec.arg) : null;
  if (!spec || !name) return null;
  // "DataSource.method" addresses a nested member. Only the object's own are checked.
  if (name.includes('.')) return null;
  const child = { kind: spec.kind, name };
  return spec.removes ? { absent: [child] } : { present: [child] };
}

/**
 * The read-back comparison for one modify operation that has reported success.
 *
 * `earlierNotes` is what the reply already says: when the claim check
 * (preserveMetadataElements.ts) has reported the value as not in the file, this
 * stays silent rather than say it a second time. `splitMethods` returns the name
 * of every method in an add-method source that carries SEVERAL (null for a block
 * that is not a method), or null for a single one, which is written under the
 * operation's methodName. It is passed in because the X++ splitter lives in the
 * module that imports this one.
 */
export async function readBackAfterModify(
  filePath: string | undefined,
  operation: string,
  objectType: string,
  args: Record<string, unknown>,
  earlierNotes: string,
  splitMethods: (source: string) => Array<string | null> | null,
): Promise<string> {
  try {
    if (earlierNotes.includes('NOT in the file after a reported success')) return '';
    let methods: string[] | undefined;
    if (operation === 'add-method') {
      const source = args.sourceCode ?? args.methodCode;
      const several = typeof source === 'string' && source ? splitMethods(source) : null;
      methods = several
        ? several.filter((n): n is string => !!n)
        : typeof args.methodName === 'string' ? [args.methodName] : [];
    }
    return await verifyWriteIntent(filePath, modifyIntentFor(operation, objectType, args, methods));
  } catch {
    return '';
  }
}

/** `properties` keys of a create that never become a top-level element of that name. */
const CREATE_KEYS_NOT_COMPARED = new Set([
  // Identity, and the base type the create resolves or writes into the declaration.
  'name', 'extends',
  // Written by the create's own best-practice defaults, which report on them.
  'operationaldomain', 'subscriberaccesslevel',
]);

/**
 * Reference-valued properties that are an element of the same name on every type
 * that has them and that no serializer omits when set. Requested and absent is
 * a miss for these. For any other key absence can be an omitted default.
 */
const CREATE_PROPERTIES_THAT_MUST_EXIST = [
  'configurationKey', 'dataManagementStagingTable', 'primaryCompanyContext', 'countryRegionCodes', 'formRef',
];

/**
 * The intent of a create's top-level scalar `properties`. Null for a table, which
 * has its own reconciliation (createTablePropertyHonesty.ts) and must not be
 * reported twice. `alreadyReported` are keys another note in the same reply
 * already names as not written.
 */
export function createIntentFor(
  objectType: string,
  properties: unknown,
  alreadyReported: readonly string[] = [],
): WriteIntent | null {
  if (objectType === 'table' || !properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const reported = new Set(alreadyReported.map(k => k.toLowerCase()));
  const scalars: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const k = key.toLowerCase();
    if (CREATE_KEYS_NOT_COMPARED.has(k) || reported.has(k)) continue;
    scalars[key] = String(value);
  }
  return Object.keys(scalars).length ? { properties: scalars, mustExist: CREATE_PROPERTIES_THAT_MUST_EXIST } : null;
}
