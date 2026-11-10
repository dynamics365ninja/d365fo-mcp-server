/**
 * Custom Filters sub-pattern class (2 variants).
 * Containers that display QuickFilters and any other modeled custom filters.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/custom-filter-group-subpattern
 */

import type { SubPatternSpec } from '../../types.js';

export const customAndQuickFilters: SubPatternSpec = {
  id: 'CustomAndQuickFilters',
  xmlName: 'CustomAndQuickFilters',
  displayName: 'Custom and Quick Filters',
  versions: ['1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group'],
  purpose:
    'Filter group above a grid containing a QuickFilter plus optional modeled custom filter fields. ' +
    'Used when a QuickFilter is required (the default for list-style patterns).',
  referenceForms: ['CustTable (CustomFilterGroup)', 'CustGroup (CustomFilterGroup)'],
  root: [
    {
      id: 'QuickFilter',
      controlTypes: ['QuickFilterControl'],
      occurrence: 'required',
      nameHint: 'QuickFilterControl',
    },
  ],
  // Custom filter input controls may follow the QuickFilter
  extraRootChildren: 'any',
};

export const customFilters: SubPatternSpec = {
  id: 'CustomFilters',
  xmlName: 'CustomFilters',
  displayName: 'Custom Filters',
  versions: ['1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group'],
  purpose:
    'Filter group with modeled custom filter fields only — no QuickFilter required.',
  referenceForms: ['LedgerJournalTable (TopFields)'],
  root: [],
  extraRootChildren: 'any',
};

export const customFilterSubPatterns: SubPatternSpec[] = [customAndQuickFilters, customFilters];
