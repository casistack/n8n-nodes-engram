import type { IExecuteFunctions } from 'n8n-workflow';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import {
  ExtractionDiagnostics,
  ExtractionError,
} from '../../../src/extraction/ExtractionDiagnostics';
import { logWrapper } from '../../../src/utils/logWrapper';
import { BaseChatMemory } from '@langchain/classic/memory/chat_memory';
import type { InputValues, OutputValues } from '@langchain/core/memory';

function context() {
  let index = 0;
  return {
    addInputData: jest.fn(() => ({ index: index++ })),
    addOutputData: jest.fn(),
    getNode: () => ({ name: 'Memory' }),
    logger: { warn: jest.fn() },
  };
}
const wrapped = (memory: BaseChatMemory, ctx: ReturnType<typeof context>) =>
  logWrapper(memory, ctx as unknown as IExecuteFunctions) as EngramChatMemory;

describe('memory execution diagnostics', () => {
  let storage: GraphologyStorage;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });

  it('attaches a caught leaf HTTP error to the save output while history survives', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'temperature unsupported PRIVATE',
    });
    const memory = new EngramChatMemory({
      storage,
      groupId: 'group',
      enableExtraction: true,
      llmConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'fixed' },
    });
    const ctx = context();
    await expect(
      wrapped(memory, ctx).saveContext({ input: 'Hello' }, { output: 'Hi' }),
    ).resolves.toBeUndefined();
    const [connection, index, data] = ctx.addOutputData.mock.calls[0];
    expect(connection).toBe('ai_memory');
    expect(index).toBe(0);
    expect(data[0][0].json).toMatchObject({
      action: 'saveContext',
      extraction: {
        status: 'failed',
        errors: [{ kind: 'unsupported_parameter', stage: 'entities', http_status: 400 }],
      },
    });
    expect(data[0][0].json.chatHistory).toHaveLength(2);
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(data)).not.toContain('PRIVATE');
  });

  it('keeps interleaved saves and delayed history reads bound to local output indices', async () => {
    const memory = new EngramChatMemory({ storage, groupId: 'group' });
    const a = new ExtractionDiagnostics().finish('disabled');
    const collector = new ExtractionDiagnostics();
    collector.error('entities', new ExtractionError('authentication', 401));
    const b = collector.finish();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(memory, 'saveContextWithOutcome')
      .mockImplementation(async (input) => (input.input === 'slow' ? (await barrier, a) : b));
    const ctx = context();
    const proxy = wrapped(memory, ctx);
    const first = proxy.saveContext({ input: 'slow' }, { output: 'one' });
    await proxy.saveContext({ input: 'fast' }, { output: 'two' });
    release();
    await first;
    expect(
      ctx.addOutputData.mock.calls.map((call) => [call[1], call[2][0][0].json.extraction.status]),
    ).toEqual([
      [1, 'failed'],
      [0, 'disabled'],
    ]);
    expect(memory.saveContextWithOutcome).toHaveBeenCalledTimes(2);
  });

  it('retains the first outcome while its history preview finishes after a later save', async () => {
    const memory = new EngramChatMemory({ storage, groupId: 'group' });
    const failed = new ExtractionDiagnostics();
    failed.error('entities', new ExtractionError('network'));
    jest
      .spyOn(memory, 'saveContextWithOutcome')
      .mockResolvedValueOnce(failed.finish())
      .mockResolvedValueOnce(new ExtractionDiagnostics().finish('disabled'));
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest
      .spyOn(memory.chatHistory, 'getMessages')
      .mockImplementationOnce(async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [];
      })
      .mockResolvedValueOnce([]);
    const ctx = context();
    const proxy = wrapped(memory, ctx);
    const slow = proxy.saveContext({ input: 'one' }, { output: 'first' });
    await reached;
    await proxy.saveContext({ input: 'two' }, { output: 'second' });
    release();
    await slow;
    expect(
      ctx.addOutputData.mock.calls.map((call) => [call[1], call[2][0][0].json.extraction.status]),
    ).toEqual([
      [1, 'disabled'],
      [0, 'failed'],
    ]);
  });

  it('retains outcome when post-save history read fails and never repeats save', async () => {
    const memory = new EngramChatMemory({ storage, groupId: 'group' });
    const save = jest.spyOn(memory, 'saveContextWithOutcome');
    jest.spyOn(memory.chatHistory, 'getMessages').mockRejectedValue(new Error('PRIVATE'));
    const ctx = context();
    await expect(
      wrapped(memory, ctx).saveContext({ input: 'Hello' }, { output: 'Hi' }),
    ).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(ctx.addOutputData.mock.calls[0][2][0][0].json).toMatchObject({
      extraction: { status: 'disabled' },
      historyWarning: 'History preview unavailable after save',
    });
    expect(await storage.listEpisodes('group')).toHaveLength(2);
  });

  it('does not repeat or reject a completed save on diagnostics publication failure', async () => {
    const memory = new EngramChatMemory({ storage, groupId: 'group' });
    const save = jest.spyOn(memory, 'saveContextWithOutcome');
    const ctx = context();
    ctx.addOutputData.mockImplementation(() => {
      throw new Error('PRIVATE');
    });
    await expect(
      wrapped(memory, ctx).saveContext({ input: 'Hello' }, { output: 'Hi' }),
    ).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await storage.listEpisodes('group')).toHaveLength(2);
    expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).not.toContain('PRIVATE');
  });

  it('preserves generic memory save handling', async () => {
    class OtherMemory extends BaseChatMemory {
      get memoryKeys() {
        return ['history'];
      }
      async loadMemoryVariables() {
        return {};
      }
      async saveContext(_input: InputValues, _output: OutputValues) {
        await this.chatHistory.addUserMessage('Other');
      }
    }
    const memory = new OtherMemory();
    const ctx = context();
    await wrapped(memory, ctx).saveContext({ input: 'Hello' }, { output: 'Hi' });
    const payload = ctx.addOutputData.mock.calls[0][2][0][0].json;
    expect(payload).not.toHaveProperty('extraction');
    expect(payload.chatHistory).toHaveLength(1);
  });
});

