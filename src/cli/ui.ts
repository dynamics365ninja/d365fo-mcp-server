/**
 * Prompt helpers — thin wrapper over @clack/prompts with uniform
 * cancel handling (Ctrl+C / Esc exits the CLI cleanly instead of
 * returning a cancel symbol every caller must check).
 */
import * as p from '@clack/prompts';
import type { Option } from '@clack/prompts';
import { installOneLiner, isGitCheckout } from './context.js';

export { p };

/** Unwrap a clack result; exit gracefully when the user cancelled. */
export function ensure<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value as T;
}

export async function askText(opts: { message: string; placeholder?: string; initialValue?: string; required?: boolean }): Promise<string> {
  const v = ensure(await p.text({
    message: opts.message,
    placeholder: opts.placeholder,
    initialValue: opts.initialValue,
    validate: opts.required ? (s?: string) => (s?.trim() ? undefined : 'Required') : undefined,
  }));
  return (v ?? '').trim();
}

export async function askConfirm(message: string, initialValue = true): Promise<boolean> {
  return ensure(await p.confirm({ message, initialValue }));
}

export async function askSelect<T extends string>(message: string, options: Option<T>[], initialValue?: T): Promise<T> {
  return ensure(await p.select<T>({ message, options, initialValue }));
}

/**
 * Guard for commands that only work inside a git checkout (setup, update,
 * index). Running from the npx cache or an unpacked release tarball lacks
 * scripts/, devDependencies and git — point the user at the installer instead
 * of failing halfway through.
 */
export function requireGitCheckout(): boolean {
  if (isGitCheckout) return true;
  p.log.error('This copy of d365fo-mcp is not a full installation — no git checkout found.');
  p.log.info(
    'Install the server with PowerShell:\n' +
    `  ${installOneLiner}\n` +
    'then run this command again from the install directory (npm run cli -- <command>).',
  );
  process.exitCode = 1;
  return false;
}
