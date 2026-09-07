/**
 * Per-request progress channel (#829).
 *
 * A tool that blocks for minutes has exactly one way to stay in a single round
 * trip: report while it works. Both notification channels are best-effort, so
 * the contract that matters most is that a client which rejects, or does not
 * offer, either channel can never fail or stall the tool.
 */

import { describe, it, expect, vi } from 'vitest';
import { createProgressReporter, startProgressHeartbeat } from '../../src/utils/progressReporter';

function fakeServer() {
  return { sendLoggingMessage: vi.fn().mockResolvedValue(undefined) };
}

describe('createProgressReporter', () => {
  it('sends notifications/progress when the client supplied a progressToken', async () => {
    const server = fakeServer();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter(server as any, { _meta: { progressToken: 'tok-1' }, sendNotification });

    await report('🔨 Building MyModel — 30s elapsed', 30);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [notification] = sendNotification.mock.calls[0];
    expect(notification.method).toBe('notifications/progress');
    expect(notification.params.progressToken).toBe('tok-1');
    expect(notification.params.progress).toBe(30);
    expect(notification.params.message).toContain('Building MyModel');
    // Unknown total must be omitted rather than guessed.
    expect('total' in notification.params).toBe(false);
    // The logging channel always fires too — clients differ in which they show.
    expect(server.sendLoggingMessage).toHaveBeenCalledTimes(1);
  });

  it('includes total only when the caller knows it', async () => {
    const server = fakeServer();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter(server as any, { _meta: { progressToken: 7 }, sendNotification });

    await report('step', 1, 4);

    expect(sendNotification.mock.calls[0][0].params.total).toBe(4);
  });

  it('falls back to the logging channel when no progressToken was supplied', async () => {
    const server = fakeServer();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter(server as any, { _meta: {}, sendNotification });

    await report('working', 0);

    expect(sendNotification).not.toHaveBeenCalled();
    expect(server.sendLoggingMessage).toHaveBeenCalledTimes(1);
  });

  it('is a safe no-op when the request carries no extra at all', async () => {
    const server = fakeServer();
    const report = createProgressReporter(server as any, undefined);

    await expect(report('working', 0)).resolves.toBeUndefined();
    expect(server.sendLoggingMessage).toHaveBeenCalledTimes(1);
  });

  it('never rejects when either channel throws', async () => {
    const server = { sendLoggingMessage: vi.fn().mockRejectedValue(new Error('transport closed')) };
    const sendNotification = vi.fn().mockRejectedValue(new Error('unsupported'));
    const report = createProgressReporter(server as any, { _meta: { progressToken: 'tok' }, sendNotification });

    await expect(report('working', 12)).resolves.toBeUndefined();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(server.sendLoggingMessage).toHaveBeenCalledTimes(1);
  });
});

describe('startProgressHeartbeat', () => {
  it('says nothing before the first tick, so a fast tool is unchanged', () => {
    vi.useFakeTimers();
    try {
      const report = vi.fn().mockResolvedValue(undefined);
      const stop = startProgressHeartbeat(report, '⚙️ Reading workspace configuration', 15_000);
      vi.advanceTimersByTime(14_000);
      stop();

      expect(report).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports elapsed seconds, monotonically, until it is stopped', () => {
    vi.useFakeTimers();
    try {
      const report = vi.fn().mockResolvedValue(undefined);
      const stop = startProgressHeartbeat(report, '⚙️ Reading workspace configuration', 15_000);
      vi.advanceTimersByTime(45_000);
      stop();
      vi.advanceTimersByTime(60_000);

      expect(report).toHaveBeenCalledTimes(3);
      expect(report.mock.calls.map(c => c[1])).toEqual([15, 30, 45]);
      // MCP requires the progress value to increase across notifications for one
      // request; elapsed seconds is the only monotone quantity a tool with no known
      // total has.
      expect(report.mock.calls[2][0]).toContain('45s');
    } finally {
      vi.useRealTimers();
    }
  });
});
