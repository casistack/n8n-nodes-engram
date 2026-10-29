import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { AutonomousPersonalOperationV4 } from '../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  publishAutonomousPersonalMemoryHandoffV4,
  type PrivateAutonomousPersonalMemoryLineageV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import * as parentReaderApi from '../../src/memory/AutonomousPersonalMemoryParentReaderV4';
import {
  getCompositionalRuntimeAutomaticReadContextV3,
  loadCompositionalCompatibilityRuntimeReaderV4,
} from '../../src/search/CompositionalRuntimeReaderV3';
import { getAutonomousPersonalRuntimeDisplayV4 } from '../../src/search/AutonomousPersonalRuntimeSearchV4';
import { AutonomousPersonalRuntimeDisplayV4OwnedDataSchema } from '../../src/schemas/AutonomousPersonalRuntimeSearchV4.schema';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import * as recordIntegrityApi from '../../src/storage/AutonomousPersonalRecordIntegrityV4';
import {
  getAutomaticClaimReadScope,
  type AutomaticClaimReadScope,
} from '../../src/storage/AutomaticClaimReadScope';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../../src/schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../../src/schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { CompositionalRuntimeReaderV3 } from '../../src/schemas/CompositionalRuntimeReaderV3.schema';
import type { EdgeSearchResult, IGraphStorage } from '../../src/storage/IGraphStorage';
import type { EmbeddingService } from '../../src/embeddings/EmbeddingService';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { HybridSearchEngine, type HybridSearchOptions } from '../../src/search/HybridSearchEngine';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import {
  autonomousPersonalMemoryContextV4,
  autonomousPersonalMemoryStoreHashV4,
} from '../helpers/autonomousPersonalMemoryBackend';
import { readAutonomousPersonalNativeMemoryConfigV4 } from '../../src/utils/AutonomousPersonalNativeMemoryConfigV4';
import { governedContext } from '../../src/search/GovernedContext';

// StagedGraph's production facade deliberately ignores property writes. Wrap its
// real methods at construction rather than asking jest.spyOn to replace a proxy
// property. Every invocation still reaches the genuine staged implementation.
jest.mock('../../src/extraction/StagedGraph', () => {
  const actual = jest.requireActual<typeof import('../../src/extraction/StagedGraph')>(
    '../../src/extraction/StagedGraph',
  );
  return {
    ...actual,
    StagedGraph: class extends actual.StagedGraph {
      constructor(...args: ConstructorParameters<typeof actual.StagedGraph>) {
        super(...args);
        const original = this.storage;
        const methods = new Map<PropertyKey, unknown>();
        Object.defineProperty(this, 'storage', {
          value: new Proxy(original, {
            get(target, key) {
              const value: unknown = Reflect.get(target, key);
              if (typeof value !== 'function') return value;
              if (!methods.has(key)) methods.set(key, jest.fn(value.bind(target)));
              return methods.get(key);
            },
          }),
        });
      }
    },
  };
});

type CommittedOperation = Extract<AutonomousPersonalOperationV4, { state: 'committed' }>;
type Fixture = {
  readonly directory: string;
  readonly owner: GraphologyStorage;
  readonly config: AutonomousPersonalNativeMemoryConfigV4;
  readonly lineage: PrivateAutonomousPersonalMemoryLineageV4;
  readonly parent: parentReaderApi.PrivateAutonomousPersonalMemoryParentReaderV4;
  readonly compatibility: CompositionalRuntimeReaderV3;
  readonly budget: { remaining: number; deferred: number };
  readonly scope: AutomaticClaimReadScope;
  readonly controller: AbortController;
  readonly claimIds: readonly string[];
  readonly sourceId: string;
  readonly namespace: string;
  readonly trusted: { active: boolean; failure: unknown };
  readonly opens: jest.SpyInstance;
};

const QUERY = 'prefer';
const PRIOR_CONTENT =
  'I prefer explanations in plain British English, with one practical example before any technical terminology.';

