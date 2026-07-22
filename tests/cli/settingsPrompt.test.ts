/**
 * The advanced-settings deep dive must not skip itself.
 *
 * `confirm` submits the moment `y` is pressed, so the Enter a user types right
 * after answering "yes" to "Review advanced settings?" arrives at the section
 * multiselect and submits it with nothing selected. The review the user just
 * asked for then never happened and setup walked straight on to the index step —
 * silently, which is what made it look broken rather than mis-answered.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const multiselect = vi.fn();
const confirm = vi.fn();

vi.mock('@clack/prompts', () => ({
  multiselect,
  confirm,
  text: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  isCancel: (v: unknown) => typeof v === 'symbol',
  cancel: vi.fn(),
  log: { step: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { askAdvanced } = await import('../../src/cli/settingsPrompt.js');
const { openStore } = await import('../../src/cli/settingsStore.js');

function store() {
  return openStore(fs.mkdtempSync(join(os.tmpdir(), 'd365fo-prompt-')), null);
}

beforeEach(() => {
  multiselect.mockReset();
  confirm.mockReset();
});

describe('askAdvanced', () => {
  it('asks nothing when the gate is declined', async () => {
    confirm.mockResolvedValueOnce(false);
    await askAdvanced(store(), ['index']);
    expect(multiselect).not.toHaveBeenCalled();
  });

  it('re-offers the sections when an empty selection was not meant as a skip', async () => {
    confirm
      .mockResolvedValueOnce(true)   // review advanced settings?
      .mockResolvedValueOnce(false)  // no, an empty pick was not a skip
      .mockResolvedValue(false);     // answers for the boolean settings that follow
    multiselect
      .mockResolvedValueOnce([])     // the stray Enter
      .mockResolvedValueOnce(['index']);

    await askAdvanced(store(), ['index']);

    expect(multiselect).toHaveBeenCalledTimes(2);
    // The retry pre-selects every offered area, so a second stray Enter reviews
    // them instead of skipping again.
    expect(multiselect.mock.calls[1][0].initialValues).toEqual(['index']);
  });

  it('honours an empty selection that the user confirms', async () => {
    confirm
      .mockResolvedValueOnce(true)   // review advanced settings?
      .mockResolvedValueOnce(true);  // yes, leave everything at its default
    multiselect.mockResolvedValueOnce([]);

    await askAdvanced(store(), ['index']);

    expect(multiselect).toHaveBeenCalledTimes(1);
  });
});
