import { ZodError } from 'zod';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import { AutonomousPersonalExecutionBudgetResolutionV1Schema } from '../../../src/schemas/AutonomousPersonalExecutionBudgetV1.schema';
import { BoundedAutomaticCaptureJsonError } from '../../../src/storage/BoundedAutomaticCaptureJson';
import {
  AUTONOMOUS_EXECUTION_BUDGET_V1_HASH_DOMAIN,
  AutonomousPersonalExecutionBudgetError,
  DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1,
  compileAutonomousPersonalExecutionBudgetV1,
  hashAutonomousPersonalExecutionBudgetV1,
  resolveAutonomousPersonalExecutionBudgetV1,
} from '../../../src/storage/AutonomousPersonalExecutionBudgetV1';

const configured = (overrides: Record<string, unknown> = {}) => ({
  semantics: 'configured',
  version: 1,
  completion: { mode: 'inheritOverall' },
  syntax: { mode: 'inheritOverall' },
  finalizationReserve: { mode: 'automatic' },
  ...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({
  originalStartedAt: 1_000,
  configuredOverallMs: 10_000,
  originalOverallDeadlineAt: 20_000,
  existingLeaseDeadlineAt: 50_000,
  ...overrides,
});

describe('autonomous personal execution budget V1 compilation', () => {
  it('maps only missing input to legacy and keeps legacy distinct from the default', () => {
    const legacy = compileAutonomousPersonalExecutionBudgetV1(undefined);
    expect(legacy).toEqual({ semantics: 'legacy' });
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(compileAutonomousPersonalExecutionBudgetV1({ semantics: 'legacy' })).toEqual(legacy);
    expect(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1).toEqual(configured());
    expect(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1).not.toEqual(legacy);
  });

  it('exposes an immutable default that compiles to an equal, separate owned copy', () => {
    expect(Object.isFrozen(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1.completion)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1.finalizationReserve)).toBe(true);
    const owned = compileAutonomousPersonalExecutionBudgetV1(
      DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1,
    );
    expect(owned).toEqual(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1);
    expect(owned).not.toBe(DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1);
  });

  it('accepts every configured mode at its limits', () => {
    for (const value of [100, 5_000, 120_000]) {
      expect(
        compileAutonomousPersonalExecutionBudgetV1(
          configured({
            completion: { mode: 'limited', durationMs: value },
            syntax: { mode: 'limited', durationMs: value },
          }),
        ),
      ).toMatchObject({ completion: { durationMs: value }, syntax: { durationMs: value } });
    }
    for (const value of [20, 5_000]) {
      expect(
        compileAutonomousPersonalExecutionBudgetV1(
          configured({ finalizationReserve: { mode: 'fixed', durationMs: value } }),
        ),
      ).toMatchObject({ finalizationReserve: { mode: 'fixed', durationMs: value } });
    }
  });

  it('rejects null, unknown versions, modes, keys and extra fields instead of falling back', () => {
    const invalid: unknown[] = [
      null,
      [],
      'configured',
      7,
      {},
      { semantics: 'legacy', version: 1 },
      { semantics: 'future' },
      configured({ version: 2 }),
      configured({ version: '1' }),
      configured({ extra: true }),
      configured({ completion: { mode: 'unlimited' } }),
      configured({ completion: { mode: 'inheritOverall', durationMs: 1_000 } }),
      configured({ completion: { mode: 'limited' } }),
      configured({ syntax: null }),
      configured({ finalizationReserve: { mode: 'automatic', durationMs: 100 } }),
      configured({ finalizationReserve: { mode: 'fixed' } }),
      configured({ completion: undefined }),
    ];
    for (const value of invalid) {
      expect(() => compileAutonomousPersonalExecutionBudgetV1(value)).toThrow();
    }
  });

  it('rejects coercible, fractional, negative, non-finite and out-of-range limits', () => {
    const badStage = [
      '1000',
      99.5,
      1_000.5,
      -1_000,
      0,
      99,
      120_001,
      NaN,
      Infinity,
      -Infinity,
      null,
    ];
    for (const durationMs of badStage) {
      for (const key of ['completion', 'syntax']) {
        expect(() =>
          compileAutonomousPersonalExecutionBudgetV1(
            configured({ [key]: { mode: 'limited', durationMs } }),
          ),
        ).toThrow();
      }
    }
    for (const durationMs of [
      '100',
      19,
      5_001,
      50.5,
      -20,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(() =>
        compileAutonomousPersonalExecutionBudgetV1(
          configured({ finalizationReserve: { mode: 'fixed', durationMs } }),
        ),
      ).toThrow();
    }
  });

  it('owns input through the bounded plain-data boundary before schema access', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'semantics', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'legacy';
      },
    });
    expect(() => compileAutonomousPersonalExecutionBudgetV1(accessor)).toThrow(
      BoundedAutomaticCaptureJsonError,
    );
    expect(reads).toBe(0);

    class Custom {
      semantics = 'legacy';
    }
    expect(() => compileAutonomousPersonalExecutionBudgetV1(new Custom())).toThrow(
      BoundedAutomaticCaptureJsonError,
    );
    expect(() =>
      compileAutonomousPersonalExecutionBudgetV1(configured({ note: 'x'.repeat(20_000) })),
    ).toThrow(BoundedAutomaticCaptureJsonError);
  });

  it('returns frozen data that later caller mutation cannot change', () => {
    const input = configured({ completion: { mode: 'limited', durationMs: 2_000 } });
    const owned = compileAutonomousPersonalExecutionBudgetV1(input);
    Object.assign(input.completion, { durationMs: 9_999 });
    Object.assign(input.syntax, { mode: 'limited', durationMs: 3_000 });
    expect(owned).toEqual(configured({ completion: { mode: 'limited', durationMs: 2_000 } }));
    expect(Object.isFrozen(owned)).toBe(true);
    if (owned.semantics === 'configured') {
      expect(Object.isFrozen(owned.completion)).toBe(true);
      expect(() => {
        (owned.completion as { mode: string }).mode = 'inheritOverall';
      }).toThrow(TypeError);
    }
  });
});

