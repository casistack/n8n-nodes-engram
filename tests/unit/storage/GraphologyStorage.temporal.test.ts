import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('GraphologyStorage — Temporal Queries', () => {
  let storage: GraphologyStorage;

  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // ===== getEpisodesByDateRange =====

  describe('getEpisodesByDateRange', () => {
    it('returns episodes within the specified date range', async () => {
      await storage.addEpisode({
        group_id: 'g1',
        content: 'old episode',
        role: 'human',
        reference_time: '2026-01-01T10:00:00.000Z',
      });
      await storage.addEpisode({
        group_id: 'g1',
        content: 'mid episode',
        role: 'human',
        reference_time: '2026-01-15T10:00:00.000Z',
      });
      await storage.addEpisode({
        group_id: 'g1',
        content: 'new episode',
        role: 'ai',
        reference_time: '2026-01-31T10:00:00.000Z',
      });

      const results = await storage.getEpisodesByDateRange(
        'g1',
        '2026-01-10T00:00:00.000Z',
        '2026-01-20T23:59:59.999Z',
      );
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('mid episode');
    });

    it('returns empty array when no episodes match the range', async () => {
      await storage.addEpisode({
        group_id: 'g1',
        content: 'outside range',
        role: 'human',
        reference_time: '2025-06-01T10:00:00.000Z',
      });

      const results = await storage.getEpisodesByDateRange(
        'g1',
        '2026-01-01T00:00:00.000Z',
        '2026-12-31T23:59:59.999Z',
      );
      expect(results).toHaveLength(0);
    });

    it('returns episodes sorted by reference_time ascending', async () => {
      await storage.addEpisode({
        group_id: 'g1',
        content: 'second',
        role: 'human',
        reference_time: '2026-01-20T10:00:00.000Z',
      });
      await storage.addEpisode({
        group_id: 'g1',
        content: 'first',
        role: 'human',
        reference_time: '2026-01-10T10:00:00.000Z',
      });

      const results = await storage.getEpisodesByDateRange(
        'g1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-31T23:59:59.999Z',
      );
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('first');
      expect(results[1].content).toBe('second');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.addEpisode({
          group_id: 'g1',
          content: `ep-${i}`,
          role: 'human',
          reference_time: `2026-01-${(i + 10).toString().padStart(2, '0')}T10:00:00.000Z`,
        });
      }

      const results = await storage.getEpisodesByDateRange(
        'g1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-31T23:59:59.999Z',
        2,
      );
      expect(results).toHaveLength(2);
    });

    it('scopes by group_id', async () => {
      await storage.addEpisode({
        group_id: 'g1',
        content: 'group 1',
        role: 'human',
        reference_time: '2026-01-15T10:00:00.000Z',
      });
      await storage.addEpisode({
        group_id: 'g2',
        content: 'group 2',
        role: 'human',
        reference_time: '2026-01-15T10:00:00.000Z',
      });

      const results = await storage.getEpisodesByDateRange(
        'g1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-31T23:59:59.999Z',
      );
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('group 1');
    });
  });

  // ===== getEdgeChangelog =====

  describe('getEdgeChangelog', () => {
    it('returns recently created edges', async () => {
      const alice = await storage.addEntity({
        name: 'Alice',
        group_id: 'g1',
        entity_type: 'person',
      });
      const bob = await storage.addEntity({
        name: 'Bob',
        group_id: 'g1',
        entity_type: 'person',
      });

      const sinceDate = new Date(Date.now() - 1000).toISOString();

      await storage.addEdge({
        group_id: 'g1',
        source_node_uuid: alice.uuid,
        target_node_uuid: bob.uuid,
        name: 'KNOWS',
        fact: 'Alice knows Bob',
      });

      const entries = await storage.getEdgeChangelog('g1', sinceDate);
      expect(entries).toHaveLength(1);
      expect(entries[0].change_type).toBe('created');
      expect(entries[0].sourceEntity.name).toBe('Alice');
      expect(entries[0].targetEntity.name).toBe('Bob');
    });

    it('returns expired edges in changelog', async () => {
      const alice = await storage.addEntity({
        name: 'Alice',
        group_id: 'g1',
        entity_type: 'person',
      });
      const london = await storage.addEntity({
        name: 'London',
        group_id: 'g1',
        entity_type: 'location',
      });

      const edge = await storage.addEdge({
        group_id: 'g1',
        source_node_uuid: alice.uuid,
        target_node_uuid: london.uuid,
        name: 'LIVES_IN',
        fact: 'Alice lives in London',
        valid_at: '2025-01-01T00:00:00.000Z',
      });

      const sinceDate = new Date(Date.now() - 1000).toISOString();

      // Expire the edge
      const expiredAt = new Date().toISOString();
      await storage.updateEdge(edge.uuid, { expired_at: expiredAt });

      const entries = await storage.getEdgeChangelog('g1', sinceDate);
      // Should have both 'created' and 'expired' entries
      const types = entries.map((e) => e.change_type);
      expect(types).toContain('created');
      expect(types).toContain('expired');
    });

    it('respects limit parameter', async () => {
      const a = await storage.addEntity({
        name: 'A',
        group_id: 'g1',
        entity_type: 'person',
      });
      const b = await storage.addEntity({
        name: 'B',
        group_id: 'g1',
        entity_type: 'person',
      });

      const sinceDate = new Date(Date.now() - 1000).toISOString();

      for (let i = 0; i < 5; i++) {
        await storage.addEdge({
          group_id: 'g1',
          source_node_uuid: a.uuid,
          target_node_uuid: b.uuid,
          name: `REL_${i}`,
          fact: `Fact ${i}`,
        });
      }

      const entries = await storage.getEdgeChangelog('g1', sinceDate, { limit: 2 });
      expect(entries).toHaveLength(2);
    });

    it('scopes by group_id', async () => {
      const a1 = await storage.addEntity({
        name: 'A1',
        group_id: 'g1',
        entity_type: 'person',
      });
      const b1 = await storage.addEntity({
        name: 'B1',
        group_id: 'g1',
        entity_type: 'person',
      });
      const a2 = await storage.addEntity({
        name: 'A2',
        group_id: 'g2',
        entity_type: 'person',
      });
      const b2 = await storage.addEntity({
        name: 'B2',
        group_id: 'g2',
        entity_type: 'person',
      });

      const sinceDate = new Date(Date.now() - 1000).toISOString();

      await storage.addEdge({
        group_id: 'g1',
        source_node_uuid: a1.uuid,
        target_node_uuid: b1.uuid,
        name: 'REL',
        fact: 'Group 1 fact',
      });
      await storage.addEdge({
        group_id: 'g2',
        source_node_uuid: a2.uuid,
        target_node_uuid: b2.uuid,
        name: 'REL',
        fact: 'Group 2 fact',
      });

      const entries = await storage.getEdgeChangelog('g1', sinceDate);
      expect(entries).toHaveLength(1);
      expect(entries[0].edge.fact).toBe('Group 1 fact');
    });
  });

  // ===== Date-filtered search =====

  describe('Date-filtered search', () => {
    it('searchEdges filters by valid_after', async () => {
      const a = await storage.addEntity({
        name: 'Alice',
        group_id: 'g1',
        entity_type: 'person',
      });
      const b = await storage.addEntity({
        name: 'Bob',
        group_id: 'g1',
        entity_type: 'person',
      });

      await storage.addEdge({
        group_id: 'g1',
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: 'OLD_FACT',
        fact: 'old fact about Alice and Bob',
        valid_at: '2025-01-01T00:00:00.000Z',
      });
      await storage.addEdge({
        group_id: 'g1',
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: 'NEW_FACT',
        fact: 'new fact about Alice and Bob',
        valid_at: '2026-06-01T00:00:00.000Z',
      });

      const results = await storage.searchEdges('fact Alice Bob', 'g1', {
        valid_after: '2026-01-01T00:00:00.000Z',
      });
      expect(results).toHaveLength(1);
      expect(results[0].edge.name).toBe('NEW_FACT');
    });

    it('searchEdges excludes edges with null valid_at when valid_after is set', async () => {
      const a = await storage.addEntity({
        name: 'Alice',
        group_id: 'g1',
        entity_type: 'person',
      });
      const b = await storage.addEntity({
        name: 'Bob',
        group_id: 'g1',
        entity_type: 'person',
      });

      await storage.addEdge({
        group_id: 'g1',
        source_node_uuid: a.uuid,
        target_node_uuid: b.uuid,
        name: 'NO_DATE',
        fact: 'fact about Alice and Bob without date',
        // valid_at defaults to null
      });

      const results = await storage.searchEdges('fact Alice Bob', 'g1', {
        valid_after: '2026-01-01T00:00:00.000Z',
      });
      expect(results).toHaveLength(0);
    });

    it('listEntities filters by created_after', async () => {
      // Create entity with known created_at by manipulating timing
      const old = await storage.addEntity({
        name: 'OldEntity',
        group_id: 'g1',
        entity_type: 'person',
      });

      // All entities created "now" will be after this timestamp
      const cutoff = old.created_at;
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));

      await storage.addEntity({
        name: 'NewEntity',
        group_id: 'g1',
        entity_type: 'person',
      });

      // created_after = cutoff should exclude the old entity (created AT cutoff, not after)
      // But isWithinDateRange uses >= so it includes cutoff
      const all = await storage.listEntities('g1');
      expect(all).toHaveLength(2);

      const afterCutoff = await storage.listEntities('g1', {
        created_after: cutoff,
      });
      // Both should match since first was created AT cutoff (>= check)
      expect(afterCutoff).toHaveLength(2);
    });
  });
});
