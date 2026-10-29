import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InputValues, OutputValues } from '@langchain/core/memory';
import { NodeHelpers } from 'n8n-workflow';
import { EngramMemory } from '../../../src/nodes/EngramMemory/EngramMemory.node';
import { createStorage } from '../../../src/storage/StorageFactory';
import { resolveStoragePath } from '../../../src/utils/helpers';

function createSupplyContext(options: {
  tempDir: string;
  typeVersion: number;
  parameters?: Record<string, unknown>;
}) {
  const parameters: Record<string, unknown> = {
    sessionIdType: 'customKey',
    sessionKey: 'node-group',
    backend: 'embedded',
    customStoragePath: options.tempDir,
    contextWindowLength: 10,
    enableExtraction: 'disabled',
    maxFactsPerQuery: 10,
    minRelevanceScore: 0.5,
    retentionType: 'forever',
    ...options.parameters,
  };

  return {
    getNodeParameter(name: string, itemIndex = 0, fallback?: unknown) {
      void itemIndex;
      return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
    },
    getNode() {
      return { name: 'Engram Memory', typeVersion: options.typeVersion };
    },
    getCredentials: jest.fn(async () => {
      return { apiKey: 'test-key', baseUrl: 'https://example.test' };
    }),
    getWorkflow() {
      return { id: 'wf-memory-node-test' };
    },
    getExecutionId() {
      return 'execution-node-test';
    },
    getWorkflowStaticData() {
      return {};
    },
    addInputData() {
      return { index: 0 };
    },
    addOutputData() {},
    async logAiEvent() {},
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
  } as never;
}

function createNativeContinuationHarness(options?: {
  initialize?: () => Promise<void>;
  refreshResult?: boolean;
}) {
  const memoryInstances: Array<{
    fields: unknown;
    token: unknown;
    closeNativeMemoryV4: jest.Mock;
  }> = [];
  const storageInstances: Array<{
    initialize: jest.Mock;
    applyRetention: jest.Mock;
    close: jest.Mock;
  }> = [];
  const adapterToken = jest.fn(() => Object.freeze({ token: Symbol('native-memory') }));
  const prepare = jest.fn(async () => adapterToken());
  const closePrepared = jest.fn();
  const refresh = jest.fn(async () => options?.refreshResult ?? true);
  const createStorageMock = jest.fn(() => {
    const storage = {
      initialize: jest.fn(async () => options?.initialize?.()),
      applyRetention: jest.fn(),
      close: jest.fn(async () => undefined),
    };
    storageInstances.push(storage);
    return storage;
  });
  const memoryConstructor = jest.fn().mockImplementation((fields: unknown, token: unknown) => {
    const memory = {
      fields,
      token,
      closeNativeMemoryV4: jest.fn(),
    };
    memoryInstances.push(memory);
    return memory;
  });
  const logWrapperMock = jest.fn((memory: unknown) => memory);
  const mockPaths = [
    '../../../src/memory/EngramChatMemory',
    '../../../src/memory/AutonomousPersonalNativeMemoryAdapterV4',
    '../../../src/storage/StorageFactory',
    '../../../src/utils/logWrapper',
  ];

  let IsolatedEngramMemory: typeof EngramMemory;
  jest.isolateModules(() => {
    jest.doMock('../../../src/memory/EngramChatMemory', () => ({
      EngramChatMemory: memoryConstructor,
    }));
    jest.doMock('../../../src/memory/AutonomousPersonalNativeMemoryAdapterV4', () => ({
      prepareNativeAutonomousPersonalMemoryAdapterV4: prepare,
      closePreparedAutonomousPersonalNativeMemoryAdapterV4: closePrepared,
      refreshAutonomousPersonalNativeMemoryAdapterV4: refresh,
    }));
    jest.doMock('../../../src/storage/StorageFactory', () => ({
      createStorage: createStorageMock,
    }));
    jest.doMock('../../../src/utils/logWrapper', () => ({
      logWrapper: logWrapperMock,
    }));
    IsolatedEngramMemory = (
      require('../../../src/nodes/EngramMemory/EngramMemory.node') as {
        EngramMemory: typeof EngramMemory;
      }
    ).EngramMemory;
  });
  for (const pathName of mockPaths) jest.dontMock(pathName);

  return {
    node: new IsolatedEngramMemory!(),
    memoryInstances,
    storageInstances,
    adapterToken,
    prepare,
    closePrepared,
    refresh,
    createStorage: createStorageMock,
    memoryConstructor,
    logWrapper: logWrapperMock,
  };
}

