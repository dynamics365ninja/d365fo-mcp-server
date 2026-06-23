/**
 * MCP Resource helpers: X++ Class Source Code
 * Exposes class source code via xpp://class/{className} URIs.
 *
 * These are pure helpers consumed by the unified resource registrar
 * (resources/index.ts). They no longer register their own request handlers —
 * a single dispatcher owns ListResources/ReadResource so the class and
 * workspace schemes can coexist (previously the later registration silently
 * overwrote the earlier one).
 */

import type { XppServerContext } from '../types/context.js';

export const CLASS_URI_PREFIX = 'xpp://class/';

/** True when a URI addresses a class source resource. */
export function isClassUri(uri: string): boolean {
  return uri.startsWith(CLASS_URI_PREFIX);
}

/**
 * Read the full X++ source for a class addressed by an xpp://class/{name} URI.
 * Returns the reconstructed source (declaration + methods).
 * Throws when the class is unknown or cannot be parsed.
 */
export async function readClassSource(
  context: XppServerContext,
  uri: string
): Promise<string> {
  const { symbolIndex, parser } = context;
  const className = uri.slice(CLASS_URI_PREFIX.length);
  const classSymbol = symbolIndex.getSymbolByName(className, 'class');

  if (!classSymbol) {
    throw new Error(`Class "${className}" not found`);
  }

  const classInfo = await parser.parseClassFile(classSymbol.filePath);
  if (!classInfo.success || !classInfo.data) {
    throw new Error(`Failed to parse class: ${classInfo.error || 'Unknown error'}`);
  }

  return [
    classInfo.data.declaration,
    ...classInfo.data.methods.map((m: { source: string }) => m.source),
  ].join('\n\n');
}
