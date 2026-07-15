import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline';
import type { ExtractionSource } from '../../../src/extraction/ExtractionSource';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('EngramChatMemory storage and extraction controls', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await storage.close();
  });

  const combinations = Array.from({ length: 32 }, (_, mask) => ({
    storeHumanEpisodes: Boolean(mask & 1),
    storeAiEpisodes: Boolean(mask & 2),
    extractHuman: Boolean(mask & 4),
    extractAi: Boolean(mask & 8),
    extractSystemTool: Boolean(mask & 16),
  }));

  it.each(combinations)('keeps storage and extraction independent for %#', async (controls) => {
    const processSources = jest
      .spyOn(ExtractionPipeline.prototype, 'processSources')
      .mockResolvedValue();
    const groupId = `controls-${combinations.indexOf(controls)}`;
    const memory = new EngramChatMemory({
      storage,
      groupId,
      enableExtraction: true,
      llmConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://localhost',
        model: 'test-model',
      },
      ...controls,
    });

    await memory.saveContext(
      {
        input: 'Human statement',
        system_message: 'System policy',
        tool_output: 'Tool observation',
      },
      { output: 'Assistant reply' },
    );

    const episodes = await storage.listEpisodes(groupId, { sort_order: 'asc' });
    expect(episodes.map((episode) => episode.episode_kind)).toEqual([
      ...(controls.storeHumanEpisodes ? (['active_human'] as const) : []),
      ...(controls.storeAiEpisodes ? (['assistant_reply'] as const) : []),
    ]);

    const expectedKinds = [
      ...(controls.extractHuman ? (['active_human'] as const) : []),
      ...(controls.extractAi ? (['assistant_reply'] as const) : []),
      ...(controls.extractSystemTool ? (['system', 'tool_output'] as const) : []),
    ];
    if (expectedKinds.length === 0) {
      expect(processSources).not.toHaveBeenCalled();
    } else {
      expect(processSources).toHaveBeenCalledTimes(1);
      const sources = processSources.mock.calls[0][0] as ExtractionSource[];
      expect(sources.map((source) => source.episode_kind)).toEqual(expectedKinds);
      for (const source of sources) {
        const shouldBeStored =
          (source.episode_kind === 'active_human' && controls.storeHumanEpisodes) ||
          (source.episode_kind === 'assistant_reply' && controls.storeAiEpisodes);
        expect(Boolean(source.episode_uuid)).toBe(shouldBeStored);
      }
    }
  });

  it('propagates source metadata and deduplicates retried turns', async () => {
    const memory = new EngramChatMemory({
      storage,
      groupId: 'metadata-group',
      episodeMetadata: {
        source_message_id: 'message-42',
        idempotency_key: 'turn-42',
        conversation_id: 'conversation-7',
        sender_id: 'sender-9',
        sender_name: 'Alice',
        quoted_message_id: 'message-41',
        trust_level: 'trusted',
        source_workflow_id: 'workflow-3',
        source_execution_id: 'execution-8',
        attributes: { channel: 'whatsapp' },
      },
    });

    await memory.saveContext({ input: 'Remember this' }, { output: 'Noted' });
    await memory.saveContext({ input: 'Remember this' }, { output: 'Noted' });

    const episodes = await storage.listEpisodes('metadata-group', { sort_order: 'asc' });
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual(
      expect.objectContaining({
        episode_kind: 'active_human',
        source_message_id: 'message-42',
        idempotency_key: 'turn-42:active_human',
        conversation_id: 'conversation-7',
        sender_id: 'sender-9',
        sender_name: 'Alice',
        quoted_message_id: 'message-41',
        trust_level: 'trusted',
        source_workflow_id: 'workflow-3',
        source_execution_id: 'execution-8',
        attributes: { channel: 'whatsapp' },
      }),
    );
    expect(episodes[1]).toEqual(
      expect.objectContaining({
        episode_kind: 'assistant_reply',
        idempotency_key: 'turn-42:assistant_reply',
        sender_id: null,
        sender_name: null,
      }),
    );
  });

  it('persists and extracts passive human provenance with retry deduplication', async () => {
    const processSources = jest
      .spyOn(ExtractionPipeline.prototype, 'processSources')
      .mockResolvedValue();
    const memory = new EngramChatMemory({
      storage,
      groupId: 'passive-metadata-group',
      humanEpisodeKind: 'passive_human',
      storeAiEpisodes: false,
      enableExtraction: true,
      extractHuman: true,
      extractAi: false,
      llmConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://localhost',
        model: 'test-model',
      },
      episodeMetadata: {
        source_message_id: 'passive-message-42',
        idempotency_key: 'passive-turn-42',
        sender_id: 'sender-9',
        sender_name: 'Alice',
      },
    });

    await memory.saveContext({ input: 'Observed group message' }, { output: 'Curated' });
    await memory.saveContext({ input: 'Observed group message' }, { output: 'Curated' });

    const episodes = await storage.listEpisodes('passive-metadata-group');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toEqual(
      expect.objectContaining({
        episode_kind: 'passive_human',
        source_message_id: 'passive-message-42',
        idempotency_key: 'passive-turn-42:passive_human',
        sender_id: 'sender-9',
        sender_name: 'Alice',
      }),
    );
    expect(processSources).toHaveBeenCalledTimes(2);
    for (const [sources] of processSources.mock.calls) {
      expect(sources).toEqual([
        expect.objectContaining({
          episode_kind: 'passive_human',
          episode_uuid: episodes[0].uuid,
          source_message_id: 'passive-message-42',
          sender_id: 'sender-9',
        }),
      ]);
    }
  });

  it('uses passive provenance for transient extraction when human storage is disabled', async () => {
    const processSources = jest
      .spyOn(ExtractionPipeline.prototype, 'processSources')
      .mockResolvedValue();
    const memory = new EngramChatMemory({
      storage,
      groupId: 'passive-transient-group',
      humanEpisodeKind: 'passive_human',
      storeHumanEpisodes: false,
      storeAiEpisodes: false,
      enableExtraction: true,
      extractHuman: true,
      extractAi: false,
      llmConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://localhost',
        model: 'test-model',
      },
      episodeMetadata: {
        source_message_id: 'passive-message-transient',
        sender_id: 'sender-transient',
      },
    });

    await memory.saveContext({ input: 'Transient observation' }, { output: 'Ignored' });

    await expect(storage.listEpisodes('passive-transient-group')).resolves.toEqual([]);
    const transientSource = processSources.mock.calls[0][0][0];
    expect(transientSource).toEqual(
      expect.objectContaining({
        episode_kind: 'passive_human',
        source_message_id: 'passive-message-transient',
        sender_id: 'sender-transient',
      }),
    );
    expect(transientSource).not.toHaveProperty('episode_uuid');
  });
});
