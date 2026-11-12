/**
 * The member argument of `methodStr`, `staticMethodStr`, `tableMethodStr`,
 * `tableStaticMethodStr`, `delegateStr` and `staticDelegateStr`.
 *
 * xppc checks it, and more strictly than a name lookup (probes:
 * scripts/oracles/probes/intrinsic-members.ts, every row below FAILS):
 *  - the member must be declared on the NAMED type itself: a method or delegate
 *    only a base class declares is "does not exist", and so is a kernel table
 *    method the table does not override (`tableMethodStr(CustTable, postLoad)`);
 *  - an extension class's methods do count: they are added to the type it
 *    augments;
 *  - the kind must match: `methodStr` / `tableMethodStr` / `delegateStr` reject
 *    a static member, their `static…` twins an instance one, and `delegateStr`
 *    rejects an ordinary method;
 *  - `methodStr` takes a class only: a table or a form is "does not specify a
 *    known class" (they have `tableMethodStr` / `formMethodStr`).
 *
 * Out of reach, so never reported: form members (`formMethodStr`,
 * `formControlStr`, `formDataSourceStr` — the index holds no form methods or
 * controls), views, maps and data entities as `tableMethodStr` owners, field
 * groups and indexes (`tableFieldGroupStr`, `indexStr` — not indexed, and table
 * extensions add both).
 */

import { parseXppDeclaration } from '../../metadata/xppDeclaration.js';
import { distinctSymbolTypesNocase, lookupSymbolNocase, type DbLike } from '../../utils/symbolLookup.js';
import {
  extensionContributes,
  hasModifier,
  lookupMember,
  readMethodHeader,
  type KernelMethodSets,
  type OwnerKind,
} from './extensionTargets.js';
import type { ReferenceViolation } from './resolveReferences.js';

interface MemberSpec {
  /** Kinds of owner the index can answer for. */
  owners: OwnerKind[];
  member: 'method' | 'delegate';
  isStatic: boolean;
  /** The intrinsic for the other staticness, for the message. */
  twin: string;
}

const SPECS: Record<string, MemberSpec> = {
  methodstr: { owners: ['class'], member: 'method', isStatic: false, twin: 'staticMethodStr' },
  staticmethodstr: { owners: ['class'], member: 'method', isStatic: true, twin: 'methodStr' },
  tablemethodstr: { owners: ['table'], member: 'method', isStatic: false, twin: 'tableStaticMethodStr' },
  tablestaticmethodstr: { owners: ['table'], member: 'method', isStatic: true, twin: 'tableMethodStr' },
  delegatestr: { owners: ['class', 'table'], member: 'delegate', isStatic: false, twin: 'staticDelegateStr' },
  staticdelegatestr: { owners: ['class', 'table'], member: 'delegate', isStatic: true, twin: 'delegateStr' },
};

/** True for the intrinsics this module checks the member of. */
export function isMemberIntrinsic(fn: string): boolean {
  return fn.toLowerCase() in SPECS;
}

interface DeclaredRow {
  name: string;
  source: string | null;
  file_path: string | null;
}

/**
 * The member as declared on `owner` itself. A class and a table can share a
 * name, so when several rows answer, the one in the owner's own file wins.
 */
function declaredOn(db: DbLike, owner: { name: string; file_path: string | null }, member: string): DeclaredRow | undefined {
  const rows = db.prepare(
    `SELECT name, source, file_path FROM symbols
     WHERE parent_name = ? AND type = 'method' AND name = ? COLLATE NOCASE`,
  ).all(owner.name, member) as DeclaredRow[];
  if (rows.length === 0) return undefined;
  return rows.find(r => r.file_path && owner.file_path && r.file_path === owner.file_path) ?? rows[0];
}

/**
 * The finding for `fn(target, member)`, or null when the member is proven, or
 * undefined when the index cannot say (the caller then counts the reference as
 * verified by its target, as before).
 */
