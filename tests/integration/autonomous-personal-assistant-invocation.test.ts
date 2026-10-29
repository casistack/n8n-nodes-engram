import * as fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { ExtractionBudgetError } from '../../src/extraction/ExtractionDiagnostics';
import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from '../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
  publishAutonomousPersonalMemoryHandoffV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  canStageAutonomousPersonalAssistantFinalV4,
  claimAutonomousPersonalAssistantFinalReconciliationV4,
  closeAutonomousPersonalAssistantFinalInvocationV4,
  consumeAutonomousPersonalAssistantFinalInvocationV4,
  issueAutonomousPersonalAssistantFinalInvocationV4,
  markAutonomousPersonalAssistantFinalCandidateReturnedV4,
  readAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4,
} from '../../src/storage/AutonomousPersonalAssistantFinalInvocationV4';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';

const memoryAttemptHash = () => randomBytes(32).toString('hex');

function finalIntent(attemptHash: string) {
  return {
    version: 4 as const,
    purpose: 'assistant_final_save' as const,
    humanObservation: { kind: 'configured_query' as const },
    finalAssistant: {
      content: 'The final assistant response is synthetic test data.',
      sourceMessageId: null,
      conversationId: null,
      senderId: null,
      senderName: null,
      sourceWorkflowId: null,
      originalSourceExecutionId: null,
      sourceType: 'message' as const,
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' as const },
    },
    memoryAttemptHash: attemptHash,
    invocationDeadlineMs: 30_000,
  };
}

type Fixture = {
  readonly directory: string;
  readonly file: string;
  readonly owner: GraphologyStorage;
  readonly producerOwner: GraphologyStorage;
  readonly config: AutonomousPersonalNativeMemoryConfigV4;
  readonly memoryContext: ReturnType<typeof autonomousPersonalMemoryContextV4>;
  readonly lineage: PrivateAutonomousPersonalMemoryLineageV4;
};

let openedStore: GraphologyStorage | undefined;
let openedStoreIsOpen = false;
let openedDirectory: string | undefined;
let fixture: Fixture | undefined;
let issuedTokens: unknown[] = [];
let consumedKeys: PrivateConsumedAutonomousPersonalAssistantFinalInvocationV4[] = [];

async function createFixture(): Promise<Fixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-assistant-final-invocation-'));
  openedDirectory = directory;
  const workflowId = `assistant-workflow-${randomUUID()}`;
  const file = join(directory, `${workflowId}-engram.json`);
  const producerOwner = new GraphologyStorage(file);
  openedStore = producerOwner;
  await producerOwner.initialize();
  openedStoreIsOpen = true;

  const seed = await seedAutonomousPersonalCaptureSubject(producerOwner);
  const native = {
    instance: `assistant-instance-${randomUUID()}`,
    workflow: workflowId,
    execution: `assistant-execution-${randomUUID()}`,
  };
  const turn = `assistant-turn-${randomUUID()}`;
  const content = 'What games are on today?';
  const producerContext = nativeAutonomousPersonalCaptureContext(seed, {
    content,
    executionId: native.execution,
    workflowId: native.workflow,
    instanceId: native.instance,
    routeId: 'route:assistant-final-invocation',
    model: 'model:assistant-final-invocation',
    requestLimit: 2,
    deadlineMs: 30_000,
    extraParameters: {
      automaticMemoryProfile: 'explicit',
      automaticIntent: 'disabled',
      automaticTurn: turn,
      automaticInput: content,
      automaticWrapper: 'disabled',
      queueTemperatureMode: 'providerDefault',
    },
  });
  const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('The no-claim C2 fixture must not call a provider');
  });
  let completed: Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>;
  try {
    completed = await completeNativeAutonomousPersonalCaptureV4(producerContext, producerOwner);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    provider.mockRestore();
  }
  if (completed.kind !== 'original_turn')
    throw new Error(`Expected a genuine C2 original turn, got ${completed.kind}`);

  const publication = publishAutonomousPersonalMemoryHandoffV4(
    producerContext,
    producerOwner,
    completed.origin,
  );
  if (publication.kind !== 'published')
    throw new Error(`Expected genuine C2 handoff publication, got ${publication.kind}`);

  await producerOwner.close();
  openedStoreIsOpen = false;
  const owner = new GraphologyStorage(file);
  openedStore = owner;
  await owner.initialize();
  openedStoreIsOpen = true;

  const storeHash = autonomousPersonalMemoryStoreHashV4(file);
  const memoryContext = autonomousPersonalMemoryContextV4({
    persistPath: file,
    storageWorkflowId: native.workflow,
    native,
    namespace: seed.request.namespace,
    issuer: seed.request.issuer,
    actorReference: seed.request.actorReference,
    turn,
    sourceId: publication.sourceId,
    profileId: 'explicit',
    explicitIntent: false,
    currentHumanQuery: content,
    sourceMapping: { mode: 'full_body' },
  });
  const config = await readAutonomousPersonalNativeMemoryConfigV4(memoryContext, 0, storeHash);
  const lineage = consumeAutonomousPersonalMemoryHandoffV4(
    memoryContext,
    config.storeHash,
    config.namespace,
    config.issuer,
    config.actorReference,
    config.turn,
    config.sourceId,
  );
  if (!lineage) throw new Error('Expected the actual C2 lineage after Memory-owner reopen');
  return { directory, file, owner, producerOwner, config, memoryContext, lineage };
}

