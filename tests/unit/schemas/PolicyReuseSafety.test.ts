/** Regression coverage for immutable policy reuse and fresh input/authority checks.
 * Policy isolation preserves the single shared execution-scope module instance.
 */
import { performance } from 'node:perf_hooks';
import { hashAutomaticCaptureV2 } from '../../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  bindAutonomousPersonalExecutionScopeV1,
  createAutonomousPersonalExecutionScopeWorkV1,
  diagnoseAutonomousPersonalExecutionScopeV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeSyntaxSpanV1,
  runAutonomousPersonalExecutionScopeV1,
  type AutonomousPersonalExecutionScopeEntryV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';

type PolicyModule = typeof import('../../../src/schemas/AutonomousPersonalPolicyV3.schema');
type Entry = AutonomousPersonalExecutionScopeEntryV1;

const POLICY_PATH = '../../../src/schemas/AutonomousPersonalPolicyV3.schema';

const PROFILES = ['conservative', 'explicit', 'reviewFirst'] as const;
type Profile = (typeof PROFILES)[number];

// Same values as goldens[profile][0] in AutonomousPersonalPolicyV3.test.ts.
const GOLDEN: Record<Profile, string> = {
  conservative: '4cbbe760432c51a478786dd32d644ac628ccfc311314d44e099d26fa79b9976d',
  explicit: 'bbdb43bcba958223134fad530c56b203e84a3736af2e72417ed76b4eb81a0eb7',
  reviewFirst: '92b42ba2140717667c575839828e962a3b8717e912713587314ef6763ffa0d90',
};

/** Fresh policy module registry entry; nothing else (notably not the scope module) is reset. */
function loadPolicy(): PolicyModule {
  let loaded: PolicyModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require(POLICY_PATH) as PolicyModule;
  });
  if (!loaded) throw new Error('isolated policy module did not load');
  return loaded;
}

const warmAll = (policy: PolicyModule) => {
  for (const profileId of PROFILES) policy.compileAutonomousPersonalPolicyV3({ profileId });
};

const deepFrozen = (value: unknown): boolean =>
  value === null ||
  typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(deepFrozen));

const resign = (value: Record<string, unknown>) => {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'fingerprint'));
  return {
    ...body,
    fingerprint: hashAutomaticCaptureV2({ domain: 'engram-autonomous-policy-v1', policy: body }),
  };
};

describe('policy reuse safety (policy module only)', () => {
  describe.each(PROFILES)('%s', (profileId) => {
    test('cold and warm compile match the golden, are deeply frozen and resist poisoning', () => {
      const policy = loadPolicy();
      const compile = policy.compileAutonomousPersonalPolicyV3;
      const cold = compile({ profileId });
      const coldJson = JSON.stringify(cold);
      expect(cold.fingerprint).toBe(GOLDEN[profileId]);
      expect(deepFrozen(cold)).toBe(true);

      const warm = compile({ profileId });
      expect(warm.fingerprint).toBe(GOLDEN[profileId]);
      expect(JSON.stringify(warm)).toBe(coldJson);
      expect(deepFrozen(warm)).toBe(true);

      // Arrow functions in a strict module: frozen writes must throw, not be ignored.
      type MutationView = {
        autoAccept: boolean;
        fingerprint: string;
        limits: { sourceUnits?: number };
        finalizationReserve: { maxMs: number };
        preferenceInterpreter: { lexiconVersion: number };
        extra?: boolean;
      };
      const writes: Array<(p: MutationView) => void> = [
        (p) => (p.autoAccept = !p.autoAccept),
        (p) => (p.fingerprint = '0'.repeat(64)),
        (p) => (p.limits.sourceUnits = 1),
        (p) => (p.finalizationReserve.maxMs = 1),
        (p) => (p.preferenceInterpreter.lexiconVersion = 99),
        (p) => delete p.limits.sourceUnits,
        (p) => (p.extra = true),
      ];
      for (const write of writes) expect(() => write(warm as MutationView)).toThrow(TypeError);

      expect(JSON.stringify(cold)).toBe(coldJson);
      const after = compile({ profileId });
      expect(after.fingerprint).toBe(GOLDEN[profileId]);
      expect(JSON.stringify(after)).toBe(coldJson);
      expect(policy.AutonomousPersonalPolicyV3Schema.parse(after)).toEqual(after);
    });
  });

  test('profiles never share entries when compiled interleaved in one module', () => {
    const { compileAutonomousPersonalPolicyV3: compile } = loadPolicy();
    for (const profileId of [...PROFILES, ...PROFILES].reverse()) {
      expect(compile({ profileId }).fingerprint).toBe(GOLDEN[profileId]);
    }
    expect(new Set(PROFILES.map((profileId) => compile({ profileId }).fingerprint)).size).toBe(3);
  });

  // Repeat compiles reuse a private immutable template after fresh input validation.
  test('reference identity for repeat compiles', () => {
    const { compileAutonomousPersonalPolicyV3: compile } = loadPolicy();
    for (const profileId of PROFILES) {
      const first = compile({ profileId });
      const second = compile({ profileId });
      expect(second).toBe(first);
    }
    expect(compile({ profileId: 'conservative' })).not.toBe(compile({ profileId: 'explicit' }));
  });

  describe('cross-profile relabel', () => {
    const pairs = PROFILES.flatMap((from) =>
      PROFILES.filter((to) => to !== from).map((to) => [from, to] as const),
    );
    test.each(pairs)(
      '%s body labelled %s is rejected unsigned and re-signed, cold and warm',
      (from, to) => {
        // Original comes from its own module; the parse target below is always a different one.
        const original = loadPolicy().compileAutonomousPersonalPolicyV3({ profileId: from });
        const relabelled = { ...original, profileId: to };
        const variants = { unsigned: relabelled, resigned: resign(relabelled) };
        for (const state of ['cold', 'warm'] as const) {
          for (const [name, candidate] of Object.entries(variants)) {
            const target = loadPolicy();
            if (state === 'warm') warmAll(target);
            // Cold: safeParse runs before any compile in this module instance.
            expect({ state, name, ok: target.AutonomousPersonalPolicyV3Schema.safeParse(candidate).success }).toEqual({
              state,
              name,
              ok: false,
            });
            const healthy = target.compileAutonomousPersonalPolicyV3({ profileId: to });
            expect(healthy.fingerprint).toBe(GOLDEN[to]);
            expect(target.AutonomousPersonalPolicyV3Schema.safeParse(healthy).success).toBe(true);
          }
        }
      },
    );
  });

  test('warm cache: invalid selectors trigger no traps and the next compile is still golden', () => {
    const policy = loadPolicy();
    warmAll(policy);
    let traps = 0;
    const trapped = [
      Object.defineProperty({}, 'profileId', { enumerable: true, get: () => ++traps }),
      { profileId: 'conservative', toJSON: () => ++traps },
      new Proxy(
        {},
        {
          get: () => ++traps,
          ownKeys: () => {
            traps++;
            return [];
          },
        },
      ),
    ];
    for (const value of trapped) {
      expect(() => policy.compileAutonomousPersonalPolicyV3(value)).toThrow();
      expect(policy.AutonomousPersonalPolicyV3Schema.safeParse(value).success).toBe(false);
    }
    expect(traps).toBe(0);
    for (const value of [{ profileId: 'conservative', actor: 'synthetic-authority' }, {}]) {
      expect(() => policy.compileAutonomousPersonalPolicyV3(value)).toThrow(
        'Invalid autonomous personal policy data',
      );
    }
    for (const profileId of PROFILES) {
      expect(policy.compileAutonomousPersonalPolicyV3({ profileId }).fingerprint).toBe(
        GOLDEN[profileId],
      );
    }
  });
});

