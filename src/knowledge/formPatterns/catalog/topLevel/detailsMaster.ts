/**
 * Details Master form pattern class (2 variants).
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/details-master-form-pattern
 */

import type { FormPatternSpec, NodeSpec } from '../../types.js';
import { actionPane, filterGroup } from './common.js';

const fastTabs: NodeSpec = {
  id: 'FastTabs',
  controlTypes: ['Tab'],
  occurrence: 'required',
  nameHint: 'Tab',
  properties: { Style: 'FastTabs' },
  children: [
    {
      id: 'FastTabPage',
      controlTypes: ['TabPage'],
      occurrence: 'oneOrMore',
      requiresSubPattern: true,
      extraChildren: 'any',
    },
  ],
  extraChildren: 'none',
};

export const detailsMaster: FormPatternSpec = {
  id: 'DetailsMaster',
  xmlName: 'DetailsMaster',
  displayName: 'Details Master',
  versions: ['1.4', '1.3', 'UX7 1.2', 'UX7 1.1', 'UX7 1.0'],
  purpose:
    'Displays the details of a complex master entity on FastTabs, with a grid view and a details view ' +
    '(e.g. customers, vendors, products).',
  whenToUse: [
    'Complex primary/master entity with many fields organized into FastTabs',
    'Users switch between a grid (browse) view and a details view',
  ],
  whenNotToUse: [
    'Header + lines transaction entity → Details Transaction',
    'More than ~15 FastTabs that can be grouped → Details Master w/ Standard Tabs',
    'Medium complexity entity → Simple List & Details',
  ],
  referenceForms: ['CustTable', 'VendTable', 'EcoResProductDetailsExtended'],
  designProperties: { Style: 'DetailsFormMaster' },
  requiresDataSource: 'one',
  root: [
    actionPane('required'),
    filterGroup('optional'),
    {
      id: 'HeaderGroup',
      controlTypes: ['Group'],
      occurrence: 'optional',
      nameHint: 'HeaderGroup',
      extraChildren: 'any',
    },
    fastTabs,
  ],
  extraRootChildren: 'none',
  lifecycleGuidance: [
    'Override form init() to capture caller context (element.args()).',
    'Override the datasource active() to enable/disable controls per record state.',
    'Override the datasource validateWrite()/write() for save-time logic.',
  ],
};

export const detailsMasterTabs: FormPatternSpec = {
  id: 'DetailsMasterTabs',
  xmlName: 'DetailsMasterTabs',
  variantOf: 'DetailsMaster',
  displayName: 'Details Master w/ Standard Tabs',
  versions: ['1.4', '1.3', 'UX7 1.2'],
  purpose:
    'Details Master variant for forms with a large number of FastTabs (>15) grouped into ' +
    'categories using standard tabs.',
  whenToUse: ['More than ~15 FastTabs that can be grouped into categories'],
  referenceForms: ['HcmWorker'],
  designProperties: { Style: 'DetailsFormMaster' },
  requiresDataSource: 'one',
  root: [
    actionPane('required'),
    filterGroup('optional'),
    {
      id: 'StandardTabs',
      controlTypes: ['Tab'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
  notes: ['xmlName to be confirmed by mining (Phase 3 cross-check).'],
};
