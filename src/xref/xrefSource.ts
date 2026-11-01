/**
 * Which cross-reference source answers a tool call.
 *
 *   1. the C# bridge, when it is up and has its DYNAMICSXREFDB — unchanged;
 *   2. else the SQLite export named by D365FO_XREF_SQLITE_PATH, when it opens
 *      and validates (sqliteXrefProvider.ts);
 *   3. else none, and every caller falls back exactly as it did before: the
 *      bridge object (or nothing) is returned, which the adapters report as
 *      "unavailable".
 *
 * Decided per call, not at startup: a bridge that finishes starting takes over,
 * and a file the host swaps is picked up on the next call.
 */

import type {
  BridgeApiUsageCallersResult,
  BridgeEventSubscriberResult,
  BridgeExtensionClassResult,
  BridgeReferenceResult,
} from '../bridge/bridgeTypes.js';
import {
  SqliteXrefProvider,
  XREF_META_REFS_WITHOUT_SOURCE_REMOVED,
  XREF_SQLITE_COUNT_CAP,
  XREF_SQLITE_INDEX_COUNT_CAP,
  type XrefSqliteStatus,
} from './sqliteXrefProvider.js';

/** What the tool adapters need from a cross-reference source. The bridge client is one. */
export interface XrefSource {
  readonly isReady: boolean;
  readonly xrefAvailable: boolean;
  /** "_Source:_" wording; the bridge has none and gets the default. */
  readonly sourceLabel?: string;
  findReferences(targetName: string, targetType?: string): Promise<BridgeReferenceResult>;
  findExtensionClasses(baseClassName: string): Promise<BridgeExtensionClassResult | null>;
  findEventSubscribers(
    targetName: string,
    eventName?: string,
    handlerType?: string,
  ): Promise<BridgeEventSubscriberResult | null>;
  findApiUsageCallers(apiName: string, limit?: number): Promise<BridgeApiUsageCallersResult | null>;
}

/** The context slice the selection reads. */
export interface XrefSourceContext {
  bridge?: XrefSource;
  xrefSqlite?: SqliteXrefProvider;
}

/** Wording of the bridge as a source, in the formats it has always used. */
export const BRIDGE_SOURCE_LABEL = 'C# bridge (DYNAMICSXREFDB)';

export function xrefSourceLabel(source: XrefSource | undefined): string {
  return source?.sourceLabel ?? BRIDGE_SOURCE_LABEL;
}

/** The source to query; the bridge (possibly not ready) or undefined when none can answer. */
export function xrefSource(context: XrefSourceContext): XrefSource | undefined {
  if (context.bridge?.isReady && context.bridge.xrefAvailable) return context.bridge;
  if (context.xrefSqlite?.isReady) return context.xrefSqlite;
  return context.bridge;
}

/** True when the SQLite file, not the bridge, would answer. */
export function isSqliteXref(source: XrefSource | undefined): source is SqliteXrefProvider {
  return source instanceof SqliteXrefProvider;
}

/**
 * Why the configured SQLite file cannot be used, or null when it can or none is
 * configured. For the "why no cross-references" texts, which every client reads:
 * so without the file's path (the server's layout), which the log and doctor show.
 */
export function xrefSqliteProblem(context: Pick<XrefSourceContext, 'xrefSqlite'>): string | null {
  const status = context.xrefSqlite?.status();
  return status && status.state !== 'ok' ? status.reason.split(status.path).join('the file') : null;
}

let fromEnv: SqliteXrefProvider | undefined;

/**
 * The provider for D365FO_XREF_SQLITE_PATH, or undefined when it is not set.
 * Creating it opens nothing (the first use does), so it is safe at startup.
 */
export function xrefSqliteFromEnv(env: NodeJS.ProcessEnv = process.env): SqliteXrefProvider | undefined {
  const path = env.D365FO_XREF_SQLITE_PATH?.trim();
  if (!path) return undefined;
  if (fromEnv?.path !== path) {
    fromEnv?.close();
    fromEnv = new SqliteXrefProvider(path);
  }
  return fromEnv;
}

export type XrefSourceKind = 'bridge' | 'sqlite' | 'none';

export interface XrefSourceDescription {
  kind: XrefSourceKind;
  /** One line for get_workspace_info. */
  line: string;
  /** More lines for get_workspace_info(diagnostics=true). */
  detail: string[];
  /** Set when the SQLite file is configured; its status. */
  sqlite?: XrefSqliteStatus;
}

/** How a usable file's totals are counted, for get_workspace_info and doctor. */
export function xrefSqliteCounting(status: Extract<XrefSqliteStatus, { state: 'ok' }>): string {
  return status.countsFromIndex
    ? `from the TargetId index, exact up to ${XREF_SQLITE_INDEX_COUNT_CAP} per lookup ` +
        `(the export left out ${status.meta[XREF_META_REFS_WITHOUT_SOURCE_REMOVED]} references without a source name)`
    : `joined to Names, exact up to ${XREF_SQLITE_COUNT_CAP} per lookup ` +
        `(no meta.${XREF_META_REFS_WITHOUT_SOURCE_REMOVED}: the file may hold references without a source name)`;
}

/** The active cross-reference source and, for the SQLite file, how old its data is. */
export function describeXrefSource(context: XrefSourceContext): XrefSourceDescription {
  const sqlite = context.xrefSqlite?.status();
  if (context.bridge?.isReady && context.bridge.xrefAvailable) {
    const detail = sqlite ? [`D365FO_XREF_SQLITE_PATH is set but not used while the bridge has DYNAMICSXREFDB`] : [];
    return { kind: 'bridge', line: `${BRIDGE_SOURCE_LABEL} — live`, detail, sqlite };
  }
  if (sqlite?.state === 'ok') {
    const meta = sqlite.meta;
    const counts = [meta.names && `${meta.names} names`, meta.references && `${meta.references} references`]
      .filter(Boolean)
      .join(', ');
    return {
      kind: 'sqlite',
      line:
        `SQLite export of DYNAMICSXREFDB — exported ${sqlite.exportedAt ?? '(unknown)'}, ${sqlite.modules} modules ` +
        `(only as current as that export)`,
      detail: [
        `File     : ${sqlite.path}`,
        ...(counts ? [`Contents : ${counts}`] : []),
        `Totals   : ${xrefSqliteCounting(sqlite)}`,
      ],
      sqlite,
    };
  }
  if (sqlite) {
    return {
      kind: 'none',
      line: `none — D365FO_XREF_SQLITE_PATH is not usable (${sqlite.reason}); find_references uses a name-based search`,
      detail: [`File     : ${sqlite.path}`],
      sqlite,
    };
  }
  return { kind: 'none', line: 'none — find_references uses a name-based search', detail: [] };
}