function createNativeSupplyContext(options: {
  tempDir: string;
  signal?: AbortSignal;
  parentNode?: {
    id: string;
    name: string;
    type: string;
    typeVersion: number;
  };
  extractionCredentialId?: string;
  neo4jCredentialId?: string;
  parameters?: Record<string, unknown>;
}) {
  const parameters: Record<string, unknown> = {
    sessionIdType: 'customKey',
    sessionKey: 'native-node-group',
    backend: 'embedded',
    customStoragePath: options.tempDir,
    contextWindowLength: 10,
    enableExtraction: 'disabled',
    maxFactsPerQuery: 10,
    minRelevanceScore: 0.5,
    retentionType: 'forever',
    automaticCaptureLifecycle: 'replaySafeV2',
    automaticPreferenceInterpreter: 'autonomousPersonalV1',
    automaticMemoryProfile: 'conservative',
    automaticTurn: 'turn-native-1',
    automaticIssuer: 'native-test-app',
    automaticActor: 'native-test-user',
    automaticCapturedSource: '1d89a473-20da-4de1-bbfa-337769e1edb2',
    currentHumanQuery: 'I prefer tea.',
    advancedExtractionPolicy: 'bounded',
    historyFilter: 'provenance',
    messageWritePolicy: 'finalTurns',
    ...options.parameters,
  };
  const signal = options.signal;
  const node = {
    id: 'memory-node-native-test',
    name: 'Engram Memory',
    type: 'n8n-nodes-engram.engramMemory',
    typeVersion: 3,
    parameters,
    credentials: {
      engramExtractionApi: {
        id: options.extractionCredentialId ?? 'extraction-credential-id',
        name: 'Extraction',
      },
      engramNeo4jApi: { id: options.neo4jCredentialId ?? 'neo4j-credential-id', name: 'Neo4j' },
    },
  };
  return {
    parentNode: options.parentNode,
    getNodeParameter(name: string, itemIndex = 0, fallback?: unknown) {
      void itemIndex;
      return Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback;
    },
    getNode() {
      return node;
    },
    getCredentials: jest.fn(async () => ({
      apiKey: 'test-secret',
      baseUrl: 'https://example.test/v1',
      uri: 'bolt://example.test:7687',
      username: 'test-user',
      password: 'test-password',
    })),
    getWorkflow() {
      return { id: 'wf-native-memory-test' };
    },
    getExecutionId() {
      return 'execution-native-memory-test';
    },
    getInstanceId() {
      return 'instance-native-memory-test';
    },
    getExecutionCancelSignal() {
      return signal;
    },
    getInputData() {
      return [{ json: { chatInput: 'I prefer tea.' } }];
    },
    evaluateExpression() {
      return 'native-node-group';
    },
    getWorkflowStaticData() {
      return {};
    },
    addInputData() {
      return { index: 0 };
    },
    addOutputData() {},
    async logAiEvent() {},
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
  } as never;
}

function normalizeNodeParameters(
  node: EngramMemory,
  parameters: Record<string, unknown>,
  typeVersion = 3,
): Record<string, unknown> {
  return (NodeHelpers.getNodeParameters(
    node.description.properties,
    parameters as never,
    true,
    false,
    { typeVersion },
  ) ?? {}) as Record<string, unknown>;
}

function displayedDefinitions(
  node: EngramMemory,
  parameters: Record<string, unknown>,
  name: string,
  typeVersion = 3,
) {
  return node.description.properties.filter(
    (property) =>
      property.name === name &&
      NodeHelpers.displayParameter(
        parameters as never,
        property,
        { typeVersion },
        parameters as never,
      ),
  );
}