async function createFixture(): Promise<Fixture> {
  const directory = fs.mkdtempSync(join(tmpdir(), 'engram-runtime-engine-v4-'));
  const workflowId = `runtime-engine-${randomUUID()}`;
  const file = join(directory, `${workflowId}-engram.json`);
  let producer: GraphologyStorage | undefined;
  let owner: GraphologyStorage | undefined;
  let producerOpen = false;
  let ownerOpen = false;
  let parent: parentReaderApi.PrivateAutonomousPersonalMemoryParentReaderV4 | undefined;
  const opens = jest.spyOn(parentReaderApi, 'openAutonomousPersonalMemoryParentReaderV4');
  try {
    producer = new GraphologyStorage(file);
    await producer.initialize();
    producerOpen = true;
    const seed = await seedAutonomousPersonalCaptureSubject(producer);

    const capture = async (
      content: string,
      category: 'preference' | null,
      profileId: 'conservative' | 'explicit',
    ) => {
      const turn = `runtime-engine-turn-${randomUUID()}`;
      const native = {
        instance: `runtime-engine-instance-${turn}`,
        workflow: workflowId,
        execution: `runtime-engine-execution-${turn}`,
      };
      // Synthetic provider response only; no HTTP leaves the process.
      const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        if (category === null) throw new Error('no-claim fixture must not dispatch provider');
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    units: user.units.map(({ unitId }) => ({
                      unitId,
                      category,
                      risk: 'ordinary',
                      usefulness: 'personal_memory',
                      downgrade: [],
                    })),
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      try {
        const context = nativeAutonomousPersonalCaptureContext(seed, {
          content,
          executionId: native.execution,
          workflowId: native.workflow,
          instanceId: native.instance,
          routeId: 'route:runtime-engine-v4',
          model: 'model:runtime-engine-v4',
          requestLimit: 2,
          deadlineMs: 30_000,
          extraParameters: {
            automaticMemoryProfile: profileId,
            automaticIntent: 'disabled',
            automaticTurn: turn,
            automaticInput: content,
            automaticWrapper: 'disabled',
            queueTemperatureMode: 'providerDefault',
          },
        });
        const completed = await completeNativeAutonomousPersonalCaptureV4(context, producer!);
        if (completed.kind !== 'original_turn')
          throw new Error(
            `Expected actual C2 original turn, got ${JSON.stringify(completed)}`,
          );
        const graph = await producer!.exportGraph(seed.request.namespace);
        const operations = (graph.automatic_operations_v1?.operations ?? []).filter(
          (operation): operation is CommittedOperation =>
            operation.version === 4 &&
            operation.state === 'committed' &&
            operation.identity.turn === turn,
        );
        if (operations.length !== 1) throw new Error('Expected one actual committed Operation4');
        const operation = operations[0]!;
        const published = publishAutonomousPersonalMemoryHandoffV4(
          context,
          producer!,
          completed.origin,
        );
        if (published.kind !== 'published')
          throw new Error(`Expected actual C2 handoff, got ${published.kind}`);
        return { operation, sourceId: published.sourceId, native, content };
      } finally {
        provider.mockRestore();
      }
    };

    const prior = await capture(PRIOR_CONTENT, 'preference', 'conservative');
    const receipt = prior.operation.terminalReceipt;
    const claimIds =
      receipt.kind === 'human_autonomous_capture_committed' &&
      receipt.selection.kind === 'occurrences'
        ? receipt.selection.items.flatMap((item) =>
            item.effect === 'created' && item.claimId ? [item.claimId] : [],
          )
        : [];
    if (claimIds.length < 1) throw new Error('Expected an accepted actual Claim3 row');
    const current = await capture('What games are on today?', null, 'explicit');

    await producer.close();
    producerOpen = false;
    owner = new GraphologyStorage(file);
    await owner.initialize();
    ownerOpen = true;

    const storeHash = autonomousPersonalMemoryStoreHashV4(file);
    const identity = current.operation.identity;
    const memoryContext = autonomousPersonalMemoryContextV4({
      persistPath: file,
      storageWorkflowId: workflowId,
      native: current.native,
      namespace: identity.namespace,
      issuer: identity.issuer,
      actorReference: identity.actorReference,
      turn: identity.turn,
      sourceId: current.sourceId,
      profileId: 'explicit',
      explicitIntent: false,
      currentHumanQuery: current.content,
      sourceMapping: { mode: 'full_body' },
      routeId: 'route:runtime-engine-v4',
      model: 'model:runtime-engine-v4',
    });
    const config = await readAutonomousPersonalNativeMemoryConfigV4(memoryContext, 0, storeHash);
    const lineage = consumeAutonomousPersonalMemoryHandoffV4(
      memoryContext,
      config.storeHash,
      config.namespace,
      config.issuer,
      config.actorReference,
      config.turn,
      config.sourceId,
    );
    if (!lineage) throw new Error('Expected genuine C2 lineage for the reopened Memory owner');

    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    const controller = new AbortController();
    const trusted = { active: false, failure: undefined as unknown };
    const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
      absoluteMonotonicDeadlineMs: performance.now() + 30_000,
      signal: controller.signal,
    });
    // Armed only after fixture setup.
    const check = () => {
      if (trusted.active) throw trusted.failure;
    };
    const opened = await parentReaderApi.openAutonomousPersonalMemoryParentReaderV4(
      owner,
      lineage,
      config,
      { scope, work, check },
    );
    if (opened.kind !== 'reader_ready')
      throw new Error(`Expected ParentReader, got ${opened.reason}`);
    parent = opened.reader;
    const loaded = await loadCompositionalCompatibilityRuntimeReaderV4(owner, parent, budget);
    if (loaded.status !== 'ready')
      throw new Error(`Expected compatibility reader, got ${loaded.reason}`);
    return {
      directory,
      owner,
      config,
      lineage,
      parent,
      compatibility: loaded.reader,
      budget,
      scope,
      controller,
      claimIds,
      sourceId: prior.sourceId,
      namespace: identity.namespace,
      trusted,
      opens,
    };
  } catch (error) {
    if (parent && owner) parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(owner, parent);
    if (ownerOpen) await owner?.close();
    if (producerOpen) await producer?.close();
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
    throw error;
  }
}

