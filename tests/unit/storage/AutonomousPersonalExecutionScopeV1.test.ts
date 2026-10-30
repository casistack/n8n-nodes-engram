import { performance } from 'node:perf_hooks';
import { ExtractionBudgetError } from '../../../src/extraction/ExtractionDiagnostics';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  AutonomousPersonalExecutionScopeError,
  bindAutonomousPersonalExecutionScopeV1,
  checkAutonomousPersonalExecutionScopeWorkV1,
  clipAutonomousPersonalExecutionScopeLeaseV1,
  closeAutonomousPersonalExecutionScopeV1,
  createAutonomousPersonalExecutionScopeWorkV1,
  currentAutonomousPersonalExecutionScopeV1,
  diagnoseAutonomousPersonalExecutionScopeV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeSyntaxSpanV1,
  runAutonomousPersonalExecutionScopeV1,
  type AutonomousPersonalExecutionScopeEntryV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';
import { AutonomousPersonalExecutionScopeDiagnosticsV1Schema } from '../../../src/schemas/AutonomousPersonalExecutionScopeV1.schema';

type Entry = AutonomousPersonalExecutionScopeEntryV1;

const realSetImmediate = setImmediate;
const BASE = 1000;
let now = BASE;

const budgetWith = (
  syntax: object = { mode: 'limited', durationMs: 100 },
  finalizationReserve: object = { mode: 'automatic' },
) => ({
  semantics: 'configured',
  version: 1,
  completion: { mode: 'inheritOverall' },
  syntax,
  finalizationReserve,
});

