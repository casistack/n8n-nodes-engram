import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import {
  closeAutonomousPersonalCaptureProviderStageAccessV4,
  closeAutonomousPersonalCompletionV4,
  consumeAutonomousPersonalCaptureProviderStageV4,
  consumeAutonomousPersonalCompletionHandleV4,
  getAutonomousPersonalCaptureProviderStageAccessV4,
  getAutonomousPersonalCompletionAccessV4,
  prepareNativeAutonomousPersonalCaptureProviderV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import * as uuidFactory from '../../src/utils/uuid';
import { hashAutomaticCaptureV2 } from '../../src/schemas/AutomaticCapture.schema';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../../src/schemas/AutonomousPersonalPolicyV3.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  type AutonomousPersonalCaptureSeed,
} from '../helpers/autonomousPersonalCaptureBackend';

type ProviderBody = {
  messages: Array<{ role: string; content: string }>;
};

type MutableNativeContext = {
  readonly context: IExecuteFunctions;
  readonly overrides: Record<string, unknown>;
  setExecutionId: (value: string) => void;
  setCredentials: (value: { apiKey: string; baseUrl: string }) => void;
};

const TEST_API_KEY = 'completion-preparation-test-key';
const TEST_BASE_URL = 'https://memory.invalid/v1';

export interface AutonomousPersonalCompletionPreparationFixture {
  readonly store: IGraphStorage;
  readonly seed: AutonomousPersonalCaptureSeed;
  close(): Promise<void>;
}

export type AutonomousPersonalCompletionPreparationFixtureFactory =
  () => Promise<AutonomousPersonalCompletionPreparationFixture>;

function successfulProviderResponse(unitIds: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              version: 1,
              units: unitIds.map((unitId) => ({
                unitId,
                category: 'preference',
                risk: 'ordinary',
                usefulness: 'personal_memory',
                downgrade: [],
              })),
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mutableContext(seed: AutonomousPersonalCaptureSeed): MutableNativeContext {
  const context = nativeAutonomousPersonalCaptureContext(seed, {
    credentials: { apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL },
  });
  const overrides: Record<string, unknown> = {};
  let executionId = 'execution:A';
  let credentials = { apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL };
  const mutable = context as unknown as {
    getNodeParameter: (name: string, index: number, fallback: unknown) => unknown;
    getExecutionId: () => string;
    getCredentials: () => Promise<{ apiKey: string; baseUrl: string }>;
  };
  const originalGetNodeParameter = mutable.getNodeParameter.bind(context);
  mutable.getNodeParameter = (name, index, fallback) =>
    Object.prototype.hasOwnProperty.call(overrides, name)
      ? overrides[name]
      : originalGetNodeParameter(name, index, fallback);
  mutable.getExecutionId = () => executionId;
  mutable.getCredentials = async () => credentials;
  return {
    context,
    overrides,
    setExecutionId: (value) => {
      executionId = value;
    },
    setCredentials: (value) => {
      credentials = value;
    },
  };
}

function installSuccessfulProviderFetch(afterDispatch?: () => void) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as ProviderBody;
    const user = JSON.parse(body.messages[1]!.content) as {
      units: Array<{ unitId: string }>;
    };
    afterDispatch?.();
    return successfulProviderResponse(user.units.map((unit) => unit.unitId));
  });
}

