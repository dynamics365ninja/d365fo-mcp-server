/**
 * add-duty, remove-duty, add-privilege and remove-privilege: what the operations
 * decide before anything is written.
 *
 * Kept out of modifyD365File.ts, which is capped (tests/utils/layering.test.ts) and
 * only routes. The XML transform is in tools/xml/securityDutyRoleXml.ts and the file
 * writers in directXmlWriters.ts.
 */

import { findBaseObjectXml } from '../../utils/baseObjectXml.js';
import { lookupSymbolNocase, type DbLike } from '../../utils/symbolLookup.js';
import {
  listSecurityReferences, SECURITY_REFERENCE_SHAPES, type SecurityReferenceKind,
} from '../xml/securityDutyRoleXml.js';
import { directXmlAddSecurityReference, directXmlRemoveSecurityReference } from './directXmlWriters.js';

const OPERATIONS: Record<string, { kind: SecurityReferenceKind; param: 'dutyName' | 'privilegeName'; adds: boolean }> = {
  'add-duty': { kind: 'duty', param: 'dutyName', adds: true },
  'remove-duty': { kind: 'duty', param: 'dutyName', adds: false },
  'add-privilege': { kind: 'privilege', param: 'privilegeName', adds: true },
  'remove-privilege': { kind: 'privilege', param: 'privilegeName', adds: false },
};

const SYMBOL_TYPE: Record<SecurityReferenceKind, string> = {
  duty: 'security-duty',
  privilege: 'security-privilege',
};

const OTHER_KIND: Record<SecurityReferenceKind, SecurityReferenceKind> = {
  duty: 'privilege',
  privilege: 'duty',
};

const quotedList = (types: readonly string[]) => types.map(t => `"${t}"`).join(' | ');

/**
 * The refusal for one of these operations on an object that has no such list, or
 * null when the pair is valid.
 *
 * Asked before the file is looked up. canBridgeModify cannot answer it: it admits
 * every listed operation on every ordinary bridge type, so add-duty on a table would
 * reach the writer, and on a security-privilege it answers "not supported by the
 * bridge", which says nothing about what to do instead.
 */
export function securityReferenceTypeRefusal(operation: string, objectType: string): string | null {
  const op = OPERATIONS[operation];
  if (!op) return null;
  const { container, objectTypes } = SECURITY_REFERENCE_SHAPES[op.kind];
  if (objectTypes.includes(objectType)) return null;

  const hint =
    objectType === 'security-privilege' ? ' A privilege holds entry points: add-entry-point / remove-entry-point.'
    : objectType.startsWith('security-duty') ? ' A duty holds privileges: add-privilege / remove-privilege.'
    : '';
  return (
    `❌ '${operation}' applies to objectType=${quotedList(objectTypes)} only — a ${objectType} has no ` +
    `<${container}> list, so nothing was written.${hint}`
  );
}

type IndexVerdict = 'found' | 'other-kind' | 'unknown' | 'unchecked';

/**
 * What the symbol index says about a referenced name.
 *
 * Both kinds are asked for separately: a duty and a privilege may share a name, so
 * only a name that exists SOLELY as the other kind is a mistake. An index holding no
 * object of the kind at all (a write-only companion) proves nothing, and "not found"
 * and "could not look" are different claims.
 */
function indexVerdict(symbolIndex: { getReadDb(): DbLike }, kind: SecurityReferenceKind, name: string): IndexVerdict {
  try {
    const db = symbolIndex.getReadDb();
    if (lookupSymbolNocase(db, name, [SYMBOL_TYPE[kind]])) return 'found';
    if (lookupSymbolNocase(db, name, [SYMBOL_TYPE[OTHER_KIND[kind]]])) return 'other-kind';
    return db.prepare('SELECT 1 FROM symbols WHERE type = ? LIMIT 1').get(SYMBOL_TYPE[kind]) ? 'unknown' : 'unchecked';
  } catch {
    return 'unchecked';
  }
}

/** The refusal for a name that exists only as the other kind. */
function wrongKindRefusal(kind: SecurityReferenceKind, name: string, objectType: string): string {
  const other = OTHER_KIND[kind];
  const otherOperation = `add-${other}`;
  const { objectTypes } = SECURITY_REFERENCE_SHAPES[other];
  return (
    `'${name}' is a ${other} in the symbol index, not a ${kind} — nothing was written. ` +
    (objectTypes.includes(objectType)
      ? `Use ${otherOperation} with ${OPERATIONS[otherOperation].param}="${name}".`
      : `${otherOperation} is the operation for it, on objectType=${quotedList(objectTypes)}.`)
  );
}

/** Warns when the base role or duty of an extension already holds the reference. */
async function baseAlreadyHoldsNote(
  kind: SecurityReferenceKind,
  name: string,
  objectType: string,
  baseNames: string[],
  symbolIndex: unknown,
): Promise<string> {
  if (!objectType.endsWith('-extension')) return '';
  const baseType = objectType.slice(0, -'-extension'.length);
  const wanted = name.toLowerCase();
  for (const baseName of baseNames) {
    try {
      const xml = await findBaseObjectXml(baseType, baseName, symbolIndex);
      if (xml && listSecurityReferences(xml, kind).some(n => n.toLowerCase() === wanted)) {
        return `⚠️ ${baseType} "${baseName}" already references ${kind} "${name}", so this extension adds ` +
          `nothing to it. The reference was written anyway.\n`;
      }
    } catch { /* advisory: a base that cannot be read must not fail the write */ }
  }
  return '';
}

/** Run one of the four operations. Null when its name parameter is missing. */
export async function applySecurityReferenceOperation(
  filePath: string,
  operation: string,
  args: Record<string, unknown>,
  target: { objectType: string; baseNames: string[]; symbolIndex: any },
): Promise<{ success: boolean; message: string; skipped?: boolean } | null> {
  const { kind, param, adds } = OPERATIONS[operation];
  const given = args[param];
  if (typeof given !== 'string') return null;
  const name = given.trim();
  if (!adds) return directXmlRemoveSecurityReference(filePath, kind, name);

  const verdict = indexVerdict(target.symbolIndex, kind, name);
  if (verdict === 'other-kind') {
    return { success: false, message: wrongKindRefusal(kind, name, target.objectType) };
  }
  const indexNote =
    verdict === 'unknown'
      ? `⚠️ No ${kind} named "${name}" is in the symbol index. The reference was written anyway: it may ` +
        `be created in this batch or not be indexed yet, but a misspelled name produces exactly this ` +
        `warning, so check the spelling.\n`
      : verdict === 'unchecked'
        ? `ℹ️ Could not verify "${name}" — this server's symbol index holds no ${kind} objects, so nothing ` +
          `was checked. Confirm the spelling.\n`
        : '';
  const baseNote = await baseAlreadyHoldsNote(kind, name, target.objectType, target.baseNames, target.symbolIndex);
  return directXmlAddSecurityReference(filePath, kind, name, indexNote + baseNote);
}
