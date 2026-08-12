/**
 * `d365fo-mcp doctor` — the message it prints when a configured path setting
 * names a folder that is not there.
 *
 * Three settings share this message and they are not the same kind of thing:
 *
 *   environment.packagePath            traditional: found by the drive scan
 *                                      UDE:         read from the XPP config
 *   environment.customPackagesPath     UDE:         XPP config ModelStoreFolder
 *                                      traditional: a deliberate pin, the
 *                                                   documented fix for junction
 *                                                   layouts (docs/MCP_CONFIG.md)
 *   environment.microsoftPackagesPath  UDE only:    XPP config FrameworkDirectory
 *
 * The distinction is not cosmetic. "Delete the stale pin" is the right fix only
 * where something else would resolve the value live; where nothing would, that
 * advice breaks a working install. And a fix line may only propose a value
 * doctor can actually know — `<drive>:\AosService\PackagesLocalDirectory` is a
 * traditional-VM artifact and is never the UDE ModelStoreFolder.
 */

import { describe, it, expect } from 'vitest';
import { missingPathFix, PATH_FACTS, type EnvKind } from '../../src/cli/commands/doctor.js';
import { settingByPath } from '../../src/config/settings.js';

const GONE = 'K:\\gone\\platform-7.0.1234';

function fix(settingPath: string, kind: EnvKind, pinnedByEnv: boolean) {
  const setting = settingByPath(settingPath)!;
  return missingPathFix(setting, PATH_FACTS[settingPath], 'Root', GONE, kind, pinnedByEnv);
}

describe('doctor — missing path setting', () => {
  it('names the stale .env pin as the cause where auto-detection exists', () => {
    // The bug this check was built for: the wizard wrote the value into .env, a
    // platform update deleted the folder, and the .env copy kept outranking the
    // now-correct XPP-config detection at every startup.
    const r = fix('environment.customPackagesPath', 'ude', true);

    expect(r.message).toContain('pinned by legacy .env (D365FO_CUSTOM_PACKAGES_PATH)');
    expect(r.fix).toContain('remove D365FO_CUSTOM_PACKAGES_PATH from .env');
    expect(r.fix).toContain('ModelStoreFolder');
  });

  it('does not tell a traditional VM to delete a pin nothing would replace', () => {
    // customPackagesPath on a traditional VM is the documented junction-layout
    // fix — deleting it is how you break `modify`, not how you repair it.
    const r = fix('environment.customPackagesPath', 'traditional', true);

    expect(r.fix).not.toMatch(/remove .* from \.env —/);
    expect(r.fix).toContain('point environment.customPackagesPath at');
    expect(r.fix).toContain('outranks the JSON config');
    expect(r.fix).not.toMatch(/XPP config/);
  });

  it('does not call packagePath a UDE value on a traditional VM', () => {
    // The regression this guards: one message written for UDE, applied to all
    // three settings, telling a traditional VM its packages root comes from an
    // XPP config it does not have.
    const r = fix('environment.packagePath', 'traditional', true);

    expect(r.fix).not.toMatch(/XPP config/);
  });

  it('keeps the detected-root hint that makes packagePath actionable', () => {
    const r = fix('environment.packagePath', 'traditional', false);

    // Either a concrete "found instead" or the scan summary — never nothing.
    expect(r.message).toMatch(/found instead:|AosService/);
    expect(r.fix).toContain('environment.packagePath');
  });

  it('never proposes a PackagesLocalDirectory for the UDE roots', () => {
    for (const settingPath of ['environment.customPackagesPath', 'environment.microsoftPackagesPath']) {
      for (const kind of ['ude', 'traditional'] as EnvKind[]) {
        for (const pinned of [true, false]) {
          const r = fix(settingPath, kind, pinned);
          expect(`${r.message}\n${r.fix}`, `${settingPath} / ${kind} / env=${pinned}`)
            .not.toMatch(/AosService|PackagesLocalDirectory/);
        }
      }
    }
  });

  it('offers unsetting as the cure when the JSON config pins a UDE root', () => {
    const r = fix('environment.microsoftPackagesPath', 'ude', false);

    expect(r.message).not.toContain('legacy .env');
    expect(r.fix).toContain('clear environment.microsoftPackagesPath');
    expect(r.fix).toContain('XPP config');
    expect(r.fix).toContain('FrameworkDirectory');
  });

  it('always names the setting and the folder that is missing', () => {
    for (const settingPath of Object.keys(PATH_FACTS)) {
      for (const kind of ['ude', 'traditional'] as EnvKind[]) {
        const r = fix(settingPath, kind, false);
        expect(r.message, settingPath).toContain(GONE);
        expect(r.fix, settingPath).toContain(settingPath);
      }
    }
  });
});
