import * as SnapshotIndex from '../../../src/extraction/CompositionalSnapshotIndexV3';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import {
  runAutonomousPersonalMemoryOperationV1,
  runAutonomousPersonalMemoryPreparationV1,
  assertAutonomousPersonalMemoryPreparationConfigV1,
} from '../../../src/utils/AutonomousPersonalMemoryExecutionEntryV1';
import { createAutonomousPersonalNativeMemoryWorkV4 } from '../../../src/utils/AutonomousPersonalNativeMemoryWorkV4';
import {
  currentAutonomousPersonalExecutionScopeWorkV1,
  checkCurrentAutonomousPersonalExecutionScopeWorkV1,
  AutonomousPersonalExecutionScopeBudgetError,
} from '../../../src/storage/AutonomousPersonalExecutionScopeV1';
import {
  getAutomaticClaimReadScope,
  getAutomaticClaimReadScopeWithAbsoluteDeadline,
} from '../../../src/storage/AutomaticClaimReadScope';
import { createCompositionalRetrievalSessionFactoryV3 } from '../../../src/search/CompositionalRetrievalSessionV3';

const budget = {
  semantics: 'configured' as const,
  version: 1 as const,
  completion: { mode: 'inheritOverall' as const },
  syntax: { mode: 'inheritOverall' as const },
  finalizationReserve: { mode: 'automatic' as const },
};
const config = (duration = 10_000) =>
  ({
    executionBudget: budget,
    invocationDeadlineMs: duration,
  }) as AutonomousPersonalNativeMemoryConfigV4;
function host(controller: AbortController, configured = true) {
  const parameters = {
    automaticPreferenceInterpreter: 'autonomousPersonalV1',
    ...(configured ? { automaticExecutionBudgetMode: 'configuredV1' } : {}),
  };
  return {
    getNode: () => ({ parameters }),
    getNodeParameter: (name: string, _index: number, fallback: unknown) =>
      name === 'extractionDeadlineMs' ? 10_000 : fallback,
    getExecutionCancelSignal: () => controller.signal,
  } as unknown as IExecuteFunctions;
}

