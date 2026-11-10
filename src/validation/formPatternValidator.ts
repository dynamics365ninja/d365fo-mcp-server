/**
 * Form Pattern Validator — pure structural validator for AxForm XML.
 *
 * Every pattern the platform defines is checked against the platform's own
 * definition (src/knowledge/formPatterns/platform.generated.ts, interpreted by
 * ./platformPatternMatcher.ts): the names, versions, parts, counts, order,
 * allowed sub-patterns and required property values the X++ compiler enforces.
 * The Design and every container that declares a sub-pattern are validated on
 * their own, as the compiler does. The curated catalog
 * (src/knowledge/formPatterns/catalog) only adds advice on top (datasource
 * expectations, "did you mean" names) and owns the `Custom` sentinel, which
 * declares that no Microsoft pattern applies.
 *
 * Rules:
 *   FP001 (error)   unknown <Pattern> on Design / unknown sub-pattern on a container
 *   FP002 (error)   unknown PatternVersion for a known pattern
 *         (warning) older-than-current version, missing version, or a version
 *                   newer than the generated definitions (platform drift)
 *   FP003 (error)   required part missing (e.g. SimpleList without a Grid)
 *   FP004 (error)   control not allowed where it is
 *   FP005 (error)   control out of the order the pattern prescribes
 *   FP006 (warning) container at a sub-pattern slot declares none ("unspecified")
 *   FP007 (error)   sub-pattern not allowed at this part, or applied to a control
 *                   type it does not apply to
 *   FP008 (warning) datasource expectation unmet (count / TitleDataSource)
 *   FP010 (warning) no <Pattern> declared on Design at all
 *   FP011 (error)   property value the pattern requires is not met (set in the
 *                   XML, or the metamodel default when the XML omits it)
 *
 * Severity policy: only what the compiler rejects (FP001-FP005, FP007, FP011)
 * is an error and may block writes; the rest are recommendations. FP009 (curated
 * property defaults) is retired: FP011 checks the platform's required values.
 */

import { Parser } from '../utils/xml.js';
import {
  walkFormDesign,
  type FormControlNode,
  type FormDesignInfo,
} from '../metadata/formPatternMiner.js';
import {
  resolvePattern,
  resolvePatternExact,
  resolveSubPattern,
} from '../knowledge/formPatterns/index.js';
import {
  compareVersionStrings,
  currentPlatformPattern,
  isPlatformPatternName,
  platformPattern,
  platformPatternNames,
  platformVersions,
  type PlatformPatternDefinition,
} from '../knowledge/formPatterns/platform.js';
import { matchPlatformPattern, type PatternTarget, type PlatformIssueKind } from './platformPatternMatcher.js';

// Types

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

// Helpers

const CONTAINER_TYPES = new Set(['Group', 'TabPage', 'Tab']);

/**
 * Composite platform controls whose internal child structure is managed by the
 * platform, not by the form pattern. The financial DimensionEntryControl is the
 * classic case: it nests its own Groups (one per dimension segment). The
 * validator never descends into them.
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

/** `Custom` declares "no Microsoft pattern applies" — nothing to validate. */
function isCustomPattern(name: string): boolean {
  return name.trim().toLowerCase() === 'custom';
}

// Platform-backed validation

const ISSUE_RULE: Record<PlatformIssueKind, { rule: string; severity: 'error' | 'warning' }> = {
  missing: { rule: 'FP003', severity: 'error' },
  extra: { rule: 'FP004', severity: 'error' },
  order: { rule: 'FP005', severity: 'error' },
  subPattern: { rule: 'FP007', severity: 'error' },
  target: { rule: 'FP007', severity: 'error' },
  property: { rule: 'FP011', severity: 'error' },
  unspecified: { rule: 'FP006', severity: 'warning' },
};

/**
 * Resolve the platform definition a declared pattern/version validates against,
 * emitting FP001/FP002 as the compiler sees it. Returns undefined when there is
 * nothing to match structurally (unknown name, unknown version).
 */
