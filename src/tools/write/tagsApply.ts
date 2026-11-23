/**
 * Applies `<Tags>` to an AOT file AFTER the create / modify that wrote it, whichever writer (bridge,
 * template, direct XML) produced the file. Doing it as one pure-XML step on the written file keeps
 * the tag logic in one place for every object type and works without a bridge release.
 *
 * Which tag is written:
 *   1. an explicit `tags` argument always wins ("A, B", or an array);
 *   2. otherwise, when an object is created or an element ADDED, the instance default
 *      `D365FO_DEFAULT_TAG` (.env), but never over a tag the object or element already carries;
 *   3. `tags=""` opts out for that call.
 * Every result says what was applied, so a wrong default is visible at once.
 */

import fs from 'fs/promises';
import { withFileLock, writeFileAtomic } from '../../utils/atomicFileWrite.js';
import { normalizeD365Xml } from '../../utils/d365XmlNormalizer.js';
import {
  constraintNamesOf, normalizeTagsInput, readElementTags, readObjectTags,
  setElementTags, setObjectTags, type TagsElementKind, type TagsMode, type TagsEditResult,
} from '../xml/tagsEdit.js';

export interface TagArgs {
  tags?: unknown;
  tagsMode?: unknown;
  [key: string]: unknown;
}

/**
 * Tag to write when the caller passed none: the instance default D365FO_DEFAULT_TAG. An explicit value
 * wins; an explicit empty value opts out. No tag and no default: write nothing.
 */
export function resolveTagsToWrite(explicit: unknown): { tags?: string; source: 'explicit' | 'default' | 'opt-out' | 'none' } {
  if (explicit !== undefined && explicit !== null) {
    const v = normalizeTagsInput(explicit)!;
    return v === '' ? { source: 'opt-out' } : { tags: v, source: 'explicit' };
  }
  const def = normalizeTagsInput(process.env.D365FO_DEFAULT_TAG);
  return def ? { tags: def, source: 'default' } : { source: 'none' };
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

export function parseTagsMode(v: unknown): TagsMode {
  return v === 'add' || v === 'remove' ? v : 'replace';
}

/** Comments, string literals and attribute blocks blanked out, so braces and parentheses are code. */
function stripNoise(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/@?"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\[[^\]]*\]/g, ' ');
}

/** Names of the top-level methods in an X++ snippet (one or several), in order. */
export function methodNamesOf(source: string | undefined): string[] {
  if (!source) return [];
  const text = stripNoise(source);
  const names: string[] = [];
  let depth = 0;
  let header = '';
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) {
        const m = /\b([A-Za-z_]\w*)\s*\(/.exec(header);
        if (m) names.push(m[1]);
        header = '';
      }
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      header += ch;
    }
  }
  return names;
}

interface Target { kind: TagsElementKind; names: string[]; /** The operation adds the element (default tag applies). */ adds: boolean }

/** The element(s) an operation adds or edits, and whether it adds them. */
export function targetsOf(operation: string, a: TagArgs): Target | null {
  const methodNames = methodNamesOf(str(a.sourceCode) ?? str(a.methodCode));
  const one = (kind: TagsElementKind, name: unknown, adds: boolean): Target | null => {
    const n = str(name);
    return n ? { kind, names: [n], adds } : null;
  };
  switch (operation) {
    case 'add-field': return one('field', a.fieldName, true);
    case 'modify-field': return one('field', a.fieldNewName ?? a.fieldName, false);
    case 'add-relation': return one('relation', a.relationName, true);
    case 'add-index': return one('index', a.indexName, true);
    case 'add-field-group': return one('field-group', a.fieldGroupName, true);
    case 'add-enum-value': return one('enum-value', a.enumValueName, true);
    case 'modify-enum-value': return one('enum-value', a.enumValueNewName ?? a.enumValueName, false);
    case 'add-method':
    case 'add-table-method':
    case 'add-display-method': {
      const explicit = str(a.methodName);
      // A form data source / control override lives outside <SourceCode><Methods>; not tagged here.
      if (explicit?.includes('.')) return null;
      const names = [...methodNames];
      // add-table-method with a generated body: the method is named after tableMethodType.
      if (names.length === 0 && (explicit ?? str(a.tableMethodType))) names.push((explicit ?? str(a.tableMethodType))!);
      return names.length ? { kind: 'method', names, adds: true } : null;
    }
    default: return null;
  }
}

