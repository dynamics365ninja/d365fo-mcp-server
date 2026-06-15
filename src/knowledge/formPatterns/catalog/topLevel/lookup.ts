/**
 * Lookup form pattern class (3 variants).
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/lookup-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';
import { filterGroup, mainGrid } from './common.js';

export const lookupBasic: FormPatternSpec = {
  id: 'Lookup',
  xmlName: 'Lookup',
  displayName: 'Lookup - Basic',
  versions: ['1.2', '1.1', '1.0'],
  purpose:
    'Form used as a lookup: a grid (or tree) optimized for picking a value, with optional ' +
    'filters or buttons.',
  whenToUse: [
    'Custom lookup replacing the auto-generated one (form name conventionally ends in "Lookup")',
    'Pick-a-value scenarios launched from a control',
  ],
  whenNotToUse: [
    'A record preview is needed → Lookup w/ Preview',
    'Multiple lookup views (grid + tree) → Lookup w/ Tabs',
  ],
  referenceForms: ['SysLanguageLookup', 'HcmWorkerLookup', 'CaseCategoryLookup'],
  designProperties: { Style: 'Lookup' },
  requiresDataSource: 'one',
  root: [filterGroup('optional'), mainGrid('required')],
  // Lookups may add button groups / preview panes around the grid
  extraRootChildren: 'any',
  lifecycleGuidance: [
    'Override form init() to read the calling control via element.args().',
    'Override the datasource executeQuery() to apply context filters from the caller.',
    'Use SysTableLookup/selectMode patterns to return the picked value.',
  ],
};

export const lookupGridOnly: FormPatternSpec = {
  id: 'LookupGridOnly',
  xmlName: 'LookupGridOnly',
  variantOf: 'Lookup',
  displayName: 'Lookup - Grid Only',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Simplified lookup with only a grid (no filter bar or extra buttons) — the most common lookup variant.',
  whenToUse: ['Auto-lookup replacement where no filter bar is needed'],
  whenNotToUse: ['Filter bar needed → Lookup - Basic'],
  referenceForms: ['CurrencyCodeLookup'],
  designProperties: { Style: 'Lookup' },
  requiresDataSource: 'one',
  root: [mainGrid('required')],
  extraRootChildren: 'any',
};

export const lookupTab: FormPatternSpec = {
  id: 'LookupTab',
  xmlName: 'LookupTab',
  variantOf: 'Lookup',
  displayName: 'Lookup w/ Tabs',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Lookup with multiple tab pages offering alternative views (e.g. grid view + tree view) for picking a value.',
  whenToUse: ['Lookup that offers multiple selection modes or views in tabs'],
  whenNotToUse: ['Single grid view → Lookup - Grid Only'],
  referenceForms: ['HcmWorkerLookup'],
  designProperties: { Style: 'Lookup' },
  requiresDataSource: 'one',
  root: [
    filterGroup('optional'),
    {
      id: 'LookupTabs',
      controlTypes: ['Tab'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};

export const lookupPreview: FormPatternSpec = {
  id: 'LookupPreview',
  xmlName: 'LookupPreview',
  variantOf: 'Lookup',
  displayName: 'Lookup w/ Preview',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Lookup with a grid on the left and a preview/details pane on the right for the selected record.',
  whenToUse: ['Lookup where users need to see record details before confirming their selection'],
  whenNotToUse: ['No preview needed → Lookup - Grid Only'],
  referenceForms: ['EcoResProductVariantsPerCompany'],
  designProperties: { Style: 'Lookup' },
  requiresDataSource: 'one',
  root: [
    filterGroup('optional'),
    mainGrid('required'),
    {
      id: 'PreviewGroup',
      controlTypes: ['Group'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};
