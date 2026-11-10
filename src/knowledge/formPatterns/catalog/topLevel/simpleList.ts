/**
 * Simple List form pattern.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/simple-list-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';
import { actionPane, filterGroup, mainGrid } from './common.js';

export const simpleList: FormPatternSpec = {
  id: 'SimpleList',
  xmlName: 'SimpleList',
  displayName: 'Simple List',
  versions: ['1.1', 'UX7 1.0'],
  purpose:
    'Maintains data for simple entities as a single editable grid with fewer than ~10 fields per record. ' +
    'The default pattern for setup/group tables.',
  whenToUse: [
    'Simple entity (setup table, group table) with < 10 fields per record',
    'Users maintain records directly in a grid',
    'No detail panel is needed — the grid shows everything',
  ],
  whenNotToUse: [
    'More than ~10 fields → use Simple List & Details',
    'Read-only browsing entry point with FactBoxes → use List Page',
    'Complex master entity → use Details Master',
  ],
  referenceForms: ['CustGroup', 'VendGroup', 'CustClassificationGroup'],
  designProperties: { Style: 'SimpleList' },
  requiresDataSource: 'one',
  // SimpleList 1.1 requires the custom filter group (part CustomFilterGroup, Count 1).
  root: [actionPane('required'), filterGroup('required'), mainGrid('required')],
  extraRootChildren: 'none',
  lifecycleGuidance: [
    'Usually no form methods are needed — the grid binds straight to the datasource.',
    'Override the datasource initValue() to default new-record fields.',
    'Override the datasource validateWrite() for cross-field validation before save.',
  ],
};