export function checkIntrinsicMember(
  db: DbLike,
  fn: string,
  target: string,
  member: string,
  line: number,
  kernel: KernelMethodSets,
): ReferenceViolation | null | undefined {
  const spec = SPECS[fn.toLowerCase()];
  if (!spec) return undefined;
  const call = `${intrinsicName(fn)}(${target}, ${member})`;
  try {
    // `delegateStr(HcmWorker, …)` names the FORM's delegate when the form shares
    // its name with a table or class, and form delegates are not indexed: all 41
    // false errors of the first shipped sweep had this shape.
    if (spec.member === 'delegate' && distinctSymbolTypesNocase(db, target).includes('form')) return undefined;

    let owner: { name: string; type: string; file_path: string | null } | undefined;
    for (const kind of spec.owners) {
      owner = lookupSymbolNocase(db, target, [kind]) ?? undefined;
      if (owner) break;
    }

    if (!owner) {
      if (fn.toLowerCase() === 'methodstr') {
        const types = distinctSymbolTypesNocase(db, target);
        const other = types.find(t => t === 'table' || t === 'form');
        if (other) {
          return {
            kind: 'wrong-member-kind',
            severity: 'error',
            line,
            identifier: call,
            detail: `methodStr() takes a class; "${target}" is a ${other}. Use ` +
              `${other === 'table' ? 'tableMethodStr' : 'formMethodStr'}(${target}, ${member}).`,
          };
        }
      }
      return undefined; // a view, map, entity or form owner: not answerable here
    }

    const row = declaredOn(db, owner, member);
    if (!row) {
      if (extensionContributes(db, owner.name, member)) return null;
      if (owner.type === 'class' && kernel.object.has(member.toLowerCase())) return undefined;
      const inherited = lookupMember(db, owner.name, member, kernel, owner.type as OwnerKind);
      const what = spec.member === 'delegate' ? 'delegate' : 'method';
      if (inherited.state === 'found' && inherited.owner !== owner.name) {
        return {
          kind: 'unknown-method',
          severity: 'error',
          line,
          identifier: call,
          detail: `"${member}" is declared on ${inherited.owner}, a base of ${owner.name}, and ${intrinsicName(fn)}() ` +
            `does not see inherited members: name the declaring type, ${intrinsicName(fn)}(${inherited.owner}, ${member}).`,
        };
      }
      return {
        kind: 'unknown-method',
        severity: 'error',
        line,
        identifier: call,
        detail: `${owner.name} declares no ${what} "${member}"` +
          (inherited.state === 'kernel' ? ' (a kernel method it does not override does not count)' : '') +
          `, so the compiler rejects ${intrinsicName(fn)}(). If an update removed or renamed it, find the ` +
          `replacement with get_object_info(name="${owner.name}"); if it was added this session, run ` +
          'update_symbol_index first.',
      };
    }

    if (!row.source) return null;
    const header = readMethodHeader(row.source);
    if (spec.member === 'delegate' && !header.isDelegate) {
      return {
        kind: 'wrong-member-kind',
        severity: 'error',
        line,
        identifier: call,
        detail: `"${row.name}" on ${owner.name} is an ordinary method, not a delegate. ` +
          'Subscribe to it with [PreHandlerFor]/[PostHandlerFor] and methodStr(), or wrap it with Chain of Command.',
      };
    }
    if (spec.member === 'method' && header.isDelegate) return undefined; // unprobed
    const decl = parseXppDeclaration(row.source, member);
    if (decl && hasModifier(decl, 'static') !== spec.isStatic) {
      return {
        kind: 'wrong-member-kind',
        severity: 'error',
        line,
        identifier: call,
        detail: `"${row.name}" on ${owner.name} is ${spec.isStatic ? 'an instance' : 'a static'} ` +
          `${spec.member}, which ${intrinsicName(fn)}() rejects. Use ${spec.twin}(${owner.name}, ${row.name}).`,
      };
    }
    return null;
  } catch {
    return undefined;
  }
}

const SPELLING: Record<string, string> = {
  methodstr: 'methodStr',
  staticmethodstr: 'staticMethodStr',
  tablemethodstr: 'tableMethodStr',
  tablestaticmethodstr: 'tableStaticMethodStr',
  delegatestr: 'delegateStr',
  staticdelegatestr: 'staticDelegateStr',
};

function intrinsicName(fn: string): string {
  return SPELLING[fn.toLowerCase()] ?? fn;
}
