import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  FunctionMessage,
} from '@langchain/core/messages';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline';
import type { EngramChatMemoryInput } from '../../../src/memory/EngramChatMemory';

const toolTurn = () => [
  new HumanMessage('Real human JSON: [{"response":"keep"}]'),
  new AIMessage({ content: '', tool_calls: [{ id: 'call1', name: 'probe', args: {} }] }),
  new ToolMessage({ content: 'PRIVATE TOOL RESULT', tool_call_id: 'call1', id: 'tool-id' }),
  new AIMessage('Final answer'),
];

describe('shared final-turn writer', () => {
  let storage: GraphologyStorage;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });
  const memory = (storage: GraphologyStorage, fields: Partial<EngramChatMemoryInput> = {}) =>
    new EngramChatMemory({
      storage,
      groupId: 'turns',
      policy: { finalTurnWrites: true },
      ...fields,
    });

  it('stores human/final assistant in one batch and omits intermediates by default', async () => {
    const append = jest.spyOn(storage, 'appendEpisodes');
    const m = memory(storage);
    await m.chatHistory.addMessages(toolTurn());
    const rows = await storage.listEpisodes('turns', { sort_order: 'asc' });
    expect(rows.map((r) => [r.role, r.episode_kind, r.content])).toEqual([
      ['human', 'active_human', 'Real human JSON: [{"response":"keep"}]'],
      ['ai', 'assistant_reply', 'Final answer'],
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(rows[1].previous_episode_uuid).toBe(rows[0].uuid);
  });

  it('stores optional audit data with role/trust/tool IDs and excludes it from context', async () => {
    const m = memory(storage, { policy: { finalTurnWrites: true, storeToolAudit: true } });
    await m.chatHistory.addMessages(toolTurn());
    const rows = await storage.listEpisodes('turns', { sort_order: 'asc' });
    expect(rows.map((r) => r.episode_kind)).toEqual([
      'active_human',
      'tool_output',
      'tool_output',
      'assistant_reply',
    ]);
    expect(rows[2]).toMatchObject({
      role: 'ai',
      trust_level: 'unverified',
      review_status: 'proposed',
      attributes: {
        engram_audit: true,
        engram_message: {
          original_role: 'tool',
          original_message_id: 'tool-id',
          tool_call_id: 'call1',
        },
      },
    });
    expect((await m.chatHistory.getMessages()).map((x) => x.content)).toEqual([
      toolTurn()[0].content,
      'Final answer',
    ]);
  });

  it('never turns native function/system messages into human facts', async () => {
    const process = jest.spyOn(ExtractionPipeline.prototype, 'processSources').mockResolvedValue();
    const m = memory(storage, {
      enableExtraction: true,
      llmConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'test' },
      extractAi: false,
      policy: { finalTurnWrites: true, storeToolAudit: true },
    });
    await m.chatHistory.addMessages([
      new HumanMessage('User'),
      new FunctionMessage({ name: 'fn', content: 'RESULT' }),
      new SystemMessage('policy'),
      new AIMessage('Final'),
    ]);
    expect(
      process.mock.calls[0][0].map((source) => [source.role, source.episode_kind, source.content]),
    ).toEqual([['human', 'active_human', 'User']]);
  });

  it('keeps explicit tool extraction independent of audit storage and labels it unverified', async () => {
    const process = jest.spyOn(ExtractionPipeline.prototype, 'processSources').mockResolvedValue();
    const m = memory(storage, {
      enableExtraction: true,
      llmConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'test' },
      extractHuman: false,
      extractAi: false,
      extractSystemTool: true,
    });
    await m.chatHistory.addMessages(toolTurn());
    const sources = process.mock.calls[0][0];
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      role: 'ai',
      episode_kind: 'tool_output',
      trust_level: 'unverified',
      content: 'PRIVATE TOOL RESULT',
    });
    expect(
      (await storage.listEpisodes('turns')).every((r) => r.episode_kind !== 'tool_output'),
    ).toBe(true);
  });

  it('deduplicates cross-entry retries using explicit turn identity, not content or execution alone', async () => {
    const process = jest.spyOn(ExtractionPipeline.prototype, 'processSources').mockResolvedValue();
    const m = memory(storage, {
      enableExtraction: true,
      llmConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'test' },
      episodeMetadata: {
        idempotency_key: 'stable-turn',
        source_message_id: 'human-id',
        sender_id: 'sender',
        trust_level: 'trusted',
      },
    });
    await m.saveContext({ input: 'User' }, { output: 'Final' });
    const h = new HumanMessage({ content: 'User', id: 'human-id' });
    const result = await m.saveMessagesWithOutcome([
      h,
      ...toolTurn().slice(1, -1),
      new AIMessage({ content: 'Final', id: 'provider-ai-id' }),
    ]);
    expect(await storage.listEpisodes('turns')).toHaveLength(2);
    expect(result).toMatchObject({ written: 0, duplicates: 2, extraction: { status: 'skipped' } });
    expect(process).toHaveBeenCalledTimes(1);
    const rows = await storage.listEpisodes('turns', { sort_order: 'asc' });
    expect(rows[0]).toMatchObject({
      source_message_id: 'human-id',
      sender_id: 'sender',
      trust_level: 'trusted',
    });
    expect(rows[1].sender_id).toBeNull();
  });

  it('retains repeated identical turns without an explicit identity even within one execution', async () => {
    const m = memory(storage, { episodeMetadata: { source_execution_id: 'same-execution' } });
    await m.saveContext({ input: 'Again' }, { output: 'Okay' });
    await m.chatHistory.addMessages([new HumanMessage('Again'), new AIMessage('Okay')]);
    expect(await storage.listEpisodes('turns')).toHaveLength(4);
  });

  it('deduplicates separate native roles with overlapping message IDs safely', async () => {
    const m = memory(storage, { policy: { finalTurnWrites: true, storeToolAudit: true } });
    await m.chatHistory.addMessages([
      new HumanMessage({ content: 'Human', id: 'same' }),
      new ToolMessage({ content: 'Tool', tool_call_id: 'call', id: 'same' }),
      new AIMessage({ content: 'Answer', id: 'same' }),
    ]);
    expect(await storage.listEpisodes('turns')).toHaveLength(3);
  });

  it('retains human storage/extraction controls for bulk calls', async () => {
    const process = jest.spyOn(ExtractionPipeline.prototype, 'processSources').mockResolvedValue();
    const m = memory(storage, {
      storeHumanEpisodes: false,
      storeAiEpisodes: true,
      extractHuman: true,
      extractAi: false,
      enableExtraction: true,
      llmConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'test' },
      humanEpisodeKind: 'passive_human',
      episodeMetadata: {
        sender_id: 'sender-42',
        sender_name: 'Alice',
        source_message_id: 'human-source',
        trust_level: 'trusted',
      },
    });
    await m.chatHistory.addMessages(toolTurn());
    expect((await storage.listEpisodes('turns')).map((x) => x.episode_kind)).toEqual([
      'assistant_reply',
    ]);
    expect(process.mock.calls[0][0][0]).toMatchObject({
      role: 'human',
      episode_kind: 'passive_human',
      sender_id: 'sender-42',
      sender_name: 'Alice',
      source_message_id: 'human-source',
      trust_level: 'trusted',
    });
    expect(process.mock.calls[0][0][0].episode_uuid).toBeUndefined();
  });

  it('selects final replies per human segment, preserving genuine JSON final text', async () => {
    const m = memory(storage);
    await m.chatHistory.addMessages([
      new HumanMessage('one'),
      new AIMessage('draft'),
      new AIMessage('[]'),
      new HumanMessage('two'),
      new AIMessage('last'),
    ]);
    expect(
      (await storage.listEpisodes('turns', { sort_order: 'asc' })).map((r) => r.content),
    ).toEqual(['one', '[]', 'two', 'last']);
  });

  it('surfaces a failed atomic history batch and performs no extraction', async () => {
    const process = jest.spyOn(ExtractionPipeline.prototype, 'processSources').mockResolvedValue();
    jest.spyOn(storage, 'appendEpisodes').mockRejectedValue(new Error('write failed'));
    const m = memory(storage, {
      enableExtraction: true,
      llmConfig: { apiKey: 'key', baseUrl: 'https://example.test', model: 'test' },
    });
    await expect(m.chatHistory.addMessages(toolTurn())).rejects.toThrow('write failed');
    expect(process).not.toHaveBeenCalled();
  });
  it('does not mistake a draft or unresolved tool sequence for a final assistant reply', async () => {
    const m = memory(storage);
    await m.chatHistory.addMessages([
      new HumanMessage('Human'),
      new AIMessage('draft'),
      new AIMessage({ content: '', tool_calls: [{ id: 'missing', name: 'probe', args: {} }] }),
      new AIMessage('Unresolved guess'),
    ]);
    expect((await storage.listEpisodes('turns')).map((r) => r.content)).toEqual(['Human']);
  });
  it('recognizes legacy function-call envelopes and their completed result', async () => {
    const m = memory(storage);
    await m.chatHistory.addMessages([
      new HumanMessage('Human'),
      new AIMessage({
        content: '',
        additional_kwargs: { function_call: { name: 'probe', arguments: '{}' } },
      }),
      new FunctionMessage({ name: 'probe', content: 'result' }),
      new AIMessage('Final'),
    ]);
    expect(
      (await storage.listEpisodes('turns', { sort_order: 'asc' })).map((r) => r.content),
    ).toEqual(['Human', 'Final']);
  });
  it('does not let empty canonical tool calls mask unresolved legacy tool calls', async () => {
    const m = memory(storage);
    const call = new AIMessage({
      content: '',
      additional_kwargs: {
        tool_calls: [
          { id: 'pending', type: 'function', function: { name: 'probe', arguments: '{}' } },
        ],
      },
    });
    call.tool_calls = [];
    await m.chatHistory.addMessages([
      new HumanMessage('Human'),
      call,
      new AIMessage('Unresolved draft'),
    ]);
    expect((await storage.listEpisodes('turns')).map((r) => r.content)).toEqual(['Human']);
  });
});
