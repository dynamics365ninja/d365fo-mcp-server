/**
 * provenanceStore tests — grounding tokens, TTL, object binding, enforcement.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createProvenanceToken,
  getProvenanceBundle,
  isValidToken,
  tokenMatchesTarget,
  enforceGrounding,
} from '../../src/utils/provenanceStore';

const ORIGINAL_ENFORCE = process.env.GROUNDING_ENFORCE;
const ORIGINAL_SECRET = process.env.GROUNDING_SECRET;

afterEach(() => {
  if (ORIGINAL_ENFORCE === undefined) delete process.env.GROUNDING_ENFORCE;
  else process.env.GROUNDING_ENFORCE = ORIGINAL_ENFORCE;
  if (ORIGINAL_SECRET === undefined) delete process.env.GROUNDING_SECRET;
  else process.env.GROUNDING_SECRET = ORIGINAL_SECRET;
  vi.useRealTimers();
});

// ─── Token lifecycle ─────────────────────────────────────────────────────────

describe('createProvenanceToken / isValidToken', () => {
  it('creates a 32-char hex token that validates', () => {
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidToken(token)).toBe(true);
  });

  it('stores the full context in the bundle', () => {
    const token = createProvenanceToken({
      goal: 'test',
      objectName: 'CustTable',
      methodName: 'validateWrite',
      proposedName: 'CustTableContoso_Extension',
    });
    const bundle = getProvenanceBundle(token);
    expect(bundle?.context.objectName).toBe('CustTable');
    expect(bundle?.context.proposedName).toBe('CustTableContoso_Extension');
  });

  it('rejects an unknown token', () => {
    expect(isValidToken('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });

  it('expires tokens after 30 minutes', () => {
    vi.useFakeTimers();
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(isValidToken(token)).toBe(true);
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(isValidToken(token)).toBe(false);
  });
});

// ─── Object binding ──────────────────────────────────────────────────────────

describe('tokenMatchesTarget', () => {
  const bundleFor = (objectName: string, proposedName?: string) => {
    const token = createProvenanceToken({ goal: 'test', objectName, proposedName });
    return getProvenanceBundle(token)!;
  };

  it('matches exact object name (case-insensitive)', () => {
    expect(tokenMatchesTarget(bundleFor('CustTable'), 'custtable')).toBe(true);
  });

  it('matches extension element name embedding the base object', () => {
    expect(tokenMatchesTarget(bundleFor('CustTable'), 'CustTable.ContosoExtension')).toBe(true);
  });

  it('matches extension class name embedding the base object', () => {
    expect(tokenMatchesTarget(bundleFor('SalesFormLetter'), 'SalesFormLetterContoso_Extension')).toBe(true);
  });

  it('matches the proposedName recorded by prepare_change', () => {
    expect(tokenMatchesTarget(
      bundleFor('CustTable', 'ContosoCustHelper'),
      'ContosoCustHelper',
    )).toBe(true);
  });

  it('rejects a different object', () => {
    expect(tokenMatchesTarget(bundleFor('CustTable'), 'SalesTable.ContosoExtension')).toBe(false);
  });

  it('does not substring-match very short names', () => {
    expect(tokenMatchesTarget(bundleFor('Tax'), 'TaxWithholdContoso_Extension')).toBe(false);
    expect(tokenMatchesTarget(bundleFor('Tax'), 'Tax')).toBe(true);
  });
});

// ─── Signed (portable) tokens — GROUNDING_SECRET ─────────────────────────────

describe('HMAC-signed tokens (GROUNDING_SECRET)', () => {
  it('issues a g1.-prefixed signed token when the secret is set', () => {
    process.env.GROUNDING_SECRET = 'test-secret';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(token.startsWith('g1.')).toBe(true);
    expect(isValidToken(token)).toBe(true);
  });

  it('validates a signed token without the in-memory bundle (cross-process)', async () => {
    process.env.GROUNDING_SECRET = 'test-secret';
    const token = createProvenanceToken({
      goal: 'test', objectName: 'CustTable', proposedName: 'CustTableContoso_Extension',
    });
    // Simulate the write-only companion: a fresh module instance whose
    // in-memory store never saw this token.
    vi.resetModules();
    const fresh = await import('../../src/utils/provenanceStore');
    expect(fresh.isValidToken(token)).toBe(true);
    const bundle = fresh.getProvenanceBundle(token)!;
    expect(bundle.context.objectName).toBe('CustTable');
    expect(bundle.context.proposedName).toBe('CustTableContoso_Extension');
    expect(fresh.tokenMatchesTarget(bundle, 'CustTable.ContosoExtension')).toBe(true);
  });

  it('rejects a tampered signed token', () => {
    process.env.GROUNDING_SECRET = 'test-secret';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    const [prefix, , mac] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ o: 'SalesTable', e: Date.now() + 60 * 60 * 1000 }), 'utf8',
    ).toString('base64url');
    expect(isValidToken(`${prefix}.${forgedPayload}.${mac}`)).toBe(false);
  });

  it('rejects a signed token verified with a different secret', async () => {
    process.env.GROUNDING_SECRET = 'secret-A';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    process.env.GROUNDING_SECRET = 'secret-B';
    vi.resetModules();
    const fresh = await import('../../src/utils/provenanceStore');
    expect(fresh.isValidToken(token)).toBe(false);
  });

  it('rejects an expired signed token', async () => {
    process.env.GROUNDING_SECRET = 'test-secret';
    vi.useFakeTimers();
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    vi.advanceTimersByTime(31 * 60 * 1000);
    vi.resetModules();
    const fresh = await import('../../src/utils/provenanceStore');
    expect(fresh.isValidToken(token)).toBe(false);
  });
});

// ─── Enforcement ─────────────────────────────────────────────────────────────

describe('enforceGrounding', () => {
  it('passes when GROUNDING_ENFORCE is not set', () => {
    delete process.env.GROUNDING_ENFORCE;
    expect(enforceGrounding(undefined, 'op')).toBeNull();
  });

  it('fails closed without a token when GROUNDING_ENFORCE=true', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = enforceGrounding(undefined, 'create_d365fo_file(...)');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('prepare(mode="change"');
  });

  it('fails with an invalid token', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const result = enforceGrounding('deadbeefdeadbeefdeadbeefdeadbeef', 'op');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('expired or is invalid');
  });

  it('passes with a valid token and matching target', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(enforceGrounding(token, 'op', 'CustTable.ContosoExtension')).toBeNull();
  });

  it('rejects a valid token used on a different object', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    const result = enforceGrounding(token, 'op', 'SalesTable.ContosoExtension');
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain('token mismatch');
    expect(result?.content[0].text).toContain('SalesTable.ContosoExtension');
  });

  it('passes with a valid token when no target is supplied (backward compatible)', () => {
    process.env.GROUNDING_ENFORCE = 'true';
    const token = createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(enforceGrounding(token, 'op')).toBeNull();
  });
});

// ─── Hybrid-deployment guard ─────────────────────────────────────────────────
// In write-only mode prepare_change is not exposed and tokens live in the
// read-only instance's memory — enforcement would dead-loop the agent between
// the two servers, so it must be bypassed (with a stderr warning).

describe('enforceGrounding in write-only server mode', () => {
  afterEach(() => {
    vi.doUnmock('../../src/server/serverMode');
    vi.resetModules();
  });

  it('bypasses enforcement even without a token', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    delete process.env.GROUNDING_SECRET;
    vi.resetModules();
    vi.doMock('../../src/server/serverMode', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/server/serverMode')>()),
      SERVER_MODE: 'write-only' as const,
    }));
    const { enforceGrounding: enforceWriteOnly } = await import('../../src/utils/provenanceStore');
    expect(enforceWriteOnly(undefined, 'create_d365fo_file(...)')).toBeNull();
    expect(enforceWriteOnly('deadbeefdeadbeefdeadbeefdeadbeef', 'op')).toBeNull();
  });

  it('enforces in write-only mode when GROUNDING_SECRET is shared', async () => {
    process.env.GROUNDING_ENFORCE = 'true';
    process.env.GROUNDING_SECRET = 'shared-secret';
    vi.resetModules();
    vi.doMock('../../src/server/serverMode', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../src/server/serverMode')>()),
      SERVER_MODE: 'write-only' as const,
    }));
    const writeOnly = await import('../../src/utils/provenanceStore');
    // No token → fails closed (signed tokens are validatable here, so no dead-loop)
    expect(writeOnly.enforceGrounding(undefined, 'op')?.isError).toBe(true);
    // A signed token issued "elsewhere" with the same secret → passes
    const token = writeOnly.createProvenanceToken({ goal: 'test', objectName: 'CustTable' });
    expect(writeOnly.enforceGrounding(token, 'op', 'CustTable.ContosoExtension')).toBeNull();
  });
});
