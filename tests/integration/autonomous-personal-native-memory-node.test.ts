import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import { EngramMemory } from '../../src/nodes/EngramMemory/EngramMemory.node';
import * as NativeAdapter from '../../src/memory/AutonomousPersonalNativeMemoryAdapterV4';
import * as StorageFactory from '../../src/storage/StorageFactory';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { GraphData } from '../../src/schemas/GraphData.schema';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { publishAutonomousPersonalMemoryHandoffV4 } from '../../src/storage/AutonomousPersonalNativeMemoryHandoffV4';
import { WRITE_OWNER_V2_ATTRIBUTE } from '../../src/storage/AutomaticIdentity';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import { autonomousPersonalMemoryContextV4 } from '../helpers/autonomousPersonalMemoryBackend';

jest.setTimeout(30_000);

const QUERY = 'What games are on today?';
const ANSWER = 'This final assistant response is synthetic test data.';
const ROUTE = 'route:native-memory-node';
const MODEL = 'model:native-memory-node';

type SourceFixture = {
  readonly directory: string;
  readonly file: string;
  readonly workflow: string;
  readonly namespace: string;
  readonly issuer: string;
  readonly actorReference: string;
  readonly turn: string;
  readonly sourceId: string;
  readonly sourceOwner: GraphologyStorage;
  readonly native: {
    readonly instance: string;
    readonly workflow: string;
    readonly execution: string;
  };
  readonly beforeGraph: GraphData;
};

type MemoryContextOptions = {
  readonly automaticCaptureLifecycle?: string;
  readonly interpreter?: 'literalV1' | 'autonomousPersonalV1';
  readonly profileId?: 'existing' | 'conservative' | 'explicit' | 'reviewFirst';
  readonly backend?: 'embedded' | 'neo4j';
  readonly graphContextPolicy?: 'legacy' | 'current' | 'historical' | 'asOf';
  readonly graphContextAt?: string;
  readonly signal?: AbortSignal;
};

type MemoryExecuteContext = IExecuteFunctions & {
  readonly outputData: unknown[];
  readonly parentNode: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly typeVersion: number;
  };
};

type CreatedStorage = {
  storage: GraphologyStorage | null;
  closeSpy: jest.SpyInstance | null;
};

const directories = new Set<string>();
const createdStorages: CreatedStorage[] = [];
const suppliedCloseFunctions = new Set<() => Promise<void>>();

async function createSourceFixture(): Promise<SourceFixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-memory-node-'));
  directories.add(directory);
  const workflow = `native-memory-workflow-${randomUUID()}`;
  const file = join(directory, `${workflow}-engram.json`);
  const producer = new GraphologyStorage(file);
  await producer.initialize();
  const seed = await seedAutonomousPersonalCaptureSubject(producer);
  const native = {
    instance: `native-memory-instance-${randomUUID()}`,
    workflow,
    execution: `native-memory-execution-${randomUUID()}`,
  };
  const turn = `native-memory-turn-${randomUUID()}`;
  const producerContext = nativeAutonomousPersonalCaptureContext(seed, {
    content: QUERY,
    executionId: native.execution,
    workflowId: native.workflow,
    instanceId: native.instance,
    routeId: ROUTE,
    model: MODEL,
    requestLimit: 2,
    deadlineMs: 30_000,
    extraParameters: {
      automaticMemoryProfile: 'explicit',
      automaticIntent: 'disabled',
      automaticTurn: turn,
      automaticInput: QUERY,
      automaticWrapper: 'disabled',
      queueTemperatureMode: 'providerDefault',
    },
  });
  const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('The synthetic native Memory fixture must not call a provider');
  });

  try {
    const completed = await completeNativeAutonomousPersonalCaptureV4(producerContext, producer);
    expect(provider).not.toHaveBeenCalled();
    if (completed.kind !== 'original_turn') {
      throw new Error(`Expected a genuine C2 original turn, got ${completed.kind}`);
    }
    const publication = publishAutonomousPersonalMemoryHandoffV4(
      producerContext,
      producer,
      completed.origin,
    );
    if (publication.kind !== 'published') {
      throw new Error(`Expected a genuine published C2 handoff, got ${publication.kind}`);
    }
    const beforeGraph = await producer.exportGraph();
    await producer.close();

    return {
      directory,
      file,
      workflow,
      namespace: seed.request.namespace,
      issuer: seed.request.issuer,
      actorReference: seed.request.actorReference,
      turn,
      sourceId: publication.sourceId,
      sourceOwner: producer,
      native,
      beforeGraph,
    };
  } finally {
    provider.mockRestore();
    // The producer owner is already closed on success; this is idempotent for fixture failures.
    await producer.close().catch(() => undefined);
  }
}

