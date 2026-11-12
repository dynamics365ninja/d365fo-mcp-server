import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { validateFormPatternXml } from '../../validation/formPatternValidator.js';

/**
 * Checks every form of a package against the platform pattern definitions after a build.
 *
 * A pipeline build (MSBuild and Microsoft's BuildTask) compiles the whole package and rejects a
 * form whose controls break their pattern, e.g. "Property 'ColumnsMode' on control … must have
 * value 'Fill' per pattern 'Fields and Field Groups'". An `-incremental` xppc build, the default
 * here, reports no `FormPatternValidation` error for a form it does not recompile (exit 0, empty
 * log: see the #1048 probe in buildProject.test.ts), so a green build_d365fo_project was followed
 * by a red pipeline. The pattern validator (formPatternValidator.ts) checks the definitions the
 * platform uses; running it over the package's forms after a successful build gives the build
 * the pipeline's verdict. After a full build it finds nothing xppc did not already fail on,
 * unless xppc and the validator disagree, which is worth knowing before the pipeline says so.
 *
 * Every form of the package, not only the changed ones: the pipeline compiles the whole package,
 * so an older form that breaks its pattern fails it too.
 */

/** One error-severity finding, as the build result reports it. */
export interface FormPatternBuildError {
  form: string;
  rule: string;
  path: string;
  excerpt: string;
}

export interface FormPatternScanResult {
  errors: FormPatternBuildError[];
  formsChecked: number;
  /** Folders or files that could not be read or validated; the scan goes on without them. */
  unreadable: string[];
}

const FORM_TYPE = 'AxForm';
const SCAN_CONCURRENCY = 8;

export async function scanFormPatternErrors(sourceRoot: string, packageName: string): Promise<FormPatternScanResult> {
  const packageDir = path.join(sourceRoot, packageName);
  const result: FormPatternScanResult = { errors: [], formsChecked: 0, unreadable: [] };

  let models;
  try {
    models = await readdir(packageDir, { withFileTypes: true });
  } catch (err: any) {
    result.unreadable.push(`${packageDir}: ${err?.message ?? err}`);
    return result;
  }

  const files: string[] = [];
  for (const model of models) {
    if (!model.isDirectory()) continue;
    const formDir = path.join(packageDir, model.name, FORM_TYPE);
    let entries;
    try {
      entries = await readdir(formDir, { withFileTypes: true });
    } catch (err: any) {
      // bin, XppMetadata and models without forms have no AxForm folder.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') result.unreadable.push(`${formDir}: ${err?.message ?? err}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && entry.name.toLowerCase().endsWith('.xml')) files.push(path.join(formDir, entry.name));
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++];
        try {
          const report = await validateFormPatternXml(await readFile(file, 'utf-8'));
          result.formsChecked++;
          const form = report.formName ?? path.basename(file, '.xml');
          for (const v of report.violations) {
            if (v.severity !== 'error') continue;
            // FP000 is the validator failing to read a file the compiler accepted: say so, but
            // it is not a verdict on the form.
            if (v.rule === 'FP000') {
              result.unreadable.push(`${file}: ${v.excerpt}`);
              continue;
            }
            result.errors.push({ form, rule: v.rule, path: v.path, excerpt: v.excerpt });
          }
        } catch (err: any) {
          result.unreadable.push(`${file}: ${err?.message ?? err}`);
        }
      }
    }),
  );
  result.errors.sort((a, b) => a.form.localeCompare(b.form) || a.path.localeCompare(b.path));
  return result;
}

const LISTED = 20;

/** The errors as lines for the build result and log: `AxForm/<form>: <path>: <finding> (<rule>)`. */
export function describeFormPatternErrors(errors: FormPatternBuildError[]): string {
  const lines = errors.slice(0, LISTED).map(e => `  AxForm/${e.form}: ${e.path}: ${e.excerpt} (${e.rule})`);
  if (errors.length > LISTED) lines.push(`  … and ${errors.length - LISTED} more`);
  return lines.join('\n');
}
