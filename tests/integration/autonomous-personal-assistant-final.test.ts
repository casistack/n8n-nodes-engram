/// <reference lib="es2021.promise" />

import * as fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { GraphDataSchema, type GraphData } from '../../src/schemas/GraphData.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../src/schemas/AutomaticCaptureReceipt.schema';
import { WRITE_OWNER_V2_ATTRIBUTE } from '../../src/storage/AutomaticIdentity';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import {
  issueAutonomousPersonalAssistantFinalInvocationV4,
  type PrivateAutonomousPersonalAssistantFinalInvocationV4,
} from '../../src/storage/AutonomousPersonalAssistantFinalInvocationV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  publishAutonomousPersonalMemoryHandoffV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
} from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
} from '../helpers/autonomousPersonalMemoryBackend';

const query = 'What games are on today?';
const finalContent = 'The final assistant response is synthetic test data.';

type Fixture = {
  readonly directory: string;
  readonly file: string;
  readonly owner: GraphologyStorage;
  readonly seed: Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;
  readonly native: {
    readonly instance: string;
    readonly workflow: string;
    readonly execution: string;
  };
  readonly config: AutonomousPersonalNativeMemoryConfigV4;
  readonly sourceContent: string;
  readonly lineage: PrivateAutonomousPersonalMemoryLineageV4;
  readonly memoryContext: ReturnType<typeof autonomousPersonalMemoryContextV4>;
};

type GraphologyStorageInternals = {
  writeTextAtomic: (
    payload: string,
    targetPath: string,
    durable?: boolean,
    onReplaced?: () => void,
    onReplacementAttempted?: () => void,
  ) => Promise<void>;
  acquirePersistLock: (check?: () => void) => Promise<() => Promise<void>>;
  recoveryRequired: boolean;
};

const internals = (store: GraphologyStorage): GraphologyStorageInternals =>
  store as unknown as GraphologyStorageInternals;

const openStores = new Set<GraphologyStorage>();
const openedDirectories = new Set<string>();
const issuedTokens: Array<{ owner: GraphologyStorage; token: unknown }> = [];

function finalIntent(
  memoryAttemptHash: string,
  options: {
    readonly observation?:
      | { readonly kind: 'configured_query' }
      | { readonly kind: 'message'; readonly content: string };
    readonly content?: string;
    readonly invocationDeadlineMs?: number;
  } = {},
) {
  return {
    version: 4 as const,
    purpose: 'assistant_final_save' as const,
    humanObservation: options.observation ?? { kind: 'configured_query' as const },
    finalAssistant: {
      content: options.content ?? finalContent,
      sourceMessageId: 'assistant-final-message',
      conversationId: null,
      senderId: null,
      senderName: null,
      sourceWorkflowId: null,
      originalSourceExecutionId: null,
      sourceType: 'message' as const,
      quotedMessageId: null,
      eventTime: { mode: 'first_capture' as const },
    },
    memoryAttemptHash,
    invocationDeadlineMs: options.invocationDeadlineMs ?? 30_000,
  };
}

function work(
  signal: AbortSignal = new AbortController().signal,
  absoluteMonotonicDeadlineMs = performance.now() + 30_000,
): AutonomousPersonalTypedSyntaxWorkV1 {
  return Object.freeze({ signal, absoluteMonotonicDeadlineMs });
}

