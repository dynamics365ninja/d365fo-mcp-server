/**
 * Workspace form patterns.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/workspace-form-pattern
 *
 * Two flavors exist in metadata:
 *  - 'Workspace' — the original tabbed-panorama workspace (used by the local template)
 *  - 'WorkspaceOperational' — the preferred, performance-enhanced operational workspace
 * Exact xmlNames/versions are cross-checked by mining (Phase 3).
 */

import type { FormPatternSpec } from '../../types.js';
import { actionPane } from './common.js';

export const workspacePanorama: FormPatternSpec = {
  id: 'Workspace',
  xmlName: 'TabbedWorkspace',
  xmlAliases: ['Workspace'],
  displayName: 'Workspace (Tabbed Panorama)',
  versions: ['1.0'],
  purpose:
    'Activity overview page: a horizontally scrolling panorama with a tile/KPI summary section ' +
    'followed by list/chart/link sections. Primary means of navigation for an activity.',
  whenToUse: [
    'Overview dashboard for an operational activity (work queues, KPIs, quick links)',
    'Primary navigation hub combining tiles, lists, and links',
  ],
  whenNotToUse: [
    'New workspaces should prefer the Operational Workspace pattern',
    'Entity maintenance → Details Master / Simple List',
  ],
  referenceForms: ['FmClerkWorkspace'],
  designProperties: { Style: 'Workspace' },
  requiresDataSource: 'none',
  root: [
    actionPane('optional'),
    {
      id: 'PanoramaBody',
      controlTypes: ['Tab'],
      occurrence: 'required',
      nameHint: 'PanoramaBody',
      properties: { Style: 'Panorama' },
      children: [
        {
          id: 'PanoramaSection',
          controlTypes: ['TabPage'],
          occurrence: 'oneOrMore',
          extraChildren: 'any',
        },
      ],
      extraChildren: 'none',
    },
  ],
  extraRootChildren: 'any',
  lifecycleGuidance: [
    'Tile counts come from menu items with query-based counts or unbound fields refreshed in executeQuery().',
    'Each panorama list section typically binds its own datasource or Form Part.',
  ],
};

export const formPartSectionList: FormPatternSpec = {
  id: 'FormPartSectionList',
  xmlName: 'FormPartSectionList',
  xmlAliases: ['SectionList', 'WorkspaceSectionList'],
  displayName: 'Form Part Section List',
  versions: ['1.2', '1.1', '1.0'],
  purpose:
    'A list shown in a workspace section — modeled as a separate form and rendered in the ' +
    'workspace via a Form Part control.',
  whenToUse: ['List section of an Operational Workspace (work queue, recent items)'],
  referenceForms: ['FMRentalsToStartPart'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'SectionBody',
      controlTypes: ['Group', 'Grid'],
      occurrence: 'oneOrMore',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
  notes: ['Variant "Section List - Double" adds a secondary hidden list.'],
};

export const formPartSectionListDouble: FormPatternSpec = {
  id: 'FormPartSectionListDouble',
  xmlName: 'FormPartSectionListDouble',
  xmlAliases: ['SectionListDouble', 'WorkspaceSectionListDouble'],
  variantOf: 'FormPartSectionList',
  displayName: 'Form Part Section List - Double',
  versions: ['1.2', '1.1', '1.0'],
  purpose:
    'A workspace section list with two lists — the primary visible list and a secondary hidden ' +
    'list that becomes visible on toggle (e.g. "My" vs "All" tasks).',
  whenToUse: ['Work-queue section that offers two list views the user can switch between'],
  referenceForms: ['FMRentalsDoubleListPart'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'PrimaryList',
      controlTypes: ['Group', 'Grid'],
      occurrence: 'required',
      extraChildren: 'any',
    },
    {
      id: 'SecondaryList',
      controlTypes: ['Group', 'Grid'],
      occurrence: 'optional',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};

export const hubPartChart: FormPatternSpec = {
  id: 'HubPartChart',
  xmlName: 'HubPartChart',
  xmlAliases: ['SectionChart', 'WorkspaceSectionChart'],
  displayName: 'Hub Part Chart',
  versions: ['1.0'],
  purpose: 'A chart shown in a workspace section via a Form Part control.',
  whenToUse: ['Chart section of an Operational Workspace'],
  referenceForms: ['VendInvoiceJourCountChart'],
  requiresDataSource: 'none',
  root: [
    { id: 'Chart', controlTypes: ['*'], occurrence: 'required' },
  ],
  extraRootChildren: 'any',
};

export const hubPartGrid: FormPatternSpec = {
  id: 'HubPartGrid',
  xmlName: 'HubPartGrid',
  xmlAliases: ['SectionGrid', 'WorkspaceSectionGrid'],
  displayName: 'Hub Part Grid',
  versions: ['1.0'],
  purpose: 'A grid shown in a workspace section via a Form Part control.',
  whenToUse: ['Grid/list section of an Operational Workspace rendered as a Form Part'],
  referenceForms: ['SalesOrderProcessingWorkspaceGrid'],
  requiresDataSource: 'one',
  root: [
    { id: 'Grid', controlTypes: ['Grid'], occurrence: 'required', extraChildren: 'any' },
  ],
  extraRootChildren: 'any',
};

export const workspaceOperational: FormPatternSpec = {
  id: 'WorkspaceOperational',
  xmlName: 'WorkspaceOperational',
  variantOf: 'Workspace',
  displayName: 'Operational Workspace',
  versions: ['1.1', '1.0'],
  purpose:
    'The preferred, performance-enhanced workspace variant: sections render via Form Part ' +
    'controls so content loads on demand.',
  whenToUse: ['All new workspaces'],
  referenceForms: ['FmClerkWorkspace', 'SalesOrderProcessingWorkspace'],
  requiresDataSource: 'none',
  root: [
    actionPane('optional'),
    {
      id: 'PanoramaBody',
      controlTypes: ['Tab'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
};
