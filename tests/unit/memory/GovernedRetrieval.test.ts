import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { HybridSearchEngine } from '../../../src/search/HybridSearchEngine';
import { governedContext } from '../../../src/search/GovernedContext';
import { randomUUID } from 'crypto';

const group = 'governed';
describe('governed current and historical context', () => {
  let storage: GraphologyStorage;
  const original = global.fetch;
  beforeEach(async () => {
    storage = new GraphologyStorage();
    await storage.initialize();
  });
  afterEach(async () => {
    global.fetch = original;
    await storage.close();
  });
  async function fixture(fact = 'Alice lives in London', extra = {}) {
    const a = await storage.addEntity({
      group_id: group,
      name: 'Alice',
      entity_type: 'person',
      summary: 'Alice watches the game tomorrow',
      name_embedding: [1, 0],
    });
    const b = await storage.addEntity({
      group_id: group,
      name: 'London',
      entity_type: 'location',
      name_embedding: [1, 0],
    });
    const source = await storage.addEpisode({
      group_id: group,
      role: 'human',
      episode_kind: 'active_human',
      trust_level: 'standard',
      review_status: 'accepted',
      content: fact,
      reference_time: '2026-04-09T12:00:00Z',
    });
    const edge = await storage.addEdge({
      group_id: group,
      source_node_uuid: a.uuid,
      target_node_uuid: b.uuid,
      name: 'LIVES_IN',
      fact,
      episodes: [source.uuid],
      ...extra,
    });
    await storage.appendEpisode({
      group_id: group,
      role: 'human',
      content: 'Recent hello',
      reference_time: '2026-10-24T12:00:00Z',
    });
    return { a, b, edge, source };
  }
  function memory(mode: 'current' | 'historical' | 'asOf' = 'current', extra = {}) {
    return new EngramChatMemory({
      storage,
      groupId: group,
      retrievalMode: mode,
      minRelevanceScore: 0,
      acceptedOnlyRetrieval: true,
      enableTraversal: true,
      contextWindow: 1,
      ...extra,
    });
  }
  function system(result: any) {
    return result.variables.chat_history
      .filter((message: any) => message._getType() === 'system')
      .map((message: any) => message.content)
      .join('\n');
  }
  it('retains live/lives recall, renders a search/traversal edge once and omits ungrounded entity summaries', async () => {
    await fixture();
    const result = await memory().loadMemoryVariablesWithDiagnostics({
      input: 'Where does Alice live?',
    });
    const text = system(result);
    expect(text).toContain('Alice lives in London');
    expect(text.match(/Alice lives in London/g)).toHaveLength(1);
    expect(text).not.toContain('watches the game tomorrow');
    expect(text).toContain('2026-04-09');
    expect(result.diagnostics.retrieval.selection!.duplicate_uuid).toBeGreaterThan(0);
  });
  it.each(['2026-10-24', '2026-10-24T12:00:00', '10/24/2026'])(
    'rejects ambiguous asOf input %s under every host timezone',
    (retrievalAt) => {
      const previous = process.env.TZ;
      try {
        for (const timezone of ['UTC', 'America/Los_Angeles']) {
          process.env.TZ = timezone;
          expect(() => memory('asOf', { retrievalAt })).toThrow('as_of_requires_timestamp');
        }
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );
  it('does not represent old relative-date plans as current but retrieves them explicitly historically', async () => {
    await fixture('Alice plans to watch the game tomorrow', {
      name: 'WATCHES_GAME',
      expired_at: '2026-04-11T00:00:00Z',
      invalid_at: '2026-04-11T00:00:00Z',
    });
    const current = await memory().loadMemoryVariablesWithDiagnostics({
      input: 'What game did Alice plan?',
    });
    expect(system(current)).not.toContain('game tomorrow');
    const past = await memory('historical').loadMemoryVariablesWithDiagnostics({
      input: 'What games did Alice plan previously?',
    });
    expect(system(past)).toContain('game tomorrow');
    expect(system(past)).toContain('Historical evidence');
    expect(system(past)).toContain('2026-04-09');
  });
  it('applies the separate historical evidence allowance without consuming the conversation window', async () => {
    await fixture();
    const result = await memory('historical', {
      graphEvidenceBudgets: { historical: 0 },
    }).loadMemoryVariablesWithDiagnostics({ input: 'Where does Alice live?' });
    expect(system(result)).toBe('');
    expect(result.diagnostics.retrieval.selection!.budget).toBeGreaterThan(0);
    expect(result.diagnostics.history.returned).toBe(1);
  });
  it('defers high-provenance candidates within a shared search/traversal hydration bound while preserving legacy behavior', async () => {
    const { edge } = await fixture();
    await storage.updateEdge(edge.uuid, {
      episodes: Array.from({ length: 5000 }, () => randomUUID()),
    });
    const hydrate = jest.spyOn(storage, 'getEpisodes');
    try {
      const engine = new HybridSearchEngine(storage);
      const result = await governedContext(storage, engine, 'Where does Alice live?', group, {
        mode: 'current',
        limit: 20,
        minScore: 0,
        traversal: true,
        hops: 1,
        acceptedOnly: true,
        filters: {},
      });
      expect(result.context).toBe('');
      expect(result.audit).toMatchObject({ truncated: true });
      expect(result.audit.source_reference_deferred).toBeGreaterThan(0);
      expect(
        hydrate.mock.calls.reduce((total, [ids]) => total + ids.length, 0),
      ).toBeLessThanOrEqual(512);
      hydrate.mockClear();
      await engine.search('Alice', group, { minScore: 0 });
      expect(hydrate.mock.calls.some(([ids]) => ids.length === 5000)).toBe(true);
    } finally {
      hydrate.mockRestore();
    }
  });
  it('treats unresolved old plans as uncertain even when the legacy edge is not expired', async () => {
    await fixture('Alice plans to watch the game tomorrow', { name: 'WATCHES_GAME' });
    const current = await memory().loadMemoryVariablesWithDiagnostics({
      input: 'What game does Alice watch?',
    });
    expect(system(current)).toBe('');
    expect(current.diagnostics.retrieval.selection!.uncertain_time).toBeGreaterThan(0);
  });
  it('uses half-open event intervals for asOf without pretending to reconstruct past knowledge state', async () => {
    await fixture('Alice watches the game tomorrow', {
      name: 'WATCHES_GAME',
      attributes: {
        engram_memory_quality: {
          version: 1,
          category: 'event_plan',
          policy: 'durableTemporal',
          evidence: [],
          temporal: {
            status: 'resolved',
            source_times: ['2026-04-09T12:00:00Z'],
            timezone: 'UTC',
            start: '2026-04-10T00:00:00Z',
            end: '2026-04-11T00:00:00Z',
            precision: 'day',
          },
        },
      },
    });
    expect(
      system(
        await memory('asOf', {
          retrievalAt: '2026-04-10T00:00:00Z',
        }).loadMemoryVariablesWithDiagnostics({ input: 'What game did Alice watch?' }),
      ),
    ).toContain('game tomorrow');
    expect(
      system(
        await memory('asOf', {
          retrievalAt: '2026-04-11T00:00:00Z',
        }).loadMemoryVariablesWithDiagnostics({ input: 'What game did Alice watch?' }),
      ),
    ).toBe('');
  });
  it('preserves semantic vector evidence for a paraphrase without accepting a sender-only query', async () => {
    await fixture('Alice resides by the sea', { name: 'RESIDES_NEAR', fact_embedding: [1, 0] });
    global.fetch = jest
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] })),
      );
    const m = memory('current', {
      embeddingConfig: { apiKey: 'test', baseUrl: 'https://provider.test', model: 'embed' },
    });
    expect(
      system(await m.loadMemoryVariablesWithDiagnostics({ input: "Where is Alice's dwelling?" })),
    ).toContain('Alice resides by the sea');
    expect(system(await m.loadMemoryVariablesWithDiagnostics({ input: 'Alice' }))).toBe('');
  });
});