async function createFixture(options: { readonly wrapper?: boolean } = {}): Promise<Fixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-assistant-final-v4-'));
  openedDirectories.add(directory);
  const workflow = `assistant-final-workflow-${randomUUID()}`;
  const file = join(directory, `${workflow}-engram.json`);
  const producer = new GraphologyStorage(file);
  openStores.add(producer);
  await producer.initialize();

  const seed = await seedAutonomousPersonalCaptureSubject(producer);
  const native = {
    instance: `assistant-final-instance-${randomUUID()}`,
    workflow,
    execution: `assistant-final-execution-${randomUUID()}`,
  };
  const turn = `assistant-final-turn-${randomUUID()}`;
  const prefix = options.wrapper ? 'Speaker 🧭: ' : '';
  const sourceContent = `${prefix}${query}`;
  const region = { start: prefix.length, end: prefix.length + query.length };
  const producerContext = nativeAutonomousPersonalCaptureContext(seed, {
    content: sourceContent,
    executionId: native.execution,
    workflowId: native.workflow,
    instanceId: native.instance,
    routeId: 'route:assistant-final-v4',
    model: 'model:assistant-final-v4',
    requestLimit: 2,
    deadlineMs: 30_000,
    extraParameters: {
      automaticMemoryProfile: 'explicit',
      automaticIntent: 'disabled',
      automaticTurn: turn,
      automaticInput: sourceContent,
      automaticWrapper: options.wrapper ? 'enabled' : 'disabled',
      automaticRawHuman: options.wrapper ? query : '',
      ...(options.wrapper
        ? { automaticRegionStart: region.start, automaticRegionEnd: region.end }
        : {}),
      queueTemperatureMode: 'providerDefault',
    },
  });

  const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('The source-verdict parent fixture must not call a provider');
  });
  let completed: Awaited<ReturnType<typeof completeNativeAutonomousPersonalCaptureV4>>;
  try {
    completed = await completeNativeAutonomousPersonalCaptureV4(producerContext, producer);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    provider.mockRestore();
  }
  if (completed.kind !== 'original_turn')
    throw new Error(`Expected a genuine C2 original turn, got ${completed.kind}`);

  const publication = publishAutonomousPersonalMemoryHandoffV4(
    producerContext,
    producer,
    completed.origin,
  );
  if (publication.kind !== 'published')
    throw new Error(`Expected actual C2 lineage publication, got ${publication.kind}`);
  await producer.close();
  openStores.delete(producer);

  const owner = new GraphologyStorage(file);
  openStores.add(owner);
  await owner.initialize();
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
    currentHumanQuery: query,
    routeId: 'route:assistant-final-v4',
    model: 'model:assistant-final-v4',
    requestLimit: 2,
    deadlineMs: 30_000,
    temperatureMode: 'providerDefault',
    ...(options.wrapper
      ? {
          rawHumanContent: query,
          sourceMapping: { mode: 'application_region' as const, humanRegion: region },
        }
      : { sourceMapping: { mode: 'full_body' as const } }),
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
  if (!lineage) throw new Error('Expected actual C2 lineage after Memory-owner reopen');

  const parentGraph = await owner.readExtractionSnapshot(config.namespace);
  const parentOperation = parentGraph.automatic_operations_v1?.operations.find(
    (operation) => operation.version === 4 && operation.identity.sourceId === config.sourceId,
  );
  if (!parentOperation || parentOperation.version !== 4 || parentOperation.state !== 'committed')
    throw new Error('Expected the actual Source4 parent operation in the stored graph');
  expect(parentOperation.terminalReceipt.kind).toBe('human_autonomous_source_verdict_committed');
  return { directory, file, owner, seed, native, config, sourceContent, lineage, memoryContext };
}

async function issue(
  fixture: Fixture,
  options: {
    readonly observation?:
      | { readonly kind: 'configured_query' }
      | { readonly kind: 'message'; readonly content: string };
    readonly content?: string;
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly workDeadline?: number;
  } = {},
): Promise<PrivateAutonomousPersonalAssistantFinalInvocationV4> {
  const memoryAttemptHash = randomBytes(32).toString('hex');
  const intent = finalIntent(memoryAttemptHash, {
    ...(options.observation ? { observation: options.observation } : {}),
    ...(options.content ? { content: options.content } : {}),
    ...(options.deadlineMs ? { invocationDeadlineMs: options.deadlineMs } : {}),
  });
  const token = await issueAutonomousPersonalAssistantFinalInvocationV4(
    fixture.owner,
    fixture.lineage,
    intent,
    async () => {
      const config = await readAutonomousPersonalNativeMemoryConfigV4(
        fixture.memoryContext,
        0,
        fixture.config.storeHash,
      );
      return { config, memoryAttemptHash };
    },
    work(
      options.signal ?? new AbortController().signal,
      options.workDeadline ?? performance.now() + 30_000,
    ),
    () => {},
  );
  if (!token) throw new Error('Expected genuine V4 assistant invocation token');
  issuedTokens.push({ owner: fixture.owner, token });
  return token;
}

function assistants(graph: GraphData) {
  return graph.episodes.filter(
    (episode) =>
      episode.role === 'ai' &&
      (episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] as { purpose?: unknown } | undefined)
        ?.purpose === 'assistant_final_save',
  );
}

function assistantOperations(graph: GraphData) {
  return (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
    if (operation.version === 1) return false;
    return (
      operation.identity.role === 'assistant' &&
      operation.identity.purpose === 'assistant_final_save'
    );
  });
}

function persistedRecords(graph: GraphData) {
  return {
    entities: graph.entities,
    edges: graph.edges,
    episodes: graph.episodes,
    automatic_operations_v1: graph.automatic_operations_v1,
    metadata: graph.metadata,
  };
}

