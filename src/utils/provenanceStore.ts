/**
 * In-memory provenance store for grounding tokens.
 *
 * A grounding token proves that the model queried the real D365FO codebase
 * (via prepare_change) before generating extension code. Tokens expire after
 * TTL_MS to prevent stale context being reused across sessions.
 *
 * Enforcement: when GROUNDING_ENFORCE=true, extension patterns in generate_object(mode="pattern")
 * and extension objectTypes in create_d365fo_file will reject calls without a
 * valid token.
 */

import crypto from 'crypto';
import { SERVER_MODE } from '../server/serverMode.js';

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ProvenanceContext {
  goal: string;
  objectName: string;
  methodName?: string;
  objectType?: string;
  /** Proposed name of the new extension object, when supplied to prepare_change */
  proposedName?: string;
  /** Condensed facts gathered by prepare_change */
  methodSignature?: string;
  cocExtensions?: string;
  extensionEligibility?: string;
  recommendedStrategy?: string;
  namingValidation?: string;
  patterns?: string;
}

export interface ProvenanceBundle {
  token: string;
  context: ProvenanceContext;
  timestamp: number;
  expiresAt: number;
}

// Module-level singleton — shared across all requests in the process lifetime.
const store = new Map<string, ProvenanceBundle>();

function prune(): void {
  const now = Date.now();
  for (const [key, bundle] of store.entries()) {
    if (bundle.expiresAt < now) store.delete(key);
  }
}

export function createProvenanceToken(context: ProvenanceContext): string {
  prune();
  const payload = `${context.goal}:${context.objectName}:${context.methodName ?? ''}:${Date.now()}`;
  const token = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  const now = Date.now();
  store.set(token, {
    token,
    context,
    timestamp: now,
    expiresAt: now + TTL_MS,
  });
  return token;
}

export function getProvenanceBundle(token: string): ProvenanceBundle | undefined {
  prune();
  const bundle = store.get(token);
  if (!bundle) return undefined;
  if (bundle.expiresAt < Date.now()) {
    store.delete(token);
    return undefined;
  }
  return bundle;
}

export function isValidToken(token: string): boolean {
  return getProvenanceBundle(token) !== undefined;
}

/**
 * Check that a token was issued for the object actually being written.
 *
 * A token issued for `CustTable` is accepted for targets that embed that name
 * (`CustTable.ContosoExtension`, `CustTableContoso_Extension`, …) and for the
 * proposedName recorded by prepare_change. Names shorter than 4 chars are
 * compared exactly to avoid trivial substring matches.
 */
export function tokenMatchesTarget(
  bundle: ProvenanceBundle,
  targetObjectName: string,
): boolean {
  const target = targetObjectName.trim().toLowerCase();
  if (!target) return true;
  const candidates = [bundle.context.objectName, bundle.context.proposedName]
    .filter((c): c is string => !!c)
    .map(c => c.trim().toLowerCase());
  return candidates.some(c => {
    if (c === target) return true;
    if (c.length < 4 || target.length < 4) return false;
    return target.includes(c) || c.includes(target);
  });
}

/**
 * Enforce grounding for extension write operations.
 *
 * Returns an error result if GROUNDING_ENFORCE=true is set in the environment AND:
 *   - no valid grounding token was provided, OR
 *   - the token was issued for a different object than `targetObjectName`.
 *
 * Returns null when enforcement passes (either disabled or token is valid).
 */
let warnedWriteOnlyBypass = false;

export function enforceGrounding(
  groundingToken: string | undefined,
  operationDescription: string,
  targetObjectName?: string,
): { isError: true; content: [{ type: 'text'; text: string }] } | null {
  if (process.env.GROUNDING_ENFORCE !== 'true') return null;
  // Hybrid-deployment guard: in write-only mode prepare_change is not exposed
  // by this instance (it runs on the read-only/Azure server) and tokens live
  // in THAT process's memory, so no token can ever validate here. Enforcing
  // would dead-loop the agent between the two servers: local write rejects →
  // error says "call prepare_change" → Azure issues a token this process
  // cannot validate → local write rejects again. Grounding is enforced by the
  // read-only instance's generate_object(mode="pattern") path instead.
  if (SERVER_MODE === 'write-only') {
    if (!warnedWriteOnlyBypass) {
      warnedWriteOnlyBypass = true;
      console.error(
        '[provenance] ⚠️ GROUNDING_ENFORCE=true is ignored in write-only mode — ' +
        'prepare(mode="change") tokens are issued by the read-only instance and cannot be ' +
        'validated in this process. Remove GROUNDING_ENFORCE from the local companion .env.',
      );
    }
    return null;
  }
  if (groundingToken && isValidToken(groundingToken)) {
    if (!targetObjectName) return null;
    const bundle = getProvenanceBundle(groundingToken)!;
    if (tokenMatchesTarget(bundle, targetObjectName)) return null;
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `❌ Grounding token mismatch for ${operationDescription} (GROUNDING_ENFORCE=true).\n\n` +
          `The provided token was issued for object \`${bundle.context.objectName}\`` +
          (bundle.context.proposedName ? ` (proposed: \`${bundle.context.proposedName}\`)` : '') +
          `, but this call targets \`${targetObjectName}\`.\n\n` +
          `**Required workflow:**\n` +
          `1. Call \`prepare(mode="change", goal="...", objectName="${targetObjectName}")\` for THIS object.\n` +
          `2. Pass the returned \`groundingToken\` to this tool.\n\n` +
          `Tokens are object-bound — one token cannot authorize writes to a different object.`,
      }],
    };
  }
  const reason = groundingToken
    ? 'the provided groundingToken has expired or is invalid'
    : 'no groundingToken was provided';
  return {
    isError: true,
    content: [{
      type: 'text',
      text:
        `❌ Grounding required for ${operationDescription} (GROUNDING_ENFORCE=true).\n\n` +
        `Reason: ${reason}.\n\n` +
        `**Required workflow:**\n` +
        `1. Call \`prepare(mode="change", goal="...", objectName="...")\` to gather facts from the D365FO index.\n` +
        `2. Pass the returned \`groundingToken\` as a parameter to this tool.\n\n` +
        `This ensures generated extension code is grounded in your actual codebase, not AI training data.\n\n` +
        `To disable enforcement (direct API / human use): set \`GROUNDING_ENFORCE=false\` in the server .env.`,
    }],
  };
}
