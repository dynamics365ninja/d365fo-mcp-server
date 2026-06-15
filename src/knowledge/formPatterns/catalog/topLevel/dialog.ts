/**
 * Dialog form pattern class (6 variants) + Drop Dialog class (2 variants).
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/dialog-form-pattern
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/drop-dialog-form-pattern
 */

import type { FormPatternSpec, NodeSpec } from '../../types.js';

const dialogBody: NodeSpec = {
  id: 'DialogBody',
  controlTypes: ['Group'],
  occurrence: 'required',
  nameHint: 'DialogBody',
  properties: { Style: 'DialogContent' },
  requiresSubPattern: true,
  allowedSubPatterns: ['FieldsFieldGroups', 'TabularFields', 'FillText'],
  extraChildren: 'any',
};

const commitButtons: NodeSpec = {
  id: 'CommitButtonGroup',
  controlTypes: ['ButtonGroup'],
  occurrence: 'required',
  nameHint: 'ButtonGroup',
  properties: { Style: 'DialogCommitContainer' },
  children: [
    {
      id: 'CommitButton',
      controlTypes: ['CommandButton', 'Button', 'MenuItemButton'],
      occurrence: 'oneOrMore',
    },
  ],
  extraChildren: 'any',
};

export const dialogBasic: FormPatternSpec = {
  id: 'Dialog',
  xmlName: 'Dialog',
  displayName: 'Dialog - Basic',
  versions: ['1.2', '1.1', '1.0'],
  purpose:
    'Modal dialog that gathers or shows a small set of information, committed with OK/Cancel.',
  whenToUse: [
    'Gather a set of inputs before running an action',
    'Quick-create scenarios with a handful of fields',
  ],
  whenNotToUse: [
    'Fewer than ~5 fields attached to a button → Drop Dialog',
    'Content grouped into FastTabs/tabs → Dialog FastTabs/Tabs variants',
    'Read-only info → Dialog - Read Only',
  ],
  referenceForms: ['ProjTableCreate', 'CustOpenBalance'],
  designProperties: { Style: 'Dialog' },
  requiresDataSource: 'none',
  root: [dialogBody, commitButtons],
  extraRootChildren: 'none',
  lifecycleGuidance: [
    'Override form init() to read caller args (element.args()) and default field values.',
    'Override the OK command button clicked() to validate and apply the action.',
    'For quick-create dialogs bind a datasource and override its initValue().',
  ],
};

export const dropDialog: FormPatternSpec = {
  id: 'DropDialog',
  xmlName: 'DropDialog',
  variantOf: 'Dialog',
  displayName: 'Drop Dialog',
  versions: ['1.2', '1.1', '1.0'],
  purpose:
    'Lightweight dialog dropped from a button to gather a small set of inputs (<5 fields) ' +
    'that provide context for an action.',
  whenToUse: ['Action confirmation/parameters with fewer than ~5 fields, anchored to a button'],
  referenceForms: ['CustCollectionsNewActivityAction', 'SalesEstimates'],
  designProperties: { Style: 'DropDialog' },
  requiresDataSource: 'none',
  root: [
    {
      id: 'DialogBody',
      controlTypes: ['Group'],
      occurrence: 'required',
      requiresSubPattern: true,
      allowedSubPatterns: ['FieldsFieldGroups', 'TabularFields', 'FillText'],
      extraChildren: 'any',
    },
    commitButtons,
  ],
  extraRootChildren: 'none',
};

export const dialogFastTabs: FormPatternSpec = {
  id: 'DialogFastTabs',
  xmlName: 'DialogFastTabs',
  variantOf: 'Dialog',
  displayName: 'Dialog w/ FastTabs',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Modal dialog whose content is organized into FastTabs — for dialogs with many fields grouped by topic.',
  whenToUse: ['Dialog with >5 fields that benefit from FastTab grouping'],
  whenNotToUse: ['Few flat fields → Dialog - Basic', 'Standard tabs → Dialog w/ Tabs'],
  referenceForms: ['BankReconciliation'],
  designProperties: { Style: 'Dialog' },
  requiresDataSource: 'none',
  root: [
    {
      id: 'FastTabBody',
      controlTypes: ['Tab'],
      occurrence: 'required',
      properties: { Style: 'FastTabs' },
      extraChildren: 'any',
    },
    commitButtons,
  ],
  extraRootChildren: 'none',
};