describe('Graphology atomic assistant final V4 writer', () => {
  beforeEach(() => {
    issuedTokens.length = 0;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const cleanupFailures: unknown[] = [];
    for (const store of openStores) {
      try {
        await store.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    openStores.clear();
    for (const directory of openedDirectories) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    openedDirectories.clear();
    issuedTokens.length = 0;
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1)
      throw new AggregateError(cleanupFailures, 'Assistant final test cleanup failed');
  });

  it('writes one committed assistant source and preserves the actual Source4 parent and every old row', async () => {
    const fixture = await createFixture();
    const before = await fixture.owner.readExtractionSnapshot();
    const parent = before.episodes.find((episode) => episode.uuid === fixture.config.sourceId);
    const parentOperation = before.automatic_operations_v1?.operations.find(
      (operation) =>
        operation.version === 4 && operation.identity.sourceId === fixture.config.sourceId,
    );
    if (!parent || !parentOperation || parentOperation.version !== 4)
      throw new Error('Expected a complete actual Source4 parent');

    const result = await fixture.owner.saveAssistantFinalV4(await issue(fixture));
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'initial_owner',
      currentAuthority: 'active',
      eligibleFirstCommit: false,
    });
    if (result.kind !== 'committed')
      throw new Error(`Expected committed result, got ${result.kind}`);
    expect(AutomaticCaptureTerminalReceiptV2Schema.parse(result.terminalReceipt)).toEqual(
      result.terminalReceipt,
    );

    const after = await fixture.owner.readExtractionSnapshot();
    const saved = assistants(after);
    const savedOperations = assistantOperations(after);
    expect(saved).toHaveLength(1);
    expect(savedOperations).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      uuid: result.terminalReceipt.sourceId,
      role: 'ai',
      episode_kind: 'assistant_reply',
      previous_episode_uuid: parent.uuid,
      content: finalContent,
      trust_level: 'unverified',
      review_status: 'proposed',
    });
    const storedOwner = saved[0]!.attributes[WRITE_OWNER_V2_ATTRIBUTE] as Record<string, unknown>;
    expect(storedOwner.assistantWriteAuthority).toMatchObject({
      kind: 'owned_human_turn_v4',
      parentFamily: 'autonomous-personal-v1',
      parentOperationId: parentOperation.operationId,
      sourceId: parent.uuid,
      sourceHash: parentOperation.identity.sourceHash,
      descriptorHash: parentOperation.identity.descriptorHash,
    });
    expect(savedOperations[0]).toMatchObject({
      version: 2,
      state: 'committed',
      generation: 1,
      operationId: result.terminalReceipt.operationId,
      terminalReceipt: result.terminalReceipt,
    });
    expect(savedOperations[0]).not.toHaveProperty('lease');
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(
      after.episodes.filter((episode) => episode.uuid !== result.terminalReceipt.sourceId),
    ).toEqual(before.episodes);
    expect(
      after.automatic_operations_v1?.operations.filter(
        (operation) => operation.operationId !== result.terminalReceipt.operationId,
      ),
    ).toEqual(before.automatic_operations_v1?.operations);
  }, 30_000);

  it('reuses the exact receipt for fresh semantic replays and rejects changed final text without duplication', async () => {
    const fixture = await createFixture();
    const first = await fixture.owner.saveAssistantFinalV4(await issue(fixture));
    if (first.kind !== 'committed') throw new Error(`Expected first commit, got ${first.kind}`);

    const replay = await fixture.owner.saveAssistantFinalV4(
      await issue(fixture, { observation: { kind: 'message', content: query } }),
    );
    expect(replay).toEqual({
      kind: 'committed_replay',
      terminalReceipt: first.terminalReceipt,
      currentAuthority: 'active',
      eligibleFirstCommit: false,
    });

    const changed = await fixture.owner.saveAssistantFinalV4(
      await issue(fixture, { content: 'A changed final response must not reuse the old receipt.' }),
    );
    expect(changed).toEqual({ kind: 'decision', reason: 'conflict', eligibleFirstCommit: false });
    const after = await fixture.owner.readExtractionSnapshot();
    expect(assistants(after)).toHaveLength(1);
    expect(assistantOperations(after)).toHaveLength(1);
  }, 30_000);

  it('accepts the whole formatted source wrapper and rejects a partial wrapper observation', async () => {
    const fixture = await createFixture({ wrapper: true });
    const first = await fixture.owner.saveAssistantFinalV4(await issue(fixture));
    if (first.kind !== 'committed') throw new Error(`Expected first commit, got ${first.kind}`);

    const fullWrapper = await fixture.owner.saveAssistantFinalV4(
      await issue(fixture, {
        observation: { kind: 'message', content: fixture.sourceContent },
      }),
    );
    expect(fullWrapper.kind).toBe('committed_replay');
    if (fullWrapper.kind !== 'committed_replay') return;
    expect(fullWrapper.terminalReceipt).toEqual(first.terminalReceipt);

    const partial = await fixture.owner.saveAssistantFinalV4(
      await issue(fixture, {
        observation: { kind: 'message', content: 'Speaker 🧭: What games' },
      }),
    );
    expect(partial).toEqual({ kind: 'decision', reason: 'conflict', eligibleFirstCommit: false });
    expect(assistants(await fixture.owner.readExtractionSnapshot())).toHaveLength(1);
  }, 30_000);

  it('rejects forged and foreign-owner invocation tokens before any assistant write', async () => {
    const fixture = await createFixture();
    const before = await fixture.owner.readExtractionSnapshot();
    const forged = await fixture.owner.saveAssistantFinalV4(
      Object.freeze(Object.create(null)) as PrivateAutonomousPersonalAssistantFinalInvocationV4,
    );
    expect(forged).toEqual({
      kind: 'decision',
      reason: 'invalid_handle',
      eligibleFirstCommit: false,
    });

    const foreignFile = join(fixture.directory, `foreign-${randomUUID()}.json`);
    const foreignOwner = new GraphologyStorage(foreignFile);
    openStores.add(foreignOwner);
    await foreignOwner.initialize();
    const token = await issue(fixture);
    const foreign = await foreignOwner.saveAssistantFinalV4(token);
    expect(foreign).toEqual({
      kind: 'decision',
      reason: 'invalid_handle',
      eligibleFirstCommit: false,
    });
    expect(persistedRecords(await fixture.owner.readExtractionSnapshot())).toEqual(
      persistedRecords(before),
    );
    expect(await foreignOwner.readExtractionSnapshot()).toEqual(
      expect.objectContaining({ episodes: [], edges: [], entities: [] }),
    );
  }, 30_000);

  it.each(['source review', 'source trust', 'binding revocation'] as const)(
    'blocks a newly revoked current parent after the assistant invocation is issued: %s',
    async (change) => {
      const fixture = await createFixture();
      const token = await issue(fixture);
      if (change === 'source review') {
        await fixture.owner.updateEpisode(fixture.config.sourceId, { review_status: 'rejected' });
      } else if (change === 'source trust') {
        await fixture.owner.updateEpisode(fixture.config.sourceId, { trust_level: 'untrusted' });
      } else {
        const revoked = await fixture.owner.automaticBindingCommand!({
          action: 'revoke',
          namespace: fixture.seed.request.namespace,
          bindingId: fixture.seed.binding.bindingId,
          expectedRevision: fixture.seed.binding.revision,
          authorizedBy: 'synthetic-assistant-final-test',
          reason: 'Exercise current Source4 authority revalidation',
        });
        expect(revoked.state).toBe('revoked');
      }
      const beforeWrite = await fixture.owner.readExtractionSnapshot();
      const result = await fixture.owner.saveAssistantFinalV4(token);
      expect(result).toEqual({
        kind: 'decision',
        reason: 'authority_changed',
        eligibleFirstCommit: false,
      });
      expect(persistedRecords(await fixture.owner.readExtractionSnapshot())).toEqual(
        persistedRecords(beforeWrite),
      );
      expect(assistants(beforeWrite)).toHaveLength(0);
      expect(assistantOperations(beforeWrite)).toHaveLength(0);
    },
  );

  it('uses the original abort and deadline without writing after they stop the invocation', async () => {
    const abortedFixture = await createFixture();
    const controller = new AbortController();
    const abortedHash = randomBytes(32).toString('hex');
    const abortedIntent = finalIntent(abortedHash);
    const abortedToken = await issueAutonomousPersonalAssistantFinalInvocationV4(
      abortedFixture.owner,
      abortedFixture.lineage,
      abortedIntent,
      async () => {
        const config = await readAutonomousPersonalNativeMemoryConfigV4(
          abortedFixture.memoryContext,
          0,
          abortedFixture.config.storeHash,
        );
        return { config, memoryAttemptHash: abortedHash };
      },
      work(controller.signal),
      () => {},
    );
    if (!abortedToken) throw new Error('Expected abort test invocation');
    issuedTokens.push({ owner: abortedFixture.owner, token: abortedToken });
    controller.abort();
    const abortedBefore = await abortedFixture.owner.readExtractionSnapshot();
    const abortedWrites = jest.spyOn(internals(abortedFixture.owner), 'writeTextAtomic');
    expect(await abortedFixture.owner.saveAssistantFinalV4(abortedToken)).toEqual({
      kind: 'decision',
      reason: 'interrupted',
      eligibleFirstCommit: false,
    });
    expect(abortedWrites).not.toHaveBeenCalled();
    expect(persistedRecords(await abortedFixture.owner.readExtractionSnapshot())).toEqual(
      persistedRecords(abortedBefore),
    );

    const expiredFixture = await createFixture();
    const shortDeadline = performance.now() + 1_000;
    const expiredToken = await issue(expiredFixture, { workDeadline: shortDeadline });
    const expiredBefore = await expiredFixture.owner.readExtractionSnapshot();
    const expiredWrites = jest.spyOn(internals(expiredFixture.owner), 'writeTextAtomic');
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(await expiredFixture.owner.saveAssistantFinalV4(expiredToken)).toEqual({
      kind: 'decision',
      reason: 'budget_exhausted',
      eligibleFirstCommit: false,
    });
    expect(expiredWrites).not.toHaveBeenCalled();
    expect(persistedRecords(await expiredFixture.owner.readExtractionSnapshot())).toEqual(
      persistedRecords(expiredBefore),
    );
  }, 30_000);

  it('does not confirm a replacement-attempt failure even when one readback sees the candidate', async () => {
    const fixture = await createFixture();
    const token = await issue(fixture);
    const write = jest.spyOn(internals(fixture.owner), 'writeTextAtomic');
    const originalChmod = fs.promises.chmod.bind(fs.promises);
    let failed = false;
    const chmod = jest.spyOn(fs.promises, 'chmod').mockImplementation(async (...args) => {
      if (!failed) {
        failed = true;
        throw new Error('synthetic post-rename durability failure');
      }
      return originalChmod(...args);
    });

    const result = await fixture.owner.saveAssistantFinalV4(token);
    expect(result).toEqual({
      kind: 'decision',
      reason: 'acknowledgement_unknown',
      eligibleFirstCommit: false,
    });
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    const visible = await fixture.owner.readExtractionSnapshot();
    expect(assistants(visible)).toHaveLength(1);
    expect(assistantOperations(visible)).toHaveLength(1);
  }, 30_000);

  it('returns only the exact durable receipt after a post-ACK cleanup error and preserves recoveryRequired', async () => {
    const fixture = await createFixture();
    const token = await issue(fixture);
    const state = internals(fixture.owner);
    const originalAcquire = state.acquirePersistLock.bind(fixture.owner);
    const acquire = jest.spyOn(state, 'acquirePersistLock').mockImplementation(async (check) => {
      const release = await originalAcquire(check);
      return async () => {
        await release();
        state.recoveryRequired = true;
        throw new Error('synthetic post-durability lock cleanup failure');
      };
    });
    const write = jest.spyOn(state, 'writeTextAtomic');

    const result = await fixture.owner.saveAssistantFinalV4(token);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed')
      throw new Error(`Expected committed durable ACK, got ${result.kind}`);
    expect(result.invocation).toBe('initial_owner');
    expect(result.eligibleFirstCommit).toBe(false);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(state.recoveryRequired).toBe(true);
    const persisted = GraphDataSchema.parse(JSON.parse(fs.readFileSync(fixture.file, 'utf8')));
    const saved = assistants(persisted);
    const operations = assistantOperations(persisted);
    expect(saved).toHaveLength(1);
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    if (!operation || operation.version !== 2 || operation.state !== 'committed')
      throw new Error('Expected the exact committed assistant Operation2');
    expect(result.terminalReceipt).toEqual(operation.terminalReceipt);
  }, 30_000);

  it('keeps a known pre-rename write failure uncommitted and does not retry the writer', async () => {
    const fixture = await createFixture();
    const token = await issue(fixture);
    const beforeBytes = fs.readFileSync(fixture.file);
    const write = jest
      .spyOn(internals(fixture.owner), 'writeTextAtomic')
      .mockRejectedValue(new Error('synthetic temp-file write failure before rename'));

    const result = await fixture.owner.saveAssistantFinalV4(token);
    expect(result).toEqual({
      kind: 'decision',
      reason: 'storage_error',
      eligibleFirstCommit: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(fixture.file)).toEqual(beforeBytes);
    const after = await fixture.owner.readExtractionSnapshot();
    expect(assistants(after)).toHaveLength(0);
    expect(assistantOperations(after)).toHaveLength(0);
  }, 30_000);
});
