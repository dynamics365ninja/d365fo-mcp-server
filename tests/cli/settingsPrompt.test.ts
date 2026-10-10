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
const text = vi.fn();

vi.mock('@clack/prompts', () => ({
  multiselect,
  confirm,
  text,
  password: vi.fn(),
  select: vi.fn(),
  isCancel: (v: unknown) => typeof v === 'symbol',
  cancel: vi.fn(),
  log: { step: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { askAdvanced, askSetting } = await import('../../src/cli/settingsPrompt.js');
const { openStore, writeSetting, readSetting } = await import('../../src/cli/settingsStore.js');
const { settingByPath } = await import('../../src/config/settings.js');

function store() {
  return openStore(fs.mkdtempSync(join(os.tmpdir(), 'd365fo-prompt-')), null);
}

beforeEach(() => {
  multiselect.mockReset();
  confirm.mockReset();
  text.mockReset();
});

it('prefills the saved SQL server and validates it in the normal text prompt', async () => {
  const target = store();
  const setting = settingByPath('sql.server')!;
  writeSetting(target, setting, 'localhost');
  text.mockImplementationOnce(async (opts: any) => {
    expect(opts.initialValue).toBe('localhost');
    expect(opts.validate('Server=x;Database=y')).toBeTruthy();
    expect(opts.validate('')).toBeUndefined();
    return opts.initialValue;
  });
  await askSetting(target, setting);
  expect(readSetting(target, setting)).toBe('localhost');
});

describe('askSetting — detected suggestions', () => {
  it('offers a detected value over the documented default, but never over a stored one', async () => {
    // sql.database defaults to AxDB; a VM whose web.config names another
    // database should be offered that one.
    const setting = settingByPath('sql.database')!;
    const fresh = store();
    text.mockImplementationOnce(async (opts: any) => {
      expect(opts.initialValue).toBe('AxDB_Other');
      return opts.initialValue;
    });
    await askSetting(fresh, setting, { initial: 'AxDB_Other' });

    const configured = store();
    writeSetting(configured, setting, 'Chosen');
    text.mockImplementationOnce(async (opts: any) => {
      expect(opts.initialValue).toBe('Chosen');
      return opts.initialValue;
    });
    await askSetting(configured, setting, { initial: 'AxDB_Other' });
  });

  it('falls back to the default when nothing is detected', async () => {
    text.mockImplementationOnce(async (opts: any) => {
      expect(opts.initialValue).toBe('AxDB');
      return opts.initialValue;
    });
    await askSetting(store(), settingByPath('sql.database')!);
  });

  it('pre-answers a yes/no question with the suggestion unless an answer is stored', async () => {
    const setting = settingByPath('sql.trustServerCertificate')!; // default false
    confirm.mockImplementationOnce(async (opts: any) => {
      expect(opts.initialValue).toBe(true);
      return opts.initialValue;
    });
    await askSetting(store(), setting, { initial: 'true' });

    const configured = store();
    writeSetting(configured, setting, false);
    confirm.mockImplementationOnce(async (opts: any) => {
      expect(opts.initialValue).toBe(false);
      return opts.initialValue;
    });
    await askSetting(configured, setting, { initial: 'true' });
  });
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
