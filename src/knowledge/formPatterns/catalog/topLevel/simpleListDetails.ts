/**
 * Simple List & Details form pattern class (3 variants).
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/simple-list-details-form-pattern
 */

import type { FormPatternSpec, NodeSpec } from '../../types.js';
import { actionPane } from './common.js';

// Left nav list: a Group with Style=SidePanel. SidePanel is a Style, not a
// sub-pattern, so this container carries no sub-pattern.
const navigationListPanel: NodeSpec = {
  id: 'NavigationList',
  controlTypes: ['Group'],
  occurrence: 'required',
  nameHint: 'GridContainer',
  properties: { Style: 'SidePanel' },
  extraChildren: 'any',
};

// Always-visible header fields above the detail tabs.
const detailsHeader: NodeSpec = {
  id: 'DetailsHeader',
  controlTypes: ['Group'],
  occurrence: 'optional',
  nameHint: 'DetailsHeader',
  allowedSubPatterns: ['FieldsFieldGroups', 'TabularFields', 'ToolbarAndFields'],
  extraChildren: 'any',
};

// The detail FastTabs ("Details Tabs"). Optional so clones of older layouts
// (Tab nested in a Group) are not rejected; the generator emits it.
const detailsTabs: NodeSpec = {
  id: 'DetailsTabs',
  controlTypes: ['Tab', 'Group'],
  occurrence: 'optional',
  nameHint: 'Tab',
  extraChildren: 'any',
};

export const simpleListDetailsListGrid: FormPatternSpec = {
  id: 'SimpleListDetails',
  xmlName: 'SimpleListDetails',
  xmlAliases: ['SimpleListDetails-Grid'],
  displayName: 'Simple List & Details - List Grid',
  versions: ['1.4', '1.3', '1.2', '1.1', '1.0'],
  purpose:
    'Maintains data for entities of medium complexity: a left navigation list (2-3 fields) ' +
    'plus a right details panel. The default Simple List & Details variant.',
  whenToUse: [
    'Entity of medium complexity (~10-25 fields)',
    'Users pick a record from a compact list and edit details on the right',
    '2-3 identifying fields are enough for the navigation list',
  ],
  whenNotToUse: [
    'More than 3 fields needed in the list → Simple List & Details - Tabular Grid',
    'Hierarchical data → Simple List & Details - Tree',
    'Fewer than ~10 fields → Simple List',
  ],
  referenceForms: ['PaymTerm', 'CustPaymModeTable', 'BankGroup'],
  designProperties: { Style: 'SimpleListDetails' },
  requiresDataSource: 'one',
  root: [actionPane('required'), navigationListPanel, detailsHeader, detailsTabs],
  extraRootChildren: 'none',
  lifecycleGuidance: [
    'Override the datasource active() to refresh dependent detail content when selection changes.',
    'Override the datasource initValue() to default new-record fields.',
  ],
  notes: [
    'Tabular Grid and Tree variants share the SimpleListDetails xmlName in metadata — ' +
      'the variant is determined by the list panel content (tabular grid / tree control).',
    'Mining confirmed: newer forms serialize as SimpleListDetails-Grid; both forms resolve to this entry.',
  ],
};

export const simpleListDetailsTree: FormPatternSpec = {
  id: 'SimpleListDetailsTree',
  xmlName: 'SimpleListDetails-Tree',
  variantOf: 'SimpleListDetails',
  displayName: 'Simple List & Details - Tree',
  versions: ['1.3', '1.2', '1.1', '1.0'],
  purpose:
    'Simple List & Details variant where the left navigation panel contains a tree control ' +
    'instead of a flat grid (for hierarchical entities).',
  whenToUse: ['Hierarchical entity where records are organized in a tree (e.g. category hierarchies)'],
  whenNotToUse: ['Flat entity list → Simple List & Details - List Grid'],
  referenceForms: ['EcoResCategoryHierarchy'],
  designProperties: { Style: 'SimpleListDetails' },
  requiresDataSource: 'one',
  root: [
    actionPane('required'),
    {
      id: 'NavigationList',
      controlTypes: ['Group'],
      occurrence: 'required',
      nameHint: 'TreeContainer',
      properties: { Style: 'SidePanel' },
      extraChildren: 'any',
    },
    detailsHeader,
    detailsTabs,
  ],
  extraRootChildren: 'none',
};
