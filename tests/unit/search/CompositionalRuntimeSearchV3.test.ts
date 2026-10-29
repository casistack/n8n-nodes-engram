import { performance } from 'perf_hooks';
import { makeCompositionalCommittedClaimFixture } from '../../helpers/compositionalCommittedClaimFixture';
import type { IGraphStorage, EdgeSearchResult } from '../../../src/storage/IGraphStorage';
import { loadCompositionalRuntimeReaderV3 } from '../../../src/search/CompositionalRuntimeReaderV3';
import { beginAutomaticClaimReadAttempt } from '../../../src/storage/AutomaticClaimReadScope';
import { CompositionalRetrievalSnapshotV3Schema } from '../../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import {
  governCompositionalRuntimeEdgesV3,
  getCompositionalRuntimeLexicalHintV3,
} from '../../../src/search/CompositionalRuntimeSearchV3';
import { RetrievalGovernance } from '../../../src/search/RetrievalGovernance';
import { HybridSearchEngine } from '../../../src/search/HybridSearchEngine';
import { governedContext } from '../../../src/search/GovernedContext';
import { reviewExtractionMetadata } from '../../../src/schemas/ExtractionMetadata.schema';
const NOW = '2026-10-25T12:00:03.000Z';
async function setup(f = makeCompositionalCommittedClaimFixture()) {
  const edge = f.graph.edges[0],
    subject = f.graph.entities.find((row) => row.uuid === edge.source_node_uuid)!,
    value = f.graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
  const hit: EdgeSearchResult = {
    edge,
    sourceEntity: subject,
    targetEntity: value,
    score: 1,
    match_evidence: { text: true, vector: false },
  };
  const getEpisodes = jest.fn(async () => []),
    getEntity = jest.fn(async () => {
      throw new Error('live getter');
    });
  const storage = {
    readCompositionalRetrievalSnapshotV3: async (
      scope: Parameters<typeof beginAutomaticClaimReadAttempt>[0],
    ) => {
      if (!beginAutomaticClaimReadAttempt(scope))
        return { status: 'deferred', reason: 'budget_exhausted' };
      return CompositionalRetrievalSnapshotV3Schema.parse({
        status: 'snapshot',
        graph: f.graph,
        backendNow: NOW,
      });
    },
    getEpisodes,
    getEntity,
    searchEntities: jest.fn(async () => []),
    searchEdges: jest.fn(async () => [hit]),
  } as unknown as IGraphStorage;
  const budget = { remaining: 512, deferred: 0 };
  const loaded = await loadCompositionalRuntimeReaderV3(
    storage,
    { namespace: f.request.namespace },
    { budget },
  );
  if (loaded.status !== 'ready') throw new Error('Expected reader');
  return { ...f, hit, storage, budget, reader: loaded.reader, getEpisodes, getEntity };
}
describe('opt-in compositional search governance', () => {
  afterEach(() => jest.restoreAllMocks());
  it('publishes only exact full rows with complete literal provenance and identity-bound hints', async () => {
    const h = await setup();
    const result = governCompositionalRuntimeEdgesV3(h.reader, [h.hit]);
    expect(result.results).toHaveLength(1);
    const final = result.results[0];
    expect(final.edge.fact).toBe(h.hit.edge.fact);
    expect(getCompositionalRuntimeLexicalHintV3(final)).toBe(h.hit.edge.fact);
    expect(getCompositionalRuntimeLexicalHintV3({ ...final })).toBeNull();
    expect(getCompositionalRuntimeLexicalHintV3(structuredClone(final))).toBeNull();
    expect(Object.isFrozen(final)).toBe(true);
    expect(final.provenance![0]).toMatchObject({
      source_episode_uuid: h.source.uuid,
      speaker_role: 'human',
      fact_review_status: 'accepted',
    });
    expect(h.budget.remaining).toBe(500);
  });
  it.each(['edge', 'sourceEntity', 'targetEntity'] as const)(
    'rejects a changed complete %s row, even with unchanged IDs',
    async (field) => {
      const h = await setup(),
        hit = structuredClone(h.hit);
      if (field === 'edge') hit.edge.fact += ' changed';
      else hit[field].summary += ' changed';
      expect(governCompositionalRuntimeEdgesV3(h.reader, [hit]).results).toEqual([]);
      expect(getCompositionalRuntimeLexicalHintV3(hit)).toBeNull();
    },
  );
  it('retains original proposed-at-commit lineage after actual paired manual acceptance', async () => {
    const f = makeCompositionalCommittedClaimFixture('proposed');
    const edge = f.graph.edges[0],
      value = f.graph.entities.find((row) => row.uuid === edge.target_node_uuid)!;
    const original = structuredClone(f.operation);
    for (const row of [edge, value])
      row.attributes.engram_extraction = reviewExtractionMetadata(
        row.attributes.engram_extraction,
        'accepted',
        'synthetic-operator',
        '2026-10-25T12:00:02.000Z',
      );
    const h = await setup(f);
    const result = await new RetrievalGovernance(h.storage).governEdges(
      [h.hit],
      {},
      undefined,
      undefined,
      h.reader,
    );
    expect(result).toHaveLength(1);
    expect(result[0].provenance![0]).toMatchObject({
      creation_review_status: 'proposed',
      fact_review_status: 'accepted',
      creation_operation_uuid: original.operationId,
      creation_committed_at: original.terminalReceipt.terminalAt,
    });
    expect(f.operation).toEqual(original);
    expect(getCompositionalRuntimeLexicalHintV3(result[0])).toBe(edge.fact);
  });
  it('authenticates before getters and rejects proxy/getter/then shapes without invoking traps', async () => {
    const h = await setup();
    let calls = 0;
    const getter = Object.defineProperty({}, 'edge', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('unsafe');
      },
    });
    expect(governCompositionalRuntimeEdgesV3({}, [getter], getter).results).toEqual([]);
    expect(governCompositionalRuntimeEdgesV3(h.reader, [getter]).results).toEqual([]);
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          calls++;
          throw new Error('unsafe');
        },
        get() {
          calls++;
          throw new Error('unsafe');
        },
      },
    );
    expect(governCompositionalRuntimeEdgesV3(h.reader, [proxy]).results).toEqual([]);
    expect(governCompositionalRuntimeEdgesV3(h.reader, [h.hit], getter).results).toEqual([]);
    expect(calls).toBe(0);
  });
  it('does not synthesize omitted/default row fields or discard unknown attributes during exact matching', async () => {
    const h = await setup(),
      hit = structuredClone(h.hit);
    delete (hit.edge as Partial<typeof hit.edge>).fact_embedding;
    expect(governCompositionalRuntimeEdgesV3(h.reader, [hit]).results).toEqual([]);
    const proto = structuredClone(h.hit);
    Object.defineProperty(proto.edge.attributes, '__proto__', {
      value: { extra: true },
      enumerable: true,
    });
    expect(governCompositionalRuntimeEdgesV3(h.reader, [proto]).results).toEqual([]);
  });
  it.each(['historical', 'asOf'] as const)(
    'withholds rich %s context without changing history',
    async (mode) => {
      const h = await setup();
      expect(governCompositionalRuntimeEdgesV3(h.reader, [h.hit], {}, { mode }).results).toEqual(
        [],
      );
      expect(h.operation.state).toBe('committed');
    },
  );
  it.each([
    { sender_id: 'other' },
    { trust_level: 'untrusted' },
    { episode_kind: 'tool_output' },
    { source_execution_id: 'other' },
    { review_statuses: ['proposed'] },
    { reference_after: '2099-01-01T00:00:00.000Z' },
  ])('applies actual creator source/review filters %j', async (filters) => {
    const h = await setup();
    expect(governCompositionalRuntimeEdgesV3(h.reader, [h.hit], filters).results).toEqual([]);
  });
  it('partitions rich hits before old episode hydration and keeps default omitted-reader behavior', async () => {
    const h = await setup(),
      governance = new RetrievalGovernance(h.storage);
    const result = await governance.governEdges([h.hit], {}, undefined, undefined, h.reader);
    expect(result).toHaveLength(1);
    expect(h.getEpisodes).not.toHaveBeenCalled();
    expect(h.getEntity).not.toHaveBeenCalled();
    expect(await governance.governEdges([h.hit])).toEqual([]);
    expect(h.getEpisodes).toHaveBeenCalledTimes(1);
  });
  it('keeps complete rich relationship terms after target-name stripping and omits over-budget whole lines', async () => {
    const h = await setup(),
      engine = new HybridSearchEngine(h.storage);
    const found = await engine.search('technical', h.request.namespace, {
      compositionalReader: h.reader,
    });
    expect(found.edges).toHaveLength(1);
    expect(engine.formatAsContext(found, 1, true)).toBe('');
    const result = await governedContext(h.storage, engine, 'technical', h.request.namespace, {
      mode: 'current',
      limit: 10,
      minScore: 0,
      tokenBudget: 4096,
      traversal: false,
      hops: 1,
      acceptedOnly: true,
      filters: {},
      compositionalReader: h.reader,
    });
    expect(result.context).toContain(h.hit.edge.fact);
    expect(result.audit.returned).toBe(1);
    expect(result.context).not.toContain('temporal=unknown');
  });
  it('reuses the same projection fee for search and traversal and never live-hydrates traversal rows', async () => {
    const h = await setup(),
      engine = new HybridSearchEngine(h.storage);
    await engine.search('technical', h.request.namespace, { compositionalReader: h.reader });
    const remaining = h.budget.remaining;
    expect(
      await engine.governTraversalEdges([h.hit.edge], {}, undefined, undefined, h.reader),
    ).toHaveLength(1);
    expect(h.budget.remaining).toBe(remaining);
    expect(h.getEntity).not.toHaveBeenCalled();
  });
  it('does not retain a lexical hint or render a rich line after shared expiry', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = await setup(),
      final = governCompositionalRuntimeEdgesV3(h.reader, [h.hit]).results[0];
    now = 5001;
    expect(getCompositionalRuntimeLexicalHintV3(final)).toBeNull();
    expect(
      new HybridSearchEngine(h.storage).formatAsContext({ entities: [], edges: [final] }),
    ).toBe('');
    const engine = new HybridSearchEngine(h.storage),
      search = jest.spyOn(engine, 'search');
    expect(
      (
        await governedContext(h.storage, engine, 'technical', h.request.namespace, {
          mode: 'current',
          limit: 10,
          minScore: 0,
          traversal: false,
          hops: 1,
          acceptedOnly: true,
          filters: {},
          compositionalReader: h.reader,
        })
      ).context,
    ).toBe('');
    expect(search).not.toHaveBeenCalled();
  });
  it('does not register a hit when final freeze crosses the original deadline', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const h = await setup(),
      freeze = Object.freeze;
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const result = freeze(value);
      if (value && typeof value === 'object' && 'provenance' in value) now = 5001;
      return result;
    });
    expect(governCompositionalRuntimeEdgesV3(h.reader, [h.hit]).results).toEqual([]);
  });
  it.each(['proposed', 'rejected', 'missing_operation'] as const)(
    'does not give %s rows a rich lexical hint',
    async (state) => {
      const f = makeCompositionalCommittedClaimFixture(
        state === 'proposed' ? 'proposed' : 'accepted',
      );
      if (state === 'rejected')
        for (const row of [
          ...f.graph.edges,
          ...f.graph.entities.filter((row) => row.uuid === f.graph.edges[0].target_node_uuid),
        ])
          row.attributes.engram_extraction = reviewExtractionMetadata(
            row.attributes.engram_extraction,
            'rejected',
            'synthetic-reviewer',
            NOW,
          );
      if (state === 'missing_operation')
        f.graph.automatic_operations_v1 = { version: 1, operations: [] };
      const h = await setup(f);
      expect(governCompositionalRuntimeEdgesV3(h.reader, [h.hit]).results).toEqual([]);
      expect(getCompositionalRuntimeLexicalHintV3(h.hit)).toBeNull();
    },
  );
  it('hides attributed value entities and malformed opt-in hit/traversal shapes without getters', async () => {
    const h = await setup(),
      governance = new RetrievalGovernance(h.storage);
    expect(await governance.governEntities([{ entity: h.hit.targetEntity, score: 1 }])).toEqual([]);
    let calls = 0;
    const raw = Object.defineProperty({}, 'uuid', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('unsafe');
      },
    });
    expect(
      await new HybridSearchEngine(h.storage).governTraversalEdges(
        [raw as typeof h.hit.edge],
        {},
        undefined,
        undefined,
        h.reader,
      ),
    ).toEqual([]);
    expect(
      await governance.governEdges(
        [{ edge: null } as unknown as EdgeSearchResult],
        {},
        undefined,
        undefined,
        h.reader,
      ),
    ).toEqual([]);
    expect(calls).toBe(0);
  });
});
