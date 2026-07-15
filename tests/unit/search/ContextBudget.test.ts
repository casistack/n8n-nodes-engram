import { SystemMessage } from '@langchain/core/messages';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { estimateContextTokens } from '../../../src/search/ContextBudget';
import { HybridSearchEngine } from '../../../src/search/HybridSearchEngine';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('retrieval context budgets', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('formats whole provenance-bearing facts within the requested budget', async () => {
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    const episode = await storage.appendEpisode({
      group_id: 'g1',
      content: 'Source',
      role: 'human',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'active_human',
      sender_name: 'Alice',
      trust_level: 'trusted',
      review_status: 'accepted',
    });
    const fact = `Alice works at Acme ${'with detailed evidence '.repeat(20)}END_OF_FACT`;
    await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact,
      episodes: [episode.episode.uuid],
    });
    const engine = new HybridSearchEngine(storage);
    const results = await engine.search('Alice works', 'g1');
    const formatted = engine.formatAsContextWithAudit(results, 180, true);
    const context = formatted.context;

    expect(estimateContextTokens(context)).toBeLessThanOrEqual(180);
    expect(formatted.audit.total_token_budget).toBe(180);
    expect(formatted.audit.final_context_item_ids).toEqual([
      ...formatted.audit.entity_section.included_ids,
      ...formatted.audit.fact_section.included_ids,
    ]);
    if (context.includes('Alice works at Acme')) {
      expect(context).toContain('END_OF_FACT');
      expect(context).toContain('speaker=Alice');
    }
  });

  it('keeps combined search and traversal output under one deterministic total budget', async () => {
    const entities = [];
    for (let index = 0; index < 8; index++) {
      entities.push(
        await storage.addEntity({
          name: index === 0 ? 'Alice' : `Entity${index}`,
          group_id: 'budget',
          summary: `Long summary ${'context '.repeat(30)}`,
        }),
      );
    }
    for (let index = 0; index < entities.length - 1; index++) {
      await storage.addEdge({
        group_id: 'budget',
        source_node_uuid: entities[index].uuid,
        target_node_uuid: entities[index + 1].uuid,
        name: 'CONNECTS',
        fact: `Alice context relationship ${index} ${'detail '.repeat(40)}`,
      });
    }
    const memory = new EngramChatMemory({
      storage,
      groupId: 'budget',
      maxFactsPerQuery: 20,
      enableTraversal: true,
      traversalHops: 4,
      contextTokenBudget: 160,
      includeProvenanceInContext: true,
    });

    const first = await memory.loadMemoryVariables({ input: 'Alice context' });
    const second = await memory.loadMemoryVariables({ input: 'Alice context' });
    const firstText = (first.chat_history as SystemMessage[])
      .map((message) => String(message.content))
      .join('\n');
    const secondText = (second.chat_history as SystemMessage[])
      .map((message) => String(message.content))
      .join('\n');

    expect(estimateContextTokens(firstText)).toBeLessThanOrEqual(160);
    expect(secondText).toBe(firstText);
  });
});
