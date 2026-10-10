import { describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../../src/bridge/bridgeClient.js';
describe('AxDB bridge calls', () => {
  it('never retries SQL on a timeout even with read retries enabled', async () => {
    const client = new BridgeClient({ packagesPath: 'C:\\Missing', maxRetries: 3 });
    const send = vi.fn().mockRejectedValue(new Error('timed out'));
    (client as any).callOnce = send;
    for (const method of ['axdbQuery', 'axdbSchema'] as const) {
      await expect(client.callAxDb(method, {})).rejects.toThrow('timed out');
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(c => c[2] >= 50000)).toBe(true);
  });
  it('does not assume an old bridge has SQL support', () => {
    const client = new BridgeClient({ packagesPath: 'C:\\Missing' });
    (client as any).readyPayload = { status: 'ready', metadataAvailable: true };
    expect(client.axdbSqlAvailable).toBe(false);
    (client as any).readyPayload.axdbSqlAvailable = true;
    expect(client.axdbSqlAvailable).toBe(true);
  });
});
