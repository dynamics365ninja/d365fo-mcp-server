/**
 * FactBox form pattern class (2 variants) — Form Parts displayed next to a
 * parent form.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/factbox-form-patterns
 */

import type { FormPatternSpec } from '../../types.js';

export const factBoxGrid: FormPatternSpec = {
  id: 'FormPartFactboxGrid',
  xmlName: 'FormPartFactboxGrid',
  xmlAliases: ['FactBoxGrid', 'FormPartFactBoxGrid'],
  displayName: 'Form Part FactBox Grid',
  versions: ['1.1', '1.0'],
  purpose: 'FactBox showing a child collection of related records as a small grid.',
  whenToUse: [
    'Related child records (e.g. contacts of a customer) shown beside a parent form',
    'Modeled as a separate form, referenced from the parent\'s Parts node',
  ],
  referenceForms: ['ContactsInfoPart'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'FactBoxGrid',
      controlTypes: ['Grid'],
      occurrence: 'required',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
  notes: ['xmlName to be confirmed by mining (Phase 3 cross-check).'],
};

export const factBoxCard: FormPatternSpec = {
  id: 'FormPartFactboxCard',
  xmlName: 'FormPartFactboxCard',
  xmlAliases: ['FactBoxCard', 'FormPartFactBoxCard'],
  displayName: 'Form Part FactBox Card',
  versions: ['1.1', '1.0'],
  purpose: 'FactBox showing a set of related fields for a single record (card style).',
  whenToUse: ['A handful of related fields (e.g. customer statistics) beside a parent form'],
  referenceForms: ['CustStatisticsStatistics'],
  requiresDataSource: 'one',
  root: [
    {
      id: 'CardBody',
      controlTypes: ['Group', '*'],
      occurrence: 'optional',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
  notes: ['xmlName to be confirmed by mining (Phase 3 cross-check).'],
};

export const factBoxPatterns: FormPatternSpec[] = [factBoxGrid, factBoxCard];