async function closeFixture(fixture: Fixture): Promise<void> {
  parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(fixture.owner, fixture.parent);
  await fixture.owner.close();
  fs.rmSync(fixture.directory, { recursive: true, force: true });
  jest.restoreAllMocks();
}

function bind(fixture: Fixture, embedding?: EmbeddingService) {
  const bound = HybridSearchEngine.forAutonomousPersonalMemoryV4(
    fixture.owner,
    fixture.parent,
    fixture.compatibility,
    embedding,
  );
  if (!bound) throw new Error('Expected the fixed native engine route');
  return bound;
}

/** Spies every backend read the native route must never use after the single Parent read. */
function spyBackend(fixture: Fixture) {
  return {
    snapshot: jest.spyOn(fixture.owner, 'readCompositionalRetrievalSnapshotV3'),
    searchEntities: jest.spyOn(fixture.owner, 'searchEntities'),
    searchEdges: jest.spyOn(fixture.owner, 'searchEdges'),
    getEntity: jest.spyOn(fixture.owner, 'getEntity'),
    getEpisodes: jest.spyOn(fixture.owner, 'getEpisodes'),
  };
}
function expectNoBackendRead(spies: ReturnType<typeof spyBackend>): void {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
}

function fakeEmbedding(embed: () => Promise<{ embedding: number[] }>): {
  service: EmbeddingService;
  embed: jest.Mock;
} {
  const mock = jest.fn(embed);
  // Only embed() is ever used by the engine.
  return { service: { embed: mock } as unknown as EmbeddingService, embed: mock };
}

type VectorStorage = Required<
  Pick<IGraphStorage, 'searchEntitiesByVector' | 'searchEdgesByVector'>
>;
function spyVectors(storage: IGraphStorage) {
  expect(storage.searchEntitiesByVector).toBeDefined();
  expect(storage.searchEdgesByVector).toBeDefined();
  const vectorStorage = storage as VectorStorage;
  return {
    entities: jest.spyOn(vectorStorage, 'searchEntitiesByVector'),
    edges: jest.spyOn(vectorStorage, 'searchEdgesByVector'),
  };
}

