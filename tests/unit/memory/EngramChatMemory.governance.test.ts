import { SystemMessage } from '@langchain/core/messages';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('EngramChatMemory retrieval governance', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('does not inject proposed facts through search or traversal', async () => {
    const alice = await storage.addEntity({
      name: 'Alice',
      group_id: 'g1',
      summary: 'A person',
      entity_type: 'person',
    });
    const secret = await storage.addEntity({
      name: 'SecretProject',
      group_id: 'g1',
      summary: 'A hidden initiative',
      entity_type: 'organization',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'llm',
          confidence: 0.5,
          review_status: 'proposed',
          threshold_decision: 'pending_review',
          extracted_at: '2026-07-15T10:00:00.000Z',
          episode_uuids: [],
        },
      },
    });
    await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: secret.uuid,
      name: 'LEADS',
      fact: 'Alice may lead SecretProject',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'llm',
          confidence: 0.5,
          review_status: 'proposed',
          threshold_decision: 'pending_review',
          extracted_at: '2026-07-15T10:00:00.000Z',
          episode_uuids: [],
        },
      },
    });

    const memory = new EngramChatMemory({
      storage,
      groupId: 'g1',
      acceptedOnlyRetrieval: true,
      enableTraversal: true,
      traversalHops: 1,
    });
    const result = await memory.loadMemoryVariables({ input: 'Tell me about Alice' });
    const context = (result.chat_history as SystemMessage[])
      .map((message) => String(message.content))
      .join('\n');

    expect(context).toContain('Alice');
    expect(context).not.toContain('SecretProject');
    expect(context).not.toContain('may lead');
  });
});
