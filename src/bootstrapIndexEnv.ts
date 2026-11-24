/**
 * Configuration bootstrap for the index scripts. It does what bootstrapEnv does,
 * then refuses to run when a config file is there but cannot be read.
 *
 * The server may start on a broken config.json; it logs the error, and a server
 * running on defaults loses nothing. An index script on defaults does lose
 * something: EXTRACT_MODE falls back to "all", which deletes the metadata folder
 * and clears the database, and D365FO_PACKAGE_PATH falls back to whichever
 * packages root the drive scan finds. One unescaped backslash in a path made
 * `d365fo-mcp index` replace a minutes-long custom rebuild with a full extraction
 * of the whole packages path, and the only sign of it was one "[config] Cannot
 * parse" line at the top of the output.
 *
 * Import this FIRST, exactly like bootstrapEnv (see there for why it must be a
 * side-effect import). It sits next to bootstrapEnv because loadEnv finds the
 * installation directory from the caller's location.
 */

import { loadEnv, unreadableConfigFiles } from './utils/loadEnv.js';

loadEnv(import.meta.url);

const unreadable = unreadableConfigFiles();
if (unreadable.length > 0) {
  const lines = unreadable.map(u => `  ${u.file}: ${u.error}`).join('\n');
  process.stderr.write(
    `Refusing to run: the configuration cannot be read, so every setting would fall back to its default\n${lines}\n` +
    'With defaults, an index build extracts every model of the packages path and replaces the existing index.\n' +
    'Fix the file (in JSON a Windows path needs \\\\ or /), or move it aside to run on defaults deliberately.\n',
  );
  process.exit(1);
}
