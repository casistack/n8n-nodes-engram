import { performance } from 'node:perf_hooks';
import {
  AutonomousPersonalExecutionScopeBudgetError,
  AutonomousPersonalExecutionScopeError,
  bindAutonomousPersonalExecutionScopeV1,
  checkCurrentAutonomousPersonalExecutionScopeWorkV1,
  clipAutonomousPersonalExecutionScopeLeaseV1,
  createAutonomousPersonalExecutionScopeWorkV1,
  currentAutonomousPersonalExecutionScopeWorkV1,
  diagnoseAutonomousPersonalExecutionScopeV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeSyntaxSpanV1,
  runAutonomousPersonalExecutionScopeV1,
  runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1,
  type AutonomousPersonalExecutionScopeEntryV1,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';

const budget = (syntax: object = { mode: 'limited', durationMs: 100 }) => ({
  semantics: 'configured',
  version: 1,
  completion: { mode: 'inheritOverall' },
  syntax,
  finalizationReserve: { mode: 'automatic' },
});

function open(overallMs = 10_000, syntax?: object) {
  const context = {};
  const entry = openAutonomousPersonalExecutionScopeV1(context, 'memoryRead');
  bindAutonomousPersonalExecutionScopeV1(entry, context, budget(syntax), overallMs);
  return { context, entry };
}

const run = <T>(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  context: object,
  body: () => Promise<T>,
) => runAutonomousPersonalExecutionScopeV1(entry, context, body);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Synthetic CPU work for the cumulative syntax meter.
  }
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('registered work consumer APIs (connected scope)', () => {
  it('has no default work and treats unknown work as legacy outside any scope', () => {
    expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBeUndefined();
    const unknown: AutonomousPersonalTypedSyntaxWorkV1 = {
      absoluteMonotonicDeadlineMs: performance.now() + 1000,
      signal: new AbortController().signal,
    };
    expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1(unknown)).toBe('legacy');
    expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1(undefined)).toBe('legacy');
    let called = 0;
    expect(runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1(unknown, () => ++called)).toBe(1);
  });

  it('derives a frozen two-field default work privately and caches it per deadline', async () => {
    const { context, entry } = open();
    await run(entry, context, async () => {
      const work = currentAutonomousPersonalExecutionScopeWorkV1()!;
      const diagnostics = diagnoseAutonomousPersonalExecutionScopeV1(entry, context);
      expect(Object.isFrozen(work)).toBe(true);
      expect(Reflect.ownKeys(work).sort()).toEqual(['absoluteMonotonicDeadlineMs', 'signal']);
      expect(work.absoluteMonotonicDeadlineMs).toBe(diagnostics.effectiveDeadlineMs);
      expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(work);
      expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1(work)).toBe('configured');
      // A structural copy is not registered work and keeps the legacy path.
      expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1({ ...work })).toBe('legacy');
    });
  });

  it('regenerates default work after a lease clip without extending any older work', async () => {
    const { context, entry } = open();
    await run(entry, context, async () => {
      const before = currentAutonomousPersonalExecutionScopeWorkV1()!;
      const stage = createAutonomousPersonalExecutionScopeWorkV1(
        entry,
        context,
        before.absoluteMonotonicDeadlineMs - 1000,
      );
      const lease = before.absoluteMonotonicDeadlineMs - 500;
      clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, lease);
      const after = currentAutonomousPersonalExecutionScopeWorkV1()!;
      expect(after).not.toBe(before);
      expect(after.absoluteMonotonicDeadlineMs).toBe(lease);
      expect(before.absoluteMonotonicDeadlineMs).toBeGreaterThan(lease);
      // The narrower stage stays valid and is never extended; the old default stays registered.
      expect(stage.absoluteMonotonicDeadlineMs).toBeLessThan(lease);
      expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1(stage)).toBe('configured');
      // A later, looser clip request cannot move the deadline back out.
      clipAutonomousPersonalExecutionScopeLeaseV1(entry, context, lease + 5000);
      expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(after);
    });
  });

  it('throws for an active failed scope instead of falling back to legacy', async () => {
    const { context, entry } = open(100);
    let inner: unknown;
    const result = run(entry, context, async () => {
      await sleep(160);
      inner = thrown(() => currentAutonomousPersonalExecutionScopeWorkV1());
    });
    await expect(result).rejects.toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect(inner).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect((inner as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
      'invocation_deadline',
    );
  });

  it('fails closed for closed registered work and keeps copies on the legacy path', async () => {
    const { context, entry } = open();
    const work = await run(
      entry,
      context,
      async () => currentAutonomousPersonalExecutionScopeWorkV1()!,
    );
    const error = thrown(() => checkCurrentAutonomousPersonalExecutionScopeWorkV1(work));
    expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeError);
    expect((error as AutonomousPersonalExecutionScopeError).reason).toBe('scope_closed');
    expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1({ ...work })).toBe('legacy');
    expect(() => runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1(work, () => 1)).toThrow(
      AutonomousPersonalExecutionScopeError,
    );
  });

  it('rejects work registered to a different open entry as foreign', async () => {
    const a = open();
    const b = open();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let workA!: AutonomousPersonalTypedSyntaxWorkV1;
    let ready!: () => void;
    const created = new Promise<void>((resolve) => (ready = resolve));
    const first = run(a.entry, a.context, async () => {
      workA = currentAutonomousPersonalExecutionScopeWorkV1()!;
      ready();
      await gate;
    });
    await created;
    let error: unknown;
    await run(b.entry, b.context, async () => {
      error = thrown(() => checkCurrentAutonomousPersonalExecutionScopeWorkV1(workA));
    });
    release();
    await first;
    expect((error as AutonomousPersonalExecutionScopeError).reason).toBe('foreign_scope');
  });

  it('stops registered stage work on stage cancellation and keeps the first stop', async () => {
    const { context, entry } = open();
    const stage = new AbortController();
    let error: unknown;
    await run(entry, context, async () => {
      const deadline = currentAutonomousPersonalExecutionScopeWorkV1()!.absoluteMonotonicDeadlineMs;
      const work = createAutonomousPersonalExecutionScopeWorkV1(
        entry,
        context,
        deadline,
        stage.signal,
      );
      stage.abort();
      error = thrown(() => checkCurrentAutonomousPersonalExecutionScopeWorkV1(work));
    }).catch(() => undefined);
    expect(error).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect((error as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
      'stage_cancelled',
    );
  });

  it('shares one cumulative syntax allowance between explicit and context-free spans', async () => {
    const { context, entry } = open(10_000, { mode: 'limited', durationMs: 100 });
    let stop: unknown;
    await run(entry, context, async () => {
      const work = currentAutonomousPersonalExecutionScopeWorkV1()!;
      runAutonomousPersonalExecutionScopeSyntaxSpanV1(work, context, () => busy(50));
      const afterFirst = diagnoseAutonomousPersonalExecutionScopeV1(entry, context);
      expect(afterFirst.chargedSyntaxMs).toBeGreaterThanOrEqual(45);
      stop = thrown(() =>
        runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1(work, () => busy(70)),
      );
    }).catch(() => undefined);
    expect(stop).toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect((stop as AutonomousPersonalExecutionScopeBudgetError).stopReason).toBe(
      'syntax_allowance',
    );
    expect(
      diagnoseAutonomousPersonalExecutionScopeV1(entry, context).chargedSyntaxMs,
    ).toBeGreaterThanOrEqual(100);
  });

  it('rejects async span callbacks for registered work only', async () => {
    const { context, entry } = open();
    await run(entry, context, async () => {
      const work = currentAutonomousPersonalExecutionScopeWorkV1()!;
      const error = thrown(() =>
        runCurrentAutonomousPersonalExecutionScopeSyntaxSpanV1(work, (async () => 1) as never),
      );
      expect((error as AutonomousPersonalExecutionScopeError).reason).toBe('async_span_misuse');
    });
  });
});
