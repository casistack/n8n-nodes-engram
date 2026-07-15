import { migrateGraphData } from '../../../src/schemas';

const timestamp = '2026-06-21T12:00:00.000Z';

describe('GraphData migration', () => {
  it('migrates legacy episodes conservatively without changing identity or chain fields', () => {
    const source = {
      version: '1.0',
      exported_at: timestamp,
      group_id: 'legacy-group',
      metadata: {
        checksum_sha256: 'legacy-checksum',
        checksum_algorithm: 'sha256',
        generated_by: 'n8n-nodes-engram',
      },
      entities: [],
      edges: [],
      episodes: [
        {
          uuid: '00000000-0000-4000-8000-000000000001',
          group_id: 'legacy-group',
          content: 'First',
          role: 'human',
          reference_time: timestamp,
          created_at: timestamp,
        },
        {
          uuid: '00000000-0000-4000-8000-000000000002',
          group_id: 'legacy-group',
          content: 'Second',
          role: 'ai',
          reference_time: timestamp,
          previous_episode_uuid: '00000000-0000-4000-8000-000000000001',
          created_at: timestamp,
        },
      ],
    } as const;
    const original = structuredClone(source);

    const migration = migrateGraphData(source);

    expect(source).toEqual(original);
    expect(migration.data.version).toBe('2.0');
    expect(migration.report).toEqual(
      expect.objectContaining({
        source_version: '1.0',
        target_version: '2.0',
        migration_required: true,
        source_checksum_removed: true,
        records: { entities: 0, facts: 0, episodes: 2 },
        episode_defaults_applied: expect.objectContaining({
          episode_kind: 2,
          trust_level: 2,
          review_status: 2,
        }),
      }),
    );
    expect(migration.data.metadata).toEqual({ generated_by: 'n8n-nodes-engram' });
    expect(migration.data.episodes).toEqual([
      expect.objectContaining({
        uuid: source.episodes[0].uuid,
        episode_kind: 'legacy',
        trust_level: 'unverified',
        review_status: 'proposed',
        previous_episode_uuid: null,
      }),
      expect.objectContaining({
        uuid: source.episodes[1].uuid,
        previous_episode_uuid: source.episodes[0].uuid,
        episode_kind: 'legacy',
        trust_level: 'unverified',
        review_status: 'proposed',
      }),
    ]);
  });

  it('preserves explicit provenance in current graph data', () => {
    const source = {
      version: '2.0',
      exported_at: timestamp,
      entities: [],
      edges: [],
      episodes: [
        {
          uuid: '00000000-0000-4000-8000-000000000003',
          group_id: 'current-group',
          content: 'Trusted source',
          role: 'human',
          source_type: 'message',
          reference_time: timestamp,
          previous_episode_uuid: null,
          created_at: timestamp,
          updated_at: null,
          source_message_id: 'message-1',
          idempotency_key: null,
          conversation_id: null,
          sender_id: 'sender-1',
          sender_name: 'Alice',
          episode_kind: 'active_human',
          quoted_message_id: null,
          trust_level: 'trusted',
          confidence: 0.9,
          review_status: 'accepted',
          source_workflow_id: null,
          source_execution_id: null,
          attributes: {},
        },
      ],
    } as const;

    const migration = migrateGraphData(source);

    expect(migration.report.migration_required).toBe(false);
    expect(migration.report.source_checksum_removed).toBe(false);
    expect(migration.data.episodes[0]).toEqual(expect.objectContaining(source.episodes[0]));
  });

  it('reports dangling entity and episode references without modifying data', () => {
    const migration = migrateGraphData({
      version: '1.0',
      exported_at: timestamp,
      entities: [],
      edges: [
        {
          uuid: '00000000-0000-4000-8000-000000000010',
          group_id: 'g1',
          source_node_uuid: '00000000-0000-4000-8000-000000000011',
          target_node_uuid: '00000000-0000-4000-8000-000000000012',
          name: 'RELATES_TO',
          fact: 'Missing endpoints',
          created_at: timestamp,
          updated_at: timestamp,
        },
      ],
      episodes: [
        {
          uuid: '00000000-0000-4000-8000-000000000013',
          group_id: 'g1',
          content: 'Broken chain',
          role: 'human',
          reference_time: timestamp,
          previous_episode_uuid: '00000000-0000-4000-8000-000000000014',
          created_at: timestamp,
        },
      ],
    });

    expect(migration.report.warnings).toEqual([
      '1 edge(s) reference entities missing from the import data.',
      '1 episode(s) reference previous episodes missing from the import data.',
    ]);
  });
});
