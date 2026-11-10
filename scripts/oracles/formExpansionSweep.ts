/**
 * Expansion sweep: every form the pattern expander builds, judged by the
 * platform's own PatternAnalyzer (scripts/oracles/patternAnalyzer.ts).
 *
 *   npm run oracle:form-expansions
 *
 * tests/utils/formControlExpander.test.ts holds the expander to our TypeScript
 * validator in CI. This sweep holds it to the engine the compiler runs, which
 * also sees what the validator cannot: the AOT deserializer drops an element
 * written out of order, so a property the XML sets can still be missing when the
 * engine reads the form. A negative control (DialogTabs with Design Style Auto)
 * must fail, so a sweep that checks nothing cannot pass.
 *
 * Windows only, read only: the forms go to a temporary metadata store that is
 * removed afterwards. Exit code 1 when an expansion fails or the control passes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { analyze, buildProbe, fixtureStore, packagesRoot } from './patternAnalyzer.js';
import { canExpandPattern, expandPatternToXml } from '../../src/utils/formControlExpander.js';
import { FORM_PATTERN_CATALOG } from '../../src/knowledge/formPatterns/index.js';

/** Patterns generate_smart_form builds from hand-written templates, not the expander. */
const TEMPLATED = new Set([
  'SimpleList', 'SimpleListDetails', 'DetailsMaster', 'DetailsTransaction',
  'Dialog', 'TableOfContents', 'Lookup', 'ListPage', 'Workspace',
]);
const NEGATIVE = 'ZzExpansionNegativeControl';

function main(): void {
  const root = packagesRoot();
  const { store } = fixtureStore();
  const dir = path.join(store, 'FormPatternFixtures', 'FormPatternFixtures', 'AxForm');
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));

  const forms: string[] = [];
  const specs = FORM_PATTERN_CATALOG.patterns.filter((p) => !TEMPLATED.has(p.xmlName) && canExpandPattern(p));
  for (const spec of specs) {
    const name = `ZzExpansion${spec.xmlName.replace(/[^A-Za-z0-9]/g, '')}`;
    const xml = expandPatternToXml(spec, {
      formName: name, dsName: 'ExpansionTable', dsTable: 'ExpansionTable', caption: 'Expansion', gridFields: ['FieldA', 'FieldB'],
    });
    fs.writeFileSync(path.join(dir, `${name}.xml`), xml);
    forms.push(name);
  }
  const dialog = FORM_PATTERN_CATALOG.patterns.find((p) => p.xmlName === 'DialogTabs');
  if (!dialog) throw new Error('DialogTabs is missing from the catalog');
  const negative = expandPatternToXml(dialog, { formName: NEGATIVE, caption: 'Expansion' })
    .replace('<Style xmlns="">Dialog</Style>', '<Style xmlns="">Auto</Style>');
  fs.writeFileSync(path.join(dir, `${NEGATIVE}.xml`), negative);

  let verdicts;
  try {
    verdicts = analyze(buildProbe(root), store, [...forms, NEGATIVE], root);
  } finally {
    fs.rmSync(store, { recursive: true, force: true });
  }

  let failed = 0;
  for (const form of forms) {
    const own = verdicts.filter((v) => v.form === form);
    const bad = own.filter((v) => v.ok !== true);
    if (own.length === 0 || bad.length > 0) {
      failed++;
      console.log(`FAIL ${form}${own.length === 0 ? ' (the engine returned nothing)' : ''}`);
      for (const b of bad) console.log(`     ${b.path} ${b.pattern} ${b.version}: ${b.detail}`);
    }
  }
  const control = verdicts.filter((v) => v.form === NEGATIVE);
  const controlCaught = control.some((v) => v.ok === false);
  console.log(`Expanded ${forms.length} patterns: ${forms.length - failed} accepted by PatternAnalyzer, ${failed} rejected.`);
  console.log(`Negative control (DialogTabs, Style Auto): ${controlCaught ? 'rejected, as it must be' : 'NOT rejected, so the sweep checks nothing'}.`);
  if (failed > 0 || !controlCaught) process.exit(1);
}

main();
