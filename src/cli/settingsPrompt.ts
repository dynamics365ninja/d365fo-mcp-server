/**
 * Generic prompt for one registry setting.
 *
 * Every question is rendered the same way — label, then the setting's own
 * description dimmed underneath — so a user never has to guess what a value
 * does or go looking for it in .env.example. The prompt type follows the
 * setting's `type`, and the answer is written straight into the store.
 */
import { c } from '../utils/terminalUi.js';
import { multiselect, type Option } from '@clack/prompts';
import type { Setting, SectionId } from '../config/settings.js';
import { SECTIONS, settingsInSection } from '../config/settings.js';
import { initialText, readSetting, readSettingOrDefault, writeSetting, type SettingsStore } from './settingsStore.js';
import { askConfirm, askSelect, askText, ensure, p } from './ui.js';

/** "Label\n  description" — the uniform question layout. */
function message(setting: Setting, suffix?: string): string {
  const head = suffix ? `${setting.label} ${suffix}` : setting.label;
  return `${head}\n${c.dim(wrapText(setting.description, 76, '  '))}`;
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

/**
 * Ask for one setting and persist the answer.
 * Returns the value that ended up in the store (or undefined when skipped).
 */
export async function askSetting(
  store: SettingsStore,
  setting: Setting,
  opts?: { required?: boolean; initial?: string },
): Promise<unknown> {
  const required = opts?.required ?? setting.required ?? false;

  // Secrets are never echoed and never pre-filled; an empty answer keeps
  // whatever is already stored (or leaves the value to an environment variable).
  if (setting.tier === 'secret') {
    const existing = readSettingOrDefault(store, setting);
    const entered = ensure(await p.password({
      message: message(setting, existing ? c.dim('(set — Enter keeps it)') : c.dim('(Enter to skip)')),
    }));
    if (entered) writeSetting(store, setting, entered);
    return entered || existing;
  }

  switch (setting.type) {
    case 'boolean': {
      const value = await askConfirm(message(setting), readSettingOrDefault(store, setting) === true);
      writeSetting(store, setting, value);
      return value;
    }
    case 'enum': {
      const choices = setting.choices ?? [];
      // A stored value wins over the caller's suggestion — re-running setup must
      // not silently move an installation onto a freshly detected default.
      const current = String(
        readSetting(store, setting) ?? opts?.initial ?? setting.default ?? choices[0]?.value ?? '',
      );
      const value = await askSelect(
        message(setting),
        choices.map(choice => ({ value: choice.value, label: choice.value, hint: choice.hint })),
        current,
      );
      writeSetting(store, setting, value);
      return value;
    }
    case 'int': {
      const raw = await askText({
        message: message(setting),
        initialValue: initialText(store, setting),
        required,
      });
      if (!raw) {
        writeSetting(store, setting, undefined);
        return undefined;
      }
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        p.log.warn(`'${raw}' is not a number — keeping the default (${setting.default}).`);
        return undefined;
      }
      writeSetting(store, setting, parsed);
      return parsed;
    }
    case 'list': {
      const raw = await askText({
        message: message(setting, c.dim('(comma-separated)')),
        initialValue: initialText(store, setting),
        placeholder: setting.placeholder,
        required,
      });
      const list = raw.split(',').map(s => s.trim()).filter(Boolean);
      writeSetting(store, setting, list.length > 0 ? list : undefined);
      return list;
    }
    default: {
      const raw = await askText({
        message: message(setting, required ? '' : c.dim('(Enter to skip)')),
        initialValue: initialText(store, setting),
        placeholder: setting.placeholder,
        required,
      });
      writeSetting(store, setting, raw || undefined);
      return raw || undefined;
    }
  }
}

/** Ask a whole list of settings in order. */
export async function askSettings(store: SettingsStore, settings: Setting[]): Promise<void> {
  for (const setting of settings) {
    await askSetting(store, setting);
  }
}

/**
 * Optional deep-dive: pick sections, then walk their advanced settings.
 * Everything here has a working default, so skipping is always safe.
 */
export async function askAdvanced(store: SettingsStore, sections: SectionId[]): Promise<void> {
  const available = sections.filter(id => settingsInSection(id, 'advanced').length > 0);
  if (available.length === 0) return;

  if (!await askConfirm('Review advanced settings? (timeouts, index layout, quality gates — all have defaults)', false)) {
    return;
  }

  const options: Option<SectionId>[] = available.map(id => {
    const section = SECTIONS.find(s => s.id === id)!;
    const count = settingsInSection(id, 'advanced').length;
    return { value: id, label: `${section.title} (${count})`, hint: section.description };
  });

  // A confirm submits the instant `y` is pressed, so the Enter a user habitually
  // types right after it lands on this prompt and submits an empty selection —
  // the review they just asked for would silently never happen. Never walk past
  // an empty pick: confirm it, and pre-select everything on the retry so a
  // second stray Enter reviews all areas instead of skipping again.
  let initialValues: SectionId[] = [];
  for (;;) {
    const picked = ensure(await multiselect<SectionId>({
      message: 'Which areas do you want to tune? (space selects, Enter confirms)',
      options,
      initialValues,
      required: false,
    }));

    if (picked.length > 0) {
      for (const id of picked) {
        const section = SECTIONS.find(s => s.id === id)!;
        p.log.step(`${section.title} — ${section.description}`);
        await askSettings(store, settingsInSection(id, 'advanced'));
      }
      return;
    }

    if (await askConfirm('Nothing selected — leave every advanced setting at its default?', true)) return;
    initialValues = available;
  }
}

/** Ask for the secrets of the given sections, skipping any already set. */
export async function askSecrets(store: SettingsStore, sections: SectionId[]): Promise<void> {
  for (const id of sections) {
    for (const setting of settingsInSection(id, 'secret')) {
      await askSetting(store, setting);
    }
  }
}