async function lateSnapshot(
  f: Fixture,
  attemptHash: string,
  config?: AutonomousPersonalNativeMemoryConfigV4,
) {
  const nativeConfig = await readAutonomousPersonalNativeMemoryConfigV4(
    f.memoryContext,
    0,
    f.config.storeHash,
  );
  return { config: config ?? nativeConfig, memoryAttemptHash: attemptHash };
}

function work(
  signal: AbortSignal = new AbortController().signal,
  absoluteMonotonicDeadlineMs = performance.now() + 30_000,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return { signal, absoluteMonotonicDeadlineMs };
}

async function issue(
  f: Fixture,
  options: {
    readonly lineage?: unknown;
    readonly owner?: object;
    readonly intent?: unknown;
    readonly reread?: () => Promise<unknown>;
    readonly workValue?: AutonomousPersonalTypedSyntaxWorkV1;
    readonly check?: () => void;
  } = {},
): Promise<PrivateAutonomousPersonalAssistantFinalInvocationV4 | null> {
  const attemptHash = memoryAttemptHash();
  const token = await issueAutonomousPersonalAssistantFinalInvocationV4(
    options.owner ?? f.owner,
    options.lineage ?? f.lineage,
    options.intent ?? finalIntent(attemptHash),
    options.reread ?? (async () => lateSnapshot(f, attemptHash)),
    options.workValue ?? work(),
    options.check ?? (() => {}),
  );
  if (token) issuedTokens.push(token);
  return token;
}

