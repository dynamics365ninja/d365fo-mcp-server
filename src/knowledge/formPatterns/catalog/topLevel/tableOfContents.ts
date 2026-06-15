/**
 * Table of Contents form pattern.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/table-of-contents-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';
import { actionPane } from './common.js';

export const tableOfContents: FormPatternSpec = {
  id: 'TableOfContents',
  xmlName: 'TableOfContents',
  displayName: 'Table of Contents',
  versions: ['1.1', '1.0'],
  purpose:
    'Displays setup/parameters information or loosely related information sets as a vertical ' +
    'table-of-contents navigation with one content region per entry.',
  whenToUse: [
    'Module parameters forms (e.g. CustParameters)',
    'Loosely related groups of setup fields navigated from a vertical list',
  ],
  whenNotToUse: ['A single simple entity → Simple List', 'A complex entity → Details Master'],
  referenceForms: ['CustParameters', 'VendParameters', 'BankParameters'],
  designProperties: { Style: 'TableOfContents' },
  requiresDataSource: 'one',
  root: [
    actionPane('optional'),
    {
      id: 'TOCTabs',
      controlTypes: ['Tab'],
      occurrence: 'required',
      properties: { Style: 'TOCList' },
      children: [
        {
          id: 'TOCSection',
          controlTypes: ['TabPage'],
          occurrence: 'oneOrMore',
          requiresSubPattern: true,
          allowedSubPatterns: [
            'FieldsFieldGroups',
            'TabularFields',
            'FillText',
            'ToolbarAndList',
            'ToolbarAndFields',
            'NestedSimpleListDetails',
          ],
          extraChildren: 'any',
        },
      ],
      extraChildren: 'none',
    },
  ],
  extraRootChildren: 'none',
  lifecycleGuidance: [
    'Parameters forms typically use a single-record datasource with InsertIfEmpty=Yes.',
    'Override form init() + datasource executeQuery() when sections load related tables.',
  ],
};

export const advancedSelection: FormPatternSpec = {
  id: 'AdvancedSelection',
  xmlName: 'AdvancedSelection',
  displayName: 'Advanced Selection',
  versions: ['1.1', '1.0'],
  purpose:
    'Multi-select dialog allowing users to choose from a list with optional filtering — the "Add" ' +
    'dialog pattern used when selecting multiple records (e.g. adding items to a group).',
  whenToUse: [
    'Multi-select scenarios where users pick several records from a list before confirming',
    '"Add/Remove" style selection dialogs',
  ],
  whenNotToUse: ['Single-value pick → Lookup patterns'],
  referenceForms: ['DirPartyLookup'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'FilterGroup',
      controlTypes: ['Group'],
      occurrence: 'optional',
      requiresSubPattern: true,
      allowedSubPatterns: ['CustomAndQuickFilters', 'CustomFilters'],
      extraChildren: 'any',
    },
    {
      id: 'SelectionGrid',
      controlTypes: ['Grid'],
      occurrence: 'required',
      extraChildren: 'any',
    },
    {
      id: 'CommitButtonGroup',
      controlTypes: ['ButtonGroup'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'none',
};