describe('native Memory configured execution budget', () => {
  let now = 1000;
  beforeEach(() => {
    now = 1000;
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps an omitted legacy policy outside an execution scope', async () => {
    const controller = new AbortController();
    await runAutonomousPersonalMemoryPreparationV1(host(controller, false), 0, async () => {
      expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBeUndefined();
      const work = createAutonomousPersonalNativeMemoryWorkV4(host(controller), 10_000);
      expect(work.work.signal).toBe(controller.signal);
    });
    expect(controller.signal.aborted).toBe(false);
  });

  it('includes preparation elapsed time and separates temporary cancellation from the host signal', async () => {
    const controller = new AbortController();
    const ctx = host(controller);
    let preparedWork: ReturnType<typeof currentAutonomousPersonalExecutionScopeWorkV1>;
    await runAutonomousPersonalMemoryPreparationV1(ctx, 0, async () => {
      const first = currentAutonomousPersonalExecutionScopeWorkV1()!;
      now += 6100;
      const work = createAutonomousPersonalNativeMemoryWorkV4(ctx, 10_000, ctx);
      expect(work.work).toBe(first);
      expect(work.work.absoluteMonotonicDeadlineMs).toBe(11_000);
      expect(work.nativeSignal).toBe(controller.signal);
      expect(work.work.signal).not.toBe(controller.signal);
      assertAutonomousPersonalMemoryPreparationConfigV1(ctx, config());
      work.check();
      preparedWork = work.work;
    });
    expect(() => checkCurrentAutonomousPersonalExecutionScopeWorkV1(preparedWork)).toThrow(
      'scope_closed',
    );
    expect(preparedWork!.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(20_000);
    expect(preparedWork!.signal.aborted).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it('cleans up prepared resources when the final scope check fails after the body returns', async () => {
    const controller = new AbortController();
    const cleanup = jest.fn(async () => undefined);
    await expect(
      runAutonomousPersonalMemoryPreparationV1(host(controller), 0, async (register) => {
        register(cleanup);
        now = 11_000;
        return 'prepared';
      }),
    ).rejects.toBeInstanceOf(AutonomousPersonalExecutionScopeBudgetError);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
  });

  it('rejects changed resolved preparation controls without replacing the original scope', async () => {
    const controller = new AbortController();
    const ctx = host(controller);
    await expect(
      runAutonomousPersonalMemoryPreparationV1(ctx, 0, async () => {
        assertAutonomousPersonalMemoryPreparationConfigV1(ctx, config(9000));
      }),
    ).rejects.toThrow('configuration_conflict');
  });

  it('starts each later read/save freshly, while internal reads reuse the save deadline', async () => {
    const owner = {};
    const controller = new AbortController();
    await runAutonomousPersonalMemoryOperationV1(
      owner,
      'memoryRead',
      config(),
      controller.signal,
      async () => {
        expect(currentAutonomousPersonalExecutionScopeWorkV1()!.absoluteMonotonicDeadlineMs).toBe(
          11_000,
        );
        now = 2000;
      },
    );
    now = 20_000;
    await runAutonomousPersonalMemoryOperationV1(
      owner,
      'memorySave',
      config(),
      controller.signal,
      async () => {
        const original = currentAutonomousPersonalExecutionScopeWorkV1()!;
        expect(original.absoluteMonotonicDeadlineMs).toBe(30_000);
        now += 1000;
        await runAutonomousPersonalMemoryOperationV1(
          owner,
          'memoryRead',
          config(),
          controller.signal,
          async () => {
            expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(original);
            expect(
              createAutonomousPersonalNativeMemoryWorkV4(host(controller), 10_000, owner).work,
            ).toBe(original);
          },
        );
        expect(original.signal.aborted).toBe(false);
      },
    );
    expect(controller.signal.aborted).toBe(false);
  });

  it('does not share controller lifetime between independent parallel loads', async () => {
    const owner = {};
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstWork: ReturnType<typeof currentAutonomousPersonalExecutionScopeWorkV1>;
    let secondWork: ReturnType<typeof currentAutonomousPersonalExecutionScopeWorkV1>;
    const first = runAutonomousPersonalMemoryOperationV1(
      owner,
      'memoryRead',
      config(),
      controller.signal,
      async () => {
        firstWork = currentAutonomousPersonalExecutionScopeWorkV1();
        await gate;
        expect(firstWork!.signal.aborted).toBe(false);
        expect(checkCurrentAutonomousPersonalExecutionScopeWorkV1(firstWork)).toBe('configured');
      },
    );
    await runAutonomousPersonalMemoryOperationV1(
      owner,
      'memoryRead',
      config(),
      controller.signal,
      async () => {
        secondWork = currentAutonomousPersonalExecutionScopeWorkV1();
        expect(secondWork).not.toBe(firstWork);
      },
    );
    expect(() => checkCurrentAutonomousPersonalExecutionScopeWorkV1(secondWork)).toThrow(
      'scope_closed',
    );
    expect(secondWork!.signal.aborted).toBe(false);
    // Only the first invocation timer remains; closing the second did not affect it.
    expect(jest.getTimerCount()).toBe(1);
    expect(firstWork!.signal.aborted).toBe(false);
    release();
    await first;
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(20_000);
    expect(controller.signal.aborted).toBe(false);
    expect(firstWork!.signal.aborted).toBe(false);
    expect(secondWork!.signal.aborted).toBe(false);
  });

  it('reuses only the exact explicitly passed V4 read scope in the compatibility factory', () => {
    const sources = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(sources, 20_000);
    const factory = createCompositionalRetrievalSessionFactoryV3(undefined, scope);
    const begun = factory.begin(
      { namespace: 'synthetic-memory-budget', mode: 'current' },
      { budget: sources },
    );
    expect(begun.status).toBe('intake');
    if (begun.status !== 'intake') throw new Error('Expected intake');
    expect(factory.getScope(begun.intake)).toBe(scope);
    expect(sources.remaining).toBe(508);
    expect(
      factory.begin(
        { namespace: 'synthetic-memory-budget', mode: 'current' },
        { budget: { remaining: 512, deferred: 0 } },
      ),
    ).toEqual({ status: 'deferred', reason: 'invalid_resources' });
    expect(() => getAutomaticClaimReadScope(sources)).toThrow('configuration conflicts');
    now = 20_000;
    expect(
      factory.begin({ namespace: 'synthetic-memory-budget', mode: 'current' }, { budget: sources })
        .status,
    ).not.toBe('intake');
  });
  it('charges full V4 compatibility index work cumulatively without changing standalone V3', async () => {
    const fixture = makeCompositionalCommittedClaimFixture();
    const originalIndex = SnapshotIndex.createCompositionalRetrievalSnapshotIndexV3;
    const index = jest
      .spyOn(SnapshotIndex, 'createCompositionalRetrievalSnapshotIndexV3')
      .mockImplementation((...args) => {
        now += 60;
        return originalIndex(...args);
      });
    const limited = {
      ...config(),
      executionBudget: { ...budget, syntax: { mode: 'limited' as const, durationMs: 100 } },
    };
    await expect(
      runAutonomousPersonalMemoryOperationV1({}, 'memoryRead', limited, undefined, async () => {
        const work = currentAutonomousPersonalExecutionScopeWorkV1()!;
        const sources = { remaining: 512, deferred: 0 };
        const scope = getAutomaticClaimReadScopeWithAbsoluteDeadline(
          sources,
          work.absoluteMonotonicDeadlineMs,
        );
        const factory = createCompositionalRetrievalSessionFactoryV3(undefined, scope);
        const prepare = () => {
          const intake = factory.begin(
            { namespace: fixture.request.namespace, mode: 'current' },
            { budget: sources },
          );
          if (intake.status !== 'intake') throw new Error('Expected live intake');
          return factory.prepare(intake.intake, {
            graph: fixture.graph,
            backendNow: '2026-10-25T12:00:03.000Z',
          });
        };
        expect(prepare().status).toBe('prepared_data');
        // Each individual index is below 100ms, but they share the one invocation allowance.
        prepare();
      }),
    ).rejects.toMatchObject({ stopReason: 'syntax_allowance' });
    expect(index).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);

    // No V4 shared scope argument: the existing standalone factory remains unchanged.
    const factory = createCompositionalRetrievalSessionFactoryV3();
    const sources = { remaining: 512, deferred: 0 };
    const intake = factory.begin(
      { namespace: fixture.request.namespace, mode: 'current' },
      { budget: sources },
    );
    if (intake.status !== 'intake') throw new Error('Expected legacy intake');
    expect(
      factory.prepare(intake.intake, {
        graph: fixture.graph,
        backendNow: '2026-10-25T12:00:03.000Z',
      }).status,
    ).toBe('prepared_data');
  });
  it.each([
    [
      'deleted budget mode',
      (parameters: Record<string, unknown>) => {
        delete parameters.automaticExecutionBudgetMode;
      },
    ],
    [
      'legacy budget mode',
      (parameters: Record<string, unknown>) => {
        parameters.automaticExecutionBudgetMode = 'legacy';
      },
    ],
    [
      'malformed budget mode',
      (parameters: Record<string, unknown>) => {
        parameters.automaticExecutionBudgetMode = null;
      },
    ],
    [
      'different interpreter',
      (parameters: Record<string, unknown>) => {
        parameters.automaticPreferenceInterpreter = 'literalV1';
      },
    ],
    [
      'deleted interpreter',
      (parameters: Record<string, unknown>) => {
        delete parameters.automaticPreferenceInterpreter;
      },
    ],
  ] as const)(
    'rejects nested preparation with %s before invoking its body',
    async (_label, mutate) => {
      const controller = new AbortController();
      const ctx = host(controller);
      const parameters = ctx.getNode().parameters as Record<string, unknown>;
      const nestedBody = jest.fn(async () => undefined);
      await runAutonomousPersonalMemoryPreparationV1(ctx, 0, async () => {
        const originalWork = currentAutonomousPersonalExecutionScopeWorkV1()!;
        now += 50;
        mutate(parameters);
        await expect(runAutonomousPersonalMemoryPreparationV1(ctx, 0, nestedBody)).rejects.toThrow(
          'configuration_conflict',
        );
        expect(nestedBody).not.toHaveBeenCalled();
        expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(originalWork);
        expect(originalWork.absoluteMonotonicDeadlineMs).toBe(11_000);
        // Restoring the original settings can reuse only that same entry and deadline.
        parameters.automaticExecutionBudgetMode = 'configuredV1';
        parameters.automaticPreferenceInterpreter = 'autonomousPersonalV1';
        await runAutonomousPersonalMemoryPreparationV1(ctx, 0, async () => {
          expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(originalWork);
        });
      });
    },
  );

  it('rejects a nested configured save-to-legacy read downgrade before its body', async () => {
    const owner = {};
    const body = jest.fn(async () => undefined);
    await runAutonomousPersonalMemoryOperationV1(
      owner,
      'memorySave',
      config(),
      undefined,
      async () => {
        const original = currentAutonomousPersonalExecutionScopeWorkV1()!;
        const legacy = { invocationDeadlineMs: 10_000 } as AutonomousPersonalNativeMemoryConfigV4;
        await expect(
          runAutonomousPersonalMemoryOperationV1(owner, 'memoryRead', legacy, undefined, body),
        ).rejects.toThrow('configuration_conflict');
        expect(body).not.toHaveBeenCalled();
        expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(original);
      },
    );
  });
  it('rejects read-to-save downgrades and releases a rejected nested configured entry', async () => {
    const owner = {};
    const body = jest.fn(async () => undefined);
    await runAutonomousPersonalMemoryOperationV1(
      owner,
      'memoryRead',
      config(),
      undefined,
      async () => {
        const original = currentAutonomousPersonalExecutionScopeWorkV1();
        const legacy = { invocationDeadlineMs: 10_000 } as AutonomousPersonalNativeMemoryConfigV4;
        await expect(
          runAutonomousPersonalMemoryOperationV1(owner, 'memorySave', legacy, undefined, body),
        ).rejects.toThrow('configuration_conflict');
        expect(jest.getTimerCount()).toBe(1);
        await expect(
          runAutonomousPersonalMemoryOperationV1(owner, 'memorySave', config(), undefined, body),
        ).rejects.toThrow('nested_scope');
        expect(body).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(1);
        expect(currentAutonomousPersonalExecutionScopeWorkV1()).toBe(original);
      },
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});