describe('autonomous personal execution budget V1 fingerprint', () => {
  it('hashes the exact domain and complete configured body', () => {
    const body = configured({
      completion: { mode: 'limited', durationMs: 2_000 },
      syntax: { mode: 'limited', durationMs: 3_000 },
      finalizationReserve: { mode: 'fixed', durationMs: 50 },
    });
    expect(AUTONOMOUS_EXECUTION_BUDGET_V1_HASH_DOMAIN).toBe(
      'engram-autonomous-execution-budget-v1',
    );
    expect(hashAutonomousPersonalExecutionBudgetV1(body)).toBe(
      hashAutomaticCaptureV2({ domain: 'engram-autonomous-execution-budget-v1', budget: body }),
    );
  });

  it('is independent of key insertion order', () => {
    const forward = configured({ completion: { mode: 'limited', durationMs: 1_000 } });
    const reversed = {
      finalizationReserve: { mode: 'automatic' },
      syntax: { mode: 'inheritOverall' },
      completion: { durationMs: 1_000, mode: 'limited' },
      version: 1,
      semantics: 'configured',
    };
    expect(hashAutonomousPersonalExecutionBudgetV1(reversed)).toBe(
      hashAutonomousPersonalExecutionBudgetV1(forward),
    );
  });

  it('changes when any configured field or mode changes', () => {
    const variants = [
      configured(),
      configured({ completion: { mode: 'limited', durationMs: 1_000 } }),
      configured({ completion: { mode: 'limited', durationMs: 1_001 } }),
      configured({ syntax: { mode: 'limited', durationMs: 1_000 } }),
      configured({ syntax: { mode: 'limited', durationMs: 1_001 } }),
      configured({ finalizationReserve: { mode: 'fixed', durationMs: 20 } }),
      configured({ finalizationReserve: { mode: 'fixed', durationMs: 21 } }),
    ];
    const hashes = variants.map((variant) => hashAutonomousPersonalExecutionBudgetV1(variant));
    expect(new Set(hashes).size).toBe(variants.length);
    for (const hash of hashes) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for legacy and rejects malformed input', () => {
    expect(hashAutonomousPersonalExecutionBudgetV1({ semantics: 'legacy' })).toBeNull();
    expect(() => hashAutonomousPersonalExecutionBudgetV1(configured({ version: 2 }))).toThrow(
      ZodError,
    );
    expect(() => hashAutonomousPersonalExecutionBudgetV1(undefined)).toThrow();
  });
});