async function actualClaimHit(fixture: Fixture): Promise<EdgeSearchResult> {
  const hits = await fixture.owner.searchEdges(QUERY, fixture.namespace, {
    limit: 200,
    include_expired: true,
  });
  const hit = hits.find((candidate) => fixture.claimIds.includes(candidate.edge.uuid));
  if (!hit) throw new Error('Expected the actual Claim3 edge from the owner search');
  return hit;
}

describe('HybridSearchEngine.forAutonomousPersonalMemoryV4', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers a real text search from the single cached staged store with the full Claim3 meaning', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.opens).toHaveBeenCalledTimes(1);
      const ownerHit = await actualClaimHit(fixture);
      const projection = jest.spyOn(
        parentReaderApi,
        'getAutonomousPersonalMemoryParentNamespaceGraphV4',
      );
      const integrityIndex = jest.spyOn(
        recordIntegrityApi,
        'createIntegrityCheckedAutonomousPersonalClaimIndexV4',
      );
      const backend = spyBackend(fixture);

      const { engine, storage } = bind(fixture);
      const again = HybridSearchEngine.forAutonomousPersonalMemoryV4(
        fixture.owner,
        fixture.parent,
        fixture.compatibility,
      );
      expect(again?.storage).toBe(storage);
      expect(projection).toHaveBeenCalledTimes(1);
      expect(integrityIndex).not.toHaveBeenCalled();

      const stagedSearchEdges = jest.spyOn(storage, 'searchEdges');
      const stagedSearchEntities = jest.spyOn(storage, 'searchEntities');
      const stagedGetEntity = jest.spyOn(storage, 'getEntity');
      const rawStaged = await storage.searchEdges(QUERY, fixture.namespace, {
        limit: 20,
        min_score: 0,
        include_expired: false,
      });
      stagedSearchEdges.mockClear();

      const results = await engine.search(QUERY, fixture.namespace);
      const claimHits = results.edges.filter((hit) => fixture.claimIds.includes(hit.edge.uuid));
      expect(claimHits).toHaveLength(1);
      const hit = claimHits[0]!;
      expect(stagedSearchEdges).toHaveBeenCalledTimes(1);
      expect(stagedSearchEntities).toHaveBeenCalledTimes(1);
      expect(hit.score).toBe(rawStaged.find((raw) => raw.edge.uuid === hit.edge.uuid)?.score);
      expect(hit.edge.fact).toBe(ownerHit.edge.fact);
      expect(hit.provenance?.[0]?.source_episode_uuid).toBe(fixture.sourceId);
      expect(hit.provenance?.[0]?.episode_review_status).toBe('accepted');

      const display = getAutonomousPersonalRuntimeDisplayV4(hit);
      expect(display).not.toBeNull();
      expect(AutonomousPersonalRuntimeDisplayV4OwnedDataSchema.safeParse(display).success).toBe(
        true,
      );
      if (display?.kind !== 'typed_preference') throw new Error('Expected typed preference');
      // Formatter receives the registered hit itself (not a clone).
      const formatted = engine.formatAsContextWithAudit(results, undefined, true);
      const line = formatted.context
        .split('\n')
        .find((l) => l.includes('preference (structured):'));
      expect(line).toContain(JSON.stringify(display.meaning));
      expect(formatted.audit.fact_section.included_ids).toContain(hit.edge.uuid);
      for (const privateField of ['proof', 'rowHash', 'operationId', 'terminalReceipt', 'rawSpan'])
        expect(formatted.context).not.toContain(privateField);

      // Staged traffic only: the backend saw nothing and the Parent was projected exactly once.
      expectNoBackendRead(backend);
      expect(stagedGetEntity).not.toHaveBeenCalled();
      expect(projection).toHaveBeenCalledTimes(1);
      expect(integrityIndex).not.toHaveBeenCalled();
      expect(fixture.opens).toHaveBeenCalledTimes(1);

      // Writes fail instead of falling through to the owner.
      const before = await fixture.owner.exportGraph(fixture.namespace);
      await expect(
        Promise.resolve().then(() => storage.addEntity(hit.sourceEntity)),
      ).rejects.toBeDefined();
      const after = await fixture.owner.exportGraph(fixture.namespace);
      expect(after.entities).toHaveLength(before.entities.length);

      const recalled = await governedContext(
        storage,
        engine,
        'What are my preferences?',
        fixture.namespace,
        {
          mode: 'current',
          limit: 20,
          minScore: 0,
          traversal: false,
          hops: 1,
          acceptedOnly: true,
          filters: {},
          compositionalReader: fixture.compatibility,
        },
      );
      expect(recalled.context).toContain(JSON.stringify(display.meaning));
      expect(recalled.context).not.toContain('preference preferences preferred');
      expectNoBackendRead(backend);
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('rejects unbound factories and caller-supplied routes while preserving original counters and diagnostics', async () => {
    const fixture = await createFixture();
    try {
      const { engine, storage } = bind(fixture);
      const unbound = new GraphologyStorage(join(fixture.directory, 'unbound-engram.json'));
      expect(
        HybridSearchEngine.forAutonomousPersonalMemoryV4(
          unbound,
          fixture.parent,
          fixture.compatibility,
        ),
      ).toBeNull();
      expect(
        HybridSearchEngine.forAutonomousPersonalMemoryV4(
          fixture.owner,
          Object.create(fixture.parent) as typeof fixture.parent,
          fixture.compatibility,
        ),
      ).toBeNull();
      expect(
        HybridSearchEngine.forAutonomousPersonalMemoryV4(
          fixture.owner,
          { ...fixture.parent } as typeof fixture.parent,
          fixture.compatibility,
        ),
      ).toBeNull();
      expect(
        HybridSearchEngine.forAutonomousPersonalMemoryV4(
          fixture.owner,
          fixture.parent,
          {} as CompositionalRuntimeReaderV3,
        ),
      ).toBeNull();

      const stagedSearchEdges = jest.spyOn(storage, 'searchEdges');
      const stagedSearchEntities = jest.spyOn(storage, 'searchEntities');
      const wrong = await engine.search(QUERY, `wrong-${randomUUID()}`);
      expect(wrong).toEqual({ entities: [], edges: [] });
      expect(stagedSearchEdges).not.toHaveBeenCalled();
      expect(stagedSearchEntities).not.toHaveBeenCalled();

      const original = getCompositionalRuntimeAutomaticReadContextV3(fixture.compatibility);
      if (!original) throw new Error('Expected original read counters');
      const fakeReader = {} as CompositionalRuntimeReaderV3;
      const fakeHydration = { remaining: 0, deferred: 0 };
      const fakeAutomatic = {
        mode: 'current',
        sources: { remaining: 0, deferred: 0 },
        conflicts: { remaining: 0 },
      } as unknown as HybridSearchOptions['automaticBudget'];
      const fakeSnapshot = structuredClone({ fakeHydration, fakeAutomatic });
      const sourcesBefore = { ...original.sources };
      const conflictsBefore = { ...original.conflicts };
      const raw = await storage.searchEdges(QUERY, fixture.namespace, { limit: 20, min_score: 0 });
      const rawScore = raw.find((r) => fixture.claimIds.includes(r.edge.uuid))?.score;

      const hostile = await engine.search(QUERY, fixture.namespace, {
        includeDiagnostics: true,
        acceptedOnly: true,
        hydrationBudget: fakeHydration,
        automaticBudget: fakeAutomatic,
        compositionalReader: fakeReader,
      });
      const hit = hostile.edges.find((h) => fixture.claimIds.includes(h.edge.uuid));
      expect(hit).toBeDefined();
      expect(getAutonomousPersonalRuntimeDisplayV4(hit!)).not.toBeNull();
      expect(hit!.score).toBe(rawScore);
      expect(hostile.audit?.final_result_ids.facts).toContain(hit!.edge.uuid);
      expect(
        hostile.audit?.candidate_decisions.find((d) => d.candidate_id === hit!.edge.uuid),
      ).toMatchObject({ candidate_type: 'fact', included: true, score: rawScore });
      expect({ fakeHydration, fakeAutomatic }).toEqual(fakeSnapshot);

      const after = getCompositionalRuntimeAutomaticReadContextV3(fixture.compatibility);
      expect(after?.sources).toBe(original.sources);
      expect(after?.conflicts).toBe(original.conflicts);
      // The real Claim3 qualification consumes one original source hydration;
      // hostile replacement counters remain untouched and cannot reset it.
      expect(after?.sources).toEqual({ ...sourcesBefore, remaining: sourcesBefore.remaining - 1 });
      expect(after?.conflicts).toEqual(conflictsBefore);
      expect(fixture.budget.deferred).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  it('resolves traversal endpoints from the staged store, qualifying the same Claim3 without a second Parent read', async () => {
    const fixture = await createFixture();
    try {
      const ownerHit = await actualClaimHit(fixture);
      const candidates = jest.spyOn(
        parentReaderApi,
        'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4',
      );
      const { engine, storage } = bind(fixture);
      const backend = spyBackend(fixture);
      const stagedGetEntity = jest.spyOn(storage, 'getEntity');

      const searched = await engine.search(QUERY, fixture.namespace);
      const searchedHit = searched.edges.find((h) => h.edge.uuid === ownerHit.edge.uuid);
      expect(searchedHit).toBeDefined();
      const readsAfterSearch = candidates.mock.calls.length;
      expect(readsAfterSearch).toBeGreaterThanOrEqual(1);
      const idReads = (id: string) => candidates.mock.calls.filter((call) => call[2] === id);
      expect(idReads(ownerHit.edge.uuid)).toHaveLength(1);

      const traversed = await engine.governTraversalEdges([ownerHit.edge]);
      expect(traversed).toHaveLength(1);
      const traversedHit = traversed[0]!;
      expect(traversedHit.edge.uuid).toBe(ownerHit.edge.uuid);
      expect(stagedGetEntity).toHaveBeenCalledWith(ownerHit.edge.source_node_uuid);
      expect(stagedGetEntity).toHaveBeenCalledWith(ownerHit.edge.target_node_uuid);
      expect(idReads(ownerHit.edge.uuid)).toHaveLength(1);
      expect(candidates).toHaveBeenCalledTimes(readsAfterSearch);

      const searchDisplay = getAutonomousPersonalRuntimeDisplayV4(searchedHit!);
      const traversalDisplay = getAutonomousPersonalRuntimeDisplayV4(traversedHit);
      expect(traversalDisplay).not.toBeNull();
      expect(traversalDisplay).toEqual(searchDisplay);
      expect(traversedHit.sourceEntity.uuid).toBe(ownerHit.sourceEntity.uuid);
      expect(traversedHit.targetEntity.uuid).toBe(ownerHit.targetEntity.uuid);
      expect(engine.formatAsContextWithAudit({ entities: [], edges: traversed }).context).toContain(
        'preference (structured):',
      );
      expectNoBackendRead(backend);

      // Wrong-namespace edge data fails the whole traversal closed.
      const foreign = { ...ownerHit.edge, group_id: `other-${randomUUID()}` };
      expect(await engine.governTraversalEdges([foreign])).toEqual([]);
      expectNoBackendRead(backend);
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);

  describe.each(['abort', 'close'] as const)('original Parent %s during embedding', (kind) => {
    it('returns empty with no vector query, governed fact or backend fallback', async () => {
      const fixture = await createFixture();
      try {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const embedding = fakeEmbedding(async () => {
          if (kind === 'abort') fixture.controller.abort();
          else
            parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(
              fixture.owner,
              fixture.parent,
            );
          return { embedding: [0.1, 0.2, 0.3] };
        });
        const { engine, storage } = bind(fixture, embedding.service);
        const vectors = spyVectors(storage);
        const backend = spyBackend(fixture);
        const candidates = jest.spyOn(
          parentReaderApi,
          'readAutonomousPersonalMemoryParentQualifiedClaimCandidateV4',
        );

        const results = await engine.search(QUERY, fixture.namespace);
        expect(embedding.embed).toHaveBeenCalledTimes(1);
        expect(results).toEqual({ entities: [], edges: [] });
        expect(vectors.entities).not.toHaveBeenCalled();
        expect(vectors.edges).not.toHaveBeenCalled();
        expect(candidates).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expectNoBackendRead(backend);
      } finally {
        await closeFixture(fixture);
      }
    }, 60_000);
  });

  it.each([new Error('runtime engine trusted failure'), undefined])(
    'propagates the exact trusted-reader failure identity raised during embedding (%s)',
    async (failure) => {
      const fixture = await createFixture();
      try {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const embedding = fakeEmbedding(async () => {
          fixture.trusted.active = true;
          fixture.trusted.failure = failure;
          return { embedding: [0.1, 0.2, 0.3] };
        });
        const { engine, storage } = bind(fixture, embedding.service);
        const vectors = spyVectors(storage);
        const backend = spyBackend(fixture);

        let threw = false;
        let caught: unknown;
        try {
          await engine.search(QUERY, fixture.namespace);
        } catch (error) {
          threw = true;
          caught = error;
        }
        expect(threw).toBe(true);
        expect(caught).toBe(failure);
        expect(warn).not.toHaveBeenCalled();
        expect(vectors.entities).not.toHaveBeenCalled();
        expect(vectors.edges).not.toHaveBeenCalled();
        expectNoBackendRead(backend);
      } finally {
        await closeFixture(fixture);
      }
    },
    60_000,
  );

  it('keeps one hybrid pass per call under concurrency and fails closed after the original Parent closes', async () => {
    const fixture = await createFixture();
    try {
      const embedding = fakeEmbedding(async () => ({ embedding: [0.1, 0.2, 0.3] }));
      const { engine, storage } = bind(fixture, embedding.service);
      const vectors = spyVectors(storage);
      const stagedSearchEntities = jest.spyOn(storage, 'searchEntities');
      const stagedSearchEdges = jest.spyOn(storage, 'searchEdges');
      const backend = spyBackend(fixture);

      const [valid, wrongNamespace, validAgain] = await Promise.all([
        engine.search(QUERY, fixture.namespace),
        engine.search(QUERY, `wrong-${randomUUID()}`),
        engine.search(QUERY, fixture.namespace),
      ]);
      expect(wrongNamespace).toEqual({ entities: [], edges: [] });
      for (const result of [valid, validAgain]) {
        const hit = result.edges.find((h) => fixture.claimIds.includes(h.edge.uuid));
        expect(hit).toBeDefined();
        expect(getAutonomousPersonalRuntimeDisplayV4(hit!)).not.toBeNull();
      }
      // Two valid calls: exactly one text/vector pass each; the wrong namespace added none.
      expect(embedding.embed).toHaveBeenCalledTimes(2);
      expect(stagedSearchEntities).toHaveBeenCalledTimes(2);
      expect(stagedSearchEdges).toHaveBeenCalledTimes(2);
      expect(vectors.entities).toHaveBeenCalledTimes(2);
      expect(vectors.edges).toHaveBeenCalledTimes(2);
      expectNoBackendRead(backend);

      parentReaderApi.closeAutonomousPersonalMemoryParentReaderV4(fixture.owner, fixture.parent);
      const ownerHit = valid.edges.find((h) => fixture.claimIds.includes(h.edge.uuid))!;
      stagedSearchEntities.mockClear();
      stagedSearchEdges.mockClear();
      embedding.embed.mockClear();
      expect(
        HybridSearchEngine.forAutonomousPersonalMemoryV4(
          fixture.owner,
          fixture.parent,
          fixture.compatibility,
        ),
      ).toBeNull();
      expect(await engine.search(QUERY, fixture.namespace)).toEqual({ entities: [], edges: [] });
      expect(await engine.governTraversalEdges([ownerHit.edge])).toEqual([]);
      expect(getAutonomousPersonalRuntimeDisplayV4(ownerHit)).toBeNull();
      expect(embedding.embed).not.toHaveBeenCalled();
      expect(stagedSearchEntities).not.toHaveBeenCalled();
      expect(stagedSearchEdges).not.toHaveBeenCalled();
      expectNoBackendRead(backend);
    } finally {
      await closeFixture(fixture);
    }
  }, 60_000);
});