export function autonomousPersonalCompletionPreparationContract(
  createFixture: AutonomousPersonalCompletionPreparationFixtureFactory,
): void {
  describe('native V4 completion preparation handle', () => {
    let fixture: AutonomousPersonalCompletionPreparationFixture;
    let store: IGraphStorage;
    let seed: AutonomousPersonalCaptureSeed;

    beforeEach(async () => {
      fixture = await createFixture();
      store = fixture.store;
      seed = fixture.seed;
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await fixture?.close();
    });

    const prepared = async (context = mutableContext(seed).context) => {
      installSuccessfulProviderFetch();
      return prepareNativeAutonomousPersonalCompletionV4(context, store);
    };

    it('runs one native A1 begin and provider dispatch, persists only the source, and binds the pinned hashes', async () => {
      const context = mutableContext(seed);
      const fixedNonce = '00000000-0000-4000-8000-000000000091';
      jest.spyOn(uuidFactory, 'generateUuid').mockImplementationOnce(() => fixedNonce);
      const nativeStore = store as IGraphStorage &
        Required<
          Pick<
            IGraphStorage,
            | 'beginAndClaimAutonomousPersonalCaptureV4'
            | 'prepareAutonomousPersonalCaptureProviderV4'
          >
        >;
      const beginSpy = jest.spyOn(nativeStore, 'beginAndClaimAutonomousPersonalCaptureV4');
      const providerSpy = jest.spyOn(nativeStore, 'prepareAutonomousPersonalCaptureProviderV4');
      const fetchSpy = installSuccessfulProviderFetch();

      const result = await prepareNativeAutonomousPersonalCompletionV4(context.context, store);

      expect(result.kind).toBe('completion_prepared');
      expect(result).toMatchObject({ eligibleFirstCommit: false });
      if (result.kind !== 'completion_prepared') throw new Error('Expected completion handle');
      expect(beginSpy).toHaveBeenCalledTimes(1);
      expect(providerSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const graph = await store.exportGraph();
      expect(graph.episodes).toHaveLength(1);
      expect(graph.edges).toHaveLength(0);
      expect(
        graph.automatic_operations_v1?.operations.some(
          (operation) => operation.state === 'committed' || operation.state === 'cancelled',
        ),
      ).toBe(false);

      const access = consumeAutonomousPersonalCompletionHandleV4(store, result.handle);
      const consumed = getAutonomousPersonalCompletionAccessV4(store, access);
      const { scope, stagedFresh, outcome, selection } = consumed.view;
      const expectedAttemptIdHash = hashAutomaticCaptureV2({
        domain: 'engram-autonomous-personal-completion-attempt-v4',
        originalAttemptHash: scope.attemptHash,
        invocationNonce: scope.invocationNonce,
        completionNonce: fixedNonce,
        operationId: scope.operationId,
      });
      const expectedCompletionCallHash = hashAutomaticCaptureV2({
        domain: 'engram-autonomous-personal-completion-call-v4',
        originalAttemptHash: scope.attemptHash,
        invocationNonce: scope.invocationNonce,
        completionNonce: fixedNonce,
        sourceId: scope.sourceId,
        operationId: scope.operationId,
        sourceHash: stagedFresh.fence.sourceHash,
        descriptorHash: stagedFresh.fence.descriptorHash,
        providerFingerprint: scope.descriptor.provider.configurationFingerprint,
        outcome,
        selection,
      });
      expect(consumed.view.audit).toEqual({
        action: 'completion',
        attemptIdHash: expectedAttemptIdHash,
        operationId: scope.operationId,
        sourceId: scope.sourceId,
      });
      expect(consumed.view.completionCallHash).toBe(expectedCompletionCallHash);
      expect(
        hashAutomaticCaptureV2({
          domain: 'engram-autonomous-personal-completion-call-v4',
          originalAttemptHash: scope.attemptHash,
          invocationNonce: scope.invocationNonce,
          completionNonce: '00000000-0000-4000-8000-000000000092',
          sourceId: scope.sourceId,
          operationId: scope.operationId,
          sourceHash: stagedFresh.fence.sourceHash,
          descriptorHash: stagedFresh.fence.descriptorHash,
          providerFingerprint: scope.descriptor.provider.configurationFingerprint,
          outcome,
          selection,
        }),
      ).not.toBe(expectedCompletionCallHash);
      expect(consumed.view).not.toHaveProperty('ctx');
      expect(consumed.view).not.toHaveProperty('credentials');
      expect(JSON.stringify(consumed.view)).not.toContain(TEST_API_KEY);
      expect(JSON.stringify(consumed.view)).not.toContain(TEST_BASE_URL);
      expect(JSON.stringify(consumed.view)).not.toContain('model:synthetic-memory');
      expect(Object.isFrozen(consumed.view)).toBe(true);
      expect(Object.isFrozen(consumed.typedSyntaxWork)).toBe(true);
      closeAutonomousPersonalCompletionV4(store, access);
    });

    it.each([
      ['profile', { automaticMemoryProfile: 'explicit' }],
      ['intent', { automaticIntent: 'enabled' }],
      ['source mapping', { automaticOriginalWorkflow: 'workflow:changed' }],
      ['provider route', { extractionRouteId: 'route:changed' }],
    ] as const)(
      'rejects a current native %s change after provider dispatch',
      async (_name, changes) => {
        const context = mutableContext(seed);
        const result = await (async () => {
          installSuccessfulProviderFetch(() => Object.assign(context.overrides, changes));
          return prepareNativeAutonomousPersonalCompletionV4(context.context, store);
        })();
        expect(result).toEqual({ kind: 'authority_changed', eligibleFirstCommit: false });
      },
    );

    it('rejects a changed native execution identity after provider dispatch', async () => {
      const context = mutableContext(seed);
      installSuccessfulProviderFetch(() => context.setExecutionId('execution:changed'));

      const result = await prepareNativeAutonomousPersonalCompletionV4(context.context, store);

      expect(result).toEqual({ kind: 'authority_changed', eligibleFirstCommit: false });
    });

    it.each([
      ['rotated', { apiKey: 'completion-rotated-key', baseUrl: TEST_BASE_URL }],
      ['removed', { apiKey: '', baseUrl: TEST_BASE_URL }],
    ] as const)('allows a %s key on the same known provider route', async (_name, credentials) => {
      const context = mutableContext(seed);
      installSuccessfulProviderFetch(() => context.setCredentials(credentials));

      const result = await prepareNativeAutonomousPersonalCompletionV4(context.context, store);

      expect(result.kind).toBe('completion_prepared');
      if (result.kind === 'completion_prepared') {
        closeAutonomousPersonalCompletionV4(store, result.handle);
      }
    });

    it('keeps one shared budget, work object, original signal, and one-use owner-bound keys', async () => {
      const context = mutableContext(seed);
      const result = await prepared(context.context);
      if (result.kind !== 'completion_prepared') throw new Error('Expected completion handle');

      expect(() => consumeAutonomousPersonalCompletionHandleV4({}, result.handle)).toThrow(
        'Engram autonomous personal provider: invalid_handle',
      );
      expect(() =>
        consumeAutonomousPersonalCompletionHandleV4(store, { ...result.handle }),
      ).toThrow('Engram autonomous personal provider: invalid_handle');

      const access = consumeAutonomousPersonalCompletionHandleV4(store, result.handle);
      expect(() => consumeAutonomousPersonalCompletionHandleV4(store, result.handle)).toThrow(
        'Engram autonomous personal provider: invalid_handle',
      );
      expect(() => getAutonomousPersonalCompletionAccessV4({}, access)).toThrow(
        'Engram autonomous personal provider: invalid_handle',
      );
      expect(() => getAutonomousPersonalCompletionAccessV4(store, { ...access })).toThrow(
        'Engram autonomous personal provider: invalid_handle',
      );

      const first = getAutonomousPersonalCompletionAccessV4(store, access);
      expect(first.legacyReadBudget).toEqual({ remaining: 512, deferred: 0 });
      first.legacyReadBudget.remaining = 500;
      const second = getAutonomousPersonalCompletionAccessV4(store, access);
      expect(second.typedSyntaxWork).toBe(first.typedSyntaxWork);
      expect(second.legacyReadBudget).toBe(first.legacyReadBudget);
      expect(second.check).toBe(first.check);
      expect(second.legacyReadBudget).toEqual({ remaining: 500, deferred: 0 });
      expect(Object.isFrozen(second.legacyReadBudget)).toBe(false);
      closeAutonomousPersonalCompletionV4(store, access);
      expect(() => getAutonomousPersonalCompletionAccessV4(store, access)).toThrow(
        'Engram autonomous personal provider: invalid_handle',
      );
      closeAutonomousPersonalCompletionV4(store, access);
    });

    it('does not accept a raw A1 stage as a completion handle', async () => {
      installSuccessfulProviderFetch();
      const a1 = await prepareNativeAutonomousPersonalCaptureProviderV4(
        nativeAutonomousPersonalCaptureContext(seed, {
          extraParameters: { automaticTurn: 'turn:raw-stage' },
        }),
        store,
      );
      if (a1.kind !== 'prepared') throw new Error('Expected raw A1 stage');
      expect(() => consumeAutonomousPersonalCompletionHandleV4(store, a1.stage)).toThrow(
        'Engram autonomous personal provider: invalid_handle',
      );
      const stageAccess = consumeAutonomousPersonalCaptureProviderStageV4(store, a1.stage);
      expect(
        getAutonomousPersonalCaptureProviderStageAccessV4(store, stageAccess).view.outcome.kind,
      ).toBe('response');
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, stageAccess);
    });

    it('rejects an escaped-source inventory above the frozen aggregate stage cap', async () => {
      const content = String.fromCharCode(0).repeat(65_536);
      expect(Buffer.byteLength(content, 'utf8')).toBe(65_536);
      expect(Buffer.byteLength(JSON.stringify(content), 'utf8')).toBeGreaterThan(
        AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes / 2,
      );
      const context = nativeAutonomousPersonalCaptureContext(seed, {
        content,
        extraParameters: { automaticIntent: 'disabled' },
      });
      const fetchSpy = installSuccessfulProviderFetch();

      const result = await prepareNativeAutonomousPersonalCompletionV4(context, store);

      expect(result).toEqual({ kind: 'resource_exhausted', eligibleFirstCommit: false });
      expect(fetchSpy).not.toHaveBeenCalled();
      const graph = await store.exportGraph();
      expect(graph.episodes).toHaveLength(1);
    });

    it('extends the same aggregate inventory with completion hashes before exposing a handle', async () => {
      const content = String.fromCharCode(0).repeat(47_975);
      const measurementTurn = 'completion-cap-stage-a';
      const completionTurn = 'completion-cap-stage-b';
      expect(measurementTurn).toHaveLength(completionTurn.length);
      installSuccessfulProviderFetch();
      const staged = await prepareNativeAutonomousPersonalCaptureProviderV4(
        nativeAutonomousPersonalCaptureContext(seed, {
          content,
          extraParameters: { automaticIntent: 'disabled', automaticTurn: measurementTurn },
        }),
        store,
      );
      if (staged.kind !== 'prepared') throw new Error('Expected a stage below the A1 limit');
      const stageAccess = consumeAutonomousPersonalCaptureProviderStageV4(store, staged.stage);
      const stage = getAutonomousPersonalCaptureProviderStageAccessV4(store, stageAccess).view;
      const stageBytes = Buffer.byteLength(
        JSON.stringify({
          scope: stage.scope,
          stagedFresh: stage.stagedFresh,
          refs: stage.refs,
          outcome: stage.outcome,
          selection: stage.selection,
        }),
        'utf8',
      );
      const completionBytes = Buffer.byteLength(
        JSON.stringify({
          scope: stage.scope,
          stagedFresh: stage.stagedFresh,
          refs: stage.refs,
          outcome: stage.outcome,
          selection: stage.selection,
          completionCallHash: 'a'.repeat(64),
          audit: {
            action: 'completion',
            attemptIdHash: 'b'.repeat(64),
            operationId: stage.scope.operationId,
            sourceId: stage.scope.sourceId,
          },
        }),
        'utf8',
      );
      expect(stageBytes).toBeLessThan(AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes);
      expect(completionBytes).toBeGreaterThan(
        AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes,
      );
      closeAutonomousPersonalCaptureProviderStageAccessV4(store, stageAccess);

      const result = await prepareNativeAutonomousPersonalCompletionV4(
        nativeAutonomousPersonalCaptureContext(seed, {
          content,
          extraParameters: { automaticIntent: 'disabled', automaticTurn: completionTurn },
        }),
        store,
      );

      expect(result).toEqual({ kind: 'resource_exhausted', eligibleFirstCommit: false });
    });

    it('keeps the original cancellation sticky and allows cleanup after abort', async () => {
      const controller = new AbortController();
      const context = mutableContext(seed);
      const raw = context.context as unknown as { getExecutionCancelSignal: () => AbortSignal };
      raw.getExecutionCancelSignal = () => controller.signal;
      const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
      const result = await prepared(context.context);
      if (result.kind !== 'completion_prepared') throw new Error('Expected completion handle');
      const access = consumeAutonomousPersonalCompletionHandleV4(store, result.handle);
      const view = getAutonomousPersonalCompletionAccessV4(store, access);
      expect(view.typedSyntaxWork.signal).not.toBeUndefined();

      controller.abort();
      expect(() => view.check()).toThrow('Engram autonomous personal provider: cancelled');
      closeAutonomousPersonalCompletionV4(store, access);
      expect(removeSpy).toHaveBeenCalledTimes(1);
      closeAutonomousPersonalCompletionV4(store, result.handle);
    });

    it('rejects a deadline crossed inside the final native config callback and still cleans the stage', async () => {
      const context = mutableContext(seed);
      const now = performance.now.bind(performance);
      let forcePastCompletionDeadline = false;
      const nowSpy = jest
        .spyOn(performance, 'now')
        .mockImplementation(() => now() + (forcePastCompletionDeadline ? 6_000 : 0));
      const originalExecutionId = context.context.getExecutionId.bind(context.context);
      let executionIdReads = 0;
      const raw = context.context as unknown as { getExecutionId: () => string };
      raw.getExecutionId = () => {
        executionIdReads += 1;
        if (executionIdReads >= 2) forcePastCompletionDeadline = true;
        return originalExecutionId();
      };
      installSuccessfulProviderFetch();

      const result = await prepareNativeAutonomousPersonalCompletionV4(context.context, store);

      expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
      expect(nowSpy).toHaveBeenCalled();
    });

    it('closes an access after its clipped work deadline expires', async () => {
      const controller = new AbortController();
      const context = mutableContext(seed);
      const raw = context.context as unknown as { getExecutionCancelSignal: () => AbortSignal };
      raw.getExecutionCancelSignal = () => controller.signal;
      const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
      const result = await prepared(context.context);
      if (result.kind !== 'completion_prepared') throw new Error('Expected completion handle');
      const access = consumeAutonomousPersonalCompletionHandleV4(store, result.handle);
      const view = getAutonomousPersonalCompletionAccessV4(store, access);
      const now = performance.now.bind(performance);
      jest
        .spyOn(performance, 'now')
        .mockImplementation(() =>
          Math.max(now(), view.typedSyntaxWork.absoluteMonotonicDeadlineMs + 1),
        );

      expect(() => view.check()).toThrow('Engram autonomous personal provider: budget_exhausted');
      closeAutonomousPersonalCompletionV4(store, access);
      expect(view.typedSyntaxWork.signal.aborted).toBe(true);
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });

    it('aborts during the post-provider credential callback and never returns a handle', async () => {
      const controller = new AbortController();
      const context = mutableContext(seed);
      const raw = context.context as unknown as {
        getExecutionCancelSignal: () => AbortSignal;
        getCredentials: () => Promise<{ apiKey: string; baseUrl: string }>;
      };
      raw.getExecutionCancelSignal = () => controller.signal;
      const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
      installSuccessfulProviderFetch(() => {
        raw.getCredentials = async () => {
          controller.abort();
          return { apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL };
        };
      });

      const result = await prepareNativeAutonomousPersonalCompletionV4(context.context, store);

      expect(result).toEqual({ kind: 'cancelled', eligibleFirstCommit: false });
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });
  });
}