describe('EngramMemory node version controls', () => {
  let tempDir: string;
  let persistPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-memory-node-'));
    persistPath = resolveStoragePath({
      customStoragePath: tempDir,
      workflowId: 'wf-memory-node-test',
    });
  });

  afterEach(async () => {
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    await storage.clearAll();
    await storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('publishes v3 while retaining human-only extraction defaults', () => {
    const node = new EngramMemory();
    expect(node.description.version).toEqual([1, 2, 3]);

    const properties = new Map(
      node.description.properties.map((property) => [property.name, property]),
    );
    expect(properties.get('storeHumanEpisodes')?.default).toBe('enabled');
    expect(properties.get('humanEpisodeKind')?.default).toBe('active_human');
    expect(properties.get('storeAiEpisodes')?.default).toBe('enabled');
    expect(properties.get('extractHuman')?.default).toBe('enabled');
    expect(properties.get('extractAi')?.default).toBe('disabled');
    expect(properties.get('extractSystemTool')?.default).toBe('disabled');
    expect(properties.get('autoAcceptConfidence')?.default).toBe(0.85);
    expect(properties.get('rejectBelowConfidence')?.default).toBe(0.3);
    expect(properties.get('memoryFactPolicy')?.default).toBe('acceptedOnly');
    expect(properties.get('contextTokenBudget')?.default).toBe(2000);
    expect(properties.get('automaticMemoryProfile')?.default).toBe('existing');
    expect(properties.get('automaticPreferenceInterpreter')?.default).toBe('literalV1');
    expect(properties.get('automaticPreferenceInterpreter')?.noDataExpression).toBe(true);
    expect(
      properties.get('automaticPreferenceInterpreter')?.displayOptions?.show?.['@version'],
    ).toEqual([3]);
    expect(properties.get('automaticMemoryProfile')?.displayOptions?.show?.['@version']).toEqual([
      3,
    ]);
  });

  it('makes the optional extraction credential available to native Memory with extraction disabled', () => {
    const node = new EngramMemory();
    const credential = node.description.credentials?.find(
      ({ name }) => name === 'engramExtractionApi',
    );

    expect(credential).toBeDefined();
    expect(credential?.required).toBe(false);
    expect(
      NodeHelpers.displayParameter(
        {
          enableExtraction: 'disabled',
          automaticPreferenceInterpreter: 'autonomousPersonalV1',
        },
        credential!,
        { typeVersion: 3 },
        {
          enableExtraction: 'disabled',
          automaticPreferenceInterpreter: 'autonomousPersonalV1',
        },
      ),
    ).toBe(true);
  });

  it('does not retrieve optional extraction credentials on the disabled default path', async () => {
    const context = createSupplyContext({ tempDir, typeVersion: 3 });
    const getCredentials = (context as { getCredentials: jest.Mock }).getCredentials;

    await new EngramMemory().supplyData.call(context, 0);

    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('retains native-only settings through n8n parameter pruning with one displayed definition', () => {
    const node = new EngramMemory();
    const nativeParameters: Record<string, unknown> = {
      automaticMemoryProfile: 'conservative',
      automaticPreferenceInterpreter: 'autonomousPersonalV1',
      enableExtraction: 'disabled',
      extractionModel: 'native-chat-model',
      extractionTemperatureMode: 'custom',
      extractionTemperature: 0.35,
      extractionRouteId: 'native-provider-route',
      extractionExecution: 'synchronous',
      maxFactsPerQuery: 23,
      minRelevanceScore: 0.27,
      enableEmbeddings: 'enabled',
      embeddingModel: 'native-embedding-model',
      enableTraversal: 'enabled',
      traversalHops: 3,
    };
    const normalized = normalizeNodeParameters(node, nativeParameters);
    const nativeOnlyFields = [
      'extractionModel',
      'extractionTemperatureMode',
      'extractionTemperature',
      'extractionRouteId',
      'extractionExecution',
      'maxFactsPerQuery',
      'minRelevanceScore',
      'enableEmbeddings',
      'embeddingModel',
      'enableTraversal',
      'traversalHops',
    ];

    for (const field of nativeOnlyFields) {
      expect(normalized[field]).toBe(nativeParameters[field]);
      expect(displayedDefinitions(node, nativeParameters, field)).toHaveLength(1);
    }
  });

  it('preserves old extraction UI pruning and existing extraction settings', () => {
    const node = new EngramMemory();
    const oldDisabledParameters: Record<string, unknown> = {
      automaticMemoryProfile: 'conservative',
      automaticPreferenceInterpreter: 'literalV1',
      enableExtraction: 'disabled',
      extractionModel: 'legacy-model',
      extractionTemperatureMode: 'custom',
      extractionTemperature: 0.6,
      extractionRouteId: 'legacy-route',
      extractionExecution: 'synchronous',
      maxFactsPerQuery: 31,
      minRelevanceScore: 0.4,
      enableEmbeddings: 'enabled',
      embeddingModel: 'legacy-embedding-model',
      enableTraversal: 'enabled',
      traversalHops: 2,
    };
    const oldDisabled = normalizeNodeParameters(node, oldDisabledParameters);
    const nativeOnlyFields = [
      'extractionModel',
      'extractionTemperatureMode',
      'extractionTemperature',
      'extractionRouteId',
      'extractionExecution',
      'maxFactsPerQuery',
      'minRelevanceScore',
      'enableEmbeddings',
      'embeddingModel',
      'enableTraversal',
      'traversalHops',
    ];

    expect(oldDisabled.automaticPreferenceInterpreter).toBe('literalV1');
    for (const field of nativeOnlyFields) {
      expect(oldDisabled).not.toHaveProperty(field);
      expect(displayedDefinitions(node, oldDisabledParameters, field)).toHaveLength(0);
    }

    const legacyExtractionParameters: Record<string, unknown> = {
      automaticMemoryProfile: 'existing',
      automaticPreferenceInterpreter: 'literalV1',
      enableExtraction: 'enabled',
      extractionModel: 'legacy-model',
      extractionTemperatureMode: 'custom',
      extractionTemperature: 0.6,
      extractionRouteId: 'legacy-route',
      extractionExecution: 'durable',
    };
    const legacyExtraction = normalizeNodeParameters(node, legacyExtractionParameters);
    for (const field of [
      'extractionModel',
      'extractionTemperatureMode',
      'extractionTemperature',
      'extractionRouteId',
      'extractionExecution',
    ]) {
      expect(legacyExtraction[field]).toBe(legacyExtractionParameters[field]);
      expect(displayedDefinitions(node, legacyExtractionParameters, field)).toHaveLength(1);
    }
  });

  it('retains a native durable setting for explicit rejection instead of defaulting to synchronous', () => {
    const node = new EngramMemory();
    const parameters = {
      automaticMemoryProfile: 'conservative',
      automaticPreferenceInterpreter: 'autonomousPersonalV1',
      enableExtraction: 'disabled',
      extractionExecution: 'durable',
    };

    const normalized = normalizeNodeParameters(node, parameters);

    expect(normalized.extractionExecution).toBe('durable');
    expect(displayedDefinitions(node, parameters, 'extractionExecution')).toHaveLength(1);
  });

  it('keeps v1 store-both behavior even when v2 parameters are present', async () => {
    const node = new EngramMemory();
    const context = createSupplyContext({
      tempDir,
      typeVersion: 1,
      parameters: {
        storeHumanEpisodes: 'disabled',
        storeAiEpisodes: 'disabled',
      },
    });
    const supplied = await node.supplyData.call(context, 0);
    const memory = supplied.response as unknown as {
      saveContext(input: InputValues, output: OutputValues): Promise<void>;
    };

    await memory.saveContext({ input: 'Human v1' }, { output: 'Assistant v1' });

    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const episodes = await storage.listEpisodes('node-group', { sort_order: 'asc' });
    await storage.close();
    expect(episodes.map((episode) => episode.episode_kind).sort()).toEqual([
      'active_human',
      'assistant_reply',
    ]);
  });

  it('applies v2 storage controls and execution provenance', async () => {
    const node = new EngramMemory();
    const context = createSupplyContext({
      tempDir,
      typeVersion: 2,
      parameters: {
        storeHumanEpisodes: 'enabled',
        humanEpisodeKind: 'passive_human',
        storeAiEpisodes: 'disabled',
        sourceMessageId: 'source-42',
        conversationId: 'conversation-7',
        senderId: 'sender-9',
        senderName: 'Alice',
        episodeTrustLevel: 'trusted',
        episodeAttributes: { channel: 'whatsapp' },
      },
    });
    const supplied = await node.supplyData.call(context, 0);
    const memory = supplied.response as unknown as {
      saveContext(input: InputValues, output: OutputValues): Promise<void>;
    };

    await memory.saveContext({ input: 'Human v2' }, { output: 'Assistant v2' });

    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const episodes = await storage.listEpisodes('node-group', { sort_order: 'asc' });
    await storage.close();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toEqual(
      expect.objectContaining({
        episode_kind: 'passive_human',
        source_message_id: 'source-42',
        conversation_id: 'conversation-7',
        sender_id: 'sender-9',
        sender_name: 'Alice',
        trust_level: 'trusted',
        source_workflow_id: 'wf-memory-node-test',
        source_execution_id: 'execution-node-test',
        attributes: { channel: 'whatsapp' },
      }),
    );
  });
  it.each([1, 2])(
    'preserves legacy temperature and maps explicit omission for Memory v%s',
    async (typeVersion) => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"entities":[]}' } }] }),
      });
      global.fetch = fetchMock;
      for (const mode of [undefined, 'providerDefault', 'custom']) {
        const supplied = await new EngramMemory().supplyData.call(
          createSupplyContext({
            tempDir,
            typeVersion,
            parameters: {
              enableExtraction: 'enabled',
              extractionModel: 'fixed',
              ...(mode ? { extractionTemperatureMode: mode } : {}),
              extractionTemperature: 1,
            },
          }),
          0,
        );
        await (
          supplied.response as unknown as {
            saveContext(input: InputValues, output: OutputValues): Promise<void>;
          }
        ).saveContext({ input: 'Hello' }, { output: 'Hi' });
        const body = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
        if (mode === 'providerDefault') expect(body).not.toHaveProperty('temperature');
        else expect(body.temperature).toBe(mode === 'custom' ? 1 : 0);
      }
      const properties = new EngramMemory().description.properties;
      expect(
        properties.find((property) => property.name === 'extractionTemperatureMode')?.default,
      ).toBe('legacy');
      expect(
        properties.find(
          (property) =>
            property.name === 'extractionTemperature' &&
            property.displayOptions?.show?.enableExtraction,
        )?.displayOptions?.show,
      ).toMatchObject({
        enableExtraction: ['enabled'],
        extractionTemperatureMode: ['custom'],
      });
    },
  );
  it.each([1, 2])('gates new history/write controls to v2 (version %s)', async (typeVersion) => {
    const { HumanMessage, AIMessage, ToolMessage } = await import('@langchain/core/messages');
    const supplied = await new EngramMemory().supplyData.call(
      createSupplyContext({
        tempDir,
        typeVersion,
        parameters: {
          messageWritePolicy: 'finalTurns',
          historyFilter: 'provenance',
          currentHumanQuery: 'Current supplied-item query',
          storeHumanEpisodes: 'disabled',
        },
      }),
      0,
    );
    const memory =
      supplied.response as unknown as import('../../../src/memory/EngramChatMemory').EngramChatMemory;
    await memory.chatHistory.addMessages([
      new HumanMessage('Human'),
      new ToolMessage({ content: 'tool', tool_call_id: 'one' }),
      new AIMessage('Final'),
    ]);
    const storage = createStorage({ backend: 'embedded', persistPath });
    await storage.initialize();
    const episodes = await storage.listEpisodes('node-group', { sort_order: 'asc' });
    await storage.close();
    expect(episodes.map((e) => e.content)).toEqual(
      typeVersion === 2 ? ['Final'] : ['Human', 'tool', 'Final'],
    );
    const loaded = await memory.loadMemoryVariablesWithDiagnostics({});
    expect(loaded.diagnostics.retrieval.query_source).toBe(
      typeVersion === 2 ? 'configured' : 'none',
    );
  });

  it('reuses one admitted native Memory across repeated supplies and closes it once', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-native-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const firstContext = createNativeSupplyContext({
      tempDir,
      signal: controller.signal,
      parentNode,
    });
    const secondContext = createNativeSupplyContext({
      tempDir,
      signal: controller.signal,
      parentNode,
    });

    const first = await harness.node.supplyData.call(firstContext, 0);
    const second = await harness.node.supplyData.call(secondContext, 0);

    expect(second.response).toBe(first.response);
    expect(harness.createStorage).toHaveBeenCalledTimes(1);
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.logWrapper).toHaveBeenNthCalledWith(2, first.response, secondContext);
    await second.closeFunction!();
    await first.closeFunction!();
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
    expect(harness.storageInstances[0].close).not.toHaveBeenCalled();
  });

  it('reserves before async storage setup so concurrent first supplies share one initialization', async () => {
    const controller = new AbortController();
    let releaseInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const harness = createNativeContinuationHarness({ initialize: () => initializeGate });
    const parentNode = {
      id: 'agent-node-concurrent-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const firstPending = harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode }),
      0,
    );
    const secondPending = harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode }),
      0,
    );

    expect(harness.createStorage).toHaveBeenCalledTimes(1);
    expect(harness.prepare).not.toHaveBeenCalled();
    releaseInitialize();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(second.response).toBe(first.response);
    expect(harness.createStorage).toHaveBeenCalledTimes(1);
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });

  it('fails closed and invalidates the cached Memory when native settings change', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-settings-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const first = await harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode }),
      0,
    );

    await expect(
      harness.node.supplyData.call(
        createNativeSupplyContext({
          tempDir,
          signal: controller.signal,
          parentNode,
          parameters: { contextTokenBudget: 2001 },
        }),
        0,
      ),
    ).rejects.toThrow('Engram replay-safe memory: initialization_failed');

    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
    await first.closeFunction!();
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
  });

  it('fails closed if the configured embedding credential reference changes mid-turn', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-credential-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const parameters = {
      enableEmbeddings: 'enabled',
      embeddingModel: 'embed-model-v1',
    };
    const first = await harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode, parameters }),
      0,
    );

    await expect(
      harness.node.supplyData.call(
        createNativeSupplyContext({
          tempDir,
          signal: controller.signal,
          parentNode,
          extractionCredentialId: 'replacement-credential-id',
          parameters,
        }),
        0,
      ),
    ).rejects.toThrow('Engram replay-safe memory: initialization_failed');

    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
    await first.closeFunction!();
  });

  it('keeps distinct Agent scopes from sharing a native Memory object', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const firstParent = {
      id: 'agent-node-one',
      name: 'Tools Agent One',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const secondParent = {
      ...firstParent,
      id: 'agent-node-two',
      name: 'Tools Agent Two',
    };
    const first = await harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode: firstParent }),
      0,
    );
    const second = await harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode: secondParent }),
      0,
    );

    expect(second.response).not.toBe(first.response);
    expect(harness.createStorage).toHaveBeenCalledTimes(2);
    expect(harness.prepare).toHaveBeenCalledTimes(2);
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing parent', parentNode: undefined, signal: true },
    {
      label: 'unknown parent type',
      parentNode: {
        id: 'other-node',
        name: 'Other Node',
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
      },
      signal: true,
    },
    {
      label: 'missing cancellation signal',
      parentNode: {
        id: 'agent-node-no-signal',
        name: 'Tools Agent',
        type: '@n8n/n8n-nodes-langchain.agent',
        typeVersion: 3.1,
      },
      signal: false,
    },
  ])('requires a verified native scope on first supply ($label)', async (testCase) => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    await expect(
      harness.node.supplyData.call(
        createNativeSupplyContext({
          tempDir,
          signal: testCase.signal ? controller.signal : undefined,
          parentNode: testCase.parentNode,
        }),
        0,
      ),
    ).rejects.toThrow('Engram replay-safe memory: initialization_failed');
    expect(harness.createStorage).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
  });

  it('evicts and closes the shared native Memory immediately on execution abort', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-abort-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const context = createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode });
    const supplied = await harness.node.supplyData.call(context, 0);

    controller.abort();
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
    expect(harness.storageInstances[0].close).not.toHaveBeenCalled();
    await expect(harness.node.supplyData.call(context, 0)).rejects.toThrow(
      'Engram replay-safe memory: initialization_failed',
    );
    expect(harness.prepare).toHaveBeenCalledTimes(1);
    await supplied.closeFunction!();
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
  });

  it('settles and cleans up an initialization cancelled before the first Memory exists', async () => {
    const controller = new AbortController();
    let releaseInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const harness = createNativeContinuationHarness({ initialize: () => initializeGate });
    const parentNode = {
      id: 'agent-node-init-abort-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const pending = harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode }),
      0,
    );
    controller.abort();
    releaseInitialize();

    await expect(pending).rejects.toThrow('Engram replay-safe memory: initialization_failed');
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.memoryInstances).toHaveLength(0);
    expect(harness.storageInstances[0].close).not.toHaveBeenCalled();
  });

  it('closes a Neo4j owner immediately when cancellation races storage initialization', async () => {
    const controller = new AbortController();
    let releaseInitialize!: () => void;
    const initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const harness = createNativeContinuationHarness({ initialize: () => initializeGate });
    const parentNode = {
      id: 'agent-node-neo4j-init-abort',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const pending = harness.node.supplyData.call(
      createNativeSupplyContext({
        tempDir,
        signal: controller.signal,
        parentNode,
        parameters: { backend: 'neo4j' },
      }),
      0,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.storageInstances).toHaveLength(1);

    controller.abort();
    expect(harness.storageInstances[0].close).toHaveBeenCalledTimes(1);
    releaseInitialize();
    await expect(pending).rejects.toThrow('Engram replay-safe memory: initialization_failed');
    expect(harness.storageInstances[0].close).toHaveBeenCalledTimes(1);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.memoryInstances).toHaveLength(0);
  });

  it('rejects an already-aborted signal before reserving or preparing native state', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-already-aborted',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };

    await expect(
      harness.node.supplyData.call(
        createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode }),
        0,
      ),
    ).rejects.toThrow('Engram replay-safe memory: initialization_failed');
    expect(harness.createStorage).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
  });

  it('hashes large control-character inputs without duplicating raw query payloads', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-large-query',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const largeQuery = '\u0001'.repeat(40_000);
    const supplied = await harness.node.supplyData.call(
      createNativeSupplyContext({
        tempDir,
        signal: controller.signal,
        parentNode,
        parameters: {
          currentHumanQuery: largeQuery,
          automaticRawHuman: largeQuery,
        },
      }),
      0,
    );

    expect(supplied.response).toBe(harness.memoryInstances[0]);
    expect(harness.prepare).toHaveBeenCalledTimes(1);
  });

  it('closes one Neo4j owner exactly once after repeated supplies', async () => {
    const controller = new AbortController();
    const harness = createNativeContinuationHarness();
    const parentNode = {
      id: 'agent-node-neo4j-test',
      name: 'Tools Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
    };
    const parameters = { backend: 'neo4j' };
    const first = await harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode, parameters }),
      0,
    );
    const second = await harness.node.supplyData.call(
      createNativeSupplyContext({ tempDir, signal: controller.signal, parentNode, parameters }),
      0,
    );

    expect(second.response).toBe(first.response);
    await first.closeFunction!();
    await second.closeFunction!();
    expect(harness.storageInstances[0].close).toHaveBeenCalledTimes(1);
    expect(harness.memoryInstances[0].closeNativeMemoryV4).toHaveBeenCalledTimes(1);
  });
});
