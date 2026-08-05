/**
 * Configuration bootstrap — import this FIRST from every entry point.
 *
 * Importing this module loads config/d365fo-mcp.json, config/secrets.json and
 * .env onto process.env as a side effect (see loadEnv for the precedence rules).
 *
 * Why a module instead of a plain call
 * ------------------------------------
 * ESM evaluates every `import` declaration before the first statement of the
 * importing module's body. Entry points used to be written as
 *
 *     import { loadEnv } from './utils/loadEnv.js';
 *     loadEnv(import.meta.url);          // <- reads first, runs last
 *     import { apiKeyAuth } from './middleware/apiKeyAuth.js';
 *
 * which looks like configuration is loaded up front but is not: every module in
 * the import graph — including the ones that snapshot process.env into a
 * module-level const — had already been evaluated by the time loadEnv() ran, so
 * they all saw the unconfigured environment. That silently disabled API-key
 * authentication for keys supplied through .env or config/secrets.json, and made
 * METADATA_PATH, the MCP tool timeouts and the rate-limit settings unreadable
 * from those files.
 *
 * A side-effect import is subject to the same evaluation order it is trying to
 * control, so being *first* is what makes it correct — an import placed above it
 * still wins. tests/server/envConfigTiming.test.ts enforces that ordering.
 *
 * This file deliberately lives next to index.ts rather than in utils/: loadEnv
 * resolves the installation directory from the caller's own location, so the
 * bootstrap must sit at the same depth the entry points do.
 */

import { loadEnv } from './utils/loadEnv.js';

loadEnv(import.meta.url);
