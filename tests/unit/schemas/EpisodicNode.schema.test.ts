import { CreateEpisodicNodeSchema, EpisodicNodeSchema } from '../../../src/schemas';

const timestamp = '2026-07-13T20:00:00.000Z';

describe('EpisodicNodeSchema', () => {
  it('normalizes legacy episodes to conservative provenance defaults', () => {
    const episode = EpisodicNodeSchema.parse({
      uuid: '00000000-0000-4000-8000-000000000001',
      group_id: 'group-1',
      content: 'Legacy content',
      role: 'human',
      reference_time: timestamp,
      created_at: timestamp,
    });

    expect(episode.episode_kind).toBe('legacy');
    expect(episode.trust_level).toBe('unverified');
    expect(episode.review_status).toBe('proposed');
    expect(episode.confidence).toBeNull();
    expect(episode.source_message_id).toBeNull();
    expect(episode.attributes).toEqual({});
    expect(episode.updated_at).toBeNull();
  });

  it('accepts structured provenance metadata for new episodes', () => {
    const episode = CreateEpisodicNodeSchema.parse({
      group_id: 'group-1',
      content: 'I prefer email notifications.',
      role: 'human',
      reference_time: timestamp,
      source_message_id: 'whatsapp-message-42',
      idempotency_key: 'tenant-1:whatsapp-message-42',
      conversation_id: 'conversation-7',
      sender_id: 'user-9',
      sender_name: 'Alice',
      episode_kind: 'active_human',
      quoted_message_id: 'whatsapp-message-41',
      trust_level: 'trusted',
      confidence: 0.95,
      review_status: 'accepted',
      source_workflow_id: 'workflow-3',
      source_execution_id: 'execution-12',
      attributes: { channel: 'whatsapp', tenant: 'tenant-1' },
    });

    expect(episode.source_message_id).toBe('whatsapp-message-42');
    expect(episode.episode_kind).toBe('active_human');
    expect(episode.trust_level).toBe('trusted');
    expect(episode.confidence).toBe(0.95);
    expect(episode.attributes).toEqual({ channel: 'whatsapp', tenant: 'tenant-1' });
  });

  it.each([-0.01, 1.01])('rejects confidence outside the 0..1 range: %s', (confidence) => {
    const result = CreateEpisodicNodeSchema.safeParse({
      group_id: 'group-1',
      content: 'Invalid confidence',
      role: 'human',
      reference_time: timestamp,
      confidence,
    });

    expect(result.success).toBe(false);
  });

  it('rejects empty identifiers when they are supplied', () => {
    const result = CreateEpisodicNodeSchema.safeParse({
      group_id: 'group-1',
      content: 'Invalid source ID',
      role: 'human',
      reference_time: timestamp,
      source_message_id: '   ',
    });

    expect(result.success).toBe(false);
  });
});
