/**
 * Form Pattern Validator — pure structural validator for AxForm XML against
 * the curated form pattern catalog (src/knowledge/formPatterns).
 *
 * Rules:
 *   FP001 (error)   unknown <Pattern> on Design / unknown sub-pattern on a container
 *   FP002 (error)   unknown PatternVersion for a known pattern
 *         (warning) known-but-older version, or version newer than catalog (PU drift)
 *   FP003 (error)   required node missing (e.g. SimpleList without a Grid)
 *   FP004 (error)   child control type not allowed in a patterned container
 *   FP005 (error)   required children out of order (e.g. Grid before ActionPane)
 *   FP006 (warning) container that requires a sub-pattern has none ("unspecified")
 *   FP007 (error)   sub-pattern applied to an unsupported control type / parent pattern,
 *                   or not allowed at this slot of the parent pattern
 *   FP008 (warning) datasource expectation unmet (count / TitleDataSource)
 *   FP009 (warning) Design/control property differs from the pattern default
 *   FP010 (warning) no <Pattern> declared on Design at all
 *
 * Severity policy: only structural rules (FP001-FP005, FP007) are errors and
 * may block writes; the rest are recommendations.
 */

import { Parser } from 'xml2js';
import {
  walkFormDesign,
  type FormControlNode,
  type FormDesignInfo,
} from '../metadata/formPatternMiner.js';
import {
  resolvePatternExact,
  resolveSubPattern,
  knownPatternNames,
  type FormPatternSpec,
  type NodeSpec,
  type ExtraChildrenPolicy,
} from '../knowledge/formPatterns/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FormPatternViolation {
  rule: string;
  severity: 'error' | 'warning';
  /** Tree path, e.g. 'Design/Tab[TabHeader]/TabPage[General]' */
  path: string;
  excerpt: string;
  fix: string;
}

export interface FormPatternReport {
  formName?: string;
  pattern?: string;
  patternVersion?: string;
  violations: FormPatternViolation[];
  coverage: { containersTotal: number; containersPatterned: number };
}

