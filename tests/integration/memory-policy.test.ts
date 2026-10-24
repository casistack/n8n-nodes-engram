import { randomUUID } from 'crypto';
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from '@langchain/core/messages';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { EngramChatMessageHistory } from '../../src/memory/EngramChatMessageHistory';
import { contentHash } from '../../src/memory/HistorySelection';

function suite(name: string, create: () => IGraphStorage) {
  describe(name, () => {
    let storage: IGraphStorage;
    const groupId = `policy-${randomUUID()}`;
    beforeEach(async () => {
      storage = create();
      await storage.initialize();
    });
    afterEach(async () => {
      await storage.clearGroup(groupId);
      await storage.close();
    });
    it('uses identical policy semantics for bulk writes, audits, explicit retries, and refill', async () => {
      const m = new EngramChatMemory({
        storage,
        groupId,
        contextWindow: 2,
        policy: { finalTurnWrites: true, storeToolAudit: true },
        episodeMetadata: { idempotency_key: 'turn-1' },
      });
      await m.chatHistory.addMessages([
        new HumanMessage('Human'),
        new AIMessage({ content: '', tool_calls: [{ id: 'call', name: 'probe', args: {} }] }),
        new ToolMessage({ content: 'tool result', tool_call_id: 'call' }),
        new AIMessage('Final'),
      ]);
      await m.saveContext({ input: 'Human' }, { output: 'Final' });
      const episodes = await storage.listEpisodes(groupId, { sort_order: 'asc' });
      expect(episodes).toHaveLength(4);
      const loaded = await m.loadMemoryVariablesWithDiagnostics({});
      expect(loaded.variables.chat_history.map((x: { content: string }) => x.content)).toEqual([
        'Human',
        'Final',
      ]);
      expect(loaded.diagnostics.history).toMatchObject({ excluded_provenance: 2, returned: 2 });
      for (let i = 1; i < episodes.length; i++)
        expect(episodes[i].previous_episode_uuid).toBe(episodes[i - 1].uuid);
    });
    it('preserves exact legacy records while excluding only an explicitly reviewed chain pair', async () => {
      const payload = '[{"response":"tool result"}]';
      await storage.appendEpisodes([
        {
          group_id: groupId,
          role: 'human',
          content: 'Older human',
          reference_time: new Date().toISOString(),
        },
        { group_id: groupId, role: 'ai', content: '[]', reference_time: new Date().toISOString() },
        {
          group_id: groupId,
          role: 'human',
          content: payload,
          reference_time: new Date().toISOString(),
        },
        {
          group_id: groupId,
          role: 'ai',
          content: 'Final',
          reference_time: new Date().toISOString(),
        },
      ]);
      const before = await storage.listEpisodes(groupId, { sort_order: 'asc' });
      const h = new EngramChatMessageHistory({
        storage,
        groupId,
        contextWindow: 2,
        policy: { historyFilter: 'reviewedLegacy', legacyArtifactHashes: [contentHash(payload)] },
      });
      expect((await h.getMessages()).map((x) => x.content)).toEqual(['Older human', 'Final']);
      expect(await storage.listEpisodes(groupId, { sort_order: 'asc' })).toEqual(before);
    });
    it('recalls an accepted known old fact with an isolated configured query', async () => {
      const a = await storage.addEntity({
        group_id: groupId,
        name: 'Alder',
        entity_type: 'person',
        summary: 'A person',
      });
      const b = await storage.addEntity({
        group_id: groupId,
        name: 'Cobalt',
        entity_type: 'concept',
        summary: 'A color',
      });
      await storage.addEdge({
        group_id: groupId,
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: 'FAVORITE_COLOR',
        fact: 'Alder favorite color is cobalt',
      });
      const m = new EngramChatMemory({
        storage,
        groupId,
        contextWindow: 2,
        policy: { finalTurnWrites: true, historyFilter: 'provenance' },
        currentHumanQuery: 'Alder favorite color',
        minRelevanceScore: 0,
        acceptedOnlyRetrieval: true,
      });
      for (let i = 0; i < 3; i++)
        await m.saveContext({ input: `New chat ${i}` }, { output: `New answer ${i}` });
      const result = await m.loadMemoryVariablesWithDiagnostics({});
      expect(result.variables.chat_history[0]).toBeInstanceOf(SystemMessage);
      expect(result.variables.chat_history[0].content).toContain('Alder favorite color is cobalt');
      expect(result.diagnostics.history.returned).toBe(2);
      expect(result.diagnostics.retrieval.query_source).toBe('configured');
    });
  });
}
suite('embedded memory policy', () => new GraphologyStorage());
if (process.env.NEO4J_TEST_URI)
  suite(
    'Neo4j memory policy',
    () =>
      new Neo4jStorage(
        process.env.NEO4J_TEST_URI!,
        process.env.NEO4J_TEST_USERNAME ?? 'neo4j',
        process.env.NEO4J_TEST_PASSWORD ?? 'password',
        process.env.NEO4J_TEST_DATABASE ?? 'neo4j',
      ),
  );
