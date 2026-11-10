/**
 * Workspace-related container sub-patterns (sections inside an Operational
 * Workspace) + Panorama Section form-part patterns.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/section-tiles-subpattern
 *
 * xmlNames are the platform definition names (SubPatterns.Section*.xml,
 * WorkspacePageFilterGroup.xml, FiltersAndToolbar.xml in
 * Microsoft.Dynamics.AX.Metadata.Patterns.dll). The aliases keep the names an
 * earlier version of this catalog guessed, so they still resolve to guidance.
 */

import type { SubPatternSpec } from '../../types.js';
import { platformVersions } from '../../platform.js';

function workspaceSection(
  id: string,
  xmlName: string,
  aliases: string[],
  displayName: string,
  purpose: string,
  referenceForms?: string[],
): SubPatternSpec {
  return {
    id,
    xmlName,
    xmlAliases: aliases,
    displayName,
    versions: platformVersions(xmlName).map((d) => d.version),
    appliesToControlTypes: ['Group', 'TabPage'],
    parentPatterns: ['Workspace', 'WorkspaceOperational'],
    purpose,
    referenceForms,
    root: [],
    extraRootChildren: 'any',
  };
}

export const workspaceSectionSubPatterns: SubPatternSpec[] = [
  workspaceSection(
    'WorkspaceSectionTiles',
    'SectionTiles',
    ['WorkspaceTiles', 'Workspace_Tiles'],
    'Section Tiles',
    'Set of count tiles / charts in a workspace summary section (tiles bound to menu items, charts via Form Part controls).',
    ['SalesOrderProcessingWorkspace'],
  ),
  workspaceSection(
    'WorkspaceSectionRelatedLinks',
    'SectionRelatedLinks',
    ['WorkspaceLinks', 'Workspace_RelatedLinks', 'Workspace_Links'],
    'Section Related Links',
    'Set of hyperlinks (menu item buttons) in a workspace links section.',
    ['SalesOrderProcessingWorkspace'],
  ),
  workspaceSection(
    'WorkspaceSectionTabbedList',
    'SectionTabbedList',
    ['Workspace_TabbedList'],
    'Section Tabbed List',
    'Multiple list variants in one workspace section — only one visible at a time.',
  ),
  workspaceSection(
    'WorkspaceSectionStackedChart',
    'SectionStackedChart',
    ['Workspace_StackedChart'],
    'Section Stacked Chart',
    'Up to two charts stacked in an Operational Workspace section.',
  ),
  workspaceSection(
    'WorkspaceSectionPowerBI',
    'SectionPowerBI',
    ['Workspace_PowerBI'],
    'Section Power BI',
    'Power BI content section in an Operational Workspace.',
  ),
  workspaceSection(
    'WorkspacePageFilterGroup',
    'WorkspacePageFilterGroup',
    ['Workspace_PageFilter', 'Workspace_FilterGroup'],
    'Workspace Page Filter Group',
    'A single page-level filter applied across workspace sections.',
  ),
  workspaceSection(
    'FiltersAndToolbarStacked',
    'FiltersAndToolbarStacked',
    ['FiltersAndToolbar_Stacked'],
    'Filters and Toolbar - Stacked',
    'Form Part Section List: actions BELOW filters.',
  ),
  workspaceSection(
    'FiltersAndToolbarInline',
    'FiltersAndToolbarInline',
    ['FiltersAndToolbar_Inline'],
    'Filters and Toolbar - Inline',
    'Form Part Section List: filters and actions on the SAME line.',
  ),
];