function resolvePlatformDefinition(
  name: string,
  version: string | undefined,
  kind: 'form' | 'sub',
  path: string,
  violations: FormPatternViolation[],
): PlatformPatternDefinition | undefined {
  const label = `${kind === 'form' ? 'pattern' : 'sub-pattern'} ${name}`;
  if (!isPlatformPatternName(name)) {
    const curated = kind === 'form' ? resolvePattern(name) : resolveSubPattern(name);
    const suggestion = curated && isPlatformPatternName(curated.xmlName) && curated.xmlName.toLowerCase() !== name.trim().toLowerCase()
      ? ` Did you mean "${curated.xmlName}"?`
      : '';
    violations.push({
      rule: 'FP001',
      severity: 'error',
      path,
      excerpt: `Unknown ${kind === 'form' ? 'form pattern' : 'sub-pattern'} "${name}" — the platform defines no pattern by this name`,
      fix: `Use a platform ${kind === 'form' ? 'form pattern' : 'sub-pattern'} name (or Custom).${suggestion}`,
    });
    return undefined;
  }

  const all = platformVersions(name);
  const current = currentPlatformPattern(name)!;
  if (!version) {
    violations.push({
      rule: 'FP002',
      severity: 'warning',
      path,
      excerpt: `${label}: no PatternVersion declared`,
      fix: `Add <PatternVersion>${current.version}</PatternVersion>.`,
    });
    return current;
  }

  const def = platformPattern(name, version);
  if (def) {
    if (def.version !== current.version) {
      violations.push({
        rule: 'FP002',
        severity: 'warning',
        path,
        excerpt: `${label}: version ${version} is older than current ${current.version}`,
        fix: `Consider upgrading to PatternVersion ${current.version} (and its structure).`,
      });
    }
    return def;
  }

  // A version past the newest one in the same scheme ("1.3" after "1.2", "UX7 1.1"
  // after "UX7 1.0") is a platform newer than the generated definitions. A
  // version in a scheme the pattern never used (FillText "1.0") is just unknown.
  const scheme = (v: string) => /^UX7\s/i.test(v);
  const sameScheme = all.filter((d) => scheme(d.version) === scheme(version));
  const newest = sameScheme.sort((a, b) => compareVersionStrings(b.version, a.version))[0];
  if (newest && compareVersionStrings(version, newest.version) > 0) {
    // A platform update newer than the generated definitions — don't block.
    violations.push({
      rule: 'FP002',
      severity: 'warning',
      path,
      excerpt: `${label}: version ${version} is newer than the platform definitions this server knows (${newest.version})`,
      fix: 'Probably a newer platform — regenerate with scripts/capture-form-pattern-definitions.ts.',
    });
    return undefined;
  }
  violations.push({
    rule: 'FP002',
    severity: 'error',
    path,
    excerpt: `${label}: unknown version "${version}" (platform versions: ${all.map((d) => d.version).join(', ')})`,
    fix: `Use PatternVersion ${current.version}.`,
  });
  return undefined;
}

function runPlatformMatch(
  target: PatternTarget,
  def: PlatformPatternDefinition,
  path: string,
  violations: FormPatternViolation[],
): void {
  for (const issue of matchPlatformPattern(target, def, path)) {
    const { rule, severity } = ISSUE_RULE[issue.kind];
    violations.push({ rule, severity, path: issue.path, excerpt: issue.message, fix: issue.fix });
  }
}

/** Validate every container below `nodes` that declares a sub-pattern. */
function validateSubPatternsDeep(
  nodes: FormControlNode[],
  parentPath: string,
  violations: FormPatternViolation[],
): void {
  for (const node of nodes) {
    if (isOpaqueControl(node)) continue;
    const path = nodePath(parentPath, node);
    if (node.pattern && !isCustomPattern(node.pattern)) {
      const def = resolvePlatformDefinition(node.pattern, node.patternVersion, 'sub', path, violations);
      if (def) {
        runPlatformMatch(
          { name: node.name, type: node.type, extension: node.extension, pattern: node.pattern, properties: node.properties, children: node.children },
          def,
          path,
          violations,
        );
      }
    }
    validateSubPatternsDeep(node.children, path, violations);
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

// Public API

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

  if (!design.pattern) {
    violations.push({
      rule: 'FP010',
      severity: 'warning',
      path: 'Design',
      excerpt: 'Form declares no <Pattern> on Design',
      fix: `Apply a form pattern (platform patterns: ${platformPatternNames('form').join(', ')}).`,
    });
  } else if (!isCustomPattern(design.pattern)) {
    const def = resolvePlatformDefinition(design.pattern, design.patternVersion, 'form', 'Design', violations);
    if (def) {
      const properties = { ...design.properties };
      if (design.style && properties.Style === undefined) properties.Style = design.style;
      runPlatformMatch(
        { name: 'Design', type: 'FormDesign', pattern: design.pattern, properties, children: design.controls },
        def,
        'Design',
        violations,
      );
    }

    // FP008 — curated datasource advice
    const spec = resolvePatternExact(design.pattern);
    const label = `pattern ${design.pattern}`;
    if (spec?.requiresDataSource === 'one' && dataSourceCount < 1) {
      violations.push({
        rule: 'FP008',
        severity: 'warning',
        path: 'DataSources',
        excerpt: `${label}: expects at least one datasource (found ${dataSourceCount})`,
        fix: 'Add a primary AxFormDataSource bound to the entity table.',
      });
    }
    if (spec?.requiresDataSource === 'headerLines' && dataSourceCount < 2) {
      violations.push({
        rule: 'FP008',
        severity: 'warning',
        path: 'DataSources',
        excerpt: `${label}: expects header + lines datasources (found ${dataSourceCount})`,
        fix: 'Add both a header datasource and a lines datasource (linked via JoinSource).',
      });
    }
  }

  validateSubPatternsDeep(design.controls, 'Design', violations);
  return report;
}

/** Parse AxForm XML and validate it against the platform pattern definitions. */
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