describe('policy compile inside a registered syntax span (public scope APIs)', () => {
  const realNow = performance.now;
  const BASE = 1000;
  let now = BASE;

  beforeEach(() => {
    now = BASE;
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    // Guard against a leaked spy bleeding into other files in the same worker.
    expect(performance.now).toBe(realNow);
  });

  const budgetWith = (syntax: object = { mode: 'limited', durationMs: 100 }) => ({
    semantics: 'configured',
    version: 1,
    completion: { mode: 'inheritOverall' },
    syntax,
    finalizationReserve: { mode: 'automatic' },
  });

  function setup(options: { syntax?: object; overallMs?: number } = {}) {
    const context = {};
    const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
    bindAutonomousPersonalExecutionScopeV1(
      entry,
      context,
      budgetWith(options.syntax),
      options.overallMs ?? 10_000,
    );
    return { context, entry };
  }
  type Setup = Parameters<typeof setup>[0];

  const scoped = <T>(entry: Entry, context: object, body: () => T) =>
    runAutonomousPersonalExecutionScopeV1(entry, context, async () => body());

  const DIAG_KEYS = [
    'activeDepth',
    'bound',
    'chargedSyntaxMs',
    'closed',
    'effectiveDeadlineMs',
    'fingerprint',
    'firstStop',
    'originalDeadlineMs',
    'purpose',
    'syntaxAllowanceMs',
    'version',
  ];

  async function runCase(
    mode: 'cold' | 'warm',
    config: {
      scope?: Setup;
      workDeadline: number;
      stage?: AbortController;
      beforeSpan?: () => void;
      inSpan?: () => void;
    },
  ) {
    const policy = loadPolicy();
    if (mode === 'warm') warmAll(policy);
    const { entry, context } = setup(config.scope);
    const callback = jest.fn(() => {
      const value = policy.compileAutonomousPersonalPolicyV3({ profileId: 'conservative' });
      config.inSpan?.();
      return value;
    });
    let spanError: unknown;
    let spanValue: unknown;
    // The run wrapper re-throws the latched stop afterwards; capture it without hiding spanError.
    const wrapperError: unknown = await scoped(entry, context, () => {
      const work = createAutonomousPersonalExecutionScopeWorkV1(
        entry,
        context,
        config.workDeadline,
        config.stage?.signal,
      );
      config.beforeSpan?.();
      try {
        spanValue = runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, callback);
      } catch (error) {
        spanError = error;
      }
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const snapshot = diagnoseAutonomousPersonalExecutionScopeV1(entry, context);
    return { policy, callback, spanError, spanValue, wrapperError, snapshot };
  }

  function expectStop(error: unknown, budgetReason: 'deadline' | 'cancelled', stopReason: string) {
    expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect(error).toMatchObject({ budgetReason, stopReason });
  }

  /** Canonical healthy compile in a fresh scope and outside any scope. Not a storage-authority proof. */
  async function expectHealthyAfter(policy: PolicyModule) {
    now = BASE;
    const fresh = setup();
    let calls = 0;
    const value = await scoped(fresh.entry, fresh.context, () => {
      const work = createAutonomousPersonalExecutionScopeWorkV1(
        fresh.entry,
        fresh.context,
        BASE + 9000,
      );
      return runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, fresh.context, () => {
        calls++;
        return policy.compileAutonomousPersonalPolicyV3({ profileId: 'conservative' });
      });
    });
    expect(calls).toBe(1);
    expect(value.fingerprint).toBe(GOLDEN.conservative);
    expect(deepFrozen(value)).toBe(true);
    expect(diagnoseAutonomousPersonalExecutionScopeV1(fresh.entry, fresh.context)).toMatchObject({
      firstStop: null,
      chargedSyntaxMs: 0,
      closed: true,
    });
    expect(policy.compileAutonomousPersonalPolicyV3({ profileId: 'conservative' }).fingerprint).toBe(
      GOLDEN.conservative,
    );
  }

  describe.each(['cold', 'warm'] as const)('%s policy module', (mode) => {
    test('pre-cancelled stage rejects before the callback runs', async () => {
      const stage = new AbortController();
      const result = await runCase(mode, {
        workDeadline: BASE + 9000,
        stage,
        beforeSpan: () => stage.abort(),
      });
      expectStop(result.spanError, 'cancelled', 'stage_cancelled');
      expect(result.callback).toHaveBeenCalledTimes(0);
      expect(result.spanValue).toBeUndefined();
      expect(result.wrapperError).toBe(result.spanError);
      expect(Object.keys(result.snapshot).sort()).toEqual(DIAG_KEYS);
      expect(result.snapshot).toMatchObject({ firstStop: 'stage_cancelled', chargedSyntaxMs: 0 });
      await expectHealthyAfter(result.policy);
    });

    test('cancel during the callback rejects at exit and the compile value never escapes', async () => {
      const stage = new AbortController();
      const result = await runCase(mode, {
        workDeadline: BASE + 9000,
        stage,
        inSpan: () => {
          now += 25;
          stage.abort();
        },
      });
      expectStop(result.spanError, 'cancelled', 'stage_cancelled');
      expect(result.callback).toHaveBeenCalledTimes(1);
      expect(result.spanValue).toBeUndefined();
      expect(result.wrapperError).toBe(result.spanError);
      expect(Object.keys(result.snapshot).sort()).toEqual(DIAG_KEYS);
      expect(result.snapshot).toMatchObject({ firstStop: 'stage_cancelled', chargedSyntaxMs: 25 });
      await expectHealthyAfter(result.policy);
    });

    test('overall deadline with inherited syntax reports invocation_deadline, not a syntax stop', async () => {
      const result = await runCase(mode, {
        scope: { syntax: { mode: 'inheritOverall' }, overallMs: 1000 },
        workDeadline: BASE + 1000,
        inSpan: () => {
          now = BASE + 1000;
        },
      });
      expectStop(result.spanError, 'deadline', 'invocation_deadline');
      expect(result.callback).toHaveBeenCalledTimes(1);
      expect(result.spanValue).toBeUndefined();
      expect(result.wrapperError).toBe(result.spanError);
      expect(result.snapshot).toMatchObject({
        syntaxAllowanceMs: null,
        firstStop: 'invocation_deadline',
        chargedSyntaxMs: 1000,
      });
      await expectHealthyAfter(result.policy);
    });

    test('syntax allowance: 99 ms passes, exactly 100 ms is exhausted', async () => {
      const below = await runCase(mode, {
        workDeadline: BASE + 9000,
        inSpan: () => {
          now += 99;
        },
      });
      expect(below.spanError).toBeUndefined();
      expect(below.wrapperError).toBeUndefined();
      expect((below.spanValue as { fingerprint: string }).fingerprint).toBe(GOLDEN.conservative);
      expect(below.callback).toHaveBeenCalledTimes(1);
      expect(below.snapshot).toMatchObject({ firstStop: null, chargedSyntaxMs: 99 });

      now = BASE;
      const exact = await runCase(mode, {
        workDeadline: BASE + 9000,
        inSpan: () => {
          now += 100;
        },
      });
      expectStop(exact.spanError, 'deadline', 'syntax_allowance');
      expect(exact.callback).toHaveBeenCalledTimes(1);
      expect(exact.spanValue).toBeUndefined();
      expect(exact.wrapperError).toBe(exact.spanError);
      expect(exact.snapshot).toMatchObject({
        syntaxAllowanceMs: 100,
        firstStop: 'syntax_allowance',
        chargedSyntaxMs: 100,
      });
      await expectHealthyAfter(exact.policy);
    });
  });
});
