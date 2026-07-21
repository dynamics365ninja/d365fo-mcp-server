/**
 * Fixture / INPUT-OUTPUT classifier CLI (VM-free).
 *
 *   npm run eval:fixtures            # print the classification + provisioning plan
 *   npm run eval:fixtures -- --check # CI/audit gate: exit 1 if any SHARED base is unresolved
 *
 * The audit answers the crux question of eval/ROADMAP.md step 1: of the ~50
 * ConDemo / DemoNote names the catalog mentions, which are INPUT fixtures (must
 * be pre-provisioned) vs. case OUTPUTS (must NOT be)? A SHARED base with no
 * recorded decision is a latent harness gap and fails --check.
 */

import { classifyDemoObjects, loadCases, loadFixtures, fixturesForCase } from './fixtures.js';

function main(): number {
  const check = process.argv.slice(2).includes('--check');
  const cases = loadCases();
  const cls = classifyDemoObjects(cases);
  const fixtures = loadFixtures();

  console.log(`Committed fixtures (eval/fixtures/): ${fixtures.length ? fixtures.map(f => `${f.name} [${f.objectType}]`).join(', ') : '(none)'}`);
  console.log(`\nProvisioned INPUT fixtures: ${cls.provisioned.join(', ') || '(none)'}`);

  console.log(`\nSHARED bases (referenced by >1 case):`);
  for (const s of cls.shared) {
    console.log(`  [${s.decision}] ${s.base}  <- ${s.cases.join(', ')}`);
    console.log(`      ${s.note}`);
  }

  console.log(`\nOUTPUT bases (single-case, NOT provisioned): ${cls.outputs.length}`);
  for (const o of cls.outputs) console.log(`  ${o.base}  (${o.case})`);

  console.log(`\nPer-case provisioning plan (cases needing a fixture):`);
  for (const c of cases) {
    const need = fixturesForCase(c.id, cases);
    if (need.length) console.log(`  ${c.id}: ${need.join(', ')}`);
  }

  // A provisioned fixture with no committed definition file is a broken plan.
  const haveFiles = new Set(fixtures.map(f => f.name));
  const missingFiles = cls.provisioned.filter(n => !haveFiles.has(n));
  if (missingFiles.length) {
    console.error(`\n❌ provisioned fixtures with no eval/fixtures/*.metadata.xml: ${missingFiles.join(', ')}`);
    return 1;
  }

  if (cls.unresolved.length) {
    console.error(`\n❌ unresolved SHARED bases (add a SHARED_DECISIONS entry): ${cls.unresolved.join(', ')}`);
    return 1;
  }
  if (check) console.log(`\n✅ classification resolved — ${cls.provisioned.length} fixture(s), ${cls.shared.length} shared, ${cls.outputs.length} outputs.`);
  return 0;
}

process.exit(main());
