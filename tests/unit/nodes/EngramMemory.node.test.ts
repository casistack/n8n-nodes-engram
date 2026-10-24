import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { InputValues, OutputValues } from '@langchain/core/memory';
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
    async getCredentials() {
      return { apiKey: 'test-key', baseUrl: 'https://example.test' };
    },
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
    expect(properties.get('automaticMemoryProfile')?.displayOptions?.show?.['@version']).toEqual([3]);
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
      const properties = new Map(new EngramMemory().description.properties.map((p) => [p.name, p]));
      expect(properties.get('extractionTemperatureMode')?.default).toBe('legacy');
      expect(properties.get('extractionTemperature')?.displayOptions?.show).toMatchObject({
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
});
