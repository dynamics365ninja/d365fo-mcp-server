/**
 * Task form pattern class (2 LEGACY variants) — migration-only.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/task-single-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';

export const taskSingle: FormPatternSpec = {
  id: 'TaskSingle',
  // The platform pattern is "Task" (alias "Task Single"); "TaskSingle" does not compile.
  xmlName: 'Task',
  xmlAliases: ['TaskSingle', 'SimpleTask'],
  displayName: 'Task (Task Single, legacy)',
  versions: ['1.2', '1.1', 'UX7 1.0'],
  purpose: 'Legacy AX 2012-style entity form (Overview + General tabs). MIGRATION ONLY — do not use for new forms.',
  whenToUse: ['Migrating an AX 2012 form with Overview/General tabs and a single datasource'],
  whenNotToUse: ['Any NEW form — use Simple List, Simple List & Details, or Details Master instead'],
  referenceForms: ['LedgerJournalTable'],
  requiresDataSource: 'one',
  // Parts of the platform definition Task 1.2 (FormPatterns.Task_UX7.xml)
  root: [
    { id: 'ApplicationBar', controlTypes: ['ActionPane'], occurrence: 'oneOrMore', extraChildren: 'any', properties: { Style: 'Standard' } },
    {
      id: 'CustomFilterGroup', controlTypes: ['Group'], occurrence: 'optional', nameHint: 'CustomFilterGroup',
      allowedSubPatterns: ['CustomFilters'], properties: { WidthMode: 'SizeToAvailable' },
    },
    {
      id: 'Tab', controlTypes: ['Tab'], occurrence: 'required', nameHint: 'Tab',
      properties: { Style: 'Tabs', WidthMode: 'SizeToAvailable', HeightMode: 'SizeToAvailable' },
      children: [
        { id: 'OverviewTab', controlTypes: ['TabPage'], occurrence: 'required', nameHint: 'Overview', requiresSubPattern: true, allowedSubPatterns: ['ToolbarList'] },
        { id: 'OptionalTabPages', controlTypes: ['TabPage'], occurrence: 'zeroOrMore', requiresSubPattern: true },
      ],
      extraChildren: 'none',
    },
    {
      id: 'FooterGroup', controlTypes: ['Group'], occurrence: 'optional', nameHint: 'FooterGroup',
      allowedSubPatterns: ['DimensionEntryControl', 'FieldsFieldGroups', 'FillText', 'ImagePreview', 'TabularFields', 'Custom'],
      properties: { WidthMode: 'SizeToAvailable', FrameType: 'None' },
    },
  ],
  extraRootChildren: 'none',
};

export const taskDouble: FormPatternSpec = {
  id: 'TaskDouble',
  xmlName: 'TaskParentChild',
  xmlAliases: ['TaskDouble'],
  variantOf: 'TaskSingle',
  displayName: 'Task Double / Parent-Child (legacy)',
  versions: ['1.2', '1.1', 'UX7 1.0'],
  purpose: 'Legacy AX 2012-style transaction form (two stacked Overview/General sets, header + lines). MIGRATION ONLY.',
  whenToUse: ['Migrating an AX 2012 header+lines form that does not fit Details Transaction'],
  whenNotToUse: ['Any NEW form — use Details Transaction instead'],
  referenceForms: ['HRMAbsenceTableHistory', 'LedgerJournalTransDaily'],
  requiresDataSource: 'headerLines',
  // Parts of the platform definition TaskParentChild 1.2 (FormPatterns.Task_UX7.xml):
  // the child part is a Tab (not a Group), and a splitter group sits between parent and child.
  root: [
    { id: 'ApplicationBar', controlTypes: ['ActionPane'], occurrence: 'oneOrMore', extraChildren: 'any', properties: { Style: 'Standard' } },
    { id: 'CustomFilters', controlTypes: ['Group'], occurrence: 'optional', allowedSubPatterns: ['CustomFilters'], properties: { WidthMode: 'SizeToAvailable' } },
    {
      id: 'ParentTab', controlTypes: ['Tab'], occurrence: 'required', nameHint: 'ParentTab',
      properties: { Style: 'Tabs', WidthMode: 'SizeToAvailable', HeightMode: 'SizeToAvailable' },
      children: [
        { id: 'OverviewTab', controlTypes: ['TabPage'], occurrence: 'required', requiresSubPattern: true, allowedSubPatterns: ['ToolbarList'] },
        { id: 'OptionalTabPages', controlTypes: ['TabPage'], occurrence: 'zeroOrMore', requiresSubPattern: true },
      ],
      extraChildren: 'none',
    },
    {
      id: 'ParentFooterGroup', controlTypes: ['Group'], occurrence: 'optional',
      allowedSubPatterns: ['DimensionEntryControl', 'FieldsFieldGroups', 'FillText', 'ImagePreview', 'TabularFields', 'Custom'],
      properties: { WidthMode: 'SizeToAvailable', HeightMode: 'SizeToAvailable', FrameType: 'None' },
    },
    { id: 'Splitter', controlTypes: ['Group'], occurrence: 'required', nameHint: 'Splitter', properties: { Style: 'SplitterHorizontalContainer' }, extraChildren: 'none' },
    { id: 'ChildToolbar', controlTypes: ['ActionPane'], occurrence: 'optional', extraChildren: 'any', properties: { Style: 'Strip' } },
    {
      id: 'ChildTab', controlTypes: ['Tab'], occurrence: 'required', nameHint: 'ChildTab',
      properties: { Style: 'Tabs', WidthMode: 'SizeToAvailable', HeightMode: 'SizeToAvailable' },
      children: [
        { id: 'ChildOverviewTab', controlTypes: ['TabPage'], occurrence: 'required', requiresSubPattern: true, allowedSubPatterns: ['ToolbarList'] },
        { id: 'OptionalChildTabPages', controlTypes: ['TabPage'], occurrence: 'zeroOrMore', requiresSubPattern: true },
      ],
      extraChildren: 'none',
    },
  ],
  extraRootChildren: 'none',
};

export const taskPatterns: FormPatternSpec[] = [taskSingle, taskDouble];
