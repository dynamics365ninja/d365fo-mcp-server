/**
 * Toolbar-style sub-patterns + Nested Simple List and Details.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/toolbar-list-subpattern
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/toolbar-fields-subpattern
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/nested-simple-list-details-subpattern
 */

import type { SubPatternSpec } from '../../types.js';

export const toolbarAndList: SubPatternSpec = {
  id: 'ToolbarAndList',
  xmlName: 'ToolbarList',
  xmlAliases: ['ToolbarAndList'],
  displayName: 'Toolbar and List',
  versions: ['1.2', 'UX7 1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Container with actions (ActionPaneTab toolbar) above a grid.',
  referenceForms: ['VendTable (TabCommunication)'],
  root: [
    {
      id: 'Toolbar',
      controlTypes: ['ActionPaneTab'],
      occurrence: 'optional',
    },
    {
      id: 'List',
      controlTypes: ['Grid'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};

export const toolbarAndFields: SubPatternSpec = {
  id: 'ToolbarAndFields',
  xmlName: 'ToolbarFields',
  xmlAliases: ['ToolbarAndFields'],
  displayName: 'Toolbar and Fields',
  versions: ['1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Container with actions (toolbar) above a set of fields.',
  referenceForms: ['HcmPosition (WorkerAssignmentTabPage)'],
  root: [
    {
      id: 'Toolbar',
      controlTypes: ['ActionPaneTab'],
      occurrence: 'optional',
    },
  ],
  extraRootChildren: 'any',
};

export const nestedSimpleListDetails: SubPatternSpec = {
  id: 'NestedSimpleListDetails',
  xmlName: 'NestedSimpleListDetails',
  displayName: 'Nested Simple List and Details',
  versions: ['UX7 1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose:
    'Embeds a simpler Simple List & Details layout (list panel + details panel) inside a tab ' +
    'or group of a larger form.',
  referenceForms: ['HcmJob (TaskTabPage)'],
  root: [],
  extraRootChildren: 'any',
};

export const toolbarAndListDouble: SubPatternSpec = {
  id: 'ToolbarAndListDouble',
  xmlName: 'ToolbarListDouble',
  xmlAliases: ['ToolbarAndListDouble', 'ToolbarAndList2', 'ToolbarAndListsDouble'],
  displayName: 'Toolbar and List - Double',
  versions: ['1.2', 'UX7 1.1', 'UX7 1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Container with actions above TWO grids.',
  referenceForms: ['SalesQuickQuote (TabPageExistingItems)'],
  root: [
    { id: 'Toolbar', controlTypes: ['ActionPaneTab'], occurrence: 'optional' },
    { id: 'FirstList', controlTypes: ['Grid'], occurrence: 'required', extraChildren: 'any' },
    { id: 'SecondList', controlTypes: ['Grid'], occurrence: 'required', extraChildren: 'any' },
  ],
  extraRootChildren: 'any',
};

export const listPanel: SubPatternSpec = {
  id: 'ListPanel',
  xmlName: 'ListPanel',
  displayName: 'List Panel',
  versions: ['1.3', '1.2', '1.1', '1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Two lists users move items between (e.g. available ↔ selected), typically via SysListPanel.',
  referenceForms: ['CLIControls_ListPanel (FormTabPageControl1)'],
  root: [],
  extraRootChildren: 'any',
  notes: ['Usually built at runtime via SysListPanel — model the container, the class fills it.'],
};

export const dimensionEntryControl: SubPatternSpec = {
  id: 'DimensionEntryControl',
  xmlName: 'DimensionEntryControl',
  displayName: 'Dimension Entry Control',
  versions: ['1.1', '1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Tab page or group containing only a financial Dimension Entry Control.',
  referenceForms: ['CustTable (TabFinancialDimensions)'],
  root: [
    { id: 'DimensionControl', controlTypes: ['Control', '*'], occurrence: 'required' },
  ],
  extraRootChildren: 'none',
  notes: ['xmlName to be confirmed by mining.'],
};

export const dimensionExpressionBuilder: SubPatternSpec = {
  id: 'DimensionExpressionBuilder',
  xmlName: 'DimensionExpressionBuilder',
  displayName: 'Dimension Expression Builder',
  versions: ['1.0'],
  appliesToControlTypes: ['Group', 'TabPage'],
  purpose: 'Container with a Dimension Expression Builder control.',
  referenceForms: ['LedgerAllocationRuleDestination'],
  root: [],
  extraRootChildren: 'any',
  notes: ['xmlName to be confirmed by mining.'],
};

export const toolbarSubPatterns: SubPatternSpec[] = [
  toolbarAndList,
  toolbarAndListDouble,
  toolbarAndFields,
  nestedSimpleListDetails,
  listPanel,
  dimensionEntryControl,
  dimensionExpressionBuilder,
];
