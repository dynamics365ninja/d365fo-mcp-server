/**
 * List Page form pattern.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/list-page-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';
import { actionPane, filterGroup, mainGrid } from './common.js';

export const listPage: FormPatternSpec = {
  id: 'ListPage',
  xmlName: 'ListPage',
  displayName: 'List Page',
  versions: ['1.1', '1.0'],
  purpose:
    'Read-optimized grid entry point for browsing records and acting on them, typically with ' +
    'FactBoxes in the Parts node and a corresponding Details form.',
  whenToUse: [
    'Primary navigation entry point for a master entity',
    'Browsing/acting on records rather than editing them in place',
    'FactBoxes show related info; opening a record navigates to a Details form',
  ],
  whenNotToUse: [
    'In-grid editing of a simple entity → Simple List',
    'New forms generally favor Details Master with its grid view',
  ],
  referenceForms: ['SalesTableListPage', 'CustTableListPage'],
  designProperties: { Style: 'ListPage' },
  requiresDataSource: 'one',
  root: [actionPane('required'), filterGroup('optional'), mainGrid('required')],
  extraRootChildren: 'none',
  lifecycleGuidance: [
    'List pages traditionally pair with a *ListPageInteraction class for logic.',
    'Keep the grid read-only; actions live in the ActionPane.',
  ],
};
