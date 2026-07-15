import { RetrievalGovernance } from '../../../src/search/RetrievalGovernance';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('RetrievalGovernance', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns complete fact provenance and applies episode filters', async () => {
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    const human = await storage.appendEpisode({
      group_id: 'g1',
      content: 'I work at Acme',
      role: 'human',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'active_human',
      source_message_id: 'message-1',
      conversation_id: 'conversation-1',
      sender_id: 'sender-1',
      sender_name: 'Alice',
      trust_level: 'trusted',
      review_status: 'accepted',
      source_workflow_id: 'workflow-chat',
      source_execution_id: 'execution-1',
    });
    const tool = await storage.appendEpisode({
      group_id: 'g1',
      content: 'Tool result',
      role: 'ai',
      reference_time: '2026-07-15T11:00:00.000Z',
      episode_kind: 'tool_output',
      trust_level: 'unverified',
      review_status: 'proposed',
      source_workflow_id: 'workflow-monitor',
    });
    const edge = await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
      episodes: [human.episode.uuid, tool.episode.uuid],
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'llm',
          confidence: 0.92,
          review_status: 'accepted',
          threshold_decision: 'auto_accepted',
          extracted_at: '2026-07-15T11:00:00.000Z',
          episode_uuids: [human.episode.uuid, tool.episode.uuid],
        },
      },
    });
    const getEpisodes = jest.spyOn(storage, 'getEpisodes');
    const governance = new RetrievalGovernance(storage);

    const results = await governance.governEdges(
      [{ edge, sourceEntity: alice, targetEntity: acme, score: 1 }],
      {
        sender_id: 'sender-1',
        episode_kind: 'active_human',
        trust_level: 'trusted',
        source_workflow_id: 'workflow-chat',
        source_execution_id: 'execution-1',
        reference_after: '2026-07-15T09:00:00.000Z',
        reference_before: '2026-07-15T10:30:00.000Z',
        review_statuses: ['accepted'],
      },
    );

    expect(getEpisodes).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].provenance).toEqual([
      expect.objectContaining({
        source_episode_uuid: human.episode.uuid,
        source_message_id: 'message-1',
        conversation_id: 'conversation-1',
        speaker_role: 'human',
        sender_id: 'sender-1',
        sender_name: 'Alice',
        episode_kind: 'active_human',
        reference_time: '2026-07-15T10:00:00.000Z',
        trust_level: 'trusted',
        episode_review_status: 'accepted',
        source_workflow_id: 'workflow-chat',
        source_execution_id: 'execution-1',
        fact_confidence: 0.92,
        fact_review_status: 'accepted',
      }),
    ]);
  });

  it('uses explicit unknown provenance for manual facts and rejects them under episode filters', async () => {
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    const edge = await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
    });
    const governance = new RetrievalGovernance(storage);
    const input = [{ edge, sourceEntity: alice, targetEntity: acme, score: 1 }];

    const unrestricted = await governance.governEdges(input);
    expect(unrestricted[0].provenance).toEqual([
      expect.objectContaining({
        source_episode_uuid: null,
        fact_review_status: 'accepted',
      }),
    ]);
    await expect(governance.governEdges(input, { sender_id: 'sender-1' })).resolves.toEqual([]);
  });

  it('reports deterministic candidate rejection reasons without exposing episode content', async () => {
    const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
    const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1' });
    const episode = await storage.appendEpisode({
      group_id: 'g1',
      content: 'Sensitive source content',
      role: 'human',
      reference_time: '2026-07-15T10:00:00.000Z',
      episode_kind: 'active_human',
      sender_id: 'sender-1',
    });
    const edge = await storage.addEdge({
      group_id: 'g1',
      source_node_uuid: alice.uuid,
      target_node_uuid: acme.uuid,
      name: 'WORKS_AT',
      fact: 'Alice works at Acme',
      episodes: [episode.episode.uuid],
    });
    const governance = new RetrievalGovernance(storage);

    const result = await governance.governEdgesWithDecisions(
      [{ edge, sourceEntity: alice, targetEntity: acme, score: 0.8 }],
      { sender_id: 'sender-2' },
    );

    expect(result.results).toEqual([]);
    expect(result.decisions).toEqual([
      {
        candidate_id: edge.uuid,
        candidate_type: 'fact',
        score: 0.8,
        included: false,
        reasons: ['no_source_episode_matched_filters'],
      },
    ]);
    expect(JSON.stringify(result.decisions)).not.toContain('Sensitive source content');
  });
});
