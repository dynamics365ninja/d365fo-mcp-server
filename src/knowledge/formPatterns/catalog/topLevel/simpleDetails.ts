/**
 * Simple Details form pattern class (4 variants) — focused on a single record.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/simple-details-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';

export const simpleDetailsToolbarFields: FormPatternSpec = {
  id: 'SimpleDetails',
  xmlName: 'SimpleDetails-ToolbarFields',
  xmlAliases: ['SimpleDetails', 'SimpleDetailsToolbarFields', 'SimpleDetailsWToolbar'],
  displayName: 'Simple Details w/ Toolbar and Fields',
  versions: ['1.3', '1.1', '1.0'],
  purpose: 'Shows fields for a single base record with an optional toolbar — the default Simple Details variant.',
  whenToUse: [
    'Form focused on ONE record (no grid/list navigation)',
    'A flat set of fields with a toolbar for actions',
  ],
  whenNotToUse: [
    'Fields organized into FastTabs → Simple Details w/ FastTabs',
    'Multiple records → Simple List / Simple List & Details',
  ],
  referenceForms: ['AgreementLine'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'Toolbar',
      controlTypes: ['ActionPane', 'ActionPaneTab'],
      occurrence: 'optional',
      extraChildren: 'any',
    },
    {
      id: 'FieldsBody',
      controlTypes: ['Group', 'Tab'],
      occurrence: 'oneOrMore',
      requiresSubPattern: false,
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
  lifecycleGuidance: [
    'Override the datasource active()/validateWrite() for record-state logic.',
  ],
  notes: [
    'Variants (FastTabs / Standard Tabs / Panorama) share the Simple Details class; ' +
      'the variant is the body container style. Mining confirmed: newer forms serialize as ' +
      'SimpleDetails-FastTabsContainer or SimpleDetails-StandardTabsContainer.',
  ],
};

export const simpleDetailsFastTabs: FormPatternSpec = {
  id: 'SimpleDetailsFastTabs',
  xmlName: 'SimpleDetails-FastTabsContainer',
  variantOf: 'SimpleDetails',
  displayName: 'Simple Details w/ FastTabs',
  versions: ['1.4', '1.1', '1.0'],
  purpose: 'Shows fields for a single record organized into FastTabs — the most common multi-tab Simple Details variant.',
  whenToUse: [
    'Form focused on ONE record with fields grouped into FastTabs (5-15+ fields)',
    'No grid/list navigation, just a collapsible tab layout',
  ],
  whenNotToUse: [
    'Flat field set without grouping → Simple Details w/ Toolbar and Fields',
    'Standard (non-collapsible) tabs → Simple Details w/ Standard Tabs',
  ],
  referenceForms: ['ProjCategory', 'InventModelGroup'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'Toolbar',
      controlTypes: ['ActionPane', 'ActionPaneTab'],
      occurrence: 'optional',
      extraChildren: 'any',
    },
    {
      id: 'FastTabs',
      controlTypes: ['Tab'],
      occurrence: 'required',
      properties: { Style: 'FastTabs' },
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};

export const simpleDetailsStandardTabs: FormPatternSpec = {
  id: 'SimpleDetailsStandardTabs',
  xmlName: 'SimpleDetails-StandardTabsContainer',
  variantOf: 'SimpleDetails',
  displayName: 'Simple Details w/ Standard Tabs',
  versions: ['1.5', '1.1', '1.0'],
  purpose: 'Shows fields for a single record organized into standard (non-collapsible) tab pages.',
  whenToUse: [
    'Form focused on ONE record where fields are best shown in standard tabs',
    'When FastTabs visual style is not appropriate',
  ],
  whenNotToUse: [
    'FastTabs preferred for most modern forms',
  ],
  referenceForms: ['HcmPositionDetail'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'Toolbar',
      controlTypes: ['ActionPane', 'ActionPaneTab'],
      occurrence: 'optional',
      extraChildren: 'any',
    },
    {
      id: 'StandardTabs',
      controlTypes: ['Tab'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};

export const simpleDetailsPanorama: FormPatternSpec = {
  id: 'SimpleDetailsPanorama',
  xmlName: 'SimpleDetails-Panorama',
  variantOf: 'SimpleDetails',
  displayName: 'Simple Details w/ Panorama',
  versions: ['1.1', '1.0'],
  purpose: 'Simple Details variant with a panorama-style horizontal scroll layout inside the details body.',
  whenToUse: ['Single-record form with a panorama layout (rare — workspace-style UX for a detail form)'],
  whenNotToUse: ['Standard detail forms — prefer FastTabs or Toolbar/Fields variants'],
  referenceForms: ['CustCollectionsLetterCreate'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'PanoramaBody',
      controlTypes: ['Tab'],
      occurrence: 'required',
      properties: { Style: 'Panorama' },
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};

export const simpleDetailsPatterns: FormPatternSpec[] = [
  simpleDetailsToolbarFields,
  simpleDetailsFastTabs,
  simpleDetailsStandardTabs,
  simpleDetailsPanorama,
];

/**
 * Sentinel entry for forms marked as Custom — no standard pattern is enforced.
 * Prevents FP001 false-positives; not a prescriptive recommendation.
 */
export const customPattern: FormPatternSpec = {
  id: 'Custom',
  xmlName: 'Custom',
  displayName: 'Custom (no standard pattern)',
  versions: [],
  purpose: 'Indicates the form does not follow a Microsoft-defined pattern. Not for use in new development.',
  whenToUse: [],
  whenNotToUse: ['Any new form — select the appropriate Microsoft-defined pattern instead.'],
  referenceForms: [],
  root: [],
  extraRootChildren: 'any',
  notes: ['Treated as unstructured — the pattern validator does not enforce structure for Custom forms.'],
};
