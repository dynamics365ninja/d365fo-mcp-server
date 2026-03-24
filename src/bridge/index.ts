/**
 * Bridge module — C# D365MetadataBridge integration.
 *
 * Provides access to Microsoft's official Dev Tools API (IMetadataProvider)
 * and cross-reference database (DYNAMICSXREFDB) via a child process.
 *
 * Usage:
 *   import { BridgeClient, createBridgeClient } from './bridge/index.js';
 *
 *   // In server startup:
 *   const bridge = await createBridgeClient({ packagesPath: 'K:\\AosService\\PackagesLocalDirectory' });
 *   if (bridge) {
 *     const table = await bridge.readTable('CustTable');
 *     const refs = await bridge.findReferences('CustTable');
 *   }
 */

export { BridgeClient, createBridgeClient } from './bridgeClient.js';
export type { BridgeClientOptions, BridgeReadyPayload, BridgeInfoPayload } from './bridgeClient.js';
export * from './bridgeTypes.js';
export {
  tryBridgeTable,
  tryBridgeClass,
  tryBridgeMethodSource,
  tryBridgeEnum,
  tryBridgeEdt,
  tryBridgeForm,
  tryBridgeReferences,
  tryBridgeSearch,
  tryBridgeQuery,
  tryBridgeView,
  tryBridgeDataEntity,
  tryBridgeReport,
  bridgeRefreshProvider,
  bridgeValidateAfterWrite,
  bridgeResolveObject,
  canBridgeCreate,
  canBridgeModify,
  bridgeCreateObject,
  bridgeAddMethod,
  bridgeAddField,
  bridgeSetProperty,
  bridgeReplaceCode,
  bridgeDeleteObject,
  bridgeBatchModify,
  bridgeGetCapabilities,
  bridgeDiscoverFormPatterns,
} from './bridgeAdapter.js';