describe('autonomous personal execution budget V1 reserve', () => {
  it('follows clamp(ceil(overall / 10), 20, 1000)', () => {
    const reserveFor = (configuredOverallMs: number) =>
      resolveAutonomousPersonalExecutionBudgetV1(
        DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1,
        context({
          configuredOverallMs,
          originalOverallDeadlineAt: 1_000_000,
          existingLeaseDeadlineAt: 1_000_000,
        }),
      ).finalizationReserveMs;
    expect([100, 1_000, 10_000, 30_000, 120_000].map(reserveFor)).toEqual([
      20, 100, 1_000, 1_000, 1_000,
    ]);
    expect(reserveFor(105)).toBe(20);
    expect(reserveFor(1_005)).toBe(101);
  });

  it('does not export the raw reserve helper', async () => {
    const module = await import('../../../src/storage/AutonomousPersonalExecutionBudgetV1');
    expect(module).not.toHaveProperty('automaticFinalizationReserveMsV1');
  });

  it('requires a fixed reserve strictly below the configured overall allowance', () => {
    const fixed = (durationMs: number) =>
      configured({ finalizationReserve: { mode: 'fixed', durationMs } });
    for (const durationMs of [100, 120]) {
      expect(() =>
        resolveAutonomousPersonalExecutionBudgetV1(
          fixed(durationMs),
          context({ configuredOverallMs: 100 }),
        ),
      ).toThrow(AutonomousPersonalExecutionBudgetError);
    }
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      fixed(5_000),
      context({ configuredOverallMs: 5_001, originalOverallDeadlineAt: 100_000 }),
    );
    expect(resolved.finalizationReserveMs).toBe(5_000);
    expect(resolved.providerDeadlineAt).toBe(1_000 + 5_001 - 5_000);
    expect(
      resolveAutonomousPersonalExecutionBudgetV1(fixed(20), context({ configuredOverallMs: 100 }))
        .finalizationReserveMs,
    ).toBe(20);
  });
});

