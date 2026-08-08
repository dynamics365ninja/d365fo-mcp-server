/**
 * The one place this repo is allowed to import xml2js from.
 *
 * Why a seam: xml2js has had no release since 0.6.2 (2023) and no maintainer
 * activity since. It is not broken — it parses every AxForm/AxTable/.rnrproj we
 * throw at it — so replacing it now would be churn. What it is, is a dependency
 * we may one day have to swap under time pressure (a CVE, or a Node release it
 * stops working on), and it was reached for directly in 15 modules. Funnelling
 * those imports through one file makes that swap a change to this module
 * instead of an audit of every XML call site.
 *
 * Same shape as src/database/nodeSqlite.ts, which does the same job for the
 * better-sqlite3 → node:sqlite move.
 *
 * This is a seam, not an abstraction: the exports are xml2js's own, with its own
 * semantics (explicitArray, CDATA handling, `&#xD;` escaping in Builder output),
 * because the call sites depend on them in detail. Adding a "nicer" wrapper here
 * would hide exactly the behaviour they were written against.
 */

export { Builder, Parser, parseStringPromise } from 'xml2js';
export type { BuilderOptions, ParserOptions } from 'xml2js';
