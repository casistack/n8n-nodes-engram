import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../../src/schemas/AutonomousPersonalPolicyV3.schema';
import {
  AutonomousPersonalCompletionPlanV4InputOwnedDataSchema,
  AutonomousPersonalCompletionPlanV4OwnedDataSchema,
  type AutonomousPersonalCompletionPlanV4Input,
} from '../../src/schemas/AutonomousPersonalCompletionPlanV4.schema';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import {
  assertAutonomousPersonalCompletionNativeAggregateBytesV4,
  assertAutonomousPersonalCompletionPlanAggregateBytesV4,
  closeAutonomousPersonalCompletionV4,
  consumeAutonomousPersonalCompletionHandleV4,
  getAutonomousPersonalCompletionAccessV4,
  isAutonomousPersonalCompletionAccessForHandleV4,
  isAutonomousPersonalCompletionHandleOpenV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import { projectAutonomousPersonalNativeOriginV4 } from '../../src/storage/AutonomousPersonalNativeOriginV4';
import { planAutonomousPersonalCaptureCompletionV4 } from '../../src/storage/AutonomousPersonalCompletionPlanV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

describe('native-origin aggregate foundation', () => {
  let directory: string;
  let store: GraphologyStorage;
  let seed: AutonomousPersonalCaptureSeed;
  let accesses: unknown[];

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-origin-foundation-'));
    store = new GraphologyStorage(join(directory, 'store.json'));
    accesses = [];
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    for (const access of accesses) closeAutonomousPersonalCompletionV4(store, access);
    jest.restoreAllMocks();
    await store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function openNativeCompletion(content: string, turn: string) {
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(
      nativeAutonomousPersonalCaptureContext(seed, {
        content,
        deadlineMs: 30_000,
        executionId: `execution:${turn}`,
        workflowId: `workflow:${turn}`,
        instanceId: `instance:${turn}`,
        extraParameters: {
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'disabled',
          automaticTurn: turn,
        },
      }),
      store,
    );
    if (prepared.kind !== 'completion_prepared') {
      throw new Error(`Expected native completion handle: ${prepared.kind}`);
    }
    const access = consumeAutonomousPersonalCompletionHandleV4(store, prepared.handle);
    accesses.push(access);
    return { handle: prepared.handle, access };
  }

  async function planForAccess(access: unknown) {
    const runtime = getAutonomousPersonalCompletionAccessV4(store, access);
    const graph = JSON.parse(JSON.stringify(await store.exportGraph())) as GraphData;
    const { view } = runtime;
    const input: AutonomousPersonalCompletionPlanV4Input =
      AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse({
        scope: view.scope,
        stagedFresh: view.stagedFresh,
        outcome: view.outcome.kind === 'response' ? { kind: 'response' } : view.outcome,
        backendNow: new Date(
          Math.max(Date.now(), Date.parse(view.stagedFresh.operation.lastObservedAt)),
        ).toISOString(),
        completionCallHash: view.completionCallHash,
        audit: view.audit,
      });
    const plan = planAutonomousPersonalCaptureCompletionV4(
      input,
      graph,
      view.outcome.kind === 'response' ? view.outcome.response : null,
      view.selection,
      runtime.typedSyntaxWork,
      runtime.check,
      runtime.legacyReadBudget,
    );
    if (plan.kind !== 'planned') {
      throw new Error(
        `Expected strict plan: ${plan.reason}; outcome=${view.outcome.kind}; selection=${view.selection ? 'present' : 'none'}`,
      );
    }
    return {
      input,
      plan: AutonomousPersonalCompletionPlanV4OwnedDataSchema.parse(plan),
      origin: projectAutonomousPersonalNativeOriginV4(input, plan, runtime.check),
    };
  }

  it('counts the exact native-origin inventory while preserving the old DATA-only cap', async () => {
    const completion = await openNativeCompletion(
      'I prefer concise explanations.',
      'native-origin-byte-inventory',
    );
    try {
      const { plan, origin } = await planForAccess(completion.access);
      const dataOnlyInventories: string[] = [];
      const nativeInventories: string[] = [];
      const originalByteLength = Buffer.byteLength.bind(Buffer);
      jest.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
        if (typeof value === 'string' && value.startsWith('{"scope":')) {
          if (value.includes('"nativeOrigin":')) nativeInventories.push(value);
          else dataOnlyInventories.push(value);
        }
        return originalByteLength(value, encoding);
      });

      expect(() =>
        assertAutonomousPersonalCompletionPlanAggregateBytesV4(store, completion.access, plan),
      ).not.toThrow();
      expect(dataOnlyInventories).toHaveLength(1);
      const dataOnlyBytes = originalByteLength(dataOnlyInventories[0]!, 'utf8');
      expect(dataOnlyBytes).toBeLessThan(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes);

      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(
          store,
          completion.access,
          plan,
          origin,
        ),
      ).not.toThrow();
      expect(nativeInventories).toHaveLength(1);
      const nativeInventory = JSON.parse(nativeInventories[0]!) as Record<string, unknown>;
      expect(Object.keys(nativeInventory)).toEqual([
        'scope',
        'stagedFresh',
        'refs',
        'outcome',
        'selection',
        'completionCallHash',
        'audit',
        'plan',
        'nativeOrigin',
      ]);
      expect(nativeInventory.plan).toEqual(plan);
      expect(nativeInventory.nativeOrigin).toEqual(origin);
      expect(originalByteLength(nativeInventories[0]!, 'utf8')).toBeLessThan(
        AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes,
      );
    } finally {
      closeAutonomousPersonalCompletionV4(store, completion.access);
      accesses = [];
    }
  });

  it('requires the genuine consumed access and strict bounded plan and origin DATA', async () => {
    const completion = await openNativeCompletion(
      'A short synthetic source for the owner-bound native-origin byte check.',
      'native-origin-owner-boundary',
    );
    try {
      const { plan, origin } = await planForAccess(completion.access);
      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(
          store,
          completion.access,
          plan,
          origin,
        ),
      ).not.toThrow();
      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(
          {},
          completion.access,
          plan,
          origin,
        ),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(
          store,
          { ...(completion.access as object) },
          plan,
          origin,
        ),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(
          store,
          completion.access,
          completion.handle,
          origin,
        ),
      ).toThrow('Engram autonomous personal provider: invalid_input');
      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(store, completion.access, plan, {
          ...origin,
          nativeProof: true,
        }),
      ).toThrow('Engram autonomous personal provider: invalid_input');

      closeAutonomousPersonalCompletionV4(store, completion.access);
      accesses = [];
      expect(() =>
        assertAutonomousPersonalCompletionNativeAggregateBytesV4(
          store,
          completion.access,
          plan,
          origin,
        ),
      ).toThrow('Engram autonomous personal provider: invalid_handle');
    } finally {
      closeAutonomousPersonalCompletionV4(store, completion.access);
      accesses = [];
    }
  });

  it('keeps open membership after cancellation while the exact access predicate fails closed', async () => {
    const controller = new AbortController();
    const hostSignalContext = Object.assign(
      nativeAutonomousPersonalCaptureContext(seed, {
        content: 'A short synthetic source for handle-state predicates.',
        deadlineMs: 30_000,
        extraParameters: {
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'disabled',
          automaticTurn: 'native-origin-expiry-predicates',
        },
      }),
      { getExecutionCancelSignal: () => controller.signal },
    );
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(hostSignalContext, store);
    if (prepared.kind !== 'completion_prepared') {
      throw new Error(`Expected native completion handle: ${prepared.kind}`);
    }
    const access = consumeAutonomousPersonalCompletionHandleV4(store, prepared.handle);
    accesses.push(access);

    expect(isAutonomousPersonalCompletionHandleOpenV4(store, prepared.handle)).toBe(true);
    expect(isAutonomousPersonalCompletionAccessForHandleV4(store, prepared.handle, access)).toBe(
      true,
    );
    expect(isAutonomousPersonalCompletionAccessForHandleV4(store, prepared.handle, {})).toBe(false);

    controller.abort();
    expect(isAutonomousPersonalCompletionHandleOpenV4(store, prepared.handle)).toBe(true);
    expect(isAutonomousPersonalCompletionAccessForHandleV4(store, prepared.handle, access)).toBe(
      false,
    );
    expect(isAutonomousPersonalCompletionHandleOpenV4({}, prepared.handle)).toBe(false);
    expect(isAutonomousPersonalCompletionHandleOpenV4(store, { ...prepared.handle })).toBe(false);

    closeAutonomousPersonalCompletionV4(store, access);
    accesses = [];
    expect(isAutonomousPersonalCompletionHandleOpenV4(store, prepared.handle)).toBe(false);
    expect(isAutonomousPersonalCompletionAccessForHandleV4(store, prepared.handle, access)).toBe(
      false,
    );
  });

  it('keeps open membership after expiry while the exact access predicate fails closed', async () => {
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(
      nativeAutonomousPersonalCaptureContext(seed, {
        content: 'A short synthetic source for expiry-state predicates.',
        deadlineMs: 30_000,
        extraParameters: {
          automaticMemoryProfile: 'explicit',
          automaticIntent: 'disabled',
          automaticTurn: 'native-origin-expiry-predicates',
        },
      }),
      store,
    );
    if (prepared.kind !== 'completion_prepared') {
      throw new Error(`Expected native completion handle: ${prepared.kind}`);
    }
    const access = consumeAutonomousPersonalCompletionHandleV4(store, prepared.handle);
    accesses.push(access);

    const actualNow = performance.now.bind(performance);
    const nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + 31_000);
    try {
      expect(isAutonomousPersonalCompletionHandleOpenV4(store, prepared.handle)).toBe(true);
      expect(isAutonomousPersonalCompletionAccessForHandleV4(store, prepared.handle, access)).toBe(
        false,
      );
    } finally {
      nowSpy.mockRestore();
    }

    closeAutonomousPersonalCompletionV4(store, access);
    accesses = [];
    expect(isAutonomousPersonalCompletionHandleOpenV4(store, prepared.handle)).toBe(false);
    expect(isAutonomousPersonalCompletionAccessForHandleV4(store, prepared.handle, access)).toBe(
      false,
    );
  });
});
