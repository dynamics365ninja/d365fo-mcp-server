/**
 * Knowledge-base audit — resolve every AOT reference extracted
 * from KNOWLEDGE_BASE against the real symbol index, so knowledge content is
 * gated the same fail-closed way generated code is.
 *
 * Split from the CLI on purpose: this module is pure (takes a `SymbolLookup`),
 * so it unit-tests VM-free with a fake index, while the CLI supplies either
 * the real 2 GB SQLite index (VM, `--capture`) or the committed snapshot
 * (CI, `--verify`).
 */

import type { KnowledgeRef } from './knowledgeRefs.js';

/** Minimal view of the symbol index the audit needs. */
export interface SymbolLookup {
  /** Case-insensitive element lookup; null when the name is not in the AOT. */
  resolve(name: string): { canonical: string; types: string[] } | null;
  /**
   * Weaker proof of existence: the name is not an indexed element of its own,
   * but real AOT elements declare it as a base class / implemented interface
   * (e.g. `IFeatureMetadata`). Real, just not indexable on its own.
   */
  isReferencedBase(name: string): boolean;
  /** Does `canonical` declare a method named `member` (case-insensitive)? */
  hasMember(canonical: string, member: string): boolean;
}

export type FindingStatus = 'unknown-type' | 'unknown-member' | 'casing';

export interface AuditFinding {
  ref: KnowledgeRef;
  status: FindingStatus;
  detail: string;
}

export interface AuditResult {
  checked: number;
  resolved: number;
  allowed: number;
  findings: AuditFinding[];
}

/**
 * Names that legitimately never appear in the symbol index — .NET BCL types
 * reachable from X++, macro/pseudo identifiers, and platform constructs the
 * metadata parser does not index. Kept as data (not code) in
 * eval/knowledge-audit.allow.json so an exception is always a reviewed,
 * justified entry rather than a silent skip.
 */
export type Allowlist = Record<string, string>;

function isAllowed(name: string, allow: Allowlist): boolean {
  if (Object.prototype.hasOwnProperty.call(allow, name)) return true;
  // Fully-qualified .NET types are recognised by namespace prefix.
  return name.startsWith('System.') || name.startsWith('Microsoft.');
}

/**
 * Member checks only make sense for element types that own methods. A
 * `Foo::bar()` where Foo is an enum/EDT is a *type-shaped* reference (e.g.
 * `NoYes::Yes`), not a call — those are accepted on the type alone.
 */
const MEMBER_BEARING = new Set(['class', 'table', 'interface', 'map', 'view', 'data-entity', 'form']);

export function auditRefs(refs: KnowledgeRef[], lookup: SymbolLookup, allow: Allowlist = {}): AuditResult {
  const findings: AuditFinding[] = [];
  let resolved = 0;
  let allowed = 0;

  for (const ref of refs) {
    if (isAllowed(ref.name, allow)) {
      allowed++;
      continue;
    }

    // X++ lets an attribute be written without its `Attribute` suffix
    // ([DataContract] == [DataContractAttribute]), so both spellings resolve.
    const suffixed = ref.kind === 'attribute' ? `${ref.name}Attribute` : null;
    let written = ref.name;
    let hit = lookup.resolve(ref.name);
    if (!hit && suffixed) {
      hit = lookup.resolve(suffixed);
      if (hit) written = suffixed;
    }
    if (!hit) {
      if (lookup.isReferencedBase(ref.name) || (suffixed && lookup.isReferencedBase(suffixed))) {
        resolved++;
        continue;
      }
      findings.push({
        ref,
        status: 'unknown-type',
        detail: `"${ref.name}" does not exist in the symbol index`,
      });
      continue;
    }

    if (hit.canonical !== written) {
      findings.push({
        ref,
        status: 'casing',
        detail: `"${written}" is spelled "${hit.canonical}" in the AOT`,
      });
      // Casing is a defect but the type is real — keep checking the member.
    } else {
      resolved++;
    }

    if (ref.member && hit.types.some(t => MEMBER_BEARING.has(t))) {
      if (!lookup.hasMember(hit.canonical, ref.member)) {
        findings.push({
          ref,
          status: 'unknown-member',
          detail: `${hit.canonical} has no method "${ref.member}"`,
        });
      }
    }
  }

  return { checked: refs.length, resolved, allowed, findings };
}

export function renderFindings(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(
    `Knowledge audit: ${result.checked} reference(s) · ${result.resolved} resolved · ` +
    `${result.allowed} allowlisted · ${result.findings.length} defect(s)`,
  );
  if (result.findings.length === 0) {
    lines.push('✅ every named API/type in KNOWLEDGE_BASE resolves against the symbol index.');
    return lines.join('\n');
  }
  const byEntry = new Map<string, AuditFinding[]>();
  for (const f of result.findings) {
    const list = byEntry.get(f.ref.entryId) ?? [];
    list.push(f);
    byEntry.set(f.ref.entryId, list);
  }
  for (const [entryId, list] of [...byEntry].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`\n▸ ${entryId} (${list.length})`);
    for (const f of list) {
      lines.push(`   [${f.status}] ${f.ref.field} · ${f.ref.kind} · ${f.detail}`);
    }
  }
  return lines.join('\n');
}

// ─── Snapshot (CI gate) ─────────────────────────────────────────────────────

export interface AuditSnapshot {
  /** ISO timestamp of the capture run. */
  capturedAt: string;
  /** `last_indexed_at` of the symbol index the capture ran against. */
  indexedAt: string;
  /** Every reference key that resolved cleanly on the VM. */
  ok: string[];
}

export function buildSnapshot(refs: KnowledgeRef[], result: AuditResult, indexedAt: string): AuditSnapshot {
  const bad = new Set(result.findings.map(f => f.ref.key));
  return {
    capturedAt: new Date().toISOString(),
    indexedAt,
    ok: refs.map(r => r.key).filter(k => !bad.has(k)).sort(),
  };
}

/**
 * CI half of the gate: no symbol index available, so every reference must be
 * covered by the committed snapshot. Editing knowledge content therefore
 * requires re-capturing the audit on the VM — knowledge cannot silently drift
 * back to unverified.
 */
export function verifyAgainstSnapshot(refs: KnowledgeRef[], snapshot: AuditSnapshot): KnowledgeRef[] {
  const ok = new Set(snapshot.ok);
  return refs.filter(r => !ok.has(r.key));
}
