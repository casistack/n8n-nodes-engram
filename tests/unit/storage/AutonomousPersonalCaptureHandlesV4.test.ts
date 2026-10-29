import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { IExecuteFunctions } from 'n8n-workflow';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import {
  bindAutonomousPersonalCapturePreflightV4,
  checkAutonomousPersonalCompletionV4,
  closeAutonomousPersonalCompletionV4,
  consumeAutonomousPersonalCaptureAttemptV4,
  consumeAutonomousPersonalCompletionHandleV4,
  dispatchNativeAutonomousPersonalCaptureV4,
  getAutonomousPersonalCaptureFailureKindV4,
  getAutonomousPersonalCaptureProviderFailureKindV4,
  getAutonomousPersonalCaptureBeginV4InternalResultSchema,
  isAutonomousPersonalCompletionHandleOpenV4,
  prepareNativeAutonomousPersonalCompletionV4,
  recheckAutonomousPersonalNativeContextV4,
  type PrivateAutonomousPersonalCaptureAttemptV4,
} from '../../../src/storage/AutonomousPersonalCaptureHandlesV4';
import type { IGraphStorage } from '../../../src/storage/IGraphStorage';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../../helpers/autonomousPersonalCaptureBackend';

const identifiers = {
  binding: '10000000-0000-4000-8000-000000000001',
  subject: '10000000-0000-4000-8000-000000000002',
};