function createMemoryContext(
  fixture: SourceFixture,
  options: MemoryContextOptions = {},
): MemoryExecuteContext {
  const base = autonomousPersonalMemoryContextV4({
    persistPath: fixture.file,
    storageWorkflowId: fixture.workflow,
    native: fixture.native,
    namespace: fixture.namespace,
    issuer: fixture.issuer,
    actorReference: fixture.actorReference,
    turn: fixture.turn,
    sourceId: fixture.sourceId,
    profileId: options.profileId === 'existing' ? 'explicit' : (options.profileId ?? 'explicit'),
    explicitIntent: false,
    currentHumanQuery: QUERY,
    sourceMapping: { mode: 'full_body' },
    routeId: ROUTE,
    model: MODEL,
    requestLimit: 2,
    deadlineMs: 30_000,
    temperatureMode: 'providerDefault',
  });
  const parameters: Record<string, unknown> = {
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.profileId === 'existing' ? { automaticMemoryProfile: 'existing' } : {}),
    messageWritePolicy: 'finalTurns',
    historyFilter: 'provenance',
    graphContextPolicy: options.graphContextPolicy ?? 'current',
    graphContextAt: options.graphContextAt ?? '',
    extractionExecution: 'synchronous',
    contextWindowLength: 10,
    enableExtraction: 'disabled',
    enableEmbeddings: 'disabled',
    retentionType: 'forever',
  };
  const nodeParameters: Record<string, unknown> = {
    ...base.getNode().parameters,
    automaticPreferenceInterpreter: options.interpreter ?? 'autonomousPersonalV1',
  };
  if (options.automaticCaptureLifecycle === '') {
    delete nodeParameters.automaticCaptureLifecycle;
  } else {
    nodeParameters.automaticCaptureLifecycle = options.automaticCaptureLifecycle ?? 'replaySafeV2';
  }
  const node = {
    ...base.getNode(),
    id: `native-memory-node-${fixture.turn}`,
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters: nodeParameters,
    continueOnFail: false,
    onError: 'stopWorkflow',
  };
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal ?? controller!.signal;
  const parentNode = {
    id: `native-memory-agent-${fixture.workflow}`,
    name: 'Synthetic AI Agent',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 3.1,
  };
  const outputData: unknown[] = [];

  return {
    ...base,
    parentNode,
    getNode: () => node,
    getNodeParameter: (name: string, itemIndex: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name)
        ? parameters[name]
        : base.getNodeParameter(name, itemIndex, fallback),
    getInputData: () => [{ json: { sessionId: fixture.namespace } }],
    getExecutionCancelSignal: () => signal,
    getWorkflowStaticData: () => ({}),
    addInputData: () => ({ index: 0 }),
    addOutputData: (...args: unknown[]) => outputData.push(args),
    getCredentials: async (name: string) =>
      name === 'engramNeo4jApi'
        ? {
            uri: 'bolt://127.0.0.1:7687',
            username: 'synthetic-user',
            password: 'synthetic-only-secret',
            database: 'neo4j',
          }
        : base.getCredentials('engramExtractionApi'),
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    outputData,
  } as unknown as MemoryExecuteContext;
}

function observeFactoryStorage(file: string): jest.SpyInstance {
  const created: CreatedStorage = { storage: null, closeSpy: null };
  createdStorages.push(created);
  const originalCreateStorage = StorageFactory.createStorage;
  return jest.spyOn(StorageFactory, 'createStorage').mockImplementation((config) => {
    const storage = originalCreateStorage(config);
    if (config.backend === 'embedded' && config.persistPath === file) {
      created.storage = storage as GraphologyStorage;
      created.closeSpy = jest.spyOn(storage, 'close');
    }
    return storage;
  });
}

