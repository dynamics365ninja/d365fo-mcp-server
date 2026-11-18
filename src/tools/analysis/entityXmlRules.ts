/**
 * Static checks for data-entity metadata whose failures show only when data is
 * imported through DMF or OData (#1285): no build error and no BP rule catches
 * them, and each is decidable from one XML document.
 *
 *   ENT001  AxDataEntityView child data source with UseRelations=Yes and no
 *           <Relations> of its own (the generated saveDataSources() can leave it out)
 *   XML011  Staging table (name contains Staging; DefinitionGroup + ExecutionId fields)
 *           whose alternate key contains ExecutionId but not DefinitionGroup
 *
 * Both are warnings, not errors: shipped Microsoft metadata contains the ENT001
 * shape on writable DMF entities that import correctly, so the rule can only point
 * at a place worth checking, never prove a defect.
 */
import { parseNodes, firstChild, textValueOf, type XmlNode } from '../../utils/xmlNodeTree.js';

export interface EntityRuleViolation {
  rule: string;
  severity: 'error' | 'warning';
  line?: number;
  excerpt: string;
  fix: string;
}

function lineNumber(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

function childrenNamed(n: XmlNode | undefined, name: string): XmlNode[] {
  return n ? n.children.filter(c => c.name === name) : [];
}

/** ENT001 — child data source UseRelations=Yes with an empty <Relations>. */
export function checkEntityChildRelations(code: string): EntityRuleViolation[] {
  if (!code.includes('<AxDataEntityView')) return [];
  const root = parseNodes(code);
  if (!root || root.name !== 'AxDataEntityView') return [];
  const view = firstChild(root, 'ViewMetadata');
  const rootDs = firstChild(firstChild(view ?? root, 'DataSources') ?? root, 'AxQuerySimpleRootDataSource');
  if (!view || !rootDs) return [];

  const out: EntityRuleViolation[] = [];
  const walk = (ds: XmlNode): void => {
    for (const child of childrenNamed(firstChild(ds, 'DataSources'), 'AxQuerySimpleEmbeddedDataSource')) {
      const use = firstChild(child, 'UseRelations');
      const rels = childrenNamed(firstChild(child, 'Relations'), 'AxQuerySimpleDataSourceRelation');
      if (use && textValueOf(code, use) === 'Yes' && rels.length === 0) {
        const name = textValueOf(code, firstChild(child, 'Name') ?? use);
        const table = textValueOf(code, firstChild(child, 'Table') ?? use);
        out.push({
          rule: 'ENT001',
          severity: 'warning',
          line: lineNumber(code, child.start),
          excerpt: `data source "${name}" (${table}): <UseRelations>Yes</UseRelations> with no <Relations>`,
          fix:
            'The compiler can fail to build a static path for this child, and the generated ' +
            'saveDataSources() then leaves it out: an import reports Completed and writes only the ' +
            'root. Add an explicit <AxQuerySimpleDataSourceRelation> joining it to its parent, or ' +
            'confirm a table relation exists and that a test import writes this child. Some shipped ' +
            'entities use this shape and import correctly, so this is advice, not a proof.',
        });
      }
      walk(child);
    }
  };
  walk(rootDs);
  return out;
}

/** XML011 — staging table whose alternate key is not scoped by DefinitionGroup. */
export function checkStagingAlternateKey(code: string): EntityRuleViolation[] {
  if (!code.includes('<AxTable>') && !/<AxTable[\s>]/.test(code)) return [];
  const root = parseNodes(code);
  if (!root || root.name !== 'AxTable') return [];
  const fields = childrenNamed(firstChild(root, 'Fields'), 'AxTableField')
    .map(f => textValueOf(code, firstChild(f, 'Name') ?? f));
  if (!fields.includes('DefinitionGroup') || !fields.includes('ExecutionId')) return [];
  if (!/Staging/.test(textValueOf(code, firstChild(root, 'Name') ?? root))) return [];

  const out: EntityRuleViolation[] = [];
  for (const idx of childrenNamed(firstChild(root, 'Indexes'), 'AxTableIndex')) {
    const alt = firstChild(idx, 'AlternateKey');
    if (!alt || textValueOf(code, alt) !== 'Yes') continue;
    const cols = childrenNamed(firstChild(idx, 'Fields'), 'AxTableIndexField')
      .map(f => textValueOf(code, firstChild(f, 'DataField') ?? f));
    // Only the shape that is wrong by construction: ExecutionId without DefinitionGroup. A key of
    // exactly (DefinitionGroup, ExecutionId) is how shipped single-row parameter entities are
    // staged (114 of them), so it cannot be called a defect without seeing the entity.
    if (!cols.includes('ExecutionId') || cols.includes('DefinitionGroup')) continue;
    out.push({
      rule: 'XML011',
      severity: 'warning',
      line: lineNumber(code, idx.start),
      excerpt: `staging index "${textValueOf(code, firstChild(idx, 'Name') ?? idx)}": alternate key (${cols.join(', ')})`,
      fix:
        'A staging table holds many rows per execution, so its alternate key must include ' +
        'DefinitionGroup and the entity key fields: with ExecutionId alone only one row per execution can exist and every ' +
        'row after the first fails with "The record already exists", although the source has no ' +
        'duplicates. Use DefinitionGroup, ExecutionId, <entity key fields>, as ' +
        'SalesOrderLineV2Staging does.',
    });
  }
  return out;
}
