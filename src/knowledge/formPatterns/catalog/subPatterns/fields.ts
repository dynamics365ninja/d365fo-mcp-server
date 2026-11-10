/**
 * Fields sub-pattern class (5 variants).
 * Containers that primarily display individual fields.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/fields-field-groups-subpattern
 */

import type { SubPatternSpec } from '../../types.js';
import { INPUT_CONTROL_TYPES } from '../../types.js';

export const fieldsFieldGroups: SubPatternSpec = {
  id: 'FieldsFieldGroups',
  xmlName: 'FieldsFieldGroups',
  displayName: 'Fields and Field Groups',
  versions: ['1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose:
    'Responsive column layout for containers that contain only fields and one level of field groups. ' +
    'The pattern sets WidthMode/HeightMode to SizeToContent — manual widths and SizeToAvailable are not allowed.',
  referenceForms: ['InventLocation (LocationNames)', 'CustTable (FastTabs pages)'],
  root: [
    {
      id: 'FieldGroup',
      controlTypes: ['Group'],
      occurrence: 'zeroOrMore',
      // Only one level of group depth is allowed.
      extraChildren: INPUT_CONTROL_TYPES,
    },
  ],
  extraRootChildren: [...INPUT_CONTROL_TYPES],
  notes: [
    'Static text and images are NOT allowed (use HelpText or form-level help instead).',
    'More than one level of group nesting is not allowed.',
  ],
};

export const tabularFields: SubPatternSpec = {
  id: 'TabularFields',
  xmlName: 'TabularFields',
  displayName: 'Tabular Fields',
  versions: ['1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Structured grid-like layout of fields, intended primarily for totals.',
  referenceForms: ['LedgerJournalTransVendPaym (Balances)'],
  root: [],
  extraRootChildren: 'any',
};

export const fillText: SubPatternSpec = {
  id: 'FillText',
  xmlName: 'FillText',
  displayName: 'Fill Text',
  versions: ['UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'A single text control that fills the container: a StaticText (an explanation) or a String (e.g. multi-line notes).',
  referenceForms: ['FmRental (Notes)', 'DataMaintenanceActionRunModeDialog (FormGroupControl)'],
  root: [
    {
      id: 'FullWidthText',
      controlTypes: ['StaticText', 'String'],
      occurrence: 'required',
      // Both are required by the platform; HeightMode defaults to SizeToContent.
      properties: { WidthMode: 'SizeToAvailable', HeightMode: 'SizeToAvailable' },
    },
  ],
  extraRootChildren: 'none',
};

export const horizontalFieldsButtonGroup: SubPatternSpec = {
  id: 'HorizontalFieldsButtonGroup',
  xmlName: 'HorizontalFieldsButtonsGroup',
  xmlAliases: ['HorizontalFieldsButtonGroup', 'HorizontalFieldsAndButtonGroup', 'FieldsAndButtonGroup'],
  displayName: 'Horizontal Fields and Button Group',
  versions: ['UX7 1.2', 'UX7 1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group'],
  purpose: 'A field (or few fields) with an inline action button on the same row.',
  referenceForms: ['SalesTable (GroupHeaderAddressHeaderOverview)'],
  root: [],
  extraRootChildren: 'any',
};

export const imagePreview: SubPatternSpec = {
  id: 'ImagePreview',
  xmlName: 'ImagePreview',
  displayName: 'Image Preview',
  versions: ['1.1', '1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Container with an image control and optional related fields.',
  referenceForms: ['RetailVisualProfile (Login)'],
  root: [
    { id: 'Image', controlTypes: ['Image'], occurrence: 'required' },
  ],
  extraRootChildren: 'any',
  notes: ['xmlName to be confirmed by mining.'],
};

export const fieldsSubPatterns: SubPatternSpec[] = [
  fieldsFieldGroups,
  tabularFields,
  fillText,
  horizontalFieldsButtonGroup,
  imagePreview,
];

// Additional mined sub-patterns

/** Sentinel for containers with no standard sub-pattern. Suppresses FP001. */
export const customSubPattern: SubPatternSpec = {
  id: 'Custom',
  xmlName: 'Custom',
  displayName: 'Custom (no standard sub-pattern)',
  versions: [],
  appliesToControlTypes: ['Group', 'TabPage', '*'],
  purpose: 'Container that does not follow a Microsoft-defined sub-pattern.',
  root: [],
  extraRootChildren: 'any',
};

export const businessCardThreeFields: SubPatternSpec = {
  id: 'BusinessCardThreeFields',
  xmlName: 'BusinessCardThreeFields',
  displayName: 'Business Card - Three Fields',
  versions: ['1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Compact card layout displaying three identifying fields for a record.',
  referenceForms: [],
  root: [],
  extraRootChildren: 'any',
};

export const businessCardStatus: SubPatternSpec = {
  id: 'BusinessCardStatus',
  xmlName: 'BusinessCardStatus',
  displayName: 'Business Card - Status',
  versions: ['1.1', '1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Card layout highlighting a status indicator alongside identifying fields.',
  referenceForms: [],
  root: [],
  extraRootChildren: 'any',
};

export const businessCardIndicator: SubPatternSpec = {
  id: 'BusinessCardIndicator',
  xmlName: 'BusinessCardIndicator',
  displayName: 'Business Card - Indicator',
  versions: ['1.1'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Card layout with a graphical indicator (e.g. traffic light) alongside fields.',
  referenceForms: [],
  root: [],
  extraRootChildren: 'any',
};

export const tabPageTabularFields: SubPatternSpec = {
  id: 'TabPageTabularFields',
  xmlName: 'TabPageTabularFields',
  displayName: 'Tab Page - Tabular Fields',
  versions: ['1.0'],
  appliesToControlTypes: ['TabPage'],
  purpose: 'Tab page containing a structured tabular layout of fields (similar to TabularFields but scoped to a tab page).',
  referenceForms: [],
  root: [],
  extraRootChildren: 'any',
};

export const entityHeader: SubPatternSpec = {
  id: 'EntityHeader',
  xmlName: 'EntityHeader',
  displayName: 'Entity Header',
  versions: ['1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Header area of an entity form showing key identifying fields above the FastTabs.',
  referenceForms: [],
  root: [],
  extraRootChildren: 'any',
};

export const allFieldsSubPatterns: SubPatternSpec[] = [
  ...fieldsSubPatterns,
  customSubPattern,
  businessCardThreeFields,
  businessCardStatus,
  businessCardIndicator,
  tabPageTabularFields,
  entityHeader,
];
