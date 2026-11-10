/**
 * Wizard form pattern.
 * https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/user-interface/wizard-form-pattern
 */

import type { FormPatternSpec } from '../../types.js';

export const wizard: FormPatternSpec = {
  id: 'Wizard',
  xmlName: 'Wizard',
  displayName: 'Wizard',
  versions: ['1.2', '1.1', 'UX7 1.0'],
  purpose:
    'Displays a sequence of tab pages gathering information in a predetermined order, ' +
    'navigated with Back/Next/Finish buttons (backed by a SysWizard class).',
  whenToUse: [
    'Multi-step guided input where order matters',
    'Setup/onboarding flows broken into discrete steps',
  ],
  whenNotToUse: ['A single set of inputs → Dialog'],
  referenceForms: ['WrkCtrBulkResReqEditWizard'],
  requiresDataSource: 'none',
  root: [
    {
      id: 'WizardTabs',
      controlTypes: ['Tab'],
      occurrence: 'required',
      children: [
        { id: 'WizardStep', controlTypes: ['TabPage'], occurrence: 'oneOrMore', extraChildren: 'any' },
      ],
      extraChildren: 'none',
    },
    {
      id: 'NavigationButtons',
      controlTypes: ['ButtonGroup', 'Group'],
      occurrence: 'optional',
      extraChildren: 'any',
    },
  ],
  extraRootChildren: 'any',
  lifecycleGuidance: [
    'Pair the form with a SysWizard subclass driving step navigation and validation.',
    'Override form init() to wire the wizard class; validate each step in the wizard class, not the form.',
  ],
};