interface FormFacts {
  design: FormDesignInfo;
  dataSourceCount: number;
  formName?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CONTAINER_TYPES = new Set(['Group', 'TabPage', 'Tab']);

/**
 * Composite platform controls whose internal child structure is managed by the
 * platform, not by the form pattern. The financial DimensionEntryControl is the
 * classic case: it nests its own Groups (one per dimension segment), which a
 * pattern like FieldsFieldGroups would otherwise reject as "more than one level
 * of group nesting". Faithful clones of real shipped forms (SalesTable etc.)
 * legitimately contain these, so the validator treats them as opaque — accepted
 * wherever input controls are allowed, and never descended into.
 */
const OPAQUE_CONTROL_TYPES = new Set([
  'DimensionEntryControl',
  'DimensionExpressionEntryControl',
]);

/** True for composite controls whose interior is not governed by form patterns. */
function isOpaqueControl(node: FormControlNode): boolean {
  if (OPAQUE_CONTROL_TYPES.has(node.type)) return true;
  const hay = `${node.type} ${node.axType ?? ''}`.toLowerCase();
  return /dimension(entry|expression)/.test(hay);
}

function nodePath(parentPath: string, node: FormControlNode): string {
  return `${parentPath}/${node.type}[${node.name}]`;
}

function typeMatches(node: FormControlNode, allowed: string[]): boolean {
  return allowed.includes('*') || allowed.includes(node.type);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function checkVersion(
  declared: string | undefined,
  knownVersions: string[],
  patternLabel: string,
  path: string,
  violations: FormPatternViolation[],
): void {
  if (!declared) {
    violations.push({
      rule: 'FP002',
      severity: 'warning',
      path,
      excerpt: `${patternLabel}: no PatternVersion declared`,
      fix: `Add <PatternVersion>${knownVersions[0]}</PatternVersion>.`,
    });
    return;
  }
  if (knownVersions.includes(declared)) {
    if (declared !== knownVersions[0]) {
      violations.push({
        rule: 'FP002',
        severity: 'warning',
        path,
        excerpt: `${patternLabel}: version ${declared} is older than current ${knownVersions[0]}`,
        fix: `Consider upgrading to PatternVersion ${knownVersions[0]}.`,
      });
    }
    return;
  }
  const newest = knownVersions[0];
  if (compareVersions(declared, newest) > 0) {
    // Likely platform-update drift — the catalog lags behind, don't block
    violations.push({
      rule: 'FP002',
      severity: 'warning',
      path,
      excerpt: `${patternLabel}: version ${declared} is newer than the catalog's ${newest}`,
      fix: 'Probably a newer platform pattern version — update the catalog (versions list) after verifying.',
    });
  } else {
    violations.push({
      rule: 'FP002',
      severity: 'error',
      path,
      excerpt: `${patternLabel}: unknown version "${declared}" (known: ${knownVersions.join(', ')})`,
      fix: `Use a known PatternVersion, typically ${newest}.`,
    });
  }
}

// ── Child matching ───────────────────────────────────────────────────────────

interface MatchedPair {
  spec: NodeSpec;
  node: FormControlNode;
  actualIndex: number;
}

/**
 * Match a container's actual children against the spec'd children.
 * Emits FP003 (missing), FP004 (extra not allowed), FP005 (order) and returns
 * matched pairs for recursion.
 */
function matchChildren(
  actual: FormControlNode[],
  specs: NodeSpec[],
  extra: ExtraChildrenPolicy,
  ordered: boolean,
  parentPath: string,
  patternLabel: string,
  violations: FormPatternViolation[],
): MatchedPair[] {
  const consumed = new Array(actual.length).fill(false);
  const matched: MatchedPair[] = [];
  /** first actual index matched by each spec, in spec order (for FP005) */
  const orderProbe: Array<{ specId: string; firstIndex: number }> = [];

  for (const spec of specs) {
    const indices: number[] = [];
    for (let i = 0; i < actual.length; i++) {
      if (consumed[i]) continue;
      if (!typeMatches(actual[i], spec.controlTypes)) continue;
      indices.push(i);
      if (spec.occurrence === 'required' || spec.occurrence === 'optional') break;
    }

    if (indices.length === 0) {
      if (spec.occurrence === 'required' || spec.occurrence === 'oneOrMore') {
        violations.push({
          rule: 'FP003',
          severity: 'error',
          path: parentPath,
          excerpt: `${patternLabel}: required ${spec.controlTypes.join('/')} ("${spec.id}") is missing`,
          fix: `Add a ${spec.controlTypes[0]} control${spec.nameHint ? ` (conventionally named ${spec.nameHint})` : ''} under ${parentPath}.`,
        });
      }
      continue;
    }

    for (const i of indices) {
      consumed[i] = true;
      matched.push({ spec, node: actual[i], actualIndex: i });
    }
    orderProbe.push({ specId: spec.id, firstIndex: Math.min(...indices) });
  }

  if (ordered) {
    for (let i = 1; i < orderProbe.length; i++) {
      if (orderProbe[i].firstIndex < orderProbe[i - 1].firstIndex) {
        violations.push({
          rule: 'FP005',
          severity: 'error',
          path: parentPath,
          excerpt: `${patternLabel}: "${orderProbe[i].specId}" appears before "${orderProbe[i - 1].specId}" — pattern requires the opposite order`,
          fix: `Reorder the controls under ${parentPath}: ${specs.map((s) => s.id).join(' → ')}.`,
        });
      }
    }
  }

  for (let i = 0; i < actual.length; i++) {
    if (consumed[i]) continue;
    const child = actual[i];
    const allowedExtra =
      extra === 'any'
      || isOpaqueControl(child)
      || (Array.isArray(extra) && (extra.includes('*') || extra.includes(child.type)));
    if (!allowedExtra) {
      violations.push({
        rule: 'FP004',
        severity: 'error',
        path: nodePath(parentPath, child),
        excerpt: `${patternLabel}: control type "${child.type}" is not allowed here`,
        fix:
          extra === 'none'
            ? `Remove or relocate "${child.name}" — only [${specs.map((s) => s.controlTypes.join('/')).join(', ')}] are allowed under ${parentPath}.`
            : `Move "${child.name}" elsewhere — allowed extra types here: ${(extra as string[]).join(', ')}.`,
      });
    }
  }

  return matched;
}

/** Recursively apply a matched spec node to its actual control. */
function applySpecToNode(
  pair: MatchedPair,
  parentPath: string,
  patternLabel: string,
  topPatternId: string | undefined,
  violations: FormPatternViolation[],
): void {
  const { spec, node } = pair;
  const path = nodePath(parentPath, node);

  // FP009 — property defaults set by the pattern
  if (spec.properties) {
    for (const [prop, expected] of Object.entries(spec.properties)) {
      const actualValue = node.properties[prop];
      if (actualValue !== undefined && actualValue !== expected) {
        violations.push({
          rule: 'FP009',
          severity: 'warning',
          path,
          excerpt: `${patternLabel}: ${prop}="${actualValue}" differs from pattern default "${expected}"`,
          fix: `Set ${prop} to "${expected}" unless the deviation is intentional.`,
        });
      }
    }
  }

  // FP006 / FP007 — sub-pattern expectations on this slot
  if (node.pattern) {
    if (spec.allowedSubPatterns && spec.allowedSubPatterns.length > 0) {
      const declared = resolveSubPattern(node.pattern);
      const allowed = spec.allowedSubPatterns.some(
        (name) => name.toLowerCase() === node.pattern!.toLowerCase()
          || declared?.id.toLowerCase() === name.toLowerCase(),
      );
      if (!allowed) {
        violations.push({
          rule: 'FP007',
          severity: 'error',
          path,
          excerpt: `${patternLabel}: sub-pattern "${node.pattern}" is not allowed on "${spec.id}" (allowed: ${spec.allowedSubPatterns.join(', ')})`,
          fix: `Apply one of: ${spec.allowedSubPatterns.join(', ')}.`,
        });
      }
    }
  } else if (spec.requiresSubPattern) {
    violations.push({
      rule: 'FP006',
      severity: 'warning',
      path,
      excerpt: `${patternLabel}: container "${node.name}" has no sub-pattern (unspecified)`,
      fix:
        spec.allowedSubPatterns && spec.allowedSubPatterns.length > 0
          ? `Apply a sub-pattern: ${spec.allowedSubPatterns.join(', ')}.`
          : 'Apply an appropriate container sub-pattern (e.g. FieldsFieldGroups, ToolbarAndList).',
    });
  }

  // Recurse into spec'd children. Also runs when the spec has no explicit
  // children but restricts extras (e.g. one-level group nesting in
  // FieldsFieldGroups) — the extraChildren policy must still be enforced.
  const hasChildSpecs = (spec.children?.length ?? 0) > 0;
  const restrictsExtras = spec.extraChildren !== undefined && spec.extraChildren !== 'any';
  if (hasChildSpecs || restrictsExtras) {
    const matched = matchChildren(
      node.children,
      spec.children ?? [],
      spec.extraChildren ?? 'any',
      spec.childrenOrdered ?? true,
      path,
      patternLabel,
      violations,
    );
    for (const childPair of matched) {
      applySpecToNode(childPair, path, patternLabel, topPatternId, violations);
    }
  }
}

/**
 * Walk the whole tree validating every declared sub-pattern, independent of
 * whether the top-level spec covers that container.
 */
function validateSubPatternsDeep(
  nodes: FormControlNode[],
  parentPath: string,
  topPatternId: string | undefined,
  violations: FormPatternViolation[],
): void {
  for (const node of nodes) {
    // Opaque composite controls (DimensionEntryControl …) own their interior —
    // do not validate or descend into their managed child structure.
    if (isOpaqueControl(node)) continue;

    const path = nodePath(parentPath, node);

    if (node.pattern) {
      const sp = resolveSubPattern(node.pattern);
      if (!sp) {
        violations.push({
          rule: 'FP001',
          severity: 'error',
          path,
          excerpt: `Unknown sub-pattern "${node.pattern}" on ${node.type} "${node.name}"`,
          fix: 'Use a known container sub-pattern (e.g. FieldsFieldGroups, CustomAndQuickFilters, ToolbarAndList) or fix the spelling.',
        });
      } else {
        if (!sp.appliesToControlTypes.includes(node.type) && !sp.appliesToControlTypes.includes('*')) {
          violations.push({
            rule: 'FP007',
            severity: 'error',
            path,
            excerpt: `Sub-pattern "${sp.xmlName}" cannot be applied to control type "${node.type}" (applies to: ${sp.appliesToControlTypes.join(', ')})`,
            fix: `Move the sub-pattern to a ${sp.appliesToControlTypes[0]} container or choose a different sub-pattern.`,
          });
        }
        if (sp.parentPatterns && topPatternId && !sp.parentPatterns.includes(topPatternId)) {
          violations.push({
            rule: 'FP007',
            severity: 'error',
            path,
            excerpt: `Sub-pattern "${sp.xmlName}" is only valid inside ${sp.parentPatterns.join('/')} forms (this form: ${topPatternId})`,
            fix: 'Choose a sub-pattern supported by this form pattern.',
          });
        }
        checkVersion(node.patternVersion, sp.versions, `sub-pattern ${sp.xmlName}`, path, violations);

        const matched = matchChildren(
          node.children,
          sp.root,
          sp.extraRootChildren ?? 'any',
          true,
          path,
          `sub-pattern ${sp.xmlName}`,
          violations,
        );
        for (const pair of matched) {
          applySpecToNode(pair, path, `sub-pattern ${sp.xmlName}`, topPatternId, violations);
        }
      }
    }

    validateSubPatternsDeep(node.children, path, topPatternId, violations);
  }
}

function countContainers(nodes: FormControlNode[]): { total: number; patterned: number } {
  let total = 0;
  let patterned = 0;
  const visit = (node: FormControlNode): void => {
    if (isOpaqueControl(node)) return; // managed interior — not pattern containers
    if (CONTAINER_TYPES.has(node.type)) {
      total++;
      if (node.pattern) patterned++;
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return { total, patterned };
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Validate an already-walked design tree (used by tests and the miner path). */
export function validateFormTree(facts: FormFacts): FormPatternReport {
  const { design, dataSourceCount, formName } = facts;
  const violations: FormPatternViolation[] = [];
  const coverage = countContainers(design.controls);

  const report: FormPatternReport = {
    formName,
    pattern: design.pattern,
    patternVersion: design.patternVersion,
    violations,
    coverage: { containersTotal: coverage.total, containersPatterned: coverage.patterned },
  };

  let spec: FormPatternSpec | undefined;

  if (!design.pattern) {
    violations.push({
      rule: 'FP010',
      severity: 'warning',
      path: 'Design',
      excerpt: 'Form declares no <Pattern> on Design',
      fix: `Apply a form pattern (known: ${knownPatternNames().join(', ')}).`,
    });
  } else {
    spec = resolvePatternExact(design.pattern);
    if (!spec) {
      violations.push({
        rule: 'FP001',
        severity: 'error',
        path: 'Design',
        excerpt: `Unknown form pattern "${design.pattern}"`,
        fix: `Use one of the known patterns: ${knownPatternNames().join(', ')}.`,
      });
    }
  }

  if (spec) {
    const label = `pattern ${spec.xmlName}`;
    checkVersion(design.patternVersion, spec.versions, label, 'Design', violations);

    // FP009 — Design-level property defaults
    if (spec.designProperties) {
      for (const [prop, expected] of Object.entries(spec.designProperties)) {
        const actualValue = prop === 'Style' ? design.style : design.properties[prop];
        if (actualValue !== undefined && actualValue !== expected) {
          violations.push({
            rule: 'FP009',
            severity: 'warning',
            path: 'Design',
            excerpt: `${label}: ${prop}="${actualValue}" differs from pattern default "${expected}"`,
            fix: `Set Design.${prop} to "${expected}".`,
          });
        }
      }
    }

    // FP008 — datasource expectations
    if (spec.requiresDataSource === 'one' && dataSourceCount < 1) {
      violations.push({
        rule: 'FP008',
        severity: 'warning',
        path: 'DataSources',
        excerpt: `${label}: expects at least one datasource (found ${dataSourceCount})`,
        fix: 'Add a primary AxFormDataSource bound to the entity table.',
      });
    }
    if (spec.requiresDataSource === 'headerLines' && dataSourceCount < 2) {
      violations.push({
        rule: 'FP008',
        severity: 'warning',
        path: 'DataSources',
        excerpt: `${label}: expects header + lines datasources (found ${dataSourceCount})`,
        fix: 'Add both a header datasource and a lines datasource (linked via JoinSource).',
      });
    }

    // Structural matching of Design children
    const matched = matchChildren(
      design.controls,
      spec.root,
      spec.extraRootChildren ?? 'none',
      true,
      'Design',
      label,
      violations,
    );
    for (const pair of matched) {
      applySpecToNode(pair, 'Design', label, spec.id, violations);
    }
  }

  // Deep sub-pattern validation across the entire tree
  validateSubPatternsDeep(design.controls, 'Design', spec?.id, violations);

  return report;
}

/** Parse AxForm XML and validate it against the catalog. */
export async function validateFormPatternXml(xml: string): Promise<FormPatternReport> {
  const parser = new Parser({ explicitArray: false, mergeAttrs: true, trim: true });
  let parsed: any;
  try {
    parsed = await parser.parseStringPromise(xml);
  } catch (error) {
    return {
      violations: [
        {
          rule: 'FP000',
          severity: 'error',
          path: '(document)',
          excerpt: `XML parse error: ${error instanceof Error ? error.message.split('\n')[0] : 'invalid XML'}`,
          fix: 'Fix the XML syntax before validating the pattern.',
        },
      ],
      coverage: { containersTotal: 0, containersPatterned: 0 },
    };
  }

  const axForm = parsed?.AxForm;
  if (!axForm) {
    return {
      violations: [
        {
          rule: 'FP000',
          severity: 'error',
          path: '(document)',
          excerpt: 'Not an AxForm document (missing <AxForm> root)',
          fix: 'Pass complete AxForm XML.',
        },
      ],
      coverage: { containersTotal: 0, containersPatterned: 0 },
    };
  }

  const design = walkFormDesign(axForm.Design);

  let dataSourceCount = 0;
  const dataSourcesNode = axForm.DataSources;
  if (dataSourcesNode && typeof dataSourcesNode === 'object') {
    const ds = dataSourcesNode.AxFormDataSource || dataSourcesNode.AxFormDataSourceRoot;
    if (ds) dataSourceCount = Array.isArray(ds) ? ds.length : 1;
  }

  const formName = typeof axForm.Name === 'string' ? axForm.Name : undefined;
  return validateFormTree({ design, dataSourceCount, formName });
}

/** True when the report contains error-severity violations. */
export function hasPatternErrors(report: FormPatternReport): boolean {
  return report.violations.some((v) => v.severity === 'error');
}
