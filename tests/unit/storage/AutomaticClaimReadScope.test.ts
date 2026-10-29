import { performance } from 'perf_hooks';
import {
  beginAutomaticClaimReadAttempt,
  canUseAutomaticClaimReadScope,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';

describe('automatic claim read scope', () => {
  it('shares one opaque scope per source hydration budget and reserves attempt resources', () => {
    const budget = { remaining: 512, deferred: 3 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(getAutomaticClaimReadScope(budget)).toBe(scope);
    expect(Object.keys(scope)).toEqual([]);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(canUseAutomaticClaimReadScope(scope)).toBe(true);

    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(budget.remaining).toBe(508);
    expect(getAutomaticClaimReadScopeRemaining(scope)).toMatchObject({
      attemptsRemaining: 127,
      sourceHydrationsRemaining: 508,
      contextBytesRemaining: 8 * 1024 * 1024,
      snapshotBytesRemaining: 100 * 1024 * 1024,
    });
    expect(budget.deferred).toBe(3);
  });

  it('charges bounded snapshot and returned context bytes without changing diagnostics', () => {
    const budget = { remaining: 8, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(reserveAutomaticClaimSnapshotBytes(scope, 4096)).toBe(true);
    expect(chargeAutomaticClaimContextBytes(scope, 2048)).toBe(true);
    expect(getAutomaticClaimReadScopeRemaining(scope)).toMatchObject({
      snapshotBytesRemaining: 100 * 1024 * 1024 - 4096,
      contextBytesRemaining: 8 * 1024 * 1024 - 2048,
    });
    expect(reserveAutomaticClaimSnapshotBytes(scope, 101 * 1024 * 1024)).toBe(false);
    expect(chargeAutomaticClaimContextBytes(scope, 9 * 1024 * 1024)).toBe(false);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(false);
    expect(budget.deferred).toBe(0);
  });

  it('does not accept a caller-created scope token', () => {
    const forged = Object.freeze({});
    expect(canUseAutomaticClaimReadScope(forged as never)).toBe(false);
    expect(beginAutomaticClaimReadAttempt(forged as never)).toBe(false);
    expect(getAutomaticClaimReadScopeRemaining(forged as never)).toBeNull();
  });

  it('enforces exact context and snapshot byte allowances', () => {
    const budget = { remaining: 1024, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(chargeAutomaticClaimContextBytes(scope, 8 * 1024 * 1024)).toBe(true);
    expect(chargeAutomaticClaimContextBytes(scope, 1)).toBe(false);
    expect(reserveAutomaticClaimSnapshotBytes(scope, 100 * 1024 * 1024)).toBe(true);
    expect(reserveAutomaticClaimSnapshotBytes(scope, 1)).toBe(false);
  });

  it('caps attempts at 128 and keeps token availability separate from resource exhaustion', () => {
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    for (let attempt = 0; attempt < 128; attempt += 1) {
      budget.remaining = 512;
      expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    }
    expect(canUseAutomaticClaimReadScope(scope)).toBe(true);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(false);
    expect(getAutomaticClaimReadScopeRemaining(scope)?.attemptsRemaining).toBe(0);
  });

  it('expires every capability at the shared five-second monotonic deadline', () => {
    let now = 100;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const budget = { remaining: 16, deferred: 0 };
      const scope = getAutomaticClaimReadScope(budget);
      now = 5_100;
      expect(canUseAutomaticClaimReadScope(scope)).toBe(false);
      expect(beginAutomaticClaimReadAttempt(scope)).toBe(false);
      expect(reserveAutomaticClaimSnapshotBytes(scope, 1)).toBe(false);
      expect(chargeAutomaticClaimContextBytes(scope, 1)).toBe(false);
      expect(getAutomaticClaimReadScopeRemaining(scope)?.deadlineRemainingMs).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});