const MODIFY_FIELD_PARAMS = ['fieldType', 'fieldMandatory', 'fieldLabel', 'fieldHelpText', 'fieldEnumType', 'fieldStringSize', 'fieldAllowEdit', 'fieldIgnoreEdtRelation', 'computedFieldMethod', 'fieldNewName', 'sourceCode'];
const MODIFY_ENUM_VALUE_PARAMS = ['enumValueNewName', 'enumValueLabel', 'enumValueInt'];

/**
 * A modify-field / modify-enum-value that only carries `tags` has nothing for the bridge to do: the
 * tag is written afterwards by applyOperationTags. Returns the result to use instead of a bridge call,
 * or undefined when the operation also changes something else.
 */
export async function tagsOnlyResult(filePath: string, operation: string, a: TagArgs): Promise<{ success: boolean; message: string } | undefined> {
  if (a.tags === undefined || a.tags === null) return undefined;
  const others = operation === 'modify-field' ? MODIFY_FIELD_PARAMS : operation === 'modify-enum-value' ? MODIFY_ENUM_VALUE_PARAMS : null;
  if (!others || others.some(k => a[k] !== undefined)) return undefined;
  const t = targetsOf(operation, a);
  if (t) {
    // The bridge would have refused an unknown element; so must this.
    const xml = (await fs.readFile(filePath, 'utf-8')).replace(/^\uFEFF/, '');
    const probe = setElementTags(xml, t.kind, t.names[0], null);
    if (!probe.ok) return { success: false, message: `${t.kind} '${t.names[0]}' not found: ${probe.message}` };
  }
  return { success: true, message: 'Tags only; no other property changed' };
}

async function editFile(
  filePath: string,
  edit: (xml: string) => TagsEditResult,
): Promise<TagsEditResult> {
  return withFileLock(filePath, async () => {
    const raw = await fs.readFile(filePath, 'utf-8');
    const xml = raw.replace(/^\uFEFF/, '');
    const r = edit(xml);
    if (r.ok && r.changed) await writeFileAtomic(filePath, normalizeD365Xml(r.xml));
    return r;
  });
}

const banner = (lines: string[]) => (lines.length ? `\n🏷️ ${lines.join('\n🏷️ ')}` : '');

/**
 * Tag the object just created. `properties.tags` (or the default) goes on the object itself, and
 * on its own members that a create writes in the same call are NOT touched: members created with
 * the object are covered by the object's own tag only when the caller lists them (fields[].tags is
 * not supported), because the shipped convention tags the elements a change adds.
 */
export async function applyCreateTags(filePath: string | undefined, properties: unknown): Promise<string> {
  if (!filePath) return '';
  const explicit = (properties as { tags?: unknown } | undefined)?.tags;
  const { tags, source } = resolveTagsToWrite(explicit);
  if (!tags) return source === 'opt-out' ? banner(['Tags: none (opted out with tags="")']) : '';
  try {
    const r = await editFile(filePath, xml => {
      // A create path that already wrote the same tag (data entity, configuration key) is left alone.
      if (readObjectTags(xml) === tags) return { ok: true, xml, changed: false, tags, message: 'already tagged' };
      if (readObjectTags(xml) !== undefined && source === 'default') {
        return { ok: true, xml, changed: false, tags: readObjectTags(xml), message: 'already tagged' };
      }
      return setObjectTags(xml, tags);
    });
    if (!r.ok && source === 'default' && r.message.startsWith('unsupported')) return '';
    return r.ok
      ? banner([`Tags "${r.tags}" on the object (${source === 'default' ? 'D365FO_DEFAULT_TAG' : 'tags argument'}); pass tags="" to opt out.`])
      : banner([`Tags not written: ${r.message}`]);
  } catch (e) {
    return banner([`Tags not written: ${e instanceof Error ? e.message : String(e)}`]);
  }
}

/**
 * Tag the element an add-*, modify-field or modify-enum-value operation just wrote.
 * Returns the note to append to the result ('' when there is nothing to say).
 */
