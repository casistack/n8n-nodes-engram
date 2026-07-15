import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline';
import { LlmClient } from '../../../src/extraction/LlmClient';
import { extractionMetadataFromAttributes } from '../../../src/schemas';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

jest.mock('../../../src/extraction/LlmClient');

const MockedLlmClient = LlmClient as jest.MockedClass<typeof LlmClient>;

describe('ExtractionPipeline confidence governance', () => {
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

  function createPipeline(groupId: string) {
    return new ExtractionPipeline(storage, {
      groupId,
      entityTypes: ['person', 'organization'],
      llmConfig: { apiKey: 'test', baseUrl: 'http://localhost', model: 'test' },
      requireConfidence: true,
      thresholdPolicy: { autoAcceptThreshold: 0.8, rejectBelowThreshold: 0.3 },
    });
  }

  it('persists accepted, proposed, and rejected threshold decisions', async () => {
    mockChatJson
      .mockResolvedValueOnce({
        entities: ['Alice', 'Acme', 'Bob', 'Beta', 'Carol', 'Core'].map((name) => ({
          name,
          entity_type: name === 'Alice' || name === 'Bob' || name === 'Carol' ? 'person' : 'organization',
          summary: `${name} summary`,
          confidence: 0.9,
        })),
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Alice works at Acme',
            confidence: 0.8,
          },
          {
            source_entity: 'Bob',
            target_entity: 'Beta',
            name: 'ADVISES',
            fact: 'Bob advises Beta',
            confidence: 0.3,
          },
          {
            source_entity: 'Carol',
            target_entity: 'Core',
            name: 'VISITED',
            fact: 'Carol may have visited Core',
            confidence: 0.29,
          },
        ],
      });

    await createPipeline('thresholds').processSources([
      { content: 'Source content', role: 'human', episode_kind: 'active_human' },
    ]);

    const data = await storage.exportGraph('thresholds');
    const decisions = new Map(
      data.edges.map((edge) => [edge.name, extractionMetadataFromAttributes(edge.attributes)]),
    );
    expect(decisions.get('WORKS_AT')).toEqual(
      expect.objectContaining({ review_status: 'accepted', threshold_decision: 'auto_accepted' }),
    );
    expect(decisions.get('ADVISES')).toEqual(
      expect.objectContaining({ review_status: 'proposed', threshold_decision: 'pending_review' }),
    );
    expect(decisions.get('VISITED')).toEqual(
      expect.objectContaining({ review_status: 'rejected', threshold_decision: 'below_threshold' }),
    );
  });

  it('rejects malformed model records when confidence is required', async () => {
    mockChatJson.mockResolvedValueOnce({
      entities: [
        { name: 'Alice', entity_type: 'person', summary: 'Missing confidence' },
        { name: 'Bob', entity_type: 'person', summary: 'Out of range', confidence: 2 },
      ],
    });

    await createPipeline('strict').processSources([
      { content: 'Source content', role: 'human', episode_kind: 'active_human' },
    ]);

    expect((await storage.exportGraph('strict')).entities).toHaveLength(0);
    expect(mockChatJson).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed relationship confidence without discarding valid entities', async () => {
    mockChatJson
      .mockResolvedValueOnce({
        entities: [
          { name: 'Alice', entity_type: 'person', summary: 'Alice', confidence: 0.9 },
          { name: 'Acme', entity_type: 'organization', summary: 'Acme', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Missing confidence',
          },
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'KNOWS',
            fact: 'Invalid confidence',
            confidence: -1,
          },
        ],
      });

    await createPipeline('strict-relationship').processSources([
      { content: 'Source content', role: 'human', episode_kind: 'active_human' },
    ]);

    const data = await storage.exportGraph('strict-relationship');
    expect(data.entities).toHaveLength(2);
    expect(data.edges).toHaveLength(0);
  });

  it('does not let proposed duplicate evidence rewrite an accepted fact', async () => {
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'dedup' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'dedup' });
    const accepted = await storage.addEdge({
      group_id: 'dedup',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'llm',
          confidence: 0.95,
          review_status: 'accepted',
          threshold_decision: 'auto_accepted',
          extracted_at: '2026-07-15T10:00:00.000Z',
          episode_uuids: [],
        },
      },
    });
    mockChatJson
      .mockResolvedValueOnce({
        entities: [
          { name: 'Alice', entity_type: 'person', summary: 'Alice', confidence: 0.5 },
          { name: 'Acme', entity_type: 'organization', summary: 'Acme', confidence: 0.5 },
        ],
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Alice might work at Acme',
            confidence: 0.5,
          },
        ],
      })
      .mockResolvedValueOnce({ is_duplicate: true, merged_fact: 'Alice might work at Acme' });

    await createPipeline('dedup').processSources([
      { content: 'Uncertain source', role: 'human', episode_kind: 'active_human' },
    ]);

    const updated = await storage.getEdge(accepted.uuid);
    expect(updated?.fact).toBe('Alice works at Acme');
    expect(extractionMetadataFromAttributes(updated!.attributes)?.review_status).toBe('accepted');
  });

  it('stores rejected duplicate evidence separately from accepted facts', async () => {
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'rejected-dedup' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'rejected-dedup' });
    await storage.addEdge({
      group_id: 'rejected-dedup',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
    });
    mockChatJson
      .mockResolvedValueOnce({
        entities: [
          { name: 'Alice', entity_type: 'person', summary: 'Alice', confidence: 0.9 },
          { name: 'Acme', entity_type: 'organization', summary: 'Acme', confidence: 0.9 },
        ],
      })
      .mockResolvedValueOnce({
        relationships: [
          {
            source_entity: 'Alice',
            target_entity: 'Acme',
            name: 'WORKS_AT',
            fact: 'Alice possibly works at Acme',
            confidence: 0.1,
          },
        ],
      });

    await createPipeline('rejected-dedup').processSources([
      { content: 'Weak source', role: 'human', episode_kind: 'active_human' },
    ]);

    expect(mockChatJson).toHaveBeenCalledTimes(2);
    const edges = await storage.getEdgesBetween(alice.uuid, acme.uuid);
    expect(edges).toHaveLength(2);
    expect(
      edges.map((edge) => extractionMetadataFromAttributes(edge.attributes)?.review_status ?? 'accepted'),
    ).toEqual(expect.arrayContaining(['accepted', 'rejected']));
  });
});
