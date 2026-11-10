/**
 * D365FO Form Pattern Catalog — registry and lookups.
 *
 * Curated from Microsoft Learn pattern guideline docs and the reference forms
 * in PackagesLocalDirectory; cross-checked against mined pattern usage from
 * the symbol index (form_patterns table) once it is populated.
 */

import type {
  FormPatternCatalog,
  FormPatternSpec,
  SubPatternSpec,
} from './types.js';

import { simpleList } from './catalog/topLevel/simpleList.js';
import { simpleListDetailsListGrid, simpleListDetailsTree } from './catalog/topLevel/simpleListDetails.js';
import { detailsMaster, detailsMasterTabs } from './catalog/topLevel/detailsMaster.js';
import { detailsTransaction } from './catalog/topLevel/detailsTransaction.js';
import { dialogBasic, dropDialog, dialogFastTabs, dialogTabs, dialogReadOnly, dialogDoubleTabs, dropDialogReadOnly } from './catalog/topLevel/dialog.js';
import { tableOfContents, advancedSelection } from './catalog/topLevel/tableOfContents.js';
import { lookupBasic, lookupTab, lookupPreview } from './catalog/topLevel/lookup.js';
import { listPage } from './catalog/topLevel/listPage.js';
import {
  workspacePanorama,
  workspaceOperational,
  formPartSectionList,
  formPartSectionListDouble,
  hubPartChart,
  hubPartGrid,
} from './catalog/topLevel/workspace.js';
import { factBoxPatterns } from './catalog/topLevel/factBox.js';
import { simpleDetailsPatterns, customPattern } from './catalog/topLevel/simpleDetails.js';
import { taskPatterns } from './catalog/topLevel/task.js';
import { wizard } from './catalog/topLevel/wizard.js';

import { customFilterSubPatterns } from './catalog/subPatterns/customFilters.js';
import { allFieldsSubPatterns } from './catalog/subPatterns/fields.js';
import { toolbarSubPatterns } from './catalog/subPatterns/toolbar.js';
import { workspaceSectionSubPatterns } from './catalog/subPatterns/workspaceSections.js';

export * from './types.js';

export const FORM_PATTERN_CATALOG: FormPatternCatalog = {
  patterns: [
    simpleList,
    simpleListDetailsListGrid,
    simpleListDetailsTree,
    detailsMaster,
    detailsMasterTabs,
    detailsTransaction,
    dialogBasic,
    dropDialog,
    dialogFastTabs,
    dialogTabs,
    dialogReadOnly,
    dialogDoubleTabs,
    dropDialogReadOnly,
    tableOfContents,
    advancedSelection,
    lookupBasic,
    lookupTab,
    lookupPreview,
    listPage,
    workspacePanorama,
    workspaceOperational,
    formPartSectionList,
    formPartSectionListDouble,
    hubPartChart,
    hubPartGrid,
    ...factBoxPatterns,
    ...simpleDetailsPatterns,
    customPattern,
    ...taskPatterns,
    wizard,
  ],
  subPatterns: [
    ...customFilterSubPatterns,
    ...allFieldsSubPatterns,
    ...toolbarSubPatterns,
    ...workspaceSectionSubPatterns,
  ],
};

const patternByKey = new Map<string, FormPatternSpec>();
for (const p of FORM_PATTERN_CATALOG.patterns) {
  patternByKey.set(p.id.toLowerCase(), p);
  patternByKey.set(p.xmlName.toLowerCase(), p);
  for (const alias of p.xmlAliases ?? []) patternByKey.set(alias.toLowerCase(), p);
}

const subPatternByKey = new Map<string, SubPatternSpec>();
for (const sp of FORM_PATTERN_CATALOG.subPatterns) {
  subPatternByKey.set(sp.id.toLowerCase(), sp);
  subPatternByKey.set(sp.xmlName.toLowerCase(), sp);
  for (const alias of sp.xmlAliases ?? []) subPatternByKey.set(alias.toLowerCase(), sp);
}

/**
 * Free-text aliases → pattern id. Absorbs the historical
 * FormPatternTemplates.normalizePattern() mappings so user/AI phrasing like
 * "list", "master", "transaction" still resolves.
 */
const PATTERN_ALIASES: Array<{ test: (s: string) => boolean; id: string }> = [
  { test: (s) => s.includes('simplelist') && s.includes('detail'), id: 'SimpleListDetails' },
  { test: (s) => s.includes('simplelist'), id: 'SimpleList' },
  { test: (s) => s.includes('listpage'), id: 'ListPage' },
  { test: (s) => s.includes('detail') && s.includes('master'), id: 'DetailsMaster' },
  { test: (s) => s.includes('detail') && s.includes('transaction'), id: 'DetailsTransaction' },
  { test: (s) => s.includes('dropdialog'), id: 'DropDialog' },
  { test: (s) => s.includes('dialog'), id: 'Dialog' },
  { test: (s) => s.includes('tableofcontents') || s.includes('toc') || s.includes('parameter'), id: 'TableOfContents' },
  { test: (s) => s.includes('lookup'), id: 'Lookup' },
  { test: (s) => s.includes('operational'), id: 'WorkspaceOperational' },
  { test: (s) => s.includes('workspace') || s.includes('panorama'), id: 'Workspace' },
  { test: (s) => s.includes('master'), id: 'DetailsMaster' },
  { test: (s) => s.includes('transaction'), id: 'DetailsTransaction' },
  { test: (s) => s.includes('list'), id: 'SimpleList' },
];

/**
 * Resolve a top-level form pattern by id, xmlName, or free-text alias.
 * Exact (case-insensitive) matches win; alias matching is a fallback.
 */
export function resolvePattern(name: string | undefined | null): FormPatternSpec | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  const exact = patternByKey.get(key);
  if (exact) return exact;

  const normalized = key.replace(/[^a-z]/g, '');
  const byNormalized = patternByKey.get(normalized);
  if (byNormalized) return byNormalized;

  for (const alias of PATTERN_ALIASES) {
    if (alias.test(normalized)) return patternByKey.get(alias.id.toLowerCase());
  }
  return undefined;
}

/**
 * Strict resolution by id/xmlName only (case-insensitive) — used by the
 * validator, where alias fuzziness would mask typos in <Pattern> values.
 */
export function resolvePatternExact(name: string | undefined | null): FormPatternSpec | undefined {
  if (!name) return undefined;
  return patternByKey.get(name.trim().toLowerCase());
}

/** Resolve a sub-pattern by id or xmlName (case-insensitive, exact only). */
export function resolveSubPattern(name: string | undefined | null): SubPatternSpec | undefined {
  if (!name) return undefined;
  return subPatternByKey.get(name.trim().toLowerCase());
}

/**
 * Sub-patterns applicable to a container control type, optionally restricted
 * to those valid under a given top-level pattern.
 */
export function subPatternsFor(
  controlType: string,
  parentPatternId?: string,
): SubPatternSpec[] {
  return FORM_PATTERN_CATALOG.subPatterns.filter((sp) => {
    if (!sp.appliesToControlTypes.includes(controlType)) return false;
    if (sp.parentPatterns && parentPatternId && !sp.parentPatterns.includes(parentPatternId)) {
      return false;
    }
    return true;
  });
}

/** All known top-level pattern xmlNames (for tool descriptions/enums) */
export function knownPatternNames(): string[] {
  return FORM_PATTERN_CATALOG.patterns.map((p) => p.xmlName);
}