export async function applyOperationTags(
  filePath: string,
  operation: string,
  args: TagArgs,
): Promise<string> {
  const target = targetsOf(operation, args);
  if (!target) return '';
  const explicitGiven = args.tags !== undefined && args.tags !== null;
  const { tags, source } = resolveTagsToWrite(args.tags);
  // A modify only retags on request; the default is for what an operation ADDS.
  if (!explicitGiven && !target.adds) return '';
  // An explicit "" on a modify removes the element's tag; on an add it only opts out of tagging.
  if (!tags && source === 'opt-out' && !target.adds) {
    const notes: string[] = [];
    for (const name of target.names) {
      const r = await editFile(filePath, xml => setElementTags(xml, target.kind, name, null));
      if (!r.ok) notes.push(`Tags not removed for ${target.kind} ${name}: ${r.message}`);
    }
    return banner(notes.length ? notes : [`Tags removed from ${target.kind} ${target.names.join(', ')}`]);
  }
  if (!tags) return source === 'opt-out' ? banner(['Tags: none (opted out with tags="")']) : '';

  const mode = explicitGiven ? parseTagsMode(args.tagsMode) : 'replace';
  const notes: string[] = [];
  try {
    for (const name of target.names) {
      const r = await editFile(filePath, xml => {
        // The default never overrides a tag the element already carries (an add-method that
        // updates an existing method keeps the tag it was created with).
        if (!explicitGiven && readElementTags(xml, target.kind, name) !== undefined) {
          return { ok: true, xml, changed: false, message: 'already tagged' };
        }
        return setElementTags(xml, target.kind, name, tags, mode);
      });
      // The default is silent where this object type cannot carry the element's tag (view / map fields, …).
      if (!r.ok && !(source === 'default' && r.message.includes('not supported'))) {
        notes.push(`Tags not written for ${target.kind} ${name}: ${r.message}`);
      }
    }
    // A relation carries its constraints' tags too (the shipped convention).
    if (target.kind === 'relation') {
      const raw = await fs.readFile(filePath, 'utf-8');
      for (const c of constraintNamesOf(raw, target.names[0])) {
        const cr = await editFile(filePath, xml => {
          if (!explicitGiven && readElementTags(xml, 'constraint', c, target.names[0]) !== undefined) {
            return { ok: true, xml, changed: false, message: 'already tagged' };
          }
          return setElementTags(xml, 'constraint', c, tags, mode, target.names[0]);
        });
        if (!cr.ok) notes.push(`Tags not written for constraint ${c}: ${cr.message}`);
      }
    }
  } catch (e) {
    notes.push(`Tags not written: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (notes.length === 0) {
    notes.push(
      `Tags "${normalizeTagsInput(tags)}" on ${target.kind} ${target.names.join(', ')} ` +
      `(${source === 'default' ? 'D365FO_DEFAULT_TAG' : 'tags argument'}); pass tags="" to opt out.`,
    );
  }
  return banner(notes);
}

/**
 * modify-property with propertyPath "Tags": set (replace / add / remove) or clear (empty value) the
 * object's own Tags. Returns null when the call is not about Tags.
 */
export async function modifyObjectTagsProperty(
  filePath: string,
  a: { propertyPath?: string; propertyValue?: string; controlName?: string; dataSourceName?: string; tagsMode?: unknown },
): Promise<{ success: boolean; message: string } | null> {
  const propertyPath = a.propertyPath ?? '';
  const propertyValue = a.propertyValue ?? '';
  const mode = parseTagsMode(a.tagsMode);
  if (a.controlName || a.dataSourceName) return null;
  if (propertyPath.trim().toLowerCase() !== 'tags') return null;
  const value = normalizeTagsInput(propertyValue) ?? '';
  const r = await editFile(filePath, xml => {
    if (value === '') return setObjectTags(xml, null);
    return setObjectTags(xml, value, mode);
  });
  return { success: r.ok, message: r.ok ? `${r.message} (in canonical element order). File: ${filePath}` : `❌ Tags not written: ${r.message}` };
}

/**
 * Security objects have no bridge write path: modify-property serves only Tags on them (the gate
 * admits the pair, this refuses every other property). Null when the type is not a security type.
 */
export function securityPropertyRefusal(objectType: string, propertyPath: string): string | null {
  if (!/^security-(privilege|duty|role)(-extension)?$/i.test(objectType)) return null;
  return `❌ modify-property on '${objectType}' supports only propertyPath="Tags" (got "${propertyPath}"). ` +
    'Use add-/remove-privilege, add-/remove-duty or add-/remove-entry-point for the other contents.';
}