export const dialogTabs: FormPatternSpec = {
  id: 'DialogTabs',
  xmlName: 'DialogTabs',
  variantOf: 'Dialog',
  displayName: 'Dialog w/ Tabs',
  versions: ['1.3', '1.2', '1.1', '1.0'],
  purpose: 'Modal dialog whose content is organized into standard tabs.',
  whenToUse: ['Dialog that requires tabbed navigation with standard (non-collapsible) tabs'],
  whenNotToUse: ['Use FastTabs for most dialogs'],
  referenceForms: ['SalesCreateOrder'],
  designProperties: { Style: 'Dialog' },
  requiresDataSource: 'none',
  root: [
    {
      id: 'TabBody',
      controlTypes: ['Tab'],
      occurrence: 'required',
      extraChildren: 'any',
    },
    commitButtons,
  ],
  extraRootChildren: 'none',
};

export const dialogReadOnly: FormPatternSpec = {
  id: 'DialogReadOnly',
  xmlName: 'DialogReadOnly',
  variantOf: 'Dialog',
  displayName: 'Dialog - Read Only',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Read-only modal dialog that presents information without allowing edits — no commit button required.',
  whenToUse: ['Displaying a summary or details that require user acknowledgment only'],
  whenNotToUse: ['User needs to enter data → Dialog - Basic'],
  referenceForms: ['CustTable (quick view)'],
  designProperties: { Style: 'Dialog' },
  requiresDataSource: 'none',
  root: [dialogBody],
  extraRootChildren: 'none',
};

export const dialogDoubleTabs: FormPatternSpec = {
  id: 'DialogDoubleTabs',
  xmlName: 'DialogDoubleTabs',
  variantOf: 'Dialog',
  displayName: 'Dialog w/ Double Tabs',
  versions: ['1.3', '1.2', '1.1', '1.0'],
  purpose: 'Modal dialog with two independent tab controls — typically a header group of tabs and a details group.',
  whenToUse: ['Dialog content that requires two separate tab groups at the same level'],
  whenNotToUse: ['Single tab group → Dialog w/ Tabs or Dialog w/ FastTabs'],
  referenceForms: ['BankAccountStatementImport'],
  designProperties: { Style: 'Dialog' },
  requiresDataSource: 'none',
  root: [
    { id: 'FirstTabGroup', controlTypes: ['Tab'], occurrence: 'required', extraChildren: 'any' },
    { id: 'SecondTabGroup', controlTypes: ['Tab'], occurrence: 'required', extraChildren: 'any' },
    commitButtons,
  ],
  extraRootChildren: 'none',
};

export const dropDialogReadOnly: FormPatternSpec = {
  id: 'DropDialogReadOnly',
  xmlName: 'DropDialogReadOnly',
  variantOf: 'Dialog',
  displayName: 'Drop Dialog - Read Only',
  versions: ['1.2', '1.1', '1.0'],
  purpose: 'Read-only drop dialog anchored to a button — shows summary info without allowing edits.',
  whenToUse: ['Read-only preview/summary dropped from a button'],
  whenNotToUse: ['User needs to enter data → Drop Dialog'],
  referenceForms: ['ProjForecastOnAcc'],
  designProperties: { Style: 'DropDialog' },
  requiresDataSource: 'none',
  root: [
    {
      id: 'DialogBody',
      controlTypes: ['Group'],
      occurrence: 'required',
      requiresSubPattern: true,
      allowedSubPatterns: ['FieldsFieldGroups', 'TabularFields'],
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'none',
};