describe('autonomous personal execution budget V1 resolution', () => {
  const defaults = DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1;

  it('clips overall to the configured original ceiling and reports a not-started phase', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(defaults, context());
    expect(resolved).toMatchObject({
      semantics: 'configured',
      version: 1,
      originalCeilingAt: 11_000,
      effectiveOverallDeadlineAt: 11_000,
      finalizationReserveMs: 1_000,
      providerDeadlineAt: 10_000,
      phase: 'notStarted',
      completionDeadlineAt: null,
      syntaxAllowanceMs: null,
      fingerprint: hashAutonomousPersonalExecutionBudgetV1(defaults),
      clipped: {
        overallByConfiguredAllowance: true,
        overallByLease: false,
        providerByReserve: true,
        completionByOverall: false,
      },
    });
  });

  it('keeps the original deadline when it is earlier than the configured allowance', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ originalOverallDeadlineAt: 6_000 }),
    );
    expect(resolved.originalCeilingAt).toBe(6_000);
    expect(resolved.clipped.overallByConfiguredAllowance).toBe(false);
  });

  it('lets an earlier lease clip the overall deadline but never extend it', () => {
    const clipped = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ existingLeaseDeadlineAt: 4_000 }),
    );
    expect(clipped.originalCeilingAt).toBe(11_000);
    expect(clipped.effectiveOverallDeadlineAt).toBe(4_000);
    expect(clipped.providerDeadlineAt).toBe(3_000);
    expect(clipped.clipped).toMatchObject({ overallByLease: true, providerByReserve: true });

    const later = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ existingLeaseDeadlineAt: 1_000_000 }),
    );
    expect(later.effectiveOverallDeadlineAt).toBe(11_000);
    expect(later.clipped.overallByLease).toBe(false);
  });

  it('reports an expired lease as a past deadline without extending it', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ existingLeaseDeadlineAt: 0, completionStartedAt: 5_000 }),
    );
    expect(resolved.effectiveOverallDeadlineAt).toBe(0);
    expect(resolved.providerDeadlineAt).toBe(-1_000);
    expect(resolved.completionDeadlineAt).toBe(0);
  });

  it('keeps the reserve inside an earlier lease ceiling', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({
        originalStartedAt: 0,
        configuredOverallMs: 90_000,
        originalOverallDeadlineAt: 200_000,
        existingLeaseDeadlineAt: 30_000,
      }),
    );
    expect(resolved.originalCeilingAt).toBe(90_000);
    expect(resolved.effectiveOverallDeadlineAt).toBe(30_000);
    expect(resolved.finalizationReserveMs).toBe(1_000);
    expect(resolved.providerDeadlineAt).toBe(29_000);
  });

  it('reports an already-expired provider deadline when the lease remainder is below the reserve', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ originalStartedAt: 0, existingLeaseDeadlineAt: 400 }),
    );
    expect(resolved.finalizationReserveMs).toBe(1_000);
    expect(resolved.effectiveOverallDeadlineAt).toBe(400);
    expect(resolved.providerDeadlineAt).toBe(-600);
    expect(resolved.providerDeadlineAt).toBeLessThan(0);
  });

  it('never yields a deadline beyond the original ceiling or lease', () => {
    for (const lease of [0, 3_000, 11_000, 12_000, 90_000]) {
      for (const completionStartedAt of [undefined, 1_000, 8_000, 15_000]) {
        const resolved = resolveAutonomousPersonalExecutionBudgetV1(
          configured({
            completion: { mode: 'limited', durationMs: 120_000 },
            finalizationReserve: { mode: 'fixed', durationMs: 20 },
          }),
          context({
            existingLeaseDeadlineAt: lease,
            ...(completionStartedAt === undefined ? {} : { completionStartedAt }),
          }),
        );
        const ceiling = Math.min(11_000, 20_000);
        for (const deadline of [
          resolved.effectiveOverallDeadlineAt,
          resolved.providerDeadlineAt,
          resolved.completionDeadlineAt ?? 0,
        ]) {
          expect(Number.isFinite(deadline)).toBe(true);
          expect(deadline).toBeLessThanOrEqual(Math.min(ceiling, lease));
        }
      }
    }
  });

  it('resolves completion for inherit and for limited below, at and above the outer deadline', () => {
    const resolve = (completion: unknown, completionStartedAt: number) =>
      resolveAutonomousPersonalExecutionBudgetV1(
        configured({ completion }),
        context({ completionStartedAt }),
      );

    expect(resolve({ mode: 'inheritOverall' }, 3_000)).toMatchObject({
      phase: 'started',
      completionDeadlineAt: 11_000,
      clipped: { completionByOverall: false },
    });
    expect(resolve({ mode: 'limited', durationMs: 2_000 }, 3_000)).toMatchObject({
      completionDeadlineAt: 5_000,
      clipped: { completionByOverall: false },
    });
    expect(resolve({ mode: 'limited', durationMs: 8_000 }, 3_000)).toMatchObject({
      completionDeadlineAt: 11_000,
      clipped: { completionByOverall: false },
    });
    expect(resolve({ mode: 'limited', durationMs: 9_000 }, 3_000)).toMatchObject({
      completionDeadlineAt: 11_000,
      clipped: { completionByOverall: true },
    });
  });

  it('does not re-anchor an absent phase and ignores any external clock', () => {
    const spy = jest.spyOn(Date, 'now');
    const perf = jest.spyOn(performance, 'now');
    try {
      const first = resolveAutonomousPersonalExecutionBudgetV1(defaults, context());
      const second = resolveAutonomousPersonalExecutionBudgetV1(defaults, context());
      expect(second).toEqual(first);
      expect(first.phase).toBe('notStarted');
      expect(first.completionDeadlineAt).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(perf).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      perf.mockRestore();
    }
  });

  it('keeps the syntax allowance as the original configured cumulative limit', () => {
    const budget = configured({
      completion: { mode: 'limited', durationMs: 1_000 },
      syntax: { mode: 'limited', durationMs: 4_000 },
    });
    const early = resolveAutonomousPersonalExecutionBudgetV1(budget, context());
    const late = resolveAutonomousPersonalExecutionBudgetV1(
      budget,
      context({ completionStartedAt: 9_000 }),
    );
    expect(early.syntaxAllowanceMs).toBe(4_000);
    expect(late.syntaxAllowanceMs).toBe(4_000);

    const inherit = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ completionStartedAt: 9_000 }),
    );
    expect(inherit.syntaxAllowanceMs).toBeNull();
    expect(JSON.stringify(inherit)).not.toContain('Infinity');
  });

  it('resolves legacy with its documented 5000 ms completion allowance and a null fingerprint', () => {
    const legacy = { semantics: 'legacy' };
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      legacy,
      context({
        originalOverallDeadlineAt: 100_000,
        configuredOverallMs: 60_000,
        completionStartedAt: 2_000,
      }),
    );
    expect(resolved).toMatchObject({
      semantics: 'legacy',
      version: null,
      fingerprint: null,
      completionDeadlineAt: 7_000,
      syntaxAllowanceMs: 5_000,
    });
    const clipped = resolveAutonomousPersonalExecutionBudgetV1(
      legacy,
      context({ existingLeaseDeadlineAt: 4_000, completionStartedAt: 2_000 }),
    );
    expect(clipped.completionDeadlineAt).toBe(4_000);
    expect(clipped.clipped.completionByOverall).toBe(true);
  });

  it('rejects malformed, non-finite or inconsistent context data', () => {
    const invalid: Array<Record<string, unknown>> = [
      { originalStartedAt: -1 },
      { originalStartedAt: NaN },
      { originalStartedAt: Infinity },
      { originalStartedAt: '1000' },
      { configuredOverallMs: 99 },
      { configuredOverallMs: 120_001 },
      { configuredOverallMs: 1_000.5 },
      { originalOverallDeadlineAt: 1_000 },
      { originalOverallDeadlineAt: 500 },
      { originalOverallDeadlineAt: Infinity },
      { existingLeaseDeadlineAt: -1 },
      { existingLeaseDeadlineAt: Infinity },
      { existingLeaseDeadlineAt: NaN },
      { completionStartedAt: 999 },
      { completionStartedAt: Infinity },
      { completionStartedAt: null },
      { unexpected: 1 },
    ];
    for (const overrides of invalid) {
      expect(() =>
        resolveAutonomousPersonalExecutionBudgetV1(defaults, context(overrides)),
      ).toThrow();
    }
    expect(() => resolveAutonomousPersonalExecutionBudgetV1(defaults, null)).toThrow();
    expect(() => resolveAutonomousPersonalExecutionBudgetV1(undefined, context())).toThrow();
    expect(() =>
      resolveAutonomousPersonalExecutionBudgetV1({ semantics: 'configured' }, context()),
    ).toThrow();
  });

  it('accepts a completion anchor equal to the original start', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ completionStartedAt: 1_000 }),
    );
    expect(resolved.phase).toBe('started');
    expect(resolved.completionDeadlineAt).toBe(11_000);
  });

  it('returns frozen output unaffected by later mutation of the inputs', () => {
    const budgetInput = configured({ completion: { mode: 'limited', durationMs: 2_000 } });
    const contextInput = context({ completionStartedAt: 3_000 });
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(budgetInput, contextInput);
    const snapshot = JSON.parse(JSON.stringify(resolved));

    Object.assign(budgetInput.completion, { durationMs: 100 });
    contextInput.originalStartedAt = 9_999;
    expect(resolved).toEqual(snapshot);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.clipped)).toBe(true);
    expect(() => {
      (resolved as { providerDeadlineAt: number }).providerDeadlineAt = 0;
    }).toThrow(TypeError);
  });

  describe('resolution schema consistency', () => {
    const base = (completionStartedAt?: number) =>
      JSON.parse(
        JSON.stringify(
          resolveAutonomousPersonalExecutionBudgetV1(
            defaults,
            context(completionStartedAt === undefined ? {} : { completionStartedAt }),
          ),
        ),
      ) as ReturnType<typeof resolveAutonomousPersonalExecutionBudgetV1>;
    const legacyBase = () =>
      JSON.parse(
        JSON.stringify(
          resolveAutonomousPersonalExecutionBudgetV1(
            { semantics: 'legacy' },
            context({ completionStartedAt: 2_000 }),
          ),
        ),
      ) as ReturnType<typeof resolveAutonomousPersonalExecutionBudgetV1>;

    it('accepts real resolver output for configured and legacy semantics', () => {
      for (const value of [base(), base(3_000), legacyBase()]) {
        expect(AutonomousPersonalExecutionBudgetResolutionV1Schema.safeParse(value).success).toBe(
          true,
        );
      }
    });

    it('rejects internally inconsistent resolutions', () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['configured wrong version', { ...base(), version: null }],
        ['configured null fingerprint', { ...base(), fingerprint: null }],
        ['legacy with version', { ...legacyBase(), version: 1 }],
        ['legacy with fingerprint', { ...legacyBase(), fingerprint: 'a'.repeat(64) }],
        ['legacy wrong allowance', { ...legacyBase(), syntaxAllowanceMs: 4_000 }],
        ['legacy null allowance', { ...legacyBase(), syntaxAllowanceMs: null }],
        ['notStarted with completion', { ...base(), completionDeadlineAt: 5_000 }],
        [
          'notStarted clipped by overall',
          { ...base(), clipped: { ...base().clipped, completionByOverall: true } },
        ],
        ['started without completion', { ...base(3_000), completionDeadlineAt: null }],
        ['completion past effective', { ...base(3_000), completionDeadlineAt: 11_001 }],
        ['effective past ceiling', { ...base(), effectiveOverallDeadlineAt: 11_001 }],
        ['provider past effective', { ...base(), providerDeadlineAt: 11_001 }],
        ['reserve above 5000', { ...base(), finalizationReserveMs: 5_001 }],
        ['reserve below 20', { ...base(), finalizationReserveMs: 19 }],
        ['non-finite deadline', { ...base(), providerDeadlineAt: Infinity }],
        ['extra key', { ...base(), extra: true }],
      ];
      for (const [label, value] of cases) {
        expect([
          label,
          AutonomousPersonalExecutionBudgetResolutionV1Schema.safeParse(value).success,
        ]).toEqual([label, false]);
      }
    });
  });

  it('contains only serializable data with no callbacks, timers or signals', () => {
    const resolved = resolveAutonomousPersonalExecutionBudgetV1(
      defaults,
      context({ completionStartedAt: 3_000 }),
    );
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved);
    for (const value of Object.values(resolved)) expect(typeof value).not.toBe('function');
  });
});
