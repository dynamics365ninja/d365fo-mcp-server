/**
 * Case mining CLI — turn a real failure description into a draft eval case
 * (docs/AGENT_EVAL_LOOP.md §9). VM-free; writes eval/cases/<id>.json.
 *
 *   tsx src/eval/improver/caseMiningCli.ts \
 *     --title "..." --tier 2 --instruction "..." --types AxClass,AxTable \
 *     [--tags coc,extension] [--id custom-slug] [--dry-run]
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { mineCaseFromFailure, writeMinedCase, type MinedFailureInput } from './caseMining.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flagSet(flag: string): boolean {
  return process.argv.includes(flag);
}

function main(): void {
  const title = arg('--title');
  const tier = arg('--tier');
  const instruction = arg('--instruction');
  const types = arg('--types');

  if (!title || !tier || !instruction || !types) {
    console.error(
      'usage: tsx src/eval/improver/caseMiningCli.ts --title "..." --tier N --instruction "..." ' +
      '--types AxClass,AxTable [--tags a,b] [--id custom-slug] [--dry-run]',
    );
    process.exit(2);
  }

  const input: MinedFailureInput = {
    title,
    tier: Number(tier) as MinedFailureInput['tier'],
    instructionHint: instruction,
    targetArtifactTypes: types.split(',').map(s => s.trim()).filter(Boolean),
    tags: arg('--tags')?.split(',').map(s => s.trim()).filter(Boolean),
    idSlug: arg('--id'),
  };

  const spec = mineCaseFromFailure(input);

  if (flagSet('--dry-run')) {
    console.log(JSON.stringify(spec, null, 2));
    return;
  }

  const casesDir = path.join(REPO_ROOT, 'eval', 'cases');
  const outFile = writeMinedCase(spec, casesDir);
  console.log(`Wrote draft case: ${path.relative(REPO_ROOT, outFile)}`);
  console.log('Next: refine `instruction` for precise reproducibility, then run it on the VM to capture the golden (§6.4) and drop golden_pending.');
}

main();
