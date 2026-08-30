/**
 * Multi-artifact (`--actual-dir`) actual-file resolution for src/eval/oracle/cli.ts.
 * Pure logic + fs reads — no CLI argv/process side effects — split out so it can be
 * unit-tested without triggering the CLI script's `main()` (docs/AGENT_EVAL_LOOP.md §6).
 */

import * as fs from 'fs';
import * as path from 'path';
import { artifactKey } from './artifactKey.js';
import { type PrefixSpec } from './prefix.js';

/**
 * Resolve the actual-dir file matching a golden artifact filename. Tries an
 * exact filename match first (fast path, and the only path when golden and
 * actual happen to share the same EXTENSION_PREFIX session); if that misses,
 * falls back to matching on the PREFIX-CANONICALISED filename (the golden's
 * filename is itself typically a prefixed object name, e.g.
 * "ContosoMyContract.metadata.xml", produced under a different session than the
 * one that generated the actual artifacts) so a whole L3/L4 multi-artifact
 * case doesn't spuriously score every artifact as missing/extra under prefix
 * drift alone.
 *
 * The fallback compares LOGICAL ARTIFACT KEYS (`artifactKey`), not merely
 * prefix-canonicalised filenames, so a legacy golden filename
 * (`DemoEnumExtProbe.AxClass.metadata.xml` — unprefixed stem, `.Ax<Type>`
 * infix) still pairs with the actual file the VM produced
 * (`ConDemoEnumExtProbe.metadata.xml`). See artifactKey.ts and
 * the 2026-07-21 eval sweep, finding #2.
 *
 * A bare `<Name>.xml` counts too. Goldens are committed as `*.metadata.xml`,
 * but AOT files on the VM are plain `.xml`, so pointing `--actual-dir` straight
 * at `<Model>/<Model>/AxClass` — the obvious thing to do during a capture —
 * used to match nothing and score every artifact `missing`: a silent zero, not
 * an error (L2-attribute-authoring-reflection capture, 2026-08-30). A
 * `.metadata.xml` neighbour still wins when both are present.
 */
/**
 * A bare AOT filename in the shape `artifactKey` expects for a golden. Already-
 * committed `.metadata.xml` names pass through untouched — they end in `.xml` too,
 * and a blind replace turns them into `.metadata.metadata.xml`.
 */
function aotToMetadataName(filename: string): string {
  return /.metadata.xml$/i.test(filename)
    ? filename
    : filename.replace(/.xml$/i, '.metadata.xml');
}

export function resolveActualFile(
  actualDir: string,
  goldenName: string,
  goldenPrefix: PrefixSpec,
  actualPrefix: PrefixSpec,
): string | undefined {
  const direct = path.join(actualDir, goldenName);
  if (fs.existsSync(direct)) return direct;
  const asAotFile = path.join(actualDir, goldenName.replace(/.metadata.xml$/i, '.xml'));
  if (asAotFile !== direct && fs.existsSync(asAotFile)) return asAotFile;

  const canonGolden = artifactKey(goldenName, goldenPrefix);
  const files = fs.readdirSync(actualDir);
  // .metadata.xml first: when a dir holds both shapes of the same object, the
  // committed-golden shape is the one the caller meant.
  const candidate =
    files.filter(f => f.endsWith('.metadata.xml'))
      .find(f => artifactKey(f, actualPrefix) === canonGolden)
    ?? files.filter(f => f.endsWith('.xml') && !f.endsWith('.metadata.xml'))
      .find(f => artifactKey(aotToMetadataName(f), actualPrefix) === canonGolden);
  return candidate ? path.join(actualDir, candidate) : undefined;
}

/**
 * Build the `actualArtifacts` map for a multi-artifact (`--actual-dir`) run,
 * one entry per golden artifact name.
 *
 * Regression: this used to key every entry by the GOLDEN's own filename
 * (`actualArtifacts[name] = ...` inside a `for (const name of
 * artifactNames)` loop) even when the resolved actual file had a DIFFERENT
 * literal prefix (e.g. golden "ContosoMyContract.metadata.xml" resolved to actual
 * file "DemoMyContract.metadata.xml" under prefix-agnostic matching —
 * `resolveActualFile`'s whole point). `evaluateMulti`/`normalizeMultiArtifact`
 * then canonicalises each artifact KEY with `actualPrefix` — but a key that's
 * still the GOLDEN's literal name doesn't contain `actualPrefix` at all, so
 * `canonicalizePrefix` is a no-op on it, and the golden side's key (correctly
 * canonicalised from ITS OWN prefix) never matches. Every path in the
 * artifact then shows up as wholesale `missing` (under the golden's canonical
 * key) AND `extra` (under the actual's un-canonicalised key), even when the
 * content is byte-identical. Keying by the RESOLVED actual file's own
 * basename (which DOES contain `actualPrefix`) fixes the canonicalisation on
 * both sides consistently — matching the documented multi-artifact contract
 * (src/eval/oracle/normalize.ts's `normalizeMultiArtifact` doc comment).
 *
 * A golden artifact with NO resolvable actual file (genuinely missing, not a
 * prefix-matching miss) keeps the golden's own name as the key with empty
 * content — unchanged from before; there is no real actual basename to key it
 * by, and the empty content correctly registers every one of that artifact's
 * paths as `missing`.
 */
export function buildActualArtifactsMap(
  actualDir: string,
  artifactNames: string[],
  goldenPrefix: PrefixSpec,
  actualPrefix: PrefixSpec,
): { actualArtifacts: Record<string, string>; matchedActualFiles: Set<string> } {
  const actualArtifacts: Record<string, string> = {};
  const matchedActualFiles = new Set<string>();
  for (const name of artifactNames) {
    const actualFile = resolveActualFile(actualDir, name, goldenPrefix, actualPrefix);
    if (actualFile) {
      const actualBasename = path.basename(actualFile);
      // Key in the committed-golden filename shape. A bare AOT `.xml` keys to
      // `.xml`, which never equals the golden side's `.metadata.xml` key, so the
      // pair diffed as missing + extra even though resolveActualFile had matched
      // them. The key still carries actualPrefix, which is all canonicalisation
      // needs; matchedActualFiles keeps the real on-disk name for the caller.
      actualArtifacts[aotToMetadataName(actualBasename)] = fs.readFileSync(actualFile, 'utf8');
      matchedActualFiles.add(actualBasename);
    } else {
      actualArtifacts[name] = '';
    }
  }
  return { actualArtifacts, matchedActualFiles };
}