function makeContext(options: { execution?: string; extra?: Record<string, unknown> } = {}) {
  const parameters: Record<string, unknown> = {
    automaticCaptureLifecycle: 'replaySafeV2',
    automaticPreferenceInterpreter: 'autonomousPersonalV1',
    automaticExecution: 'synchronous',
    automaticProfile: 'conservative',
    automaticMemoryProfile: 'conservative',
    automaticNamespace: 'workflow:family',
    automaticIssuer: 'application:chat',
    automaticActor: 'user:42',
    automaticTurn: 'turn:17',
    automaticInput: 'I prefer concise explanations.',
    automaticRawHuman: '',
    automaticWrapper: 'disabled',
    automaticIntent: 'disabled',
    automaticOriginalExecution: '',
    automaticOriginalWorkflow: 'workflow:producer',
    automaticCapturedSource: '',
    extractionRouteId: 'route:primary',
    queueModel: 'model:memory',
    queueTemperatureMode: 'providerDefault',
    extractionRequestLimit: 2,
    extractionDeadlineMs: 45_000,
    ...options.extra,
  };

  return {
    getNode: jest.fn(() => ({
      id: 'admin-node',
      type: 'n8n-nodes-engram.engramAdmin',
      typeVersion: 3,
      parameters: {
        resource: 'automaticMemory',
        operation: 'captureHuman',
        automaticCaptureLifecycle: 'replaySafeV2',
        automaticPreferenceInterpreter: 'autonomousPersonalV1',
      },
    })),
    getNodeParameter: jest.fn((name: string, _index: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    ),
    getInputData: jest.fn(() => [{ json: {} }]),
    getExecutionId: jest.fn(() => options.execution ?? 'execution:A'),
    getWorkflow: jest.fn(() => ({ id: 'workflow:current' })),
    getInstanceId: jest.fn(() => 'instance:local'),
    getCredentials: jest.fn(async () => ({
      apiKey: 'synthetic-secret',
      baseUrl: 'https://memory.invalid/v1',
    })),
  } as unknown as IExecuteFunctions & {
    getNode: jest.Mock;
    getNodeParameter: jest.Mock;
    getCredentials: jest.Mock;
  };
}

function actualPreflight() {
  return {
    storeHash: 'a'.repeat(64),
    binding: {
      bindingId: identifiers.binding,
      revision: 2,
      subjectId: identifiers.subject,
      fingerprint: 'b'.repeat(64),
    },
  };
}

function makeStorage(onBegin: (input: unknown, attempt: unknown, owner: object) => unknown) {
  const owner = {
    beginAndClaimAutonomousPersonalCaptureV4(input: unknown, attempt: unknown) {
      return Promise.resolve(onBegin(input, attempt, this));
    },
  };
  return owner as unknown as IGraphStorage;
}

async function nativeCompletionFixture(options: { signal?: AbortSignal; turn?: string } = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-completion-handle-helper-'));
  const store = new GraphologyStorage(join(directory, 'store.json'));
  let handle: unknown;
  try {
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    const context = nativeAutonomousPersonalCaptureContext(seed, {
      deadlineMs: 30_000,
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: 'disabled',
        automaticTurn: options.turn ?? 'completion-handle-helper',
      },
    });
    if (options.signal) {
      (
        context as unknown as { getExecutionCancelSignal: () => AbortSignal }
      ).getExecutionCancelSignal = () => options.signal!;
    }
    const prepared = await prepareNativeAutonomousPersonalCompletionV4(context, store);
    if (prepared.kind !== 'completion_prepared') {
      throw new Error(`Expected native completion handle, received ${prepared.kind}`);
    }
    handle = prepared.handle;
    return {
      store,
      context,
      handle,
      close: async () => {
        closeAutonomousPersonalCompletionV4(store, handle);
        await store.close();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (handle) closeAutonomousPersonalCompletionV4(store, handle);
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function overrideParameter(context: IExecuteFunctions, name: string, value: unknown): void {
  const mutable = context as unknown as {
    getNodeParameter: (key: string, index: number, fallback: unknown) => unknown;
  };
  const original = mutable.getNodeParameter.bind(context);
  mutable.getNodeParameter = (key, index, fallback) =>
    key === name ? value : original(key, index, fallback);
}

describe('fixed native autonomous capture V4 attempt registry', () => {
  test('mints one private attempt from fixed native config and binds actual store data once', async () => {
    let boundScope: ReturnType<typeof bindAutonomousPersonalCapturePreflightV4> | undefined;
    const storage = makeStorage((input, attempt, owner) => {
      const consumed = consumeAutonomousPersonalCaptureAttemptV4(owner, input, attempt);
      expect(consumed.kind).toBe('ready');
      if (consumed.kind !== 'ready') return consumed.result;
      expect(consumed.scope.sourceId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(consumed.scope.operationId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(consumed.scope.leaseToken).toMatch(/^[0-9a-f-]{36}$/u);
      expect(consumed.scope.nativeContext).toEqual({
        instance: 'instance:local',
        workflow: 'workflow:current',
        execution: 'execution:A',
      });
      consumed.check();
      boundScope = bindAutonomousPersonalCapturePreflightV4(owner, attempt, actualPreflight());
      expect(boundScope.request.source.content).toBe('I prefer concise explanations.');
      expect(boundScope.context.binding).toEqual(actualPreflight().binding);
      expect(boundScope.descriptor.provider).not.toHaveProperty('apiKey');
      expect(boundScope.deadlineAtMonotonicMs).toBeGreaterThan(boundScope.startedAtMonotonicMs);
      boundScope.check();
      return { kind: 'in_progress', eligibleFirstCommit: false };
    });

    const ctx = makeContext();
    const result = await dispatchNativeAutonomousPersonalCaptureV4(ctx, storage);

    expect(getAutonomousPersonalCaptureBeginV4InternalResultSchema().parse(result)).toEqual({
      kind: 'in_progress',
      eligibleFirstCommit: false,
    });
    expect(boundScope).toBeDefined();
    expect(ctx.getCredentials).toHaveBeenCalledWith('engramExtractionApi');
    expect(JSON.stringify(boundScope)).not.toContain('synthetic-secret');
  });

  test('rejects an unsupported interpreter before backend dispatch', async () => {
    const begin = jest.fn(async () => ({ kind: 'in_progress', eligibleFirstCommit: false }));
    const storage = { beginAndClaimAutonomousPersonalCaptureV4: begin } as unknown as IGraphStorage;
    const ctx = makeContext({ extra: { automaticPreferenceInterpreter: 'compositionalV2' } });
    const node = ctx.getNode();
    node.parameters.automaticPreferenceInterpreter = 'compositionalV2';
    ctx.getNode.mockReturnValue(node);

    await expect(dispatchNativeAutonomousPersonalCaptureV4(ctx, storage)).resolves.toEqual({
      kind: 'unsupported_mode',
      eligibleFirstCommit: false,
    });
    expect(begin).not.toHaveBeenCalled();
    expect(ctx.getCredentials).not.toHaveBeenCalled();
  });

  test('stable request identity ignores the processing execution while attempt hashes change', async () => {
    const scopes: Array<{
      sourceId: string;
      attemptHash: string;
      stableBeginHash: string;
      execution: string;
    }> = [];
    const storage = makeStorage((input, attempt, owner) => {
      const consumed = consumeAutonomousPersonalCaptureAttemptV4(owner, input, attempt);
      if (consumed.kind !== 'ready') return consumed.result;
      const bound = bindAutonomousPersonalCapturePreflightV4(owner, attempt, actualPreflight());
      scopes.push({
        sourceId: bound.sourceId,
        attemptHash: bound.attemptHash,
        stableBeginHash: bound.stableBeginHash,
        execution: bound.context.execution,
      });
      return { kind: 'in_progress', eligibleFirstCommit: false };
    });

    await dispatchNativeAutonomousPersonalCaptureV4(
      makeContext({ execution: 'execution:A' }),
      storage,
    );
    await dispatchNativeAutonomousPersonalCaptureV4(
      makeContext({ execution: 'execution:B' }),
      storage,
    );

    expect(scopes).toHaveLength(2);
    expect(scopes[0].execution).toBe('execution:A');
    expect(scopes[1].execution).toBe('execution:B');
    expect(scopes[0].stableBeginHash).toBe(scopes[1].stableBeginHash);
    expect(scopes[0].attemptHash).not.toBe(scopes[1].attemptHash);
    expect(scopes[0].sourceId).not.toBe(scopes[1].sourceId);
  });

  test('owns request before opaque-key lookup and classifies only exact registry errors', () => {
    let proxyTraps = 0;
    const hostileAttempt = new Proxy(
      {},
      {
        get() {
          proxyTraps += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTraps += 1;
          return Object.prototype;
        },
        ownKeys() {
          proxyTraps += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          return undefined;
        },
      },
    );
    const owner = {};
    const invalidHandle = consumeAutonomousPersonalCaptureAttemptV4(
      owner,
      { mode: 'existingStore', request: null },
      hostileAttempt,
    );
    expect(invalidHandle.kind).toBe('decision');
    if (invalidHandle.kind === 'decision') expect(invalidHandle.result.kind).toBe('invalid_input');
    expect(proxyTraps).toBe(0);

    const invalidKey = Object.freeze({}) as PrivateAutonomousPersonalCaptureAttemptV4;
    const validRequest = {
      mode: 'existingStore',
      request: {
        version: 4,
        lifecycle: 'replaySafeV2',
        purpose: 'human_turn_memory',
        interpretationFamily: 'autonomous-personal-v1',
        namespace: 'workflow:family',
        issuer: 'application:chat',
        actorReference: 'user:42',
        turn: 'turn:17',
        settings: {
          profileId: 'conservative',
          requestedTrustLevel: 'standard',
          intentSetting: false,
          invocationDeadlineMs: 45_000,
          providerReference: {
            routeId: 'route:primary',
            configurationFingerprint: 'c'.repeat(64),
            protocol: 'openai-compatible-json-v1',
            configuredRequestLimit: 2,
            configuredTimeoutMs: 30_000,
            configuredRequestBytes: 262_144,
            configuredResponseBytes: 65_536,
            temperature: { mode: 'providerDefault' },
            responseFormat: 'json_object',
            outputTokenLimit: { mode: 'omit' },
          },
        },
        source: {
          content: 'I prefer concise explanations.',
          sourceMessageId: null,
          conversationId: null,
          senderId: null,
          sourceWorkflowId: 'workflow:producer',
          quotedMessageId: null,
          sourceType: 'message',
          eventTime: { mode: 'first_capture' },
          mapping: { mode: 'full_body' },
          quoteRegions: [],
        },
      },
    };
    const conflict = consumeAutonomousPersonalCaptureAttemptV4(owner, validRequest, invalidKey);
    expect(conflict.kind).toBe('decision');
    if (conflict.kind === 'decision') {
      expect(conflict.result.kind).toBe('invalid_handle');
    }
    expect(getAutonomousPersonalCaptureFailureKindV4(new Error('invalid_handle'))).toBeNull();

    let caught: unknown;
    try {
      bindAutonomousPersonalCapturePreflightV4(owner, invalidKey, actualPreflight());
    } catch (error) {
      caught = error;
    }
    expect(getAutonomousPersonalCaptureFailureKindV4(caught)).toBe('conflict');
  });
});

describe('owner-bound completion checks and native-context recheck V4', () => {
  let fixture: Awaited<ReturnType<typeof nativeCompletionFixture>>;

  beforeEach(async () => {
    fixture = await nativeCompletionFixture();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fixture?.close();
  });

  test('checks issued and consumed records without consuming or exposing their private data', async () => {
    expect(checkAutonomousPersonalCompletionV4(fixture.store, fixture.handle)).toBeUndefined();
    const issued = await recheckAutonomousPersonalNativeContextV4(
      fixture.context,
      fixture.store,
      fixture.handle,
    );
    expect(issued).toEqual({ kind: 'match' });
    expect(issued).not.toHaveProperty('scope');

    const access = consumeAutonomousPersonalCompletionHandleV4(fixture.store, fixture.handle);
    expect(checkAutonomousPersonalCompletionV4(fixture.store, fixture.handle)).toBeUndefined();
    expect(isAutonomousPersonalCompletionHandleOpenV4(fixture.store, fixture.handle)).toBe(true);
    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({ kind: 'match' });
    closeAutonomousPersonalCompletionV4(fixture.store, access);
  });

  test('rejects foreign, copied, and closed completion keys', async () => {
    const foreignOwner = {};
    const copiedHandle = { ...(fixture.handle as object) };
    expect(() => checkAutonomousPersonalCompletionV4(foreignOwner, fixture.handle)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(() => checkAutonomousPersonalCompletionV4(fixture.store, copiedHandle)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(
      await recheckAutonomousPersonalNativeContextV4(fixture.context, foreignOwner, fixture.handle),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'invalid_handle', eligibleFirstCommit: false },
    });
    expect(
      await recheckAutonomousPersonalNativeContextV4(fixture.context, fixture.store, copiedHandle),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'invalid_handle', eligibleFirstCommit: false },
    });

    closeAutonomousPersonalCompletionV4(fixture.store, fixture.handle);
    expect(() => checkAutonomousPersonalCompletionV4(fixture.store, fixture.handle)).toThrow(
      'Engram autonomous personal provider: invalid_handle',
    );
    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'invalid_handle', eligibleFirstCommit: false },
    });
  });

  test('uses the existing full request/context comparator and allows same-route key removal', async () => {
    const mutable = fixture.context as unknown as {
      getCredentials: (name: string) => Promise<{ apiKey: string; baseUrl: string }>;
    };
    mutable.getCredentials = async () => ({ apiKey: '', baseUrl: 'https://memory.invalid/v1' });

    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({ kind: 'match' });

    const execution = fixture.context as unknown as { getExecutionId: () => string };
    execution.getExecutionId = () => 'execution:changed';
    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'authority_changed', eligibleFirstCommit: false },
    });
  });

  test('maps malformed and unsupported current native configuration to existing decisions', async () => {
    overrideParameter(fixture.context, 'automaticMemoryProfile', 'invalid-profile');
    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'invalid_input', eligibleFirstCommit: false },
    });

    const mutable = fixture.context as unknown as {
      getNode: () => ReturnType<IExecuteFunctions['getNode']>;
    };
    const originalGetNode = mutable.getNode.bind(fixture.context);
    mutable.getNode = () => {
      const node = originalGetNode();
      return {
        ...node,
        parameters: { ...node.parameters, operation: 'query' },
      };
    };
    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'unsupported_mode', eligibleFirstCommit: false },
    });
  });

  test('preserves cancellation and expiry through the original sticky work check', async () => {
    const controller = new AbortController();
    const cancelledFixture = await nativeCompletionFixture({ signal: controller.signal });
    try {
      controller.abort();
      let thrown: unknown;
      try {
        checkAutonomousPersonalCompletionV4(cancelledFixture.store, cancelledFixture.handle);
      } catch (error) {
        thrown = error;
      }
      expect(getAutonomousPersonalCaptureProviderFailureKindV4(thrown)).toBe('cancelled');
      expect(
        await recheckAutonomousPersonalNativeContextV4(
          cancelledFixture.context,
          cancelledFixture.store,
          cancelledFixture.handle,
        ),
      ).toEqual({
        kind: 'decision',
        result: { kind: 'cancelled', eligibleFirstCommit: false },
      });
    } finally {
      await cancelledFixture.close();
    }

    const actualNow = performance.now.bind(performance);
    jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + 6_000);
    let expired: unknown;
    try {
      checkAutonomousPersonalCompletionV4(fixture.store, fixture.handle);
    } catch (error) {
      expired = error;
    }
    expect(getAutonomousPersonalCaptureProviderFailureKindV4(expired)).toBe('budget_exhausted');
    expect(
      await recheckAutonomousPersonalNativeContextV4(
        fixture.context,
        fixture.store,
        fixture.handle,
      ),
    ).toEqual({
      kind: 'decision',
      result: { kind: 'budget_exhausted', eligibleFirstCommit: false },
    });
    jest.restoreAllMocks();
  });
});
