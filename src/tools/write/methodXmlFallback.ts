/**
 * add-method / remove-method through the bridge, with the XML writer behind it for
 * object types the bridge has no arm for.
 *
 * MetadataWriteService.AddMethod / RemoveMethod end in a default branch that refuses
 * any objectType it does not list — data-entity was one, and the refusal surfaced as a
 * hard failure ("0/3 operations applied") while its own text said "use XML fallback".
 * Only that refusal falls back: the object was never even read, so nothing the bridge
 * could still do is being bypassed. Every other bridge outcome is returned unchanged,
 * so resolution failures keep their refresh+retry in the dispatcher.
 */

import type { BridgeClient } from '../../bridge/bridgeClient.js';
import { bridgeAddMethod, bridgeRemoveMethod } from '../../bridge/index.js';
import { xppMethodSourceForXml } from '../../utils/xppFormat.js';
import { ensureXppDocComment } from '../../utils/xppDocGen.js';
import { directXmlAddMethod, directXmlRemoveMethod, viaXmlFallback } from './directXmlWriters.js';

type WriteResult = { success: boolean; message: string; viaXmlFallback?: boolean } | null;

/** The bridge's own "no arm for this objectType" refusal. */
export function isBridgeUnsupportedTypeDecline(result: WriteResult): boolean {
  return !!result && !result.success && /not supported for objectType '[^']*' via bridge/i.test(result.message);
}

const declineReason = (r: WriteResult) => `the bridge was reachable but declined: ${r!.message}`;

export async function addMethodWithXmlFallback(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  filePath: string,
  methodName: string,
  source: string,
): Promise<WriteResult> {
  const viaBridge = await bridgeAddMethod(bridge, objectType, objectName, methodName, source);
  if (!isBridgeUnsupportedTypeDecline(viaBridge)) return viaBridge;
  // Same doc comment + indentation pass bridgeAddMethod applies, so both paths write alike.
  const viaXml = await directXmlAddMethod(
    filePath, methodName, xppMethodSourceForXml(ensureXppDocComment(source)), declineReason(viaBridge),
  );
  return viaXml ? viaXmlFallback(viaXml) : viaBridge;
}

export async function removeMethodWithXmlFallback(
  bridge: BridgeClient | undefined,
  objectType: string,
  objectName: string,
  filePath: string,
  methodName: string,
): Promise<WriteResult> {
  const viaBridge = await bridgeRemoveMethod(bridge, objectType, objectName, methodName);
  if (!isBridgeUnsupportedTypeDecline(viaBridge)) return viaBridge;
  const viaXml = await directXmlRemoveMethod(filePath, methodName, declineReason(viaBridge));
  return viaXml ? viaXmlFallback(viaXml) : viaBridge;
}
