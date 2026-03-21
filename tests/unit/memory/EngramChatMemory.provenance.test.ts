import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { LlmClient } from '../../../src/extraction/LlmClient';

jest.mock('../../../src/extraction/LlmClient');

const MockedLlmClient = LlmClient as jest.MockedClass<typeof LlmClient>;

describe('EngramChatMemory - relationship provenance', () => {
  let storage: GraphologyStorage;
  let mockChatJson: jest.Mock;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();

    MockedLlmClient.mockClear();
    mockChatJson = jest.fn();
    MockedLlmClient.prototype.chatJson = mockChatJson;
  });

  afterEach(async () => {
    await storage.close();
  });

  it('stores both turn episode UUIDs on newly extracted relationships', async () => {
    const memory = new EngramChatMemory({
      storage,
      groupId: 'g1',
      enableExtraction: true,
      llmConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://localhost',
        model: 'test-model',
      },
      entityTypes: ['person', 'organization'],
    });

    mockChatJson
      .mockResolvedValueOnce({
        entities: [
          { name: 'Alice', entity_type: 'person', summary: 'A person' },
          { name: 'Acme', entity_type: 'organization', summary: 'A company' },
        ],
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Alice works at Acme',
          },
        ],
      });

    await memory.saveContext(
      { input: 'I work at Acme.' },
      { output: 'Noted.' },
    );

    const episodes = await storage.getRecentEpisodes('g1', 10);
    expect(episodes).toHaveLength(2);

    const alice = await storage.getEntityByName('Alice', 'g1');
    expect(alice).not.toBeNull();

    const edges = await storage.getEdgesForEntity(alice!.uuid);
    expect(edges).toHaveLength(1);
    expect(edges[0].episodes).toEqual([episodes[0].uuid, episodes[1].uuid]);
  });

  it('appends new turn episode UUIDs when a relationship is deduplicated', async () => {
    const memory = new EngramChatMemory({
      storage,
      groupId: 'g1',
      enableExtraction: true,
      llmConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://localhost',
        model: 'test-model',
      },
      entityTypes: ['person', 'organization'],
    });

    mockChatJson
      .mockResolvedValueOnce({
        entities: [
          { name: 'Alice', entity_type: 'person', summary: 'A person' },
          { name: 'Acme', entity_type: 'organization', summary: 'A company' },
        ],
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Alice works at Acme',
          },
        ],
      })
      .mockResolvedValueOnce({
        entities: [
          { name: 'Alice', entity_type: 'person', summary: 'A person' },
          { name: 'Acme', entity_type: 'organization', summary: 'A company' },
        ],
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Alice works at Acme',
          },
        ],
      });

    await memory.saveContext(
      { input: 'I work at Acme.' },
      { output: 'Noted.' },
    );
    await memory.saveContext(
      { input: 'Reminder: I still work at Acme.' },
      { output: 'Still noted.' },
    );

    const episodes = await storage.getRecentEpisodes('g1', 10);
    expect(episodes).toHaveLength(4);

    const alice = await storage.getEntityByName('Alice', 'g1');
    expect(alice).not.toBeNull();

    const edges = await storage.getEdgesForEntity(alice!.uuid);
    expect(edges).toHaveLength(1);
    expect(edges[0].episodes).toEqual(episodes.map((episode) => episode.uuid));
  });
});