function getAssistantSourceOperation(graph: GraphData, sourceId: string) {
  return graph.automatic_operations_v1?.operations.find(
    (operation) =>
      operation.version === 4 &&
      operation.state === 'committed' &&
      operation.identity.sourceId === sourceId,
  );
}

function lastCreatedStorage(): CreatedStorage | undefined {
  return createdStorages[createdStorages.length - 1];
}

describe('Autonomous Personal native Engram Memory node V4', () => {
  afterEach(async () => {
    for (const close of suppliedCloseFunctions) {
      try {
        await close();
      } catch {
        // Preserve the test assertion while still attempting remaining fixture cleanup.
      }
    }
    suppliedCloseFunctions.clear();
    for (const created of createdStorages.splice(0)) {
      try {
        await created.storage?.close();
      } catch {
        // Each test uses a unique path; a closed store needs no additional recovery work here.
      }
    }
    jest.restoreAllMocks();
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
    directories.clear();
  });

  it('loads the captured source through the native route and saves only the final assistant episode', async () => {
    const fixture = await createSourceFixture();
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Native Memory must not call an extraction provider');
    });
    observeFactoryStorage(fixture.file);

    const context = createMemoryContext(fixture);
    const supplied = await new EngramMemory().supplyData.call(context, 0);
    const memory =
      supplied.response as unknown as import('../../src/memory/EngramChatMemory').EngramChatMemory;
    if (supplied.closeFunction) suppliedCloseFunctions.add(supplied.closeFunction);
    const factoryOwner = lastCreatedStorage()?.storage;

    expect(supplied.closeFunction).toBeDefined();
    expect(factoryOwner).toBeInstanceOf(GraphologyStorage);
    expect(factoryOwner).not.toBeNull();
    expect(factoryOwner).not.toBe(fixture.sourceOwner);
    expect(provider).not.toHaveBeenCalled();

    const loaded = await memory.loadMemoryVariables({ input: QUERY });
    const messages = loaded.chat_history as BaseMessage[];
    expect(
      messages.some((message) => String(message.content).includes('Engram creation summary')),
    ).toBe(true);
    expect(JSON.stringify(context.outputData)).toContain('"query_source":"input"');

    await memory.saveContext({ input: QUERY }, { output: ANSWER });
    const owner = factoryOwner!;
    const afterSave = await owner.exportGraph();
    const beforeSourceOperation = getAssistantSourceOperation(
      fixture.beforeGraph,
      fixture.sourceId,
    );
    const afterSourceOperation = getAssistantSourceOperation(afterSave, fixture.sourceId);
    expect(beforeSourceOperation).toBeDefined();
    expect(afterSourceOperation).toEqual(beforeSourceOperation);
    expect(
      afterSave.episodes.filter(
        (episode) =>
          episode.content === ANSWER &&
          episode.role === 'ai' &&
          (episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] as { purpose?: unknown } | undefined)
            ?.purpose === 'assistant_final_save',
      ),
    ).toHaveLength(1);
    expect(
      afterSave.episodes.filter((episode) => episode.content === QUERY && episode.role === 'human'),
    ).toEqual(
      fixture.beforeGraph.episodes.filter(
        (episode) => episode.content === QUERY && episode.role === 'human',
      ),
    );
    expect(provider).not.toHaveBeenCalled();

    const beforeDirectMutationAttempts = await owner.exportGraph();
    await expect(memory.chatHistory.clear()).rejects.toThrow();
    const historyWithDirectAppend = memory.chatHistory as unknown as {
      appendMessageWrites(writes: Array<{ message: BaseMessage }>): Promise<unknown>;
    };
    await expect(
      historyWithDirectAppend.appendMessageWrites([
        { message: new HumanMessage('This direct append must be blocked.') },
      ]),
    ).rejects.toThrow();
    const afterDirectMutationAttempts = await owner.exportGraph();
    expect({
      ...afterDirectMutationAttempts,
      exported_at: beforeDirectMutationAttempts.exported_at,
    }).toEqual(beforeDirectMutationAttempts);

    await supplied.closeFunction!();
    suppliedCloseFunctions.delete(supplied.closeFunction!);
    expect(lastCreatedStorage()?.closeSpy).not.toHaveBeenCalled();
    expect(await factoryOwner!.getNativeAutomaticCaptureStoreIdentityV4()).toBeTruthy();
    await expect(memory.chatHistory.getMessages()).rejects.toThrow();
    await expect(memory.loadMemoryVariables({ input: QUERY })).rejects.toThrow();

    const legacyConsumer = await new EngramMemory().supplyData.call(
      createMemoryContext(fixture, {
        automaticCaptureLifecycle: 'legacy',
        interpreter: 'literalV1',
        profileId: 'existing',
      }),
      0,
    );
    const legacyMemory =
      legacyConsumer.response as unknown as import('../../src/memory/EngramChatMemory').EngramChatMemory;
    expect(legacyConsumer.closeFunction).toBeUndefined();
    expect(lastCreatedStorage()?.storage).toBe(factoryOwner);
    await expect(legacyMemory.loadMemoryVariables({ input: QUERY })).resolves.toHaveProperty(
      'chat_history',
    );

    await factoryOwner!.close();

    const reopened = new GraphologyStorage(fixture.file);
    await reopened.initialize();
    try {
      const persisted = await reopened.exportGraph();
      expect(persisted.episodes).toEqual(afterSave.episodes);
      expect(getAssistantSourceOperation(persisted, fixture.sourceId)).toEqual(
        beforeSourceOperation,
      );
    } finally {
      await reopened.close();
    }
  });

  it('reuses one admitted native Memory across repeated Agent supplies in the same signal scope', async () => {
    const fixture = await createSourceFixture();
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Native Memory continuation must not call a provider');
    });
    observeFactoryStorage(fixture.file);
    const prepareSpy = jest.spyOn(NativeAdapter, 'prepareNativeAutonomousPersonalMemoryAdapterV4');
    const refreshSpy = jest.spyOn(NativeAdapter, 'refreshAutonomousPersonalNativeMemoryAdapterV4');
    const signal = new AbortController().signal;
    const firstContext = createMemoryContext(fixture, { signal });
    const firstNode = firstContext.getNode();
    expect(firstContext.parentNode).toEqual({
      id: `native-memory-agent-${fixture.workflow}`,
      name: 'Synthetic AI Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    });
    expect(firstNode).toMatchObject({
      id: `native-memory-node-${fixture.turn}`,
      type: 'n8n-nodes-engram.engramMemory',
      typeVersion: 3,
    });
    expect(firstContext.getExecutionCancelSignal()).toBe(signal);
    const firstSupply = await new EngramMemory().supplyData.call(firstContext, 0);
    const firstMemory =
      firstSupply.response as unknown as import('../../src/memory/EngramChatMemory').EngramChatMemory;
    if (firstSupply.closeFunction) suppliedCloseFunctions.add(firstSupply.closeFunction);
    const firstOwner = lastCreatedStorage()?.storage;

    expect(firstSupply.closeFunction).toBeDefined();
    expect(firstOwner).toBeInstanceOf(GraphologyStorage);
    expect(firstMemory.storage).toBe(firstOwner);
    await expect(firstMemory.loadMemoryVariables({ input: QUERY })).resolves.toHaveProperty(
      'chat_history',
    );

    const secondContext = createMemoryContext(fixture, { signal });
    expect(secondContext.parentNode).toEqual(firstContext.parentNode);
    expect(secondContext.getNode()).toMatchObject({
      id: firstNode.id,
      type: firstNode.type,
      typeVersion: firstNode.typeVersion,
    });
    expect(secondContext.getExecutionCancelSignal()).toBe(signal);
    const secondSupply = await new EngramMemory().supplyData.call(secondContext, 0);
    const secondMemory =
      secondSupply.response as unknown as import('../../src/memory/EngramChatMemory').EngramChatMemory;
    if (secondSupply.closeFunction) suppliedCloseFunctions.add(secondSupply.closeFunction);

    expect(secondSupply.closeFunction).toBeDefined();
    expect(secondMemory.storage).toBe(firstMemory.storage);
    expect(Reflect.get(secondMemory, 'fields')).toBe(Reflect.get(firstMemory, 'fields'));
    expect(createdStorages).toHaveLength(1);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const refreshCall = refreshSpy.mock.calls[0]!;
    expect(refreshCall[0]).toBe(firstOwner);
    expect(Reflect.get(refreshCall[1] as object, 'fields')).toBe(
      Reflect.get(firstMemory, 'fields'),
    );
    expect(refreshCall[2]).toBe(secondContext);
    expect(refreshCall[3]).toBe(0);
    await expect(secondMemory.loadMemoryVariables({ input: QUERY })).resolves.toHaveProperty(
      'chat_history',
    );
    expect(provider).not.toHaveBeenCalled();
    expect(lastCreatedStorage()?.closeSpy).not.toHaveBeenCalled();
  });

  it('closes a prepared adapter but preserves the shared StorageFactory owner on constructor failure', async () => {
    const fixture = await createSourceFixture();
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Native Memory initialization must not call a provider');
    });
    observeFactoryStorage(fixture.file);
    const prepareSpy = jest.spyOn(NativeAdapter, 'prepareNativeAutonomousPersonalMemoryAdapterV4');
    const closePreparedSpy = jest.spyOn(
      NativeAdapter,
      'closePreparedAutonomousPersonalNativeMemoryAdapterV4',
    );
    const context = createMemoryContext(fixture, {
      graphContextPolicy: 'asOf',
      graphContextAt: '',
    });

    await expect(new EngramMemory().supplyData.call(context, 0)).rejects.toThrow(
      /initialization_failed/u,
    );
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(closePreparedSpy).toHaveBeenCalledTimes(1);
    const preparedToken = await prepareSpy.mock.results[0]?.value;
    expect(closePreparedSpy).toHaveBeenCalledWith(lastCreatedStorage()?.storage, preparedToken);
    expect(lastCreatedStorage()?.closeSpy).not.toHaveBeenCalled();
    const factoryOwner = lastCreatedStorage()?.storage;
    expect(factoryOwner).not.toBeNull();
    await expect(factoryOwner!.exportGraph()).resolves.toBeDefined();
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails closed without the fixed lifecycle or when Review First is selected', async () => {
    const fixture = await createSourceFixture();
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unsupported native Memory settings must not call a provider');
    });
    const prepareSpy = jest.spyOn(NativeAdapter, 'prepareNativeAutonomousPersonalMemoryAdapterV4');
    const factorySpy = observeFactoryStorage(fixture.file);
    const noLifecycle = createMemoryContext(fixture, { automaticCaptureLifecycle: '' });
    await expect(new EngramMemory().supplyData.call(noLifecycle, 0)).rejects.toThrow();
    expect(factorySpy).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();

    const reviewFirst = createMemoryContext(fixture, { profileId: 'reviewFirst' });
    await expect(new EngramMemory().supplyData.call(reviewFirst, 0)).rejects.toThrow(
      /initialization_failed/u,
    );
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(lastCreatedStorage()?.closeSpy).not.toHaveBeenCalled();
    const factoryOwner = lastCreatedStorage()?.storage;
    expect(factoryOwner).not.toBeNull();
    await expect(factoryOwner!.exportGraph()).resolves.toBeDefined();
    expect(provider).not.toHaveBeenCalled();
  });

  it('closes a failed Neo4j owner exactly once and exposes only the redacted initialization error', async () => {
    const fixture = await createSourceFixture();
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Neo4j initialization must not call a provider');
    });
    const initialize = jest.fn(async () => {
      throw new Error('synthetic-only-secret driver initialization details');
    });
    const close = jest.fn(async () => undefined);
    const storage = { initialize, close } as unknown as ReturnType<
      typeof StorageFactory.createStorage
    >;
    const createSpy = jest.spyOn(StorageFactory, 'createStorage').mockReturnValue(storage);

    let thrown: unknown;
    try {
      await new EngramMemory().supplyData.call(
        createMemoryContext(fixture, { backend: 'neo4j' }),
        0,
      );
    } catch (error) {
      thrown = error;
    }

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(String(thrown)).toContain('initialization_failed');
    expect(String(thrown)).not.toContain('synthetic-only-secret');
    expect(provider).not.toHaveBeenCalled();
  });
});
