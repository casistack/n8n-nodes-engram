import { performance } from 'perf_hooks';
import {
  AutomaticClaimReadScopeConfigurationError,
  beginAutomaticClaimReadAttempt,
  canUseAutomaticClaimReadScope,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
  getAutomaticClaimReadScopeWithAbsoluteDeadline,
  reserveAutomaticClaimSnapshotBytes,
} from '../../../src/storage/AutomaticClaimReadScope';

function expectReason(fn: () => unknown, reason: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AutomaticClaimReadScopeConfigurationError);
  expect((error as AutomaticClaimReadScopeConfigurationError).reason).toBe(reason);
}

describe('automatic claim read scope explicit absolute deadline', () => {
  let now = 1_000;
  let clock: jest.SpyInstance;

  beforeEach(() => {
    now = 1_000;
    clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  it('keeps the legacy five-second factory and idempotence', () => {
    const budget = { remaining: 16, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    expect(getAutomaticClaimReadScope(budget)).toBe(scope);
    now = 5_999;
    expect(canUseAutomaticClaimReadScope(scope)).toBe(true);
    now = 6_000;
    expect(canUseAutomaticClaimReadScope(scope)).toBe(false);
  });

  it('honors a configured deadline shorter and longer than the legacy window', () => {
    const shortScope = getAutomaticClaimReadScopeWithAbsoluteDeadline(
      { remaining: 16, deferred: 0 },
      2_000,
    );
    const longScope = getAutomaticClaimReadScopeWithAbsoluteDeadline(
      { remaining: 16, deferred: 0 },
      60_000,
    );
    now = 1_999;
    expect(canUseAutomaticClaimReadScope(shortScope)).toBe(true);
    expect(getAutomaticClaimReadScopeRemaining(shortScope)?.deadlineRemainingMs).toBe(1);
    now = 2_000;
    expect(canUseAutomaticClaimReadScope(shortScope)).toBe(false);
    expect(beginAutomaticClaimReadAttempt(shortScope)).toBe(false);
    now = 30_000;
    expect(canUseAutomaticClaimReadScope(longScope)).toBe(true);
    expect(getAutomaticClaimReadScopeRemaining(longScope)?.deadlineRemainingMs).toBe(30_000);
    now = 60_000;
    expect(canUseAutomaticClaimReadScope(longScope)).toBe(false);
  });

  it('does not reset the original deadline on repeated calls', () => {
    const budget = { remaining: 16, deferred: 0 };
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 3_000);
    now = 2_500;
    expect(getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 3_000)).toBe(scope);
    expect(getAutomaticClaimReadScopeRemaining(scope)?.deadlineRemainingMs).toBe(500);
    now = 3_000;
    expect(getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 3_000)).toBe(scope);
    expect(canUseAutomaticClaimReadScope(scope)).toBe(false);
  });

  it('keeps past and negative deadlines expired without fallback', () => {
    for (const deadline of [999, 0, -5, -1_000_000]) {
      const budget = { remaining: 16, deferred: 0 };
      const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, deadline);
      expect(canUseAutomaticClaimReadScope(scope)).toBe(false);
      expect(beginAutomaticClaimReadAttempt(scope)).toBe(false);
      expect(reserveAutomaticClaimSnapshotBytes(scope, 1)).toBe(false);
      expect(chargeAutomaticClaimContextBytes(scope, 1)).toBe(false);
      expect(getAutomaticClaimReadScopeRemaining(scope)).toMatchObject({
        deadlineRemainingMs: 0,
        attemptsRemaining: 128,
        sourceHydrationsRemaining: 16,
      });
      expect(budget.remaining).toBe(16);
    }
  });

  it('rejects malformed and nonfinite deadlines without poisoning the budget', () => {
    const budget = { remaining: 16, deferred: 0 };
    const bad: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      undefined,
      null,
      '5000',
      {},
      [],
      BigInt(10),
      { valueOf: () => 5_000 },
    ];
    for (const deadline of bad) {
      expectReason(
        () => getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, deadline as number),
        'invalid_deadline',
      );
    }
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 4_000);
    expect(canUseAutomaticClaimReadScope(scope)).toBe(true);
  });

  it('rejects changed deadlines and legacy/configured crossovers', () => {
    const budget = { remaining: 16, deferred: 0 };
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 4_000);
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 4_001),
      'scope_configuration_conflict',
    );
    expectReason(() => getAutomaticClaimReadScope(budget), 'scope_configuration_conflict');
    expect(getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 4_000)).toBe(scope);

    const legacyBudget = { remaining: 16, deferred: 0 };
    const legacyScope = getAutomaticClaimReadScope(legacyBudget);
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(legacyBudget, 6_000),
      'scope_configuration_conflict',
    );
    expect(getAutomaticClaimReadScope(legacyBudget)).toBe(legacyScope);
    now = 5_999;
    expect(canUseAutomaticClaimReadScope(legacyScope)).toBe(true);
  });

  it('shares one counter set across repeated configured calls', () => {
    const budget = { remaining: 1024, deferred: 2 };
    const first = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 10_000);
    const second = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 10_000);
    expect(second).toBe(first);
    expect(Object.keys(first)).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);

    expect(beginAutomaticClaimReadAttempt(first)).toBe(true);
    expect(chargeAutomaticClaimContextBytes(second, 8 * 1024 * 1024)).toBe(true);
    expect(chargeAutomaticClaimContextBytes(first, 1)).toBe(false);
    expect(reserveAutomaticClaimSnapshotBytes(first, 100 * 1024 * 1024)).toBe(true);
    expect(reserveAutomaticClaimSnapshotBytes(second, 1)).toBe(false);
    expect(getAutomaticClaimReadScopeRemaining(second)).toMatchObject({
      attemptsRemaining: 127,
      contextBytesRemaining: 0,
      snapshotBytesRemaining: 0,
      sourceHydrationsRemaining: 1020,
      deadlineRemainingMs: 9_000,
    });
    expect(budget.deferred).toBe(2);
  });

  it('caps configured attempts at 128 and hydrations at four per attempt', () => {
    const budget = { remaining: 1024, deferred: 0 };
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 10_000);
    for (let attempt = 0; attempt < 128; attempt += 1) {
      budget.remaining = 1024;
      expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
      expect(budget.remaining).toBe(1020);
    }
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(false);

    const small = { remaining: 7, deferred: 0 };
    const smallScope = getAutomaticClaimReadScopeWithAbsoluteDeadline(small, 10_000);
    expect(beginAutomaticClaimReadAttempt(smallScope)).toBe(true);
    expect(beginAutomaticClaimReadAttempt(smallScope)).toBe(false);
    expect(small.remaining).toBe(3);
  });

  it('operates on the original budget object, not a clone', () => {
    const budget = { remaining: 8, deferred: 0 };
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 10_000);
    budget.remaining = 100;
    expect(getAutomaticClaimReadScopeRemaining(scope)?.sourceHydrationsRemaining).toBe(100);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(budget.remaining).toBe(96);
  });

  it('accepts null-prototype budgets and ignores extra metadata', () => {
    const budget = Object.assign(Object.create(null), { remaining: 8, deferred: 1, extra: 'x' });
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 10_000);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(budget.remaining).toBe(4);
  });

  it('rejects proxy budgets without invoking any trap', () => {
    let traps = 0;
    const count = (): never => {
      traps += 1;
      throw new Error('trap');
    };
    const handler: ProxyHandler<object> = {
      get: count,
      getOwnPropertyDescriptor: count,
      getPrototypeOf: count,
      has: count,
      ownKeys: count,
      set: count,
      defineProperty: count,
      isExtensible: count,
      preventExtensions: count,
      setPrototypeOf: count,
      deleteProperty: count,
    };
    const proxy = new Proxy({ remaining: 8, deferred: 0 }, handler);
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(proxy as never, 10_000),
      'invalid_budget',
    );
    expect(traps).toBe(0);
  });

  it('rejects accessor budgets without invoking getters or setters', () => {
    let calls = 0;
    const getterBudget = {
      get remaining() {
        calls += 1;
        return 8;
      },
      deferred: 0,
    };
    const setterBudget = {
      remaining: 8,
      get deferred() {
        calls += 1;
        return 0;
      },
      set deferred(_value: number) {
        calls += 1;
      },
    };
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(getterBudget, 10_000),
      'invalid_budget',
    );
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(setterBudget, 10_000),
      'invalid_budget',
    );
    expect(calls).toBe(0);
  });

  it('requires own writable data descriptors on a plain object', () => {
    const inherited = Object.create({ remaining: 8, deferred: 0 });
    const missingDeferred = { remaining: 8 };
    const frozen = Object.freeze({ remaining: 8, deferred: 0 });
    const readonlyRemaining = Object.defineProperty({ deferred: 0 }, 'remaining', {
      value: 8,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    const readonlyDeferred = Object.defineProperty({ remaining: 8 }, 'deferred', {
      value: 0,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    class Custom {
      remaining = 8;
      deferred = 0;
    }
    for (const candidate of [
      inherited,
      missingDeferred,
      frozen,
      readonlyRemaining,
      readonlyDeferred,
      new Custom(),
      [],
      null,
      undefined,
      42,
      'budget',
    ]) {
      expectReason(
        () => getAutomaticClaimReadScopeWithAbsoluteDeadline(candidate as never, 10_000),
        'invalid_budget',
      );
    }
  });

  it('reports invalid_deadline first when both budget and deadline are invalid', () => {
    const stale = { remaining: 2000, deferred: 0 };
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(stale, NaN),
      'invalid_deadline',
    );
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(null as never, Infinity),
      'invalid_deadline',
    );
    stale.remaining = 8;
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(stale, 10_000);
    expect(canUseAutomaticClaimReadScope(scope)).toBe(true);
  });

  it('rejects nested counter objects and proxies without invoking any trap or member', () => {
    let touched = 0;
    const touch = (): never => {
      touched += 1;
      throw new Error('touched');
    };
    const trapHandler: ProxyHandler<object> = {
      get: touch,
      getOwnPropertyDescriptor: touch,
      getPrototypeOf: touch,
      has: touch,
      ownKeys: touch,
      set: touch,
      defineProperty: touch,
      isExtensible: touch,
      preventExtensions: touch,
      setPrototypeOf: touch,
      deleteProperty: touch,
    };
    const nestedValues = (): unknown[] => [
      {
        get then() {
          touched += 1;
          return () => undefined;
        },
      },
      {
        valueOf() {
          touched += 1;
          return 8;
        },
        toString() {
          touched += 1;
          return '8';
        },
      },
      {
        get value() {
          touched += 1;
          return 8;
        },
      },
      new Proxy({}, trapHandler),
      new Proxy(() => 8, trapHandler),
      new Number(8),
      Object.assign(Object.create(null), { then: touch }),
    ];
    for (const counter of ['remaining', 'deferred'] as const) {
      for (const nested of nestedValues()) {
        const budget = { remaining: 8, deferred: 0, [counter]: nested };
        expectReason(
          () => getAutomaticClaimReadScopeWithAbsoluteDeadline(budget as never, 10_000),
          'invalid_budget',
        );
        expect(budget[counter]).toBe(nested);
      }
    }
    expect(touched).toBe(0);
  });

  it('validates counter values through the budget schema', () => {
    for (const [remaining, deferred] of [
      [-1, 0],
      [1025, 0],
      [1.5, 0],
      [NaN, 0],
      ['8', 0],
      [8, -1],
      [8, 1.5],
      [8, Infinity],
      [8, '0'],
    ]) {
      expectReason(
        () =>
          getAutomaticClaimReadScopeWithAbsoluteDeadline({ remaining, deferred } as never, 10_000),
        'invalid_budget',
      );
    }
    const edge = { remaining: 1024, deferred: 0 };
    expect(
      canUseAutomaticClaimReadScope(getAutomaticClaimReadScopeWithAbsoluteDeadline(edge, 2_000)),
    ).toBe(true);
  });

  it('recovers after a failed first call on the same object', () => {
    const budget = { remaining: 8, deferred: 0 } as { remaining: unknown; deferred: number };
    budget.remaining = 2000;
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(budget as never, 10_000),
      'invalid_budget',
    );
    expectReason(
      () => getAutomaticClaimReadScopeWithAbsoluteDeadline(budget as never, NaN),
      'invalid_deadline',
    );
    budget.remaining = 8;
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget as never, 3_000);
    expect(beginAutomaticClaimReadAttempt(scope)).toBe(true);
    expect(getAutomaticClaimReadScope).toBeDefined();
    expectReason(() => getAutomaticClaimReadScope(budget as never), 'scope_configuration_conflict');
  });

  it('does not accept copied, spread, serialized, proxied or forged tokens', () => {
    const budget = { remaining: 16, deferred: 0 };
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(budget, 10_000);
    const candidates: unknown[] = [
      { ...(scope as object) },
      Object.assign({}, scope),
      Object.create(scope),
      JSON.parse(JSON.stringify(scope)),
      new Proxy(scope as object, {}),
      Object.freeze(Object.create(null)),
      null,
      undefined,
      'scope',
    ];
    for (const candidate of candidates) {
      expect(canUseAutomaticClaimReadScope(candidate as never)).toBe(false);
      expect(beginAutomaticClaimReadAttempt(candidate as never)).toBe(false);
      expect(reserveAutomaticClaimSnapshotBytes(candidate as never, 1)).toBe(false);
      expect(chargeAutomaticClaimContextBytes(candidate as never, 1)).toBe(false);
      expect(getAutomaticClaimReadScopeRemaining(candidate as never)).toBeNull();
    }
    expect(budget.remaining).toBe(16);
  });

  it('rejects invalid byte amounts on configured scopes', () => {
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(
      { remaining: 16, deferred: 0 },
      10_000,
    );
    for (const bytes of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(reserveAutomaticClaimSnapshotBytes(scope, bytes)).toBe(false);
      expect(chargeAutomaticClaimContextBytes(scope, bytes)).toBe(false);
    }
    expect(getAutomaticClaimReadScopeRemaining(scope)).toMatchObject({
      contextBytesRemaining: 8 * 1024 * 1024,
      snapshotBytesRemaining: 100 * 1024 * 1024,
    });
  });

  it('exposes only fixed bounded error text', () => {
    const secret = 'sensitive-value';
    let error: unknown;
    try {
      getAutomaticClaimReadScopeWithAbsoluteDeadline(
        { remaining: secret, deferred: 0 } as never,
        10_000,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AutomaticClaimReadScopeConfigurationError);
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).toBe('Automatic claim read scope budget is invalid');
  });
});
