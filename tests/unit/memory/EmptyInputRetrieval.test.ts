import { SystemMessage } from '@langchain/core/messages';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('current human query for empty loads', () => {
  let storage: GraphologyStorage;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });
  afterEach(async () => storage.close());
  it('retrieves a known accepted older fact outside the recent message window', async () => {
    const source = await storage.appendEpisode({
      group_id: 'recall',
      role: 'human',
      content: 'Alder has favorite color cobalt',
      episode_kind: 'active_human',
      review_status: 'accepted',
      trust_level: 'trusted',
      reference_time: '2026-01-01T00:00:00.000Z',
    });
    const metadata = {
      engram_extraction: {
        version: 2,
        source: 'llm',
        confidence: 0.99,
        review_status: 'accepted',
        threshold_decision: 'auto_accepted',
        extracted_at: '2026-01-01T00:00:00.000Z',
        episode_uuids: [source.episode.uuid],
      },
    };
    const person = await storage.addEntity({
      group_id: 'recall',
      name: 'Alder',
      entity_type: 'person',
      summary: 'A person',
      attributes: metadata,
    });
    const color = await storage.addEntity({
      group_id: 'recall',
      name: 'Cobalt',
      entity_type: 'concept',
      summary: 'A color',
      attributes: metadata,
    });
    await storage.addEdge({
      group_id: 'recall',
      source_node_uuid: person.uuid,
      target_node_uuid: color.uuid,
      name: 'FAVORITE_COLOR',
      fact: 'Alder has favorite color cobalt',
      episodes: [source.episode.uuid],
      attributes: metadata,
    });
    const m = new EngramChatMemory({
      storage,
      groupId: 'recall',
      contextWindow: 2,
      minRelevanceScore: 0,
      acceptedOnlyRetrieval: true,
      policy: { historyFilter: 'provenance', finalTurnWrites: true },
      currentHumanQuery: 'What is Alder favorite color?',
    });
    for (let i = 0; i < 4; i++)
      await m.saveContext({ input: `Recent chat ${i}` }, { output: `Recent answer ${i}` });
    const result = await m.loadMemoryVariablesWithDiagnostics({});
    expect(result.diagnostics.retrieval).toMatchObject({
      query_source: 'configured',
      query_available: true,
      fact_messages: 1,
    });
    const messages = result.variables.chat_history;
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[0].content).toContain('Alder has favorite color cobalt');
    expect(messages.slice(1).map((m: { content: string }) => m.content)).toEqual([
      'Recent chat 3',
      'Recent answer 3',
    ]);
    expect(await storage.getEpisode(source.episode.uuid)).not.toBeNull();
  });
  it('prefers explicit input and exposes missing query without guessing from history', async () => {
    const m = new EngramChatMemory({
      storage,
      groupId: 'query',
      currentHumanQuery: 'Configured input',
    });
    const search = jest.spyOn(storage, 'searchEntities');
    expect(
      (await m.loadMemoryVariablesWithDiagnostics({ input: 'Current input' })).diagnostics.retrieval
        .query_source,
    ).toBe('input');
    expect(search).toHaveBeenCalledWith('Current input', 'query', expect.anything());
    search.mockClear();
    expect(
      (await m.loadMemoryVariablesWithDiagnostics({ input: '' })).diagnostics.retrieval
        .query_source,
    ).toBe('none');
    expect(search).not.toHaveBeenCalled();
    const noQuery = new EngramChatMemory({ storage, groupId: 'query' });
    await noQuery.saveContext({ input: 'Old human query' }, { output: 'Old reply' });
    expect(
      (await noQuery.loadMemoryVariablesWithDiagnostics({})).diagnostics.retrieval,
    ).toMatchObject({ query_available: false, query_source: 'none', fact_messages: 0 });
    expect(search).not.toHaveBeenCalled();
  });
  it('keeps supplied queries isolated by instance across overlapping loads', async () => {
    const a = new EngramChatMemory({ storage, groupId: 'a', currentHumanQuery: 'Query A' });
    const b = new EngramChatMemory({ storage, groupId: 'b', currentHumanQuery: 'Query B' });
    const search = jest.spyOn(storage, 'searchEntities');
    await Promise.all([a.loadMemoryVariables({}), b.loadMemoryVariables({})]);
    expect(search).toHaveBeenCalledWith('Query A', 'a', expect.anything());
    expect(search).toHaveBeenCalledWith('Query B', 'b', expect.anything());
  });
});
