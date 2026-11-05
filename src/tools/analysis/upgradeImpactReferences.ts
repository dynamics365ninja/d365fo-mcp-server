/**
 * Layer 1 of the upgrade impact check: `resolveXppReferences` (what `validate_code(mode="references")`
 * runs) against an index of the old and an index of the new dependency models, keeping only the
 * violations that are new. Lives under tools because the resolver does; the rest is in
 * src/metadata/upgradeImpact.ts.
 */

import type { ImpactFinding, ImpactLevel } from '../../metadata/upgradeImpact.js';
import { ourMethods } from '../../metadata/upgradeImpact.js';
import type { XppSymbolIndex } from '../../metadata/symbolIndex.js';
import type { ModelSnapshot } from '../../metadata/versionDiff.js';
import type { ReferenceViolation } from '../write/resolveReferences.js';
import { resolveXppReferences } from '../write/resolveReferences.js';

const violationKey = (v: ReferenceViolation): string => `${v.kind}|${v.identifier}`;

function levelOf(v: ReferenceViolation): ImpactLevel {
  return v.severity === 'error' ? 'error' : 'warning';
}

/**
 * Reference violations of our methods that appear against the new index and did not against the
 * old one, on names the old version had. Both indexes hold the same models of ours; only the
 * dependency models differ.
 */
export function referenceFindings(
  ours: ModelSnapshot[],
  oldIndex: XppSymbolIndex,
  newIndex: XppSymbolIndex,
  existedBefore: (name: string) => boolean,
): ImpactFinding[] {
  const out: ImpactFinding[] = [];
  const labels = { getLabelById: () => [], getLabelFileIds: () => [] };
  const oldDb = { db: oldIndex.getReadDb(), ...labels };
  const newDb = { db: newIndex.getReadDb(), ...labels };
  for (const s of ourMethods(ours)) {
    const wrapped = `class Impact {\n${s.method.source ?? ''}\n}`;
    const before = new Set(resolveXppReferences(wrapped, oldDb).violations.map(violationKey));
    for (const v of resolveXppReferences(wrapped, newDb).violations) {
      if (before.has(violationKey(v)) || v.unverifiable) continue;
      // A name that did not exist in the old version cannot have broken: our code was written
      // against another version than the one compared, which is a different question.
      const owner = v.identifier.split(/::|\.|\(/)[0];
      if (owner && !existedBefore(owner)) continue;
      out.push({
        level: levelOf(v),
        kind: `reference:${v.kind}`,
        model: s.model,
        object: s.object,
        file: s.cls.sourcePath,
        line: Math.max(1, v.line - 1),
        dependency: v.identifier,
        message: v.detail,
      });
    }
  }
  return out;
}