describe('bulk writes and empty-load diagnostics', () => {
  it('publishes invocation-scoped bulk write and load diagnostics', async () => {
    const { HumanMessage, AIMessage, ToolMessage } = await import('@langchain/core/messages');
    const storage = new GraphologyStorage();
    await storage.initialize();
    try {
      const memory = new EngramChatMemory({
        storage,
        groupId: 'bulk',
        policy: { finalTurnWrites: true },
        currentHumanQuery: 'Current human query',
      });
      const ctx = context();
      const proxy = wrapped(memory, ctx);
      await proxy.chatHistory.addMessages([
        new HumanMessage('Human'),
        new ToolMessage({ content: 'tool', tool_call_id: 'one' }),
        new AIMessage('Final'),
      ]);
      const bulk = ctx.addOutputData.mock.calls[0][2][0][0].json;
      expect(bulk).toMatchObject({
        action: 'addMessages',
        written: 2,
        skipped: 1,
        extraction: { status: 'disabled' },
      });
      await proxy.loadMemoryVariables({});
      expect(ctx.addOutputData.mock.calls[1][2][0][0].json).toMatchObject({
        action: 'loadMemoryVariables',
        history: { returned: 2 },
        retrieval: { query_source: 'configured', query_available: true },
      });
    } finally {
      await storage.close();
    }
  });
  it('keeps bulk storage failure visible and never replays a successful bulk save on logging failure', async () => {
    const { HumanMessage, AIMessage } = await import('@langchain/core/messages');
    const storage = new GraphologyStorage();
    await storage.initialize();
    const warn = jest.spyOn(console, 'warn').mockImplementation();
    try {
      const memory = new EngramChatMemory({
        storage,
        groupId: 'bulk',
        policy: { finalTurnWrites: true },
      });
      const ctx = context();
      ctx.addOutputData.mockImplementation(() => {
        throw new Error('logging failed');
      });
      await expect(
        wrapped(memory, ctx).chatHistory.addMessages([
          new HumanMessage('Human'),
          new AIMessage('Final'),
        ]),
      ).resolves.toBeUndefined();
      expect(await storage.listEpisodes('bulk')).toHaveLength(2);
      const append = jest
        .spyOn(storage, 'appendEpisodes')
        .mockRejectedValue(new Error('storage failed'));
      ctx.addOutputData.mockReset();
      await expect(
        wrapped(memory, ctx).chatHistory.addMessages([new HumanMessage('Next')]),
      ).rejects.toThrow('storage failed');
      expect(append).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await storage.close();
    }
  });
});