describe('native assistant-final invocation V4 foundation', () => {
  beforeEach(async () => {
    issuedTokens = [];
    consumedKeys = [];
    fixture = await createFixture();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const f = fixture;
    if (f) {
      for (const token of issuedTokens)
        closeAutonomousPersonalAssistantFinalInvocationV4(f.owner, token);
      for (const key of consumedKeys)
        closeAutonomousPersonalAssistantFinalInvocationV4(f.owner, key);
    }
    try {
      if (openedStoreIsOpen) await openedStore?.close();
    } finally {
      if (openedDirectory) fs.rmSync(openedDirectory, { recursive: true, force: true });
      fixture = undefined;
      openedStore = undefined;
      openedStoreIsOpen = false;
      openedDirectory = undefined;
    }
  });

  it('requires genuine C2 lineage before the late read and consumes once for the reopened Memory owner', async () => {
    const f = fixture!;
    const attemptHash = memoryAttemptHash();
    const lateRead = jest.fn(async () => lateSnapshot(f, attemptHash));
    const invalid = await issueAutonomousPersonalAssistantFinalInvocationV4(
      f.owner,
      {} as PrivateAutonomousPersonalMemoryLineageV4,
      finalIntent(attemptHash),
      lateRead,
      work(),
      () => {},
    );
    const copied = { ...(f.lineage as object) } as PrivateAutonomousPersonalMemoryLineageV4;
    const copiedResult = await issueAutonomousPersonalAssistantFinalInvocationV4(
      f.owner,
      copied,
      finalIntent(attemptHash),
      lateRead,
      work(),
      () => {},
    );
    expect(invalid).toBeNull();
    expect(copiedResult).toBeNull();
    expect(lateRead).not.toHaveBeenCalled();

    const token = await issue(f, { reread: lateRead, intent: finalIntent(attemptHash) });
    expect(token).not.toBeNull();
    expect(lateRead).toHaveBeenCalledTimes(1);
    expect(f.producerOwner).not.toBe(f.owner);
    expect(consumeAutonomousPersonalAssistantFinalInvocationV4(f.producerOwner, token)).toBeNull();
    const key = consumeAutonomousPersonalAssistantFinalInvocationV4(f.owner, token);
    expect(key).not.toBeNull();
    if (!key) throw new Error('Expected owner-bound consumed invocation key');
    consumedKeys.push(key);
    expect(consumeAutonomousPersonalAssistantFinalInvocationV4(f.owner, token)).toBeNull();

    const first = readAutonomousPersonalAssistantFinalInvocationV4(f.owner, key);
    const second = readAutonomousPersonalAssistantFinalInvocationV4(f.owner, key);
    expect(first.data).toBe(second.data);
    expect(first.work).toBe(second.work);
    expect(first.check).toBe(second.check);
    expect(second.data.sourceId).toBe(first.data.sourceId);
    expect(second.data.operationId).toBe(first.data.operationId);
    expect(second.data.beginCallHash).toBe(first.data.beginCallHash);
    expect(second.data.completionCallHash).toBe(first.data.completionCallHash);
    // The private token retains invocation DATA only; it is not an assistant write receipt.
    expect(first.data).not.toHaveProperty('proof');
    expect(first.data).not.toHaveProperty('terminalReceipt');
    expect(Object.isFrozen(first.data)).toBe(true);
    expect(Object.isFrozen(first.data.origin)).toBe(true);
    expect(Object.isFrozen(first.data.nativeSnapshot)).toBe(true);
    expect(Object.isFrozen(first.data.intent)).toBe(true);
    expect(first.data.nativeSnapshot.config).toEqual(f.config);
    expect(first.data.nativeSnapshot.memoryAttemptHash).toBe(attemptHash);
    expect(first.data.intent.memoryAttemptHash).toBe(attemptHash);
    expect(first.data.sourceId).not.toBe(first.data.origin.identity.sourceId);
    expect(first.data.operationId).not.toBe(first.data.origin.terminalReceipt.operationId);
    expect(first.data.beginCallHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.data.completionCallHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse(first.data.origin).success,
    ).toBe(true);
  }, 30_000);

  it.each([
    [
      'late config tuple mismatch',
      (config: AutonomousPersonalNativeMemoryConfigV4) => ({
        ...config,
        turn: `${config.turn}:changed`,
      }),
      false,
    ],
    [
      'late config extra field',
      (config: AutonomousPersonalNativeMemoryConfigV4) => ({ ...config, unexpected: true }),
      false,
    ],
    [
      'late attempt hash mismatch',
      (config: AutonomousPersonalNativeMemoryConfigV4) => config,
      true,
    ],
  ])(
    'rejects %s after the one late native reread',
    async (_label, mutateConfig, mismatchAttempt) => {
      const f = fixture!;
      const attemptHash = memoryAttemptHash();
      const reread = jest.fn(async () => {
        const native = await lateSnapshot(f, attemptHash);
        return {
          ...native,
          config: mutateConfig(native.config),
          memoryAttemptHash: mismatchAttempt ? randomBytes(32).toString('hex') : attemptHash,
        };
      });
      await expect(
        issue(f, {
          intent: finalIntent(attemptHash),
          reread,
        }),
      ).rejects.toThrow();
      expect(reread).toHaveBeenCalledTimes(1);
      expect(issuedTokens).toHaveLength(0);
    },
    30_000,
  );

  it('captures the original work deadline and native signal before the asynchronous reread', async () => {
    const f = fixture!;
    const base = performance.now();
    let now = base;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const controller = new AbortController();
    const replacement = new AbortController();
    const attemptHash = memoryAttemptHash();
    const callerWork = {
      signal: controller.signal,
      absoluteMonotonicDeadlineMs: base + 10_000,
    };
    const order: string[] = [];
    const token = await issue(f, {
      workValue: callerWork,
      intent: finalIntent(attemptHash),
      check: () => order.push('check'),
      reread: async () => {
        order.push('reread');
        return lateSnapshot(f, attemptHash);
      },
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error('Expected invocation token');
    const key = consumeAutonomousPersonalAssistantFinalInvocationV4(f.owner, token);
    expect(key).not.toBeNull();
    if (!key) throw new Error('Expected consumed invocation key');
    consumedKeys.push(key);
    expect(order.slice(0, 2)).toEqual(['check', 'reread']);
    const captured = readAutonomousPersonalAssistantFinalInvocationV4(f.owner, key);
    expect(captured.work.absoluteMonotonicDeadlineMs).toBe(base + 10_000);
    expect(captured.work.signal).toBe(controller.signal);
    expect(Object.isFrozen(captured.work)).toBe(true);

    callerWork.absoluteMonotonicDeadlineMs = base + 60_000;
    callerWork.signal = replacement.signal;
    expect(readAutonomousPersonalAssistantFinalInvocationV4(f.owner, key).work).toBe(captured.work);
    expect(captured.work.signal).toBe(controller.signal);
    expect(captured.work.absoluteMonotonicDeadlineMs).toBe(base + 10_000);

    now = base + 10_001;
    expect(() => readAutonomousPersonalAssistantFinalInvocationV4(f.owner, key)).toThrow(
      ExtractionBudgetError,
    );
    closeAutonomousPersonalAssistantFinalInvocationV4(f.owner, key);
    expect(() => readAutonomousPersonalAssistantFinalInvocationV4(f.owner, key)).toThrow(
      'invalid_assistant_final_invocation',
    );

    const abortController = new AbortController();
    const abortToken = await issue(f, {
      workValue: work(abortController.signal, now + 10_000),
    });
    expect(abortToken).not.toBeNull();
    if (!abortToken) throw new Error('Expected abort-scoped invocation token');
    const abortKey = consumeAutonomousPersonalAssistantFinalInvocationV4(f.owner, abortToken);
    expect(abortKey).not.toBeNull();
    if (!abortKey) throw new Error('Expected abort-scoped consumed key');
    consumedKeys.push(abortKey);
    const abortWork = readAutonomousPersonalAssistantFinalInvocationV4(f.owner, abortKey).work;
    expect(abortWork.signal).toBe(abortController.signal);

    abortController.abort();
    expect(() => readAutonomousPersonalAssistantFinalInvocationV4(f.owner, abortKey)).toThrow(
      ExtractionBudgetError,
    );
    closeAutonomousPersonalAssistantFinalInvocationV4(f.owner, abortKey);
    expect(() => readAutonomousPersonalAssistantFinalInvocationV4(f.owner, abortKey)).toThrow(
      'invalid_assistant_final_invocation',
    );
  }, 30_000);

  it.each([new Error('trusted synthetic failure'), undefined])(
    'runs trusted work before the late callback and retains its exact failure identity (%s)',
    async (failure) => {
      const f = fixture!;
      const attemptHash = memoryAttemptHash();
      const order: string[] = [];
      const check = () => {
        order.push('check');
        if (order.includes('late-failure')) throw failure;
      };
      const reread = async () => {
        order.push('late-failure');
        return lateSnapshot(f, attemptHash);
      };
      let rejected = false;
      let caught: unknown;
      try {
        await issue(f, { check, reread, intent: finalIntent(attemptHash) });
      } catch (error) {
        rejected = true;
        caught = error;
      }
      expect(rejected).toBe(true);
      expect(caught).toBe(failure);
      expect(order.slice(0, 2)).toEqual(['check', 'late-failure']);
      expect(order).toContain('check');
      expect(issuedTokens).toHaveLength(0);
    },
    30_000,
  );

  it('does not invoke hostile work getters and latches one candidate and one reconciliation', async () => {
    const f = fixture!;
    const attemptHash = memoryAttemptHash();
    let getterCalls = 0;
    const hostileWork = Object.defineProperties(
      {},
      {
        absoluteMonotonicDeadlineMs: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            throw new Error('hostile work getter must not run');
          },
        },
        signal: { enumerable: true, value: new AbortController().signal },
      },
    );
    const lateRead = jest.fn(async () => lateSnapshot(f, attemptHash));
    await expect(
      issue(f, {
        workValue: hostileWork as never,
        intent: finalIntent(attemptHash),
        reread: lateRead,
      }),
    ).rejects.toThrow('invalid_assistant_final_invocation');
    expect(getterCalls).toBe(0);
    expect(lateRead).not.toHaveBeenCalled();
    expect(issuedTokens).toHaveLength(0);

    const token = await issue(f, {
      intent: finalIntent(attemptHash),
      reread: async () => lateSnapshot(f, attemptHash),
    });
    expect(token).not.toBeNull();
    if (!token) throw new Error('Expected invocation token');
    const key = consumeAutonomousPersonalAssistantFinalInvocationV4(f.owner, token);
    expect(key).not.toBeNull();
    if (!key) throw new Error('Expected consumed invocation key');
    consumedKeys.push(key);

    expect(canStageAutonomousPersonalAssistantFinalV4(f.owner, key)).toBe(true);
    markAutonomousPersonalAssistantFinalCandidateReturnedV4(f.owner, key);
    expect(canStageAutonomousPersonalAssistantFinalV4(f.owner, key)).toBe(false);
    expect(() => markAutonomousPersonalAssistantFinalCandidateReturnedV4(f.owner, key)).toThrow(
      'invalid_assistant_final_invocation',
    );
    expect(claimAutonomousPersonalAssistantFinalReconciliationV4(f.owner, key)).toBe(true);
    expect(claimAutonomousPersonalAssistantFinalReconciliationV4(f.owner, key)).toBe(false);
  }, 30_000);
});
