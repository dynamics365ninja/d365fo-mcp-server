/**
 * Whether `update` offers to rebuild the C# bridge.
 *
 * The bridge binary lives inside the package, and `npm install -g
 * d365fo-mcp@latest` replaces the package directory wholesale — so an npm-mode
 * update deletes the only write path the server has. The decision therefore
 * cannot be made from the state after the update alone: the exe is always
 * missing by then, which reads identically to "this install never built one"
 * and skips the rebuild. A server that could write before the update would
 * come back read-only, with nothing said about it.
 *
 * Hence two inputs, one sampled on each side of the update.
 */
import { describe, it, expect } from 'vitest';
import { bridgeAction } from '../../src/cli/commands/update.js';

describe('bridgeAction', () => {
  it('does nothing when this install never had a bridge', () => {
    // Read-only, hybrid and azure-client setups: no dotnet, nothing to rebuild.
    expect(bridgeAction(false, false)).toBe('none');
  });

  it('offers an optional rebuild when the bridge survived the update', () => {
    // The git-checkout case: `git pull` leaves bin/Release alone, so rebuilding
    // is a post-D365FO-upgrade nicety rather than a repair.
    expect(bridgeAction(true, true)).toBe('optional');
  });

  it('requires a rebuild when the update removed a bridge that was there', () => {
    // The npm case, and the regression this guards: judged on the after-state
    // alone this is indistinguishable from 'none'.
    expect(bridgeAction(true, false)).toBe('required');
  });

  it('does not invent work when a bridge appears from nowhere', () => {
    // Not reachable through the update flow, but the answer should still be
    // "leave it alone" rather than a rebuild prompt for something untouched.
    expect(bridgeAction(false, true)).toBe('none');
  });
});