function setup(
  options: {
    purpose?: string;
    budget?: unknown;
    overallMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const context = {};
  const entry = openAutonomousPersonalExecutionScopeV1(context, options.purpose ?? 'memoryRead');
  bindAutonomousPersonalExecutionScopeV1(
    entry,
    context,
    options.budget ?? budgetWith(),
    options.overallMs ?? 10_000,
    options.signal,
  );
  return { context, entry };
}

const scoped = <T>(entry: Entry, context: object, body: () => T | Promise<T>) =>
  runAutonomousPersonalExecutionScopeV1(entry, context, async () => body());

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Latched budget/scope stops surface from run's final check; any other rejection is a test bug. */
function swallowStop(error: unknown): undefined {
  if (
    error instanceof ExtractionBudgetError ||
    error instanceof AutonomousPersonalExecutionScopeError
  ) {
    return undefined;
  }
  throw error;
}

const diag = (entry: Entry, context: object) =>
  diagnoseAutonomousPersonalExecutionScopeV1(entry, context);

describe('autonomous personal execution scope V1', () => {
  beforeEach(() => {
    now = BASE;
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('open and bind', () => {
    it('captures T0 first, internally, and charges pre-bind delay without resetting the deadline', () => {
      const context = {};
      const spy = performance.now as jest.Mock;
      const entry = openAutonomousPersonalExecutionScopeV1(context, 'adminCapture');
      expect(spy).toHaveBeenCalledTimes(1);
      now = BASE + 40;
      bindAutonomousPersonalExecutionScopeV1(entry, context, budgetWith(), 1000);
      const snapshot = diag(entry, context);
      expect(snapshot.originalDeadlineMs).toBe(BASE + 1000);
      expect(snapshot.effectiveDeadlineMs).toBe(BASE + 1000);
      expect(snapshot.chargedSyntaxMs).toBe(40);
      expect(snapshot.syntaxAllowanceMs).toBe(100);
      expect(snapshot.bound).toBe(true);
    });

    it('reads the clock before rejecting an invalid context or purpose', () => {
      const spy = performance.now as jest.Mock;
      expect(
        thrown(() => openAutonomousPersonalExecutionScopeV1(null, 'memoryRead')),
      ).toMatchObject({ reason: 'invalid_scope' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(thrown(() => openAutonomousPersonalExecutionScopeV1({}, 'workflow'))).toMatchObject({
        reason: 'invalid_scope',
      });
      expect(thrown(() => openAutonomousPersonalExecutionScopeV1({}, {} as never))).toMatchObject({
        reason: 'invalid_scope',
      });
    });

    it('rejects a proxy context without invoking any trap', () => {
      let traps = 0;
      const bump = () => {
        traps++;
        return undefined;
      };
      const proxy = new Proxy(
        {},
        {
          get: bump,
          has: () => !bump(),
          ownKeys: () => (bump(), []),
          getPrototypeOf: () => (bump(), null),
          getOwnPropertyDescriptor: bump,
        },
      );
      expect(
        thrown(() => openAutonomousPersonalExecutionScopeV1(proxy, 'memoryRead')),
      ).toMatchObject({ reason: 'invalid_scope' });
      const { entry, context } = setup();
      expect(thrown(() => diag(entry, proxy))).toMatchObject({ reason: 'invalid_scope' });
      expect(traps).toBe(0);
      expect(context).toBeDefined();
    });

    it('malformed bind installs nothing and a later valid bind keeps the original T0', () => {
      const context = {};
      const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryPrepare');
      now = BASE + 50;
      const bad: unknown[][] = [
        [budgetWith(), 99],
        [budgetWith(), 120_001],
        [budgetWith(), 1000.5],
        [budgetWith(), '1000'],
        [undefined, 1000],
        [null, 1000],
        [{ semantics: 'legacy' }, 1000],
        [{ ...budgetWith(), extra: true }, 1000],
        [budgetWith(undefined, { mode: 'fixed', durationMs: 1000 }), 1000],
        [budgetWith(), 1000, {}],
        [budgetWith(), 1000, new Proxy(new AbortController().signal, {})],
      ];
      for (const [budget, overall, signal] of bad) {
        expect(
          thrown(() =>
            bindAutonomousPersonalExecutionScopeV1(entry, context, budget, overall, signal),
          ),
        ).toMatchObject({ reason: 'invalid_configuration' });
      }
      expect(diag(entry, context)).toMatchObject({
        bound: false,
        originalDeadlineMs: null,
        effectiveDeadlineMs: null,
        syntaxAllowanceMs: null,
        fingerprint: null,
        chargedSyntaxMs: 0,
      });
      now = BASE + 70;
      bindAutonomousPersonalExecutionScopeV1(entry, context, budgetWith(), 1000);
      expect(diag(entry, context)).toMatchObject({
        originalDeadlineMs: BASE + 1000,
        chargedSyntaxMs: 70,
      });
    });

    it('repeat identical bind is idempotent; changed configuration conflicts without overwriting', () => {
      const parent = new AbortController();
      const { entry, context } = setup({ overallMs: 1000, signal: parent.signal });
      const before = diag(entry, context);
      now = BASE + 30;
      bindAutonomousPersonalExecutionScopeV1(entry, context, budgetWith(), 1000, parent.signal);
      expect(diag(entry, context)).toEqual(before);
      const conflicts: unknown[][] = [
        [budgetWith(), 2000, parent.signal],
        [budgetWith({ mode: 'limited', durationMs: 200 }), 1000, parent.signal],
        [budgetWith(), 1000, new AbortController().signal],
        [budgetWith(), 1000, undefined],
      ];
      for (const [budget, overall, signal] of conflicts) {
        expect(
          thrown(() =>
            bindAutonomousPersonalExecutionScopeV1(entry, context, budget, overall, signal),
          ),
        ).toMatchObject({ reason: 'configuration_conflict' });
      }
      expect(diag(entry, context)).toEqual(before);
    });

    it('rejects a fixed reserve at or above the overall allowance', () => {
      const context = {};
      const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
      expect(
        thrown(() =>
          bindAutonomousPersonalExecutionScopeV1(
            entry,
            context,
            budgetWith(undefined, { mode: 'fixed', durationMs: 1000 }),
            1000,
          ),
        ),
      ).toMatchObject({ reason: 'invalid_configuration' });
      expect(diag(entry, context).bound).toBe(false);
    });

    it('an already-aborted parent is a cancellation, not a deadline', () => {
      const parent = new AbortController();
      parent.abort();
      const context = {};
      const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
      const error = thrown(() =>
        bindAutonomousPersonalExecutionScopeV1(entry, context, budgetWith(), 1000, parent.signal),
      );
      expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
      expect((error as ExtractionBudgetError).budgetReason).toBe('cancelled');
      expect(diag(entry, context)).toMatchObject({ bound: true, firstStop: 'parent_cancelled' });
    });
  });

  describe('token and context identity', () => {
    it('supports all four purposes and exact context/purpose ownership', async () => {
      for (const purpose of ['adminCapture', 'memoryPrepare', 'memoryRead', 'memorySave']) {
        const { entry, context } = setup({ purpose });
        expect(diag(entry, context).purpose).toBe(purpose);
        await scoped(entry, context, () => {
          expect(currentAutonomousPersonalExecutionScopeV1(context, purpose)).toBe(entry);
          for (const other of ['adminCapture', 'memoryPrepare', 'memoryRead', 'memorySave']) {
            if (other !== purpose) {
              expect(currentAutonomousPersonalExecutionScopeV1(context, other)).toBeUndefined();
            }
          }
          expect(currentAutonomousPersonalExecutionScopeV1({}, purpose)).toBeUndefined();
        });
        expect(currentAutonomousPersonalExecutionScopeV1(context, purpose)).toBeUndefined();
      }
    });

    it('rejects cloned, proxied, forged and foreign tokens without corrupting the owner', () => {
      const { entry, context } = setup();
      const before = diag(entry, context);
      const other = setup();
      const forged = [{}, { ...entry }, Object.freeze({}), new Proxy(entry, {}), null, 'x'];
      for (const token of forged) {
        expect(thrown(() => diag(token as never, context))).toMatchObject({
          reason: 'invalid_scope',
        });
        expect(
          thrown(() => closeAutonomousPersonalExecutionScopeV1(token as never, context)),
        ).toMatchObject({ reason: 'invalid_scope' });
      }
      expect(thrown(() => diag(entry, other.context))).toMatchObject({ reason: 'foreign_scope' });
      expect(thrown(() => diag(other.entry, context))).toMatchObject({ reason: 'foreign_scope' });
      expect(diag(entry, context)).toEqual(before);
    });

    it('is frozen, empty and carries no serializable capability', () => {
      const { entry, context } = setup();
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Reflect.ownKeys(entry)).toEqual([]);
      const copy = JSON.parse(JSON.stringify(entry));
      expect(thrown(() => diag(copy, context))).toMatchObject({ reason: 'invalid_scope' });
    });
  });

  describe('run lifetime', () => {
    it('closes on return and on the original callback throw, keeping error identity', async () => {
      const first = setup();
      await expect(scoped(first.entry, first.context, () => 'ok')).resolves.toBe('ok');
      expect(diag(first.entry, first.context).closed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);

      const second = setup();
      const failure = new Error('callback failure');
      await expect(
        scoped(second.entry, second.context, () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(diag(second.entry, second.context).closed).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
      expect(
        await scoped(second.entry, second.context, () => 1).catch((error: unknown) => error),
      ).toMatchObject({ reason: 'scope_closed' });
    });

    it('is one-shot and a simultaneous run does not corrupt the running owner', async () => {
      const { entry, context } = setup();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const running = runAutonomousPersonalExecutionScopeV1(entry, context, async () => {
        await gate;
        return 'done';
      });
      await expect(scoped(entry, context, () => 'second')).rejects.toMatchObject({
        reason: 'scope_already_running',
      });
      expect(diag(entry, context).closed).toBe(false);
      open();
      await expect(running).resolves.toBe('done');
      await expect(scoped(entry, context, () => 'third')).rejects.toMatchObject({
        reason: 'scope_closed',
      });
    });

    it('requires a bound entry and does not nest a fresh entry in a live scope', async () => {
      const context = {};
      const unbound = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
      await expect(scoped(unbound, context, () => 1)).rejects.toMatchObject({
        reason: 'scope_not_bound',
      });
      expect(diag(unbound, context).closed).toBe(false);

      const outer = setup();
      await scoped(outer.entry, outer.context, async () => {
        const inner = setup({ purpose: 'memorySave' });
        await expect(scoped(inner.entry, inner.context, () => 1)).rejects.toMatchObject({
          reason: 'nested_scope',
        });
        expect(diag(inner.entry, inner.context).closed).toBe(false);
        expect(diag(outer.entry, outer.context).closed).toBe(false);
      });
    });

    it('lets a fresh scope replace a closed ambient scope', async () => {
      const outer = setup();
      await scoped(outer.entry, outer.context, async () => {
        closeAutonomousPersonalExecutionScopeV1(outer.entry, outer.context);
        const inner = setup({ purpose: 'memorySave' });
        await expect(scoped(inner.entry, inner.context, () => 'fresh')).resolves.toBe('fresh');
      });
    });

    it('performs the final budget check before returning a successful result', async () => {
      const { entry, context } = setup({ overallMs: 1000 });
      const error = await scoped(entry, context, () => {
        now = BASE + 1000;
        return 'late';
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
      expect(diag(entry, context)).toMatchObject({
        closed: true,
        firstStop: 'invocation_deadline',
      });
    });

    it('invokes the callback zero times for an expired, cancelled or latched entry', async () => {
      const callback = jest.fn(async () => 'ran');

      const expired = setup({ overallMs: 1000 });
      now = BASE + 1000;
      const expiredError = await runAutonomousPersonalExecutionScopeV1(
        expired.entry,
        expired.context,
        callback,
      ).catch((caught: unknown) => caught);
      expect(expiredError).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
      expect(diag(expired.entry, expired.context)).toMatchObject({
        closed: true,
        firstStop: 'invocation_deadline',
      });

      now = BASE;
      const parent = new AbortController();
      const cancelled = setup({ signal: parent.signal });
      parent.abort();
      await expect(
        runAutonomousPersonalExecutionScopeV1(cancelled.entry, cancelled.context, callback),
      ).rejects.toMatchObject({ budgetReason: 'cancelled', stopReason: 'parent_cancelled' });
      expect(diag(cancelled.entry, cancelled.context).closed).toBe(true);

      const clock = setup();
      now = BASE - 1;
      await expect(
        runAutonomousPersonalExecutionScopeV1(clock.entry, clock.context, callback),
      ).rejects.toMatchObject({ reason: 'clock_regression' });
      expect(callback).not.toHaveBeenCalled();
    });

    it('does not publish usable work for an expired stage, overall, cancellation or clock failure', async () => {
      const { entry, context } = setup({ overallMs: 1000 });
      const checked = jest.fn();
      await scoped(entry, context, () => {
        // Stage deadline already reached at creation: nothing is registered.
        const staleError = thrown(() =>
          createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE),
        ) as AutonomousPersonalExecutionScopeBudgetError;
        expect(staleError.stopReason).toBe('stage_deadline');
        expect(diag(entry, context).firstStop).toBe('stage_deadline');
        // The latched first stop is retained and still blocks any new registration.
        expect(
          thrown(() => createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 500)),
        ).toBe(staleError);
        checked();
        throw staleError;
      }).catch(swallowStop);
      expect(checked).toHaveBeenCalledTimes(1);

      const overall = setup({ overallMs: 1000 });
      await scoped(overall.entry, overall.context, () => {
        now = BASE + 1000;
        const error = thrown(() =>
          createAutonomousPersonalExecutionScopeWorkV1(overall.entry, overall.context, BASE + 1000),
        ) as AutonomousPersonalExecutionScopeBudgetError;
        expect(error.stopReason).toBe('invocation_deadline');
      }).catch(swallowStop);

      const clock = setup();
      await scoped(clock.entry, clock.context, () => {
        now = BASE - 3;
        const error = thrown(() =>
          createAutonomousPersonalExecutionScopeWorkV1(clock.entry, clock.context, BASE + 500),
        ) as AutonomousPersonalExecutionScopeError;
        expect(error.reason).toBe('clock_regression');
      }).catch(swallowStop);
    });

    it('a rejection keeps its own error while the internal stop is latched', async () => {
      const { entry, context } = setup({ overallMs: 1000 });
      const failure = new Error('provider parse');
      await expect(
        scoped(entry, context, () => {
          now = BASE + 2000;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(diag(entry, context).firstStop).toBe('invocation_deadline');
    });
  });

  describe('lease clipping, timers and cancellation', () => {
    it('clips the effective overall only earlier and never re-anchors', () => {
      const { entry, context } = setup({ overallMs: 1000 });
      clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, BASE + 500);
      expect(diag(entry, context)).toMatchObject({
        originalDeadlineMs: BASE + 1000,
        effectiveDeadlineMs: BASE + 500,
      });
      clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, BASE + 900);
      clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, BASE + 5000);
      expect(diag(entry, context).effectiveDeadlineMs).toBe(BASE + 500);
      for (const bad of [-1, NaN, Infinity, '5', undefined]) {
        expect(
          thrown(() => clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, bad)),
        ).toMatchObject({ reason: 'invalid_configuration' });
      }
      expect(diag(entry, context).effectiveDeadlineMs).toBe(BASE + 500);
    });

    it('reports an already-expired lease as a deadline stop', () => {
      const { entry, context } = setup({ overallMs: 1000 });
      now = BASE + 600;
      const error = thrown(() =>
        clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, BASE + 500),
      );
      expect(error).toBeInstanceOf(ExtractionBudgetError);
      expect((error as ExtractionBudgetError).budgetReason).toBe('deadline');
      expect(diag(entry, context).firstStop).toBe('invocation_deadline');
    });

    it('arms one own timer to the remaining original time and reschedules only earlier', () => {
      const { entry, context } = setup({ overallMs: 1000 });
      expect(jest.getTimerCount()).toBe(1);
      now = BASE + 400;
      jest.advanceTimersByTime(400);
      expect(diag(entry, context).firstStop).toBeNull();
      clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, BASE + 700);
      expect(jest.getTimerCount()).toBe(1);
      jest.advanceTimersByTime(299);
      expect(diag(entry, context).firstStop).toBeNull();
      jest.advanceTimersByTime(1);
      expect(diag(entry, context).firstStop).toBe('invocation_deadline');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('distinguishes parent cancellation from time exhaustion and leaves the parent usable', async () => {
      const parent = new AbortController();
      const { entry, context } = setup({ signal: parent.signal });
      const work = await scoped(entry, context, () => {
        const created = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 5000);
        expect(created.signal).not.toBe(parent.signal);
        parent.abort();
        const error = thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(created, context));
        expect(error).toBeInstanceOf(ExtractionBudgetError);
        expect((error as ExtractionBudgetError).budgetReason).toBe('cancelled');
        expect((error as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
          'parent_cancelled',
        );
        expect(created.signal.aborted).toBe(true);
        return created;
      }).catch(swallowStop);
      expect(work).toBeUndefined();
      expect(diag(entry, context)).toMatchObject({ closed: true, firstStop: 'parent_cancelled' });
    });

    it('close clears own timer/listener, never aborts the parent, and keeps diagnostics', () => {
      const parent = new AbortController();
      const { entry, context } = setup({ signal: parent.signal });
      expect(jest.getTimerCount()).toBe(1);
      closeAutonomousPersonalExecutionScopeV1(entry, context);
      closeAutonomousPersonalExecutionScopeV1(entry, context);
      expect(jest.getTimerCount()).toBe(0);
      expect(parent.signal.aborted).toBe(false);
      // The listener was removed, so a later parent abort cannot latch a stop.
      parent.abort();
      expect(diag(entry, context)).toMatchObject({ closed: true, firstStop: null });
    });

    it('uses captured EventTarget intrinsics, never hostile own signal methods', () => {
      const parent = new AbortController();
      let hostile = 0;
      for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
        Object.defineProperty(parent.signal, name, {
          configurable: true,
          get() {
            hostile++;
            return () => undefined;
          },
        });
      }
      const { entry, context } = setup({ signal: parent.signal });
      closeAutonomousPersonalExecutionScopeV1(entry, context);
      expect(hostile).toBe(0);
      // Node's AbortController.abort itself reads dispatchEvent; restore the
      // test override before exercising external host cancellation.
      delete (parent.signal as unknown as Record<string, unknown>).dispatchEvent;
      parent.abort();
      expect(diag(entry, context).firstStop).toBeNull();

      const live = new AbortController();
      Object.defineProperty(live.signal, 'addEventListener', {
        get() {
          hostile++;
          return () => undefined;
        },
      });
      const second = setup({ signal: live.signal });
      live.abort();
      expect(diag(second.entry, second.context).firstStop).toBe('parent_cancelled');
      expect(hostile).toBe(0);
    });
  });

  describe('typed work registration', () => {
    it('registers the exact frozen two-field object and keeps clones/proxies legacy', async () => {
      const { entry, context } = setup();
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 5000);
        expect(Object.isFrozen(work)).toBe(true);
        expect(Reflect.ownKeys(work).sort()).toEqual(['absoluteMonotonicDeadlineMs', 'signal']);
        expect(work.absoluteMonotonicDeadlineMs).toBe(BASE + 5000);
        expect(checkAutonomousPersonalExecutionScopeWorkV1(work, context)).toBe('configured');
        expect(checkAutonomousPersonalExecutionScopeWorkV1({ ...work }, context)).toBe('legacy');
        expect(checkAutonomousPersonalExecutionScopeWorkV1(new Proxy(work, {}), context)).toBe(
          'legacy',
        );
        const plain = {
          absoluteMonotonicDeadlineMs: BASE + 1,
          signal: new AbortController().signal,
        };
        expect(checkAutonomousPersonalExecutionScopeWorkV1(plain, context)).toBe('legacy');
        const callback = jest.fn(() => 'legacy result');
        expect(runAutonomousPersonalExecutionScopeSyntaxSpanV1(plain, context, callback)).toBe(
          'legacy result',
        );
        expect(callback).toHaveBeenCalledTimes(1);
        expect(diag(entry, context).chargedSyntaxMs).toBe(0);
      });
    });

    it('does not publish work when its deadline expires during construction', async () => {
      const { entry, context } = setup();
      let candidate: unknown;
      await scoped(entry, context, () => {
        const freeze = Object.freeze;
        const spy = jest.spyOn(Object, 'freeze').mockImplementation(((value: unknown) => {
          if (
            value &&
            typeof value === 'object' &&
            Object.prototype.hasOwnProperty.call(value, 'absoluteMonotonicDeadlineMs') &&
            Object.prototype.hasOwnProperty.call(value, 'signal')
          ) {
            candidate = value;
            now = BASE + 200;
          }
          return freeze(value);
        }) as typeof Object.freeze);
        try {
          expect(
            thrown(() => createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 100)),
          ).toMatchObject({ stopReason: 'stage_deadline' });
        } finally {
          spy.mockRestore();
        }
        expect(candidate).toBeDefined();
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(checkAutonomousPersonalExecutionScopeWorkV1(candidate, context)).toBe('legacy');
      }).catch(swallowStop);
    });

    it('rejects bad deadlines and stage signals and never publishes work for an aborted signal', async () => {
      const { entry, context } = setup({ overallMs: 1000 });
      await expect(
        scoped(entry, context, () => {
          for (const bad of [BASE + 1001, NaN, Infinity, '5', undefined]) {
            expect(
              thrown(() => createAutonomousPersonalExecutionScopeWorkV1(entry, context, bad)),
            ).toMatchObject({ reason: 'invalid_configuration' });
          }
          for (const signal of [{}, null, new Proxy(new AbortController().signal, {})]) {
            expect(
              thrown(() =>
                createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 500, signal),
              ),
            ).toMatchObject({ reason: 'invalid_configuration' });
          }
          const stage = new AbortController();
          stage.abort();
          const error = thrown(() =>
            createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 500, stage.signal),
          );
          expect(error).toBeInstanceOf(ExtractionBudgetError);
          expect((error as ExtractionBudgetError).budgetReason).toBe('cancelled');
          expect(diag(entry, context).firstStop).toBe('stage_cancelled');
          expect(
            thrown(() => createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 500)),
          ).toBe(error);
          throw error;
        }),
      ).rejects.toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    });

    it('stage cancellation is a cancellation and stage deadline applies before the overall', async () => {
      const { entry, context } = setup();
      const stage = new AbortController();
      await scoped(entry, context, () => {
        const cancellable = createAutonomousPersonalExecutionScopeWorkV1(
          entry,
          context,
          BASE + 5000,
          stage.signal,
        );
        stage.abort();
        const cancelled = thrown(() =>
          checkAutonomousPersonalExecutionScopeWorkV1(cancellable, context),
        ) as AutonomousPersonalExecutionScopeBudgetError;
        expect(cancelled.budgetReason).toBe('cancelled');
        expect(cancelled.stopReason).toBe('stage_cancelled');
      }).catch(swallowStop);

      const timed = setup();
      await scoped(timed.entry, timed.context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(
          timed.entry,
          timed.context,
          BASE + 50,
        );
        now = BASE + 49;
        expect(checkAutonomousPersonalExecutionScopeWorkV1(work, timed.context)).toBe('configured');
        now = BASE + 50;
        const error = thrown(() =>
          checkAutonomousPersonalExecutionScopeWorkV1(work, timed.context),
        ) as AutonomousPersonalExecutionScopeBudgetError;
        expect(error.budgetReason).toBe('deadline');
        expect(error.stopReason).toBe('stage_deadline');
      }).catch(swallowStop);
      expect(diag(timed.entry, timed.context).firstStop).toBe('stage_deadline');
    });

    it('registered work is not proof after close, for a foreign context or outside the scope', async () => {
      const { entry, context } = setup();
      let work!: ReturnType<typeof createAutonomousPersonalExecutionScopeWorkV1>;
      await scoped(entry, context, () => {
        work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 5000);
        expect(thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, {}))).toMatchObject({
          reason: 'foreign_scope',
        });
      });
      expect(
        thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context)),
      ).toMatchObject({ reason: 'scope_closed' });
      expect(
        thrown(() => runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => 1)),
      ).toMatchObject({ reason: 'scope_closed' });

      const live = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let liveWork!: ReturnType<typeof createAutonomousPersonalExecutionScopeWorkV1>;
      const running = runAutonomousPersonalExecutionScopeV1(live.entry, live.context, async () => {
        liveWork = createAutonomousPersonalExecutionScopeWorkV1(
          live.entry,
          live.context,
          BASE + 5000,
        );
        await gate;
      });
      expect(
        thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(liveWork, live.context)),
      ).toMatchObject({ reason: 'foreign_scope' });
      release();
      await running;
    });
  });

  describe('cumulative synchronous spans', () => {
    it('accumulates active work across stages while idle time counts only toward overall', async () => {
      const { entry, context } = setup({ overallMs: 10_000 });
      let failure: unknown;
      await scoped(entry, context, () => {
        const first = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        const second = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        runAutonomousPersonalExecutionScopeSyntaxSpanV1(first, context, () => {
          now += 40;
        });
        now += 500;
        runAutonomousPersonalExecutionScopeSyntaxSpanV1(second, context, () => {
          now += 40;
        });
        expect(diag(entry, context).chargedSyntaxMs).toBe(80);
        failure = thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(first, context, () => {
            now += 40;
          }),
        );
      }).catch(swallowStop);
      expect(failure).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
      expect((failure as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
        'syntax_allowance',
      );
      const snapshot = diag(entry, context);
      expect(snapshot.chargedSyntaxMs).toBe(120);
      expect(snapshot.firstStop).toBe('syntax_allowance');
    });

    it('charges nested spans once and tracks depth', async () => {
      const { entry, context } = setup();
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => {
          now += 10;
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => {
            expect(diag(entry, context).activeDepth).toBe(2);
            now += 10;
          });
          now += 10;
          expect(diag(entry, context).activeDepth).toBe(1);
        });
        expect(diag(entry, context)).toMatchObject({ chargedSyntaxMs: 30, activeDepth: 0 });
      });
    });

    it('treats the syntax allowance boundary as exhausted and truthfully reports late work', async () => {
      const below = setup();
      await scoped(below.entry, below.context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(
          below.entry,
          below.context,
          BASE + 9000,
        );
        runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, below.context, () => {
          now += 99;
        });
      });
      expect(diag(below.entry, below.context).chargedSyntaxMs).toBe(99);

      const exact = setup();
      const error = await scoped(exact.entry, exact.context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(
          exact.entry,
          exact.context,
          BASE + 9000,
        );
        runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, exact.context, () => {
          now += 100;
        });
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);

      const late = setup();
      await scoped(late.entry, late.context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(
          late.entry,
          late.context,
          BASE + 9000,
        );
        thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, late.context, () => {
            now += 700;
          }),
        );
      }).catch(swallowStop);
      expect(diag(late.entry, late.context).chargedSyntaxMs).toBe(700);
    });

    it('checks inside a span against the in-flight elapsed time', async () => {
      const { entry, context } = setup();
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        const error = thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => {
            now += 100;
            checkAutonomousPersonalExecutionScopeWorkV1(work, context);
          }),
        );
        expect((error as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
          'syntax_allowance',
        );
      }).catch(swallowStop);
    });

    it('inherited syntax has no CPU cap but overall and stage bounds still apply', async () => {
      const inherited = setup({
        budget: budgetWith({ mode: 'inheritOverall' }),
        overallMs: 10_000,
      });
      expect(diag(inherited.entry, inherited.context).syntaxAllowanceMs).toBeNull();
      await scoped(inherited.entry, inherited.context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(
          inherited.entry,
          inherited.context,
          BASE + 9000,
        );
        runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, inherited.context, () => {
          now += 5000;
        });
        const error = thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, inherited.context, () => {
            now += 5000;
          }),
        );
        expect((error as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
          'invocation_deadline',
        );
      }).catch(swallowStop);
    });

    it('retains the first failure object on every later check', async () => {
      const { entry, context } = setup({ overallMs: 1000 });
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 900);
        now = BASE + 1500;
        const first = thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context));
        expect(first).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
        expect(thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context))).toBe(
          first,
        );
        now = BASE;
        expect(thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context))).toBe(
          first,
        );
        expect(
          thrown(() => runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => 1)),
        ).toBe(first);
      }).catch(swallowStop);
    });

    it('fails a clock regression separately from budget exhaustion and latches it', async () => {
      const { entry, context } = setup();
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        now = BASE - 5;
        const error = thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context));
        expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeError);
        expect(error).not.toBeInstanceOf(ExtractionBudgetError);
        expect((error as AutonomousPersonalExecutionScopeError).reason).toBe('clock_regression');
        now = BASE + 10;
        expect(thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context))).toBe(
          error,
        );
      }).catch(swallowStop);
      expect(diag(entry, context).firstStop).toBe('clock_regression');
    });

    it('fails a nonfinite clock sample as a clock error', async () => {
      const { entry, context } = setup();
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        now = NaN;
        const error = thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context));
        expect((error as AutonomousPersonalExecutionScopeError).reason).toBe('clock_invalid');
        expect(error).not.toBeInstanceOf(ExtractionBudgetError);
      }).catch(swallowStop);
    });
  });

  describe('callback behavior and diagnostics', () => {
    it('rethrows the callback error unchanged while accounting work and latching an internal stop', async () => {
      const { entry, context } = setup();
      const original = new Error('parse failure');
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        expect(
          thrown(() =>
            runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => {
              now += 60;
              throw original;
            }),
          ),
        ).toBe(original);
        expect(diag(entry, context)).toMatchObject({ chargedSyntaxMs: 60, firstStop: null });

        const exceeding = new Error('late failure');
        expect(
          thrown(() =>
            runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => {
              now += 60;
              throw exceeding;
            }),
          ),
        ).toBe(exceeding);
        expect(diag(entry, context)).toMatchObject({
          chargedSyntaxMs: 120,
          firstStop: 'syntax_allowance',
        });
        expect(
          (
            thrown(() => checkAutonomousPersonalExecutionScopeWorkV1(work, context)) as {
              stopReason: string;
            }
          ).stopReason,
        ).toBe('syntax_allowance');
      }).catch(swallowStop);
    });

    it('rejects Promise results without awaiting and without an unhandled rejection', async () => {
      const unhandled = jest.fn();
      process.once('unhandledRejection', unhandled);
      const { entry, context } = setup();
      await scoped(entry, context, async () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        const error = thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () =>
            Promise.reject(new Error('secret provider body')),
          ),
        );
        expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeError);
        expect((error as AutonomousPersonalExecutionScopeError).reason).toBe('async_span_misuse');
        expect((error as Error).message).not.toContain('secret');
        const asyncError = thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, (async () => 1) as never),
        );
        expect((asyncError as AutonomousPersonalExecutionScopeError).reason).toBe(
          'async_span_misuse',
        );
        expect(diag(entry, context).activeDepth).toBe(0);
        expect(diag(entry, context).firstStop).toBeNull();
      });
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('rejects native async configured spans while preserving unregistered legacy callbacks', async () => {
      const hits = jest.fn();
      const nativeAsync = new Function('hit', 'return async () => { hit(); return 1; }')(
        hits,
      ) as () => Promise<number>;
      const { entry, context } = setup();
      await scoped(entry, context, async () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        expect(
          thrown(() => runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, nativeAsync)),
        ).toMatchObject({ reason: 'async_span_misuse' });
        expect(hits).not.toHaveBeenCalled();
        const legacy = { absoluteMonotonicDeadlineMs: BASE, signal: new AbortController().signal };
        expect(
          await runAutonomousPersonalExecutionScopeSyntaxSpanV1(legacy, context, nativeAsync),
        ).toBe(1);
        expect(hits).toHaveBeenCalledTimes(1);
        expect(diag(entry, context)).toMatchObject({ activeDepth: 0, chargedSyntaxMs: 0 });
      });
    });

    it('attaches the rejection sink only after descriptor-only proof, with zero getter calls', async () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', listener);
      const { entry, context } = setup();
      let reads = 0;
      const spanOver = (work: object, make: () => unknown) =>
        thrown(() =>
          runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, make as () => unknown),
        ) as AutonomousPersonalExecutionScopeError;
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);

        // Own accessor constructor on a fulfilled Promise: proof fails, getter never runs.
        const accessor = Promise.resolve(1);
        Object.defineProperty(accessor, 'constructor', {
          get() {
            reads++;
            return Promise;
          },
        });
        // Own data constructor exposing a hostile species getter: proof fails, never read.
        const speciesHost = Promise.resolve(2);
        Object.defineProperty(speciesHost, 'constructor', {
          value: {
            get [Symbol.species]() {
              reads++;
              return Promise;
            },
          },
        });
        // Foreign prototype and subclass instances are never walked.
        const foreign = Promise.resolve(3);
        Object.setPrototypeOf(foreign, {
          get constructor() {
            reads++;
            return Promise;
          },
        });
        class Sub extends Promise<number> {
          static get [Symbol.species]() {
            reads++;
            return Promise;
          }
        }
        const sub = Sub.resolve(4);
        const proxied = new Proxy(Promise.resolve(5), {
          get() {
            reads++;
            return undefined;
          },
          getPrototypeOf() {
            reads++;
            return Promise.prototype;
          },
        });
        const thenGetter = Promise.resolve(6);
        Object.defineProperty(thenGetter, 'then', {
          get() {
            reads++;
            return undefined;
          },
        });

        for (const hostile of [accessor, speciesHost, foreign, sub, thenGetter]) {
          expect(spanOver(work, () => hostile).reason).toBe('async_span_misuse');
        }
        // A Proxy is not a native Promise result: returned untouched, no trap invoked.
        expect(runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => proxied)).toBe(
          proxied,
        );
        expect(reads).toBe(0);

        // Ordinary rejected native Promise gets the safe sink: no unhandled rejection.
        expect(spanOver(work, () => Promise.reject(new Error('ordinary'))).reason).toBe(
          'async_span_misuse',
        );
        expect(diag(entry, context)).toMatchObject({ activeDepth: 0, firstStop: null });
      });
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      process.off('unhandledRejection', listener);
      expect(reads).toBe(0);
      expect(unhandled).toEqual([]);
    });

    it('never reads arbitrary result getters or thenables', async () => {
      const { entry, context } = setup();
      let reads = 0;
      const result = {
        get then() {
          reads++;
          return undefined;
        },
        get value() {
          reads++;
          return 1;
        },
      };
      await scoped(entry, context, () => {
        const work = createAutonomousPersonalExecutionScopeWorkV1(entry, context, BASE + 9000);
        expect(runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => result)).toBe(
          result,
        );
      });
      expect(reads).toBe(0);
    });

    it('returns frozen bounded DATA diagnostics that carry no capability', async () => {
      const { entry, context } = setup({ overallMs: 1000 });
      const snapshot = diag(entry, context);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(AutonomousPersonalExecutionScopeDiagnosticsV1Schema.parse(snapshot)).toEqual(snapshot);
      expect(Object.keys(snapshot).sort()).toEqual([
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
      ]);
      expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(thrown(() => diag(snapshot as never, context))).toMatchObject({
        reason: 'invalid_scope',
      });
      closeAutonomousPersonalExecutionScopeV1(entry, context);
      expect(diag(entry, context).closed).toBe(true);
      expect(snapshot.closed).toBe(false);
    });

    it('uses fixed redacted error messages', () => {
      const context = {};
      const error = thrown(() => openAutonomousPersonalExecutionScopeV1(context, 'secret-purpose'));
      expect((error as Error).message).toBe('Engram autonomous execution scope: invalid_scope');
      expect((error as Error).message).not.toContain('secret');
    });
  });
});
