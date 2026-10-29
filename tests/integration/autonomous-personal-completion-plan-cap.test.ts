import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../../src/schemas/AutonomousPersonalPolicyV3.schema';
import { AutonomousPersonalCompletionPlanV4OwnedDataSchema } from '../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';
import {
  assertAutonomousPersonalCompletionPlanAggregateBytesV4,
  closeAutonomousPersonalCaptureProviderStageAccessV4,
  closeAutonomousPersonalCompletionV4,
  consumeAutonomousPersonalCaptureProviderStageV4,
  consumeAutonomousPersonalCompletionHandleV4,
  getAutonomousPersonalCaptureProviderStageAccessV4,
  getAutonomousPersonalCompletionAccessV4,
  prepareNativeAutonomousPersonalCaptureProviderV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../src/storage/AutonomousPersonalCompletionPlanV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';
import { autonomousPersonalCompletionPlanNextStageV4 } from '../helpers/autonomousPersonalCompletionPlanV4';

describe('owner-bound completion plan aggregate cap', () => {
  let directory: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-completion-plan-cap-'));
    store = new GraphologyStorage(join(directory, 'store.json'));
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const nativeContext = (content?: string, turn = seed.request.turn) =>
    nativeAutonomousPersonalCaptureContext(seed, {
      ...(content === undefined ? {} : { content }),
      deadlineMs: 30_000,
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'disabled',
        automaticTurn: turn,
      },
    });

  const openCompletion = async (options: { content?: string; turn?: string } = {}) => {
    const result = await prepareNativeAutonomousPersonalCompletionV4(
      nativeContext(options.content, options.turn),
      store,
    );
    if (result.kind !== 'completion_prepared') {
      throw new Error(`Expected a native completion handle: ${result.kind}`);
    }
    const access = consumeAutonomousPersonalCompletionHandleV4(store, result.handle);
    const runtime = getAutonomousPersonalCompletionAccessV4(store, access);
    return { handle: result.handle, access, runtime };
  };

  const plannedOutputForTurn = async (turn: string) => {
    const stage = await autonomousPersonalCompletionPlanNextStageV4(store, seed, {
      content: 'I prefer concise explanations.',
      profile: 'explicit',
      intent: 'disabled',
      turn,
    });
    let plan;
    try {
      plan = planAutonomousPersonalCaptureCompletionV4(
        stage.input,
        stage.graph,
        stage.response,
        stage.selection,
        stage.work,
        stage.check,
        stage.budget,
      );
    } finally {
      stage.close();
    }
    if (plan.kind !== 'planned') throw new Error(`Expected planned DATA: ${plan.reason}`);
    expect(AutonomousPersonalCompletionPlanV4OwnedDataSchema.parse(plan)).toEqual(plan);
    return plan;
  };

  it('accepts strict planned DATA beside a genuine consumed native access', async () => {
    // Build the unrelated synthetic planner output before opening the genuine
    // access so its original five-second work window covers only that access.
    const plan = await plannedOutputForTurn('plan-cap-plan-small');
    const completion = await openCompletion();
    try {
      // Planner DATA comes from a separate coherent synthetic stage in this
      // same store. This cap seam checks strict DATA inventory, not write or
      // native-origin proof binding between a plan and a completion access.
      expect(plan.kind).toBe('planned');
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, plan),
      ).not.toThrow();
    } finally {
      closeAutonomousPersonalCompletionV4(store, completion.access);
    }
  });

  it('rejects wrong-owner, copied, unconsumed, and closed access keys', async () => {
    const plan = await plannedOutputForTurn('plan-cap-plan-owner');
    const completion = await openCompletion();
    try {
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4({}, completion.access, plan),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(
          store,
          { ...completion.access },
          plan,
        ),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.handle, plan),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
    } finally {
      closeAutonomousPersonalCompletionV4(store, completion.access);
    }
    expect(() =>
      assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, plan),
    ).toThrow('Engram autonomous personal provider: invalid_handle');
  });

  it('rejects malformed, accessor-backed, proxy, and no-write plan data without invoking getters', async () => {
    const validPlan = await plannedOutputForTurn('plan-cap-plan-hostile');
    const completion = await openCompletion();
    try {
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, {
          kind: 'planned',
        }),
      ).toThrow('Engram autonomous personal provider: invalid_input');

      let getterCalls = 0;
      const accessorPlan = Object.defineProperty({ kind: 'planned' }, 'createEntities', {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error('getter_must_not_run');
        },
      });
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(
          store,
          completion.access,
          accessorPlan,
        ),
      ).toThrow('Engram autonomous personal provider: invalid_input');
      expect(getterCalls).toBe(0);

      let proxyTraps = 0;
      const proxyPlan = new Proxy(validPlan, {
        get() {
          proxyTraps += 1;
          throw new Error('proxy_must_not_run');
        },
      });
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, proxyPlan),
      ).toThrow('Engram autonomous personal provider: invalid_input');
      expect(proxyTraps).toBe(0);

      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, {
          kind: 'no_write',
          reason: 'capacity',
        }),
      ).toThrow('Engram autonomous personal provider: invalid_input');
    } finally {
      closeAutonomousPersonalCompletionV4(store, completion.access);
    }
  });

  it('preserves the original work failure identity when work aborts after inventory serialization', async () => {
    const plan = await plannedOutputForTurn('plan-cap-plan-abort');
    const controller = new AbortController();
    const completionContext = nativeContext() as unknown as {
      getExecutionCancelSignal: () => AbortSignal;
    };
    completionContext.getExecutionCancelSignal = () => controller.signal;
    const result = await prepareNativeAutonomousPersonalCompletionV4(
      completionContext as unknown as ReturnType<typeof nativeContext>,
      store,
    );
    if (result.kind !== 'completion_prepared') throw new Error('Expected completion handle');
    const access = consumeAutonomousPersonalCompletionHandleV4(store, result.handle);
    const runtime = getAutonomousPersonalCompletionAccessV4(store, access);
    const originalByteLength = Buffer.byteLength.bind(Buffer);
    jest.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
      const bytes = originalByteLength(value, encoding);
      if (typeof value === 'string' && value.startsWith('{"scope"')) controller.abort();
      return bytes;
    });

    let thrown: unknown;
    try {
      assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, access, plan);
    } catch (error) {
      thrown = error;
    } finally {
      closeAutonomousPersonalCompletionV4(store, access);
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toHaveProperty('message', 'Engram autonomous personal provider: cancelled');
    let repeated: unknown;
    try {
      runtime.check();
    } catch (error) {
      repeated = error;
    }
    expect(repeated).toBe(thrown);
  });

  // Harness allowance only: setup runs three independent native A1 stages; the
  // completion access still retains its pinned five-second product work limit.
  it('rejects a valid source-only plan when its escaped-source aggregate exceeds the frozen cap', async () => {
    const content = String.fromCharCode(0).repeat(47_850);
    const measureTurn = 'plan-cap-measure-a';
    const completeTurn = 'plan-cap-measure-b';
    expect(measureTurn).toHaveLength(completeTurn.length);

    // This independent strict plan requires another native A1 stage; finish it
    // before opening the access whose original five-second work is under test.
    const plan = await plannedOutputForTurn('plan-cap-plan-boundary');

    const a1 = await prepareNativeAutonomousPersonalCaptureProviderV4(
      nativeContext(content, measureTurn),
      store,
    );
    if (a1.kind !== 'prepared') throw new Error('Expected an A1 stage under the cap');
    const stageAccess = consumeAutonomousPersonalCaptureProviderStageV4(store, a1.stage);
    const measuredStage = getAutonomousPersonalCaptureProviderStageAccessV4(
      store,
      stageAccess,
    ).view;
    const stageTuple = {
      scope: measuredStage.scope,
      stagedFresh: measuredStage.stagedFresh,
      refs: measuredStage.refs,
      outcome: measuredStage.outcome,
      selection: measuredStage.selection,
    };
    const stageBytes = Buffer.byteLength(JSON.stringify(stageTuple), 'utf8');
    const completionBytes = Buffer.byteLength(
      JSON.stringify({
        ...stageTuple,
        completionCallHash: 'a'.repeat(64),
        audit: {
          action: 'completion',
          attemptIdHash: 'b'.repeat(64),
          operationId: measuredStage.scope.operationId,
          sourceId: measuredStage.scope.sourceId,
        },
      }),
      'utf8',
    );
    closeAutonomousPersonalCaptureProviderStageAccessV4(store, stageAccess);

    const completion = await openCompletion({ content, turn: completeTurn });
    try {
      const aggregateBytes = Buffer.byteLength(
        JSON.stringify({
          scope: measuredStage.scope,
          stagedFresh: measuredStage.stagedFresh,
          refs: measuredStage.refs,
          outcome: measuredStage.outcome,
          selection: measuredStage.selection,
          completionCallHash: 'c'.repeat(64),
          audit: {
            action: 'completion',
            attemptIdHash: 'd'.repeat(64),
            operationId: measuredStage.scope.operationId,
            sourceId: measuredStage.scope.sourceId,
          },
          plan,
        }),
        'utf8',
      );
      expect(stageBytes).toBeLessThan(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes);
      expect(completionBytes).toBeLessThan(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes);
      expect(aggregateBytes).toBeGreaterThan(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes);
      expect(plan.kind).toBe('planned');
      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, plan),
      ).toThrow('Engram autonomous personal provider: resource_exhausted');
    } finally {
      closeAutonomousPersonalCompletionV4(store, completion.access);
    }
  }, 30_000);
});
