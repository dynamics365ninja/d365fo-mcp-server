/**
 * .env file helpers — read/update individual keys while preserving the rest
 * of the file byte-for-byte (comments, ordering, blank lines).
 *
 * Mirrors the semantics of the PowerShell management scripts
 * (instances/*.ps1, scripts/select-xpp-config.ps1) so both entry points stay
 * interchangeable: an active line wins over a commented one, setting a key
 * first replaces the active line, then un-comments a commented line, and
 * finally appends.
 */
import * as fs from 'node:fs';

/** First active (non-commented) value of `key`, or null. */
export function getValue(content: string, key: string): string | null {
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=(.*)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

/** Replace the active line, else un-comment a commented one, else append. */
export function setValue(content: string, key: string, value: string): string {
  // Replacer function, not a replacement string — values containing `$&`
  // or `$'` must land in the file literally.
  const line = () => `${key}=${value}`;
  const active = new RegExp(`^\\s*${escapeRe(key)}\\s*=.*$`, 'm');
  if (active.test(content)) {
    return content.replace(active, line);
  }
  const commented = new RegExp(`^#\\s*${escapeRe(key)}\\s*=.*$`, 'm');
  if (commented.test(content)) {
    return content.replace(commented, line);
  }
  return content.replace(/\s*$/, '') + `\n${key}=${value}\n`;
}

/**
 * All variable names present in the file. Commented-out assignments
 * ("# KEY=value") count as present-but-disabled so the missing-settings
 * check doesn't nag about vars a user intentionally left commented.
 */
export function varNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Vars in `exampleContent` that are absent from `envContent`, with example values. */
export function missingVars(exampleContent: string, envContent: string): { name: string; value: string }[] {
  const have = new Set(varNames(envContent));
  const missing: { name: string; value: string }[] = [];
  for (const name of varNames(exampleContent)) {
    if (have.has(name)) continue;
    have.add(name); // report each var once
    missing.push({ name, value: getValue(exampleContent, name) ?? '' });
  }
  return missing;
}

// ── File-backed wrappers ─────────────────────────────────────────────────────

export function readEnvValue(envFile: string, key: string): string | null {
  if (!fs.existsSync(envFile)) return null;
  return getValue(fs.readFileSync(envFile, 'utf8'), key);
}

export function writeEnvValue(envFile: string, key: string, value: string): void {
  const content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  fs.writeFileSync(envFile, setValue(content, key, value));
}

/**
 * Dev-environment type with the legacy fallback name, matching
 * run-instance.ps1 / rebuild-instance.ps1 and the server itself.
 */
export function readDevEnvType(envFile: string): string | null {
  return readEnvValue(envFile, 'D365FO_DEV_ENVIRONMENT_TYPE') ?? readEnvValue(envFile, 'DEV_ENVIRONMENT_TYPE');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
