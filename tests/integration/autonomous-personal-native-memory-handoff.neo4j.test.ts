import { randomUUID } from 'node:crypto';
import neo4j, { type Driver } from 'neo4j-driver';
import type { GraphData } from '../../src/schemas';
import {
  consumeAutonomousPersonalMemoryHandoffV4,
  getAutonomousPersonalMemoryLineageOriginV4,
  publishAutonomousPersonalMemoryHandoffV4,
  type NativeAutonomousPersonalMemoryContextV4,
} from '../../src/memory/AutonomousPersonalNativeMemoryHandoffV4';
import {
  completeNativeAutonomousPersonalCaptureV4,
  consumeAutonomousPersonalOriginalTurnV4,
} from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { getAutomaticClaimReadScope } from '../../src/storage/AutomaticClaimReadScope';
import { CompositionalRetrievalSnapshotV3Schema } from '../../src/schemas/CompositionalRetrievalSnapshotV3.schema';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(90_000);

const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
const describeNeo = uri ? describe : describe.skip;

type Seed = Awaited<ReturnType<typeof seedAutonomousPersonalCaptureSubject>>;
type ProviderMode = 'success' | 'unavailable' | 'unexpected';
type ProviderBody = { messages: Array<{ role: string; content: string }> };

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const sortedRows = (rows: readonly unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
const committedOperations = (graph: GraphData) =>
  (graph.automatic_operations_v1?.operations ?? []).filter(
    (operation) => operation.state === 'committed',
  );
const claimEdges = (graph: GraphData, namespace: string) =>
  graph.edges.filter(
    (edge) => edge.group_id === namespace && hasOwn(edge.attributes ?? {}, 'engram_claim_v1'),
  );

interface Locator {
  storeHash: string;
  namespace: string;
  issuer: string;
  actorReference: string;
  turn: string;
  sourceId: string;
}

describeNeo('native personal Memory handoff V4 foundation on Neo4j', () => {
  let driver: Driver | undefined;
  let store: Neo4jStorage;
  let seed: Seed;
  let namespaces: string[] = [];
  let openStores: Neo4jStorage[] = [];
  let providerBodies: ProviderBody[] = [];

  const createStore = () => new Neo4jStorage(uri!, username, password, database);

  const openStore = async () => {
    const candidate = createStore();
    openStores.push(candidate);
    await candidate.initialize();
    return candidate;
  };

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver!.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  const closeStore = async (candidate: Neo4jStorage) => {
    if (!openStores.includes(candidate)) return;
    openStores = openStores.filter((entry) => entry !== candidate);
    await candidate.close();
  };

  beforeEach(async () => {
    namespaces = [];
    openStores = [];
    providerBodies = [];
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = await openStore();
    seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces = [seed.request.namespace];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const errors: unknown[] = [];
    const attempt = async (step: () => unknown) => {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      for (const candidate of [...openStores]) await attempt(() => closeStore(candidate));
      if (driver) {
        for (const namespace of namespaces) {
          await attempt(() =>
            query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
              namespace,
            }),
          );
          await attempt(() =>
            query(
              'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
              { namespace },
            ),
          );
          await attempt(() =>
            query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
              namespace,
            }),
          );
        }
      }
      await attempt(async () => driver?.close());
    } finally {
      driver = undefined;
      namespaces = [];
      openStores = [];
    }
    if (errors.length > 0) {
      throw Object.assign(new Error('Neo4j memory handoff test cleanup failed'), { errors });
    }
  });

  function contextFor(turn: string, intent: 'enabled' | 'disabled' = 'enabled') {
    return nativeAutonomousPersonalCaptureContext(seed, {
      executionId: `execution:${turn}`,
      workflowId: `workflow:${turn}`,
      instanceId: `instance:${turn}`,
      deadlineMs: 30_000,
      content: 'I prefer concise explanations.',
      extraParameters: {
        automaticMemoryProfile: 'explicit',
        automaticIntent: intent,
        automaticTurn: turn,
      },
    });
  }

  function installProvider(mode: ProviderMode = 'success') {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (mode === 'unexpected') throw new Error('unexpected_native_provider_dispatch');
      const body = JSON.parse(String(init?.body)) as ProviderBody;
      providerBodies.push(body);
      if (mode === 'unavailable') return new Response('synthetic unavailable', { status: 503 });
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
                    category: 'preference',
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
  }

  function expectProviderDefaultOmitsTemperature() {
    expect(providerBodies.length).toBeGreaterThan(0);
    for (const body of providerBodies) expect(hasOwn(body, 'temperature')).toBe(false);
  }

  /** Real C2 on the real Neo4j owner; returns the genuine bridge and the persisted V4 operation. */
  async function prepareRealBridge(turn: string, intent: 'enabled' | 'disabled' = 'enabled') {
    const ctx = contextFor(turn, intent);
    const result = await completeNativeAutonomousPersonalCaptureV4(ctx, store);
    if (result.kind !== 'original_turn') {
      throw new Error(`Expected a real C2 original-turn bridge, got ${result.kind}`);
    }
    const graph = await store.exportGraph(seed.request.namespace);
    const committed = committedOperations(graph);
    expect(committed).toHaveLength(1);
    const operation = committed[0]!;
    if (operation.version !== 4 || operation.state !== 'committed') {
      throw new Error('Expected a real committed Operation4 for the handoff source');
    }
    return { ctx, bridge: result.origin, operation, graph };
  }

  const locatorOf = (identity: Locator): Locator => ({
    storeHash: identity.storeHash,
    namespace: identity.namespace,
    issuer: identity.issuer,
    actorReference: identity.actorReference,
    turn: identity.turn,
    sourceId: identity.sourceId,
  });

  function consume(ctx: NativeAutonomousPersonalMemoryContextV4, locator: Locator) {
    return consumeAutonomousPersonalMemoryHandoffV4(
      ctx,
      locator.storeHash,
      locator.namespace,
      locator.issuer,
      locator.actorReference,
      locator.turn,
      locator.sourceId,
    );
  }

  function tupleContext(
    base: NativeAutonomousPersonalMemoryContextV4,
    overrides: Partial<{ instance: string; workflow: string; execution: string }> = {},
  ): NativeAutonomousPersonalMemoryContextV4 {
    return {
      getInstanceId: () => overrides.instance ?? base.getInstanceId(),
      getWorkflow: () => ({ id: overrides.workflow ?? base.getWorkflow().id }),
      getExecutionId: () => overrides.execution ?? base.getExecutionId(),
    } as NativeAutonomousPersonalMemoryContextV4;
  }

  /** Close the old owner and open a fresh one against the same actual URI and database. */
  async function reopenMemoryOwner() {
    await closeStore(store);
    store = await openStore();
    return store;
  }

  it('publishes before closing the old driver and consumes once through a fresh Neo4jStorage owner', async () => {
    const turn = 'neo-handoff-reopen';
    const fetchSpy = installProvider('success');
    const beginSpy = jest.spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4');
    const providerSpy = jest.spyOn(store, 'prepareAutonomousPersonalCaptureProviderV4');
    const backendSpy = jest.spyOn(store, 'completeAutonomousPersonalCaptureForNativeV4');
    const { ctx, bridge, operation, graph: beforeGraph } = await prepareRealBridge(turn);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(backendSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalled();
    expectProviderDefaultOmitsTemperature();
    const fetchCalls = fetchSpy.mock.calls.length;

    const published = publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge);
    expect(published).toEqual({ kind: 'published', sourceId: operation.identity.sourceId });
    expect(operation.identity.sourceId).toMatch(/^[0-9a-f-]{36}$/u);
    // The genuine C2 bridge is spent by publication, and the handoff cannot be published twice.
    expect(consumeAutonomousPersonalOriginalTurnV4(store, bridge)).toBeNull();
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'not_published',
    });

    const memoryStore = await reopenMemoryOwner();
    const memoryBegin = jest.spyOn(memoryStore, 'beginAndClaimAutonomousPersonalCaptureV4');
    const memoryProvider = jest.spyOn(memoryStore, 'prepareAutonomousPersonalCaptureProviderV4');
    const memoryBackend = jest.spyOn(memoryStore, 'completeAutonomousPersonalCaptureForNativeV4');

    const locator = locatorOf(operation.identity);
    expect(locator.storeHash).toBe(neo4jAutomaticCaptureStoreHash(uri!, database));
    expect(locator.namespace).toBe(seed.request.namespace);
    expect(locator.turn).toBe(turn);
    const lineage = consume(ctx, locator);
    expect(lineage).not.toBeNull();
    expect(consume(ctx, locator)).toBeNull();

    const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
    expect(origin).not.toBeNull();
    expect(Object.isFrozen(origin)).toBe(true);
    expect(getAutonomousPersonalMemoryLineageOriginV4(lineage)).toBe(origin);
    expect(origin!.identity.sourceId).toBe(published.kind === 'published' && published.sourceId);
    expect(origin!.instance).toBe(`instance:${turn}`);
    expect(origin!.workflow).toBe(`workflow:${turn}`);
    expect(origin!.execution).toBe(`execution:${turn}`);

    // No duplicate provider/capture work happened on either side of the owner change.
    expect(memoryBegin).not.toHaveBeenCalled();
    expect(memoryProvider).not.toHaveBeenCalled();
    expect(memoryBackend).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(fetchCalls);
    expect(beginSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(backendSpy).toHaveBeenCalledTimes(1);

    // Origin DATA matches the persisted committed Operation4 read through the fresh owner.
    const afterGraph = await memoryStore.exportGraph(seed.request.namespace);
    const afterCommitted = committedOperations(afterGraph);
    expect(afterCommitted).toHaveLength(1);
    const persisted = afterCommitted[0]!;
    if (persisted.version !== 4 || persisted.state !== 'committed') {
      throw new Error('Expected a committed V4 operation');
    }
    expect(persisted.operationId).toBe(origin!.terminalReceipt.operationId);
    expect(persisted.identity).toEqual(origin!.identity);
    expect(persisted.terminalReceipt).toEqual(origin!.terminalReceipt);
    expect(persisted.identity.sourceId).toBe(operation.identity.sourceId);
    // Compare persisted rows, not root exported_at or ledger bytes.
    expect(sortedRows(afterGraph.entities)).toEqual(sortedRows(beforeGraph.entities));
    expect(sortedRows(afterGraph.edges)).toEqual(sortedRows(beforeGraph.edges));
    expect(sortedRows(afterGraph.episodes)).toEqual(sortedRows(beforeGraph.episodes));
  });

  it.each([
    ['occurrence', 'enabled', 'success', 'human_autonomous_capture_committed', 1],
    [
      'provider-deferred',
      'enabled',
      'unavailable',
      'human_autonomous_source_deferred_committed',
      0,
    ],
    ['source-verdict', 'disabled', 'unexpected', 'human_autonomous_source_verdict_committed', 0],
  ] as const)(
    'hands off the real %s receipt branch without inventing a claim',
    async (name, intent, providerMode, receiptKind, expectedClaims) => {
      const turn = `neo-handoff-${name}`;
      const fetchSpy = installProvider(providerMode);
      const { ctx, bridge, operation } = await prepareRealBridge(turn, intent);
      if (providerMode === 'unexpected') expect(fetchSpy).not.toHaveBeenCalled();
      else expectProviderDefaultOmitsTemperature();

      expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
        kind: 'published',
        sourceId: operation.identity.sourceId,
      });
      const memoryStore = await reopenMemoryOwner();
      const lineage = consume(ctx, locatorOf(operation.identity));
      const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
      expect(origin).not.toBeNull();
      expect(origin!.terminalReceipt.kind).toBe(receiptKind);
      expect(origin!.terminalReceipt).toEqual(operation.terminalReceipt);

      // Truthful no-claim state: deferred and verdict receipts leave no persisted claim.
      const graph = await memoryStore.exportGraph(seed.request.namespace);
      expect(claimEdges(graph, seed.request.namespace)).toHaveLength(expectedClaims);
      expect(committedOperations(graph)).toHaveLength(1);
    },
  );

  it('keeps the genuine pending handoff unspent after wrong locator and native-tuple attempts', async () => {
    installProvider('success');
    const { ctx, bridge, operation } = await prepareRealBridge('neo-handoff-mismatch');
    const published = publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge);
    expect(published.kind).toBe('published');
    await reopenMemoryOwner();

    // The published sourceId is read as locator DATA only; it grants nothing by itself.
    const locator = locatorOf(operation.identity);
    expect(published).toEqual({ kind: 'published', sourceId: locator.sourceId });

    const wrongLocators: Array<[string, Locator]> = [
      ['storeHash', { ...locator, storeHash: 'f'.repeat(64) }],
      ['namespace', { ...locator, namespace: `${locator.namespace}:other` }],
      ['issuer', { ...locator, issuer: `${locator.issuer}:other` }],
      ['actor', { ...locator, actorReference: `${locator.actorReference}:other` }],
      ['turn', { ...locator, turn: `${locator.turn}:other` }],
      ['source', { ...locator, sourceId: randomUUID() }],
      ['empty storeHash', { ...locator, storeHash: '' }],
    ];
    for (const [, wrong] of wrongLocators) expect(consume(ctx, wrong)).toBeNull();

    const wrongContexts = [
      tupleContext(ctx, { instance: 'instance:foreign' }),
      tupleContext(ctx, { workflow: 'workflow:foreign' }),
      tupleContext(ctx, { execution: 'execution:foreign' }),
    ];
    for (const wrong of wrongContexts) expect(consume(wrong, locator)).toBeNull();

    const lineage = consume(ctx, locator);
    expect(lineage).not.toBeNull();
    expect(getAutonomousPersonalMemoryLineageOriginV4(lineage)?.identity.sourceId).toBe(
      locator.sourceId,
    );
  });

  it('rejects foreign, fake, copied, proxied, and JSON tokens without spending the genuine bridge', async () => {
    installProvider('success');
    const { ctx, bridge, operation } = await prepareRealBridge('neo-handoff-tokens');
    const foreignOwner = await openStore();

    const attempts: Array<[string, () => unknown]> = [
      ['foreign owner', () => publishAutonomousPersonalMemoryHandoffV4(ctx, foreignOwner, bridge)],
      ['fake owner', () => publishAutonomousPersonalMemoryHandoffV4(ctx, {} as never, bridge)],
      [
        'copied token',
        () =>
          publishAutonomousPersonalMemoryHandoffV4(ctx, store, { ...(bridge as object) } as never),
      ],
      [
        'proxied token',
        () =>
          publishAutonomousPersonalMemoryHandoffV4(
            ctx,
            store,
            new Proxy(bridge as object, {}) as never,
          ),
      ],
      [
        'JSON token',
        () =>
          publishAutonomousPersonalMemoryHandoffV4(
            ctx,
            store,
            JSON.parse(JSON.stringify(bridge)) as never,
          ),
      ],
      ['null token', () => publishAutonomousPersonalMemoryHandoffV4(ctx, store, null as never)],
    ];
    for (const [, run] of attempts) expect(run()).toEqual({ kind: 'not_published' });

    const locator = locatorOf(operation.identity);
    // Nothing was published by the failed attempts, so no lineage can exist yet.
    expect(consume(ctx, locator)).toBeNull();

    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: locator.sourceId,
    });
    const lineage = consume(ctx, locator);
    expect(lineage).not.toBeNull();

    expect(getAutonomousPersonalMemoryLineageOriginV4({})).toBeNull();
    expect(getAutonomousPersonalMemoryLineageOriginV4(null)).toBeNull();
    expect(getAutonomousPersonalMemoryLineageOriginV4(Object.create(null))).toBeNull();
    expect(getAutonomousPersonalMemoryLineageOriginV4(new Proxy(lineage as object, {}))).toBeNull();
    expect(
      getAutonomousPersonalMemoryLineageOriginV4(JSON.parse(JSON.stringify(lineage))),
    ).toBeNull();
    expect(getAutonomousPersonalMemoryLineageOriginV4(lineage)).not.toBeNull();
  });

  it('transports the persisted Source4 and Op4 through a fresh bounded Memory-owner read', async () => {
    installProvider('success');
    const { ctx, bridge, operation } = await prepareRealBridge('neo-handoff-transport');
    expect(publishAutonomousPersonalMemoryHandoffV4(ctx, store, bridge)).toEqual({
      kind: 'published',
      sourceId: operation.identity.sourceId,
    });
    const memoryStore = await reopenMemoryOwner();
    const lineage = consume(ctx, locatorOf(operation.identity));
    const origin = getAutonomousPersonalMemoryLineageOriginV4(lineage);
    expect(origin).not.toBeNull();

    // This proves DATA transport parity only, not actual-parent authorization.
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const snapshot = CompositionalRetrievalSnapshotV3Schema.parse(
      await memoryStore.readCompositionalRetrievalSnapshotV3(scope),
    );
    expect(snapshot.status).toBe('snapshot');
    if (snapshot.status !== 'snapshot') throw new Error('Expected an actual full-root snapshot');
    expect(hasOwn(snapshot.graph, 'group_id')).toBe(false);
    const sources = snapshot.graph.episodes.filter(
      (row) => row.uuid === operation.identity.sourceId,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      role: 'human',
      episode_kind: 'active_human',
      group_id: seed.request.namespace,
      content: 'I prefer concise explanations.',
    });
    const operations = snapshot.graph.automatic_operations_v1?.operations.filter(
      (row) => row.operationId === operation.operationId,
    );
    expect(operations).toHaveLength(1);
    const persisted = operations![0]!;
    if (persisted.version !== 4 || persisted.state !== 'committed') {
      throw new Error('Expected a committed V4 operation in the actual snapshot');
    }
    expect(persisted.identity).toEqual(origin!.identity);
    expect(persisted.terminalReceipt).toEqual(origin!.terminalReceipt);
  });
});
