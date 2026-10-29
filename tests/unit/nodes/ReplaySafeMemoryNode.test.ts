import fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NodeConnectionType, type IExecuteFunctions, type INode } from 'n8n-workflow';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { EngramMemory } from '../../../src/nodes/EngramMemory/EngramMemory.node';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { captureReplaySafeHumanMemory } from '../../../src/memory/ReplaySafeCapture';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import * as StorageFactory from '../../../src/storage/StorageFactory';
import * as Helpers from '../../../src/utils/helpers';
import { embeddedAutomaticCaptureStoreHash } from '../../../src/storage/AutomaticCaptureStore';
import { seedAutomaticCaptureSubject } from '../../helpers/automaticCaptureBackend';

const WORKFLOW = 'synthetic-native-memory-owner';

describe('native Memory replay-safe supplyData admission and wiring', () => {
  let directory: string;
  let persistPath: string;
  let node: INode;
  let parameters: Record<string, unknown>;
  let sourceId: string;
  let input: string;
  let groupId: string;
  let staticData: Record<string, unknown>;
  let credentials: jest.Mock;
  let inputData: jest.Mock;
  let getParameter: jest.Mock;
  let factory: jest.SpyInstance;
  let initialize: jest.SpyInstance;
  let migrate: jest.SpyInstance;
  let retention: jest.SpyInstance;
  let context: IExecuteFunctions;

  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'engram-native-memory-'));
    persistPath = Helpers.resolveStoragePath({
      customStoragePath: directory,
      workflowId: WORKFLOW,
    });
    const storage = new GraphologyStorage(persistPath);
    await storage.initialize();
    const { request } = await seedAutomaticCaptureSubject(storage);
    input = request.source.content;
    groupId = request.namespace;
    const captured = await captureReplaySafeHumanMemory(storage, request);
    expect(captured).toMatchObject({ status: 'first_capture_committed', should_process: true });
    sourceId = captured.sourceId!;
    await storage.close();
    parameters = {
      automaticCaptureLifecycle: 'replaySafeV2',
      sessionIdType: 'customKey',
      sessionKey: groupId,
      backend: 'embedded',
      customStoragePath: directory,
      contextWindowLength: 10,
      maxFactsPerQuery: 10,
      minRelevanceScore: 0,
      enableExtraction: 'enabled',
      enableEmbeddings: 'enabled',
      extractionModel: '',
      retentionType: 'forever',
      retentionValue: 30,
      storeHumanEpisodes: 'enabled',
      storeAiEpisodes: 'enabled',
      extractHuman: 'enabled',
      extractAi: 'disabled',
      extractSystemTool: 'disabled',
      historyFilter: 'provenance',
      messageWritePolicy: 'finalTurns',
      storeToolAudit: 'enabled',
      advancedExtractionPolicy: 'bounded',
      knowledgeSelection: 'durableTemporal',
      extractionExecution: 'synchronous',
      automaticMemoryProfile: 'conservative',
      automaticIssuer: request.issuer,
      automaticActor: request.actorReference,
      automaticTurn: request.turn,
      automaticCapturedSource: sourceId,
      currentHumanQuery: input,
      graphContextPolicy: 'current',
      memoryFactPolicy: 'acceptedOnly',
    };
    node = {
      id: 'synthetic-memory-node',
      name: 'Memory',
      type: 'n8n-nodes-engram.engramMemory',
      typeVersion: 3,
      parameters: parameters as INode['parameters'],
      position: [0, 0],
    };
    staticData = {};
    credentials = jest
      .fn()
      .mockRejectedValue(new Error('private extraction credential must not be read'));
    inputData = jest.fn(() => [{ json: { input, sourceId } }]);
    getParameter = jest.fn((name: string, _index: number, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : fallback,
    );
    context = {
      getNode: () => node,
      getNodeParameter: getParameter,
      getInputData: inputData,
      getExecutionId: () => 'synthetic-native-memory-processing',
      getWorkflow: () => ({ id: WORKFLOW }),
      getCredentials: credentials,
      getWorkflowStaticData: jest.fn(() => staticData),
      addInputData: jest.fn(() => ({ index: 0 })),
      addOutputData: jest.fn(),
      logAiEvent: jest.fn(),
      logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    } as unknown as IExecuteFunctions;
    factory = jest.spyOn(StorageFactory, 'createStorage');
    initialize = jest.spyOn(GraphologyStorage.prototype, 'initialize');
    migrate = jest.spyOn(Helpers, 'migrateStorageIfNeeded');
    retention = jest.spyOn(GraphologyStorage.prototype, 'applyRetention');
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
  });

  afterEach(async () => {
    expect(global.fetch).not.toHaveBeenCalled();
    const instances = factory.mock.results
      .filter((result) => result.type === 'return')
      .map((result) => result.value);
    jest.restoreAllMocks();
    for (const storage of new Set(instances)) await storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const supply = (itemIndex = 0) => new EngramMemory().supplyData.call(context, itemIndex);
  const assertNoSideEffects = (before: string) => {
    expect(credentials).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
    expect(fs.readFileSync(persistPath, 'utf8')).toBe(before);
  };

  it('publishes a static opt-in whose absent/default value remains legacy', () => {
    const lifecycle = new EngramMemory().description.properties.find(
      (property) => property.name === 'automaticCaptureLifecycle',
    );
    expect(lifecycle).toMatchObject({ type: 'options', default: 'legacy', noDataExpression: true });
    expect(lifecycle?.displayOptions?.show?.['@version']).toEqual([3]);
  });

  it.each([null, 'unknown', '={{ "replaySafeV2" }}', '={{ "legacy" }}'])(
    'rejects raw lifecycle %p before resolving configuration or touching storage',
    async (value) => {
      parameters.automaticCaptureLifecycle = value;
      const before = fs.readFileSync(persistPath, 'utf8');
      await expect(supply()).rejects.toThrow(/unsupported_configuration/u);
      expect(getParameter).not.toHaveBeenCalled();
      assertNoSideEffects(before);
    },
  );

  it.each([
    { typeVersion: 2 },
    { type: 'n8n-nodes-engram.engramMemoryTool' },
    { continueOnFail: true },
    { onError: 'continueRegularOutput' },
    { onError: 'continueErrorOutput' },
  ])('rejects unsupported node/continuation %j before all storage access', async (changes) => {
    Object.assign(node, changes);
    const before = fs.readFileSync(persistPath, 'utf8');
    await expect(supply()).rejects.toThrow(/unsupported_configuration/u);
    assertNoSideEffects(before);
  });

  it.each([0, 2])('requires exactly one main parent item, got %s', async (count) => {
    inputData.mockReturnValue(Array.from({ length: count }, () => ({ json: {} })));
    const before = fs.readFileSync(persistPath, 'utf8');
    await expect(supply()).rejects.toThrow(/single_event_required/u);
    expect(inputData).toHaveBeenCalledWith(0, NodeConnectionType.Main);
    assertNoSideEffects(before);
  });

  it('rejects nonzero supply item indexes instead of silently taking the first actor', async () => {
    const before = fs.readFileSync(persistPath, 'utf8');
    await expect(supply(1)).rejects.toThrow(/single_event_required/u);
    assertNoSideEffects(before);
  });

  it.each([
    ['retentionType', 'days'],
    ['extractionExecution', 'durable'],
    ['advancedExtractionPolicy', 'legacy'],
    ['historyFilter', 'off'],
    ['extractAi', 'enabled'],
    ['extractSystemTool', 'enabled'],
    ['automaticMemoryProfile', 'existing'],
    ['automaticCapturedSource', ''],
    ['messageWritePolicy', 'legacy'],
    ['storeHumanEpisodes', 'disabled'],
    ['storeAiEpisodes', 'disabled'],
  ])(
    'rejects incompatible %s=%s before credentials, migration or storage I/O',
    async (name, value) => {
      parameters[name] = value;
      const before = fs.readFileSync(persistPath, 'utf8');
      await expect(supply()).rejects.toThrow(/unsupported_configuration/u);
      assertNoSideEffects(before);
    },
  );

  it('supplies actual bound Memory that loads and saves final/tool audits without extraction credentials', async () => {
    expect(parameters).not.toHaveProperty('automaticRawHuman');
    const supplied = await supply();
    const memory = supplied.response as EngramChatMemory;
    expect(inputData).toHaveBeenCalledWith(0, NodeConnectionType.Main);
    expect(credentials).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(retention).not.toHaveBeenCalled();
    await memory.loadMemoryVariables({ input });
    await memory.saveContext({ input }, { output: 'Native saved final.' });
    await memory.chatHistory.addMessages([
      new HumanMessage(input),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'native-call', name: 'synthetic_probe', args: { value: true } }],
      }),
      new ToolMessage({ content: 'Native tool audit', tool_call_id: 'native-call' }),
      new AIMessage('Native saved final.'),
    ]);
    const reader = new GraphologyStorage(persistPath);
    await reader.initialize();
    try {
      const graph = await reader.readExtractionSnapshot(groupId);
      expect(graph.episodes.filter((episode) => episode.role === 'human')).toHaveLength(1);
      expect(
        graph.episodes.filter((episode) => episode.role === 'ai').map((episode) => episode.content),
      ).toEqual(['Native saved final.']);
      expect(graph.episodes.filter((episode) => episode.attributes.engram_audit)).toHaveLength(2);
      expect(graph.automatic_operations_v1?.operations).toHaveLength(2);
      const human = graph.episodes.find((episode) => episode.uuid === sourceId)!;
      const final = graph.episodes.find((episode) => episode.role === 'ai')!;
      expect((human.attributes.engram_write_owner_v1 as { store: string }).store).toBe(
        embeddedAutomaticCaptureStoreHash(persistPath),
      );
      expect((final.attributes.engram_write_owner_v2 as { storeHash: string }).storeHash).toBe(
        embeddedAutomaticCaptureStoreHash(persistPath),
      );
    } finally {
      await reader.close();
    }
    expect(credentials).not.toHaveBeenCalled();
  });

  it('preserves an exact whitespace namespace through actual capture, load and final persistence', async () => {
    const namespace = ' synthetic-native-memory ';
    const seed = new GraphologyStorage(persistPath);
    await seed.initialize();
    const { request } = await seedAutomaticCaptureSubject(seed, namespace);
    const captured = await captureReplaySafeHumanMemory(seed, request);
    expect(captured).toMatchObject({ status: 'first_capture_committed', should_process: true });
    await seed.close();
    parameters.sessionKey = namespace;
    parameters.automaticCapturedSource = captured.sourceId;
    parameters.automaticIssuer = request.issuer;
    parameters.automaticActor = request.actorReference;
    parameters.automaticTurn = request.turn;
    parameters.currentHumanQuery = request.source.content;
    inputData.mockReturnValue([
      { json: { input: request.source.content, sourceId: captured.sourceId } },
    ]);
    const supplied = await supply();
    const memory = supplied.response as EngramChatMemory;
    await memory.loadMemoryVariables({ input: request.source.content });
    await memory.saveContext(
      { input: request.source.content },
      { output: 'Whitespace namespace final.' },
    );
    const reader = new GraphologyStorage(persistPath);
    await reader.initialize();
    try {
      const exact = await reader.listEpisodes(namespace, { sort_order: 'asc' });
      expect(exact.map((episode) => [episode.role, episode.content])).toEqual([
        ['human', request.source.content],
        ['ai', 'Whitespace namespace final.'],
      ]);
      expect((exact[0].attributes.engram_write_owner_v1 as { namespace: string }).namespace).toBe(
        namespace,
      );
      expect((exact[1].attributes.engram_write_owner_v2 as { namespace: string }).namespace).toBe(
        namespace,
      );
      expect(await reader.listEpisodes(namespace.trim())).toEqual([]);
      expect(
        (await reader.listEpisodes(groupId)).filter((episode) => episode.role === 'human'),
      ).toHaveLength(1);
    } finally {
      await reader.close();
    }
    expect(credentials).not.toHaveBeenCalled();
  });

  it('missing store neither migrates a legacy source nor creates a replacement before load fails', async () => {
    const missingDirectory = join(directory, 'missing-store');
    const target = Helpers.resolveStoragePath({
      customStoragePath: missingDirectory,
      workflowId: WORKFLOW,
    });
    parameters.customStoragePath = missingDirectory;
    staticData.__engramPersistPath = persistPath;
    const copy = jest.spyOn(fs, 'copyFileSync');
    const before = fs.readFileSync(persistPath, 'utf8');
    const supplied = await supply();
    const memory = supplied.response as EngramChatMemory;
    expect(fs.existsSync(target)).toBe(false);
    expect(migrate).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    await expect(memory.loadMemoryVariables({ input })).rejects.toThrow(/parent_not_authorized/u);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(persistPath, 'utf8')).toBe(before);
    expect(credentials).not.toHaveBeenCalled();
  });
});
