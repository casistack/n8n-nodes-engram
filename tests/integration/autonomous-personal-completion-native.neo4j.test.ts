import { loadOrdinaryNeo4jFixture } from '../helpers/loadOrdinaryNeo4jFixture';
import { QUEUE_ATTRIBUTE } from '../../src/extraction/QueueState';
import { performance } from 'node:perf_hooks';
import * as completionPlanner from '../../src/storage/AutonomousPersonalCompletionPlanV4';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { buildAutonomousPersonalExistingStoreFixture } from '../helpers/autonomousPersonalExistingStoreFixture';
import { randomUUID } from 'crypto';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import * as backendOutcomes from '../../src/storage/AutonomousPersonalCompletionBackendRegistryV4';
import * as completionHandles from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import * as nativeOriginProjector from '../../src/storage/AutonomousPersonalNativeOriginV4';
import { AutonomousPersonalNativeOriginV4Error } from '../../src/storage/AutonomousPersonalNativeOriginV4';
import type { AutonomousPersonalNativeOriginV4 } from '../../src/schemas/AutonomousPersonalNativeOriginV4.schema';
import type { GraphData } from '../../src/schemas';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import {
  closeAutonomousPersonalCompletionV4,
  prepareNativeAutonomousPersonalCompletionV4,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
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
type PrepareMode = 'response' | 'deferred' | 'no_dispatch';

function withoutExportedAt(graph: GraphData): Omit<GraphData, 'exported_at'> {
  return Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'exported_at')) as Omit<
    GraphData,
    'exported_at'
  >;
}

function providerResponse(unitIds: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              version: 1,
              units: unitIds.map((unitId) => ({
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
}

async function prepareCompletion(
  store: Neo4jStorage,
  seed: Seed,
  mode: PrepareMode = 'response',
): Promise<{ handle: unknown; fetchSpy: jest.SpyInstance }> {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (mode === 'deferred') return new Response('temporarily unavailable', { status: 503 });
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
    return providerResponse(user.units.map((unit) => unit.unitId));
  });
  const context = nativeAutonomousPersonalCaptureContext(seed, {
    executionId: `native-proof:${randomUUID()}`,
    credentials: {
      apiKey: 'neo4j-native-completion-test-key',
      baseUrl: 'https://memory.invalid/v1',
    },
    ...(mode === 'no_dispatch' ? { extraParameters: { automaticMemoryProfile: 'explicit' } } : {}),
  });
  const result = await prepareNativeAutonomousPersonalCompletionV4(context, store);
  if (result.kind !== 'completion_prepared')
    throw new Error(`Expected private completion handle; got ${result.kind}`);
  return { handle: result.handle, fetchSpy };
}

describeNeo('native proof core for autonomous personal completion on Neo4j', () => {
  let driver: Driver | undefined;
  let store: Neo4jStorage | undefined;
  let seed: Seed;
  let handle: unknown;
  let namespaces: string[] = [];

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver!.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  beforeEach(async () => {
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
    namespaces = [seed.request.namespace];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (store && handle) closeAutonomousPersonalCompletionV4(store, handle);
    try {
      await store?.close();
      for (const namespace of namespaces) {
        await query('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
          namespace,
        });
        await query(
          'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
          { namespace },
        );
        await query('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
          namespace,
        });
      }
    } finally {
      await driver?.close();
      driver = undefined;
      store = undefined;
      namespaces = [];
      handle = undefined;
    }
  });

  it('rejects all unsupported fixture metadata and external references before opening a database session', async () => {
    const make = () =>
      buildAutonomousPersonalExistingStoreFixture({
        groupId: `ordinary-invalid-${randomUUID()}`,
        counts: { episodes: 4, entities: 3, edges: 2 },
      }).graph;
    const opening = jest.spyOn(driver!, 'session');
    const reserved = [
      'engram_actor_bindings_v1',
      'engram_write_owner_v4',
      'engram_source_envelope_v3',
      'engram_claim_v1',
      QUEUE_ATTRIBUTE,
    ];
    for (const key of reserved) {
      const graph = make();
      graph.episodes[0].attributes[key] = {};
      await expect(loadOrdinaryNeo4jFixture(driver!, database, graph)).rejects.toThrow();
    }
    const operationRoot = make();
    operationRoot.automatic_operations_v1 = { version: 1, operations: [] };
    await expect(loadOrdinaryNeo4jFixture(driver!, database, operationRoot)).rejects.toThrow();
    const externalEndpoint = make();
    externalEndpoint.edges[0].source_node_uuid = randomUUID();
    await expect(loadOrdinaryNeo4jFixture(driver!, database, externalEndpoint)).rejects.toThrow();
    const externalChain = make();
    externalChain.episodes[1].previous_episode_uuid = randomUUID();
    await expect(loadOrdinaryNeo4jFixture(driver!, database, externalChain)).rejects.toThrow();
    expect(opening).not.toHaveBeenCalled();
  });

  it('rejects fixture collisions without overwriting existing rows', async () => {
    const namespace = `ordinary-collision-${randomUUID()}`;
    namespaces.push(namespace);
    const graph = buildAutonomousPersonalExistingStoreFixture({
      groupId: namespace,
      counts: { episodes: 4, entities: 3, edges: 2 },
    }).graph;
    await loadOrdinaryNeo4jFixture(driver!, database, graph);
    const before = await store!.exportGraph(namespace);
    await expect(loadOrdinaryNeo4jFixture(driver!, database, graph)).rejects.toThrow(
      'already exists',
    );
    expect(withoutExportedAt(await store!.exportGraph(namespace))).toEqual(
      withoutExportedAt(before),
    );
  });

  it('rejects ordinary UUID collisions with a genuine native operation without changing its records', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    await store!.completeAutonomousPersonalCaptureForNativeV4(handle);
    const before = await store!.exportGraph(seed.request.namespace);
    const operation = before.automatic_operations_v1?.operations.find(
      (row) => row.identity.namespace === seed.request.namespace && row.state === 'committed',
    );
    if (!operation) throw new Error('Expected genuinely committed native operation');
    const namespace = `ordinary-operation-collision-${randomUUID()}`;
    namespaces.push(namespace);
    const graph = buildAutonomousPersonalExistingStoreFixture({
      groupId: namespace,
      counts: { episodes: 4, entities: 3, edges: 2 },
    }).graph;
    const replacedId = graph.entities[0].uuid;
    graph.entities[0].uuid = operation.operationId;
    for (const edge of graph.edges) {
      if (edge.source_node_uuid === replacedId) edge.source_node_uuid = operation.operationId;
      if (edge.target_node_uuid === replacedId) edge.target_node_uuid = operation.operationId;
    }
    await expect(loadOrdinaryNeo4jFixture(driver!, database, graph)).rejects.toThrow(
      'already exists',
    );
    expect(withoutExportedAt(await store!.exportGraph(seed.request.namespace))).toEqual(
      withoutExportedAt(before),
    );
    const remaining = await query('MATCH (n {group_id:$namespace}) RETURN count(n) AS count', {
      namespace,
    });
    expect(Number(remaining.records[0].get('count'))).toBe(0);
  });

  it('rolls back an earlier fixture batch when a later batch fails', async () => {
    const namespace = `ordinary-rollback-${randomUUID()}`;
    namespaces.push(namespace);
    const graph = buildAutonomousPersonalExistingStoreFixture({
      groupId: namespace,
      counts: { episodes: 4, entities: 3, edges: 2 },
    }).graph;
    const session = driver!.session({ database });
    const tx = session.beginTransaction();
    const run = tx.run.bind(tx);
    const opening = jest.spyOn(driver!, 'session').mockReturnValue(session);
    const begin = jest.spyOn(session, 'beginTransaction').mockReturnValue(tx);
    const running = jest.spyOn(tx, 'run').mockImplementation((text, params) => {
      if (typeof text === 'string' && text.includes('CREATE (ep:Episode)'))
        throw new Error('Synthetic fixture batch failure');
      return run(text, params);
    });
    try {
      await expect(loadOrdinaryNeo4jFixture(driver!, database, graph)).rejects.toThrow(
        'Synthetic fixture batch failure',
      );
    } finally {
      running.mockRestore();
      begin.mockRestore();
      opening.mockRestore();
    }
    const remaining = await query('MATCH (n {group_id:$namespace}) RETURN count(n) AS count', {
      namespace,
    });
    expect(Number(remaining.records[0].get('count'))).toBe(0);
  });

  it('completes configured planning beyond five seconds on an existing store without changing old rows', async () => {
    const namespace = `configured-existing-${randomUUID()}`;
    namespaces.push(namespace);
    const shape = buildAutonomousPersonalExistingStoreFixture({ groupId: namespace });
    await loadOrdinaryNeo4jFixture(driver!, database, shape.graph);
    const loaded = await store!.exportGraph(namespace);
    for (const key of ['episodes', 'entities', 'edges'] as const) {
      expect(loaded[key]).toHaveLength(shape.graph[key].length);
      const indexed = new Map<string, { uuid: string }>(loaded[key].map((row) => [row.uuid, row]));
      for (const row of shape.graph[key]) expect(indexed.get(row.uuid)).toEqual(row);
    }
    const storedChains = await query(
      'MATCH (previous:Episode)-[:NEXT_EPISODE]->(current:Episode {group_id:$namespace}) RETURN previous.uuid AS previous, current.uuid AS current',
      { namespace },
    );
    expect(
      storedChains.records.map((row) => `${row.get('previous')}->${row.get('current')}`).sort(),
    ).toEqual(
      shape.graph.episodes
        .filter((row) => row.previous_episode_uuid)
        .map((row) => `${row.previous_episode_uuid}->${row.uuid}`)
        .sort(),
    );
    const currentSeed = await seedAutonomousPersonalCaptureSubject(store!, namespace);
    const before = await store!.exportGraph(namespace);
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = JSON.parse(body.messages[1]!.content) as { units: Array<{ unitId: string }> };
      return providerResponse(prompt.units.map((unit) => unit.unitId));
    });
    const actualNow = performance.now.bind(performance);
    let offset = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + offset);
    const originalPlan = completionPlanner.planAutonomousPersonalCaptureCompletionV4;
    let shifted = false;
    jest
      .spyOn(completionPlanner, 'planAutonomousPersonalCaptureCompletionV4')
      .mockImplementation((...args) => {
        if (!shifted) {
          shifted = true;
          offset += 6000;
        }
        return originalPlan(...args);
      });
    const contextFor = (executionId: string) => {
      const ctx = nativeAutonomousPersonalCaptureContext(currentSeed, {
        executionId,
        deadlineMs: 90_000,
        extraParameters: { automaticMemoryProfile: 'explicit', automaticIntent: 'enabled' },
      });
      const node = ctx.getNode();
      Object.assign(ctx, {
        getNode: () => ({
          ...node,
          parameters: { ...node.parameters, automaticExecutionBudgetMode: 'configuredV1' },
        }),
      });
      return ctx;
    };
    const result = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('synthetic:configured-first'),
      store!,
    );
    expect(result).toMatchObject({ kind: 'original_turn' });
    expect(shifted).toBe(true);
    const after = await store!.exportGraph(namespace);
    for (const key of ['episodes', 'entities', 'edges'] as const) {
      const indexed = new Map<string, { uuid: string }>(after[key].map((row) => [row.uuid, row]));
      for (const row of before[key]) expect(indexed.get(row.uuid)).toEqual(row);
    }
    expect(after.edges).toHaveLength(before.edges.length + 1);
    const calls = provider.mock.calls.length;
    const replay = await completeNativeAutonomousPersonalCaptureV4(
      contextFor('synthetic:configured-replay'),
      store!,
    );
    expect(replay).toMatchObject({ kind: 'decision', result: { kind: 'committed_observed' } });
    expect(provider.mock.calls).toHaveLength(calls);
    const afterReplay = await store!.exportGraph(namespace);
    expect(afterReplay.episodes).toEqual(after.episodes);
    expect(afterReplay.entities).toEqual(after.entities);
    expect(afterReplay.edges).toEqual(after.edges);
  });

  it.each([
    { mode: 'response' as const, receipt: 'human_autonomous_capture_committed' as const },
    {
      mode: 'deferred' as const,
      receipt: 'human_autonomous_source_deferred_committed' as const,
    },
    {
      mode: 'no_dispatch' as const,
      receipt: 'human_autonomous_source_verdict_committed' as const,
    },
  ])('returns a one-use proof view for the $receipt branch', async ({ mode, receipt }) => {
    const prepared = await prepareCompletion(store!, seed, mode);
    handle = prepared.handle;
    if (mode === 'no_dispatch') expect(prepared.fetchSpy).not.toHaveBeenCalled();

    const projectedOrigins: AutonomousPersonalNativeOriginV4[] = [];
    const originalProject = nativeOriginProjector.projectAutonomousPersonalNativeOriginV4;
    jest
      .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
      .mockImplementation((input, plan, check) => {
        const origin = originalProject(input, plan, check);
        projectedOrigins.push(origin);
        return origin;
      });

    const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
    expect(Object.isFrozen(token)).toBe(true);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(
      backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4({}, handle, token),
    ).toBeNull();
    expect(
      backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(store!, {}, token),
    ).toBeNull();

    const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
      store!,
      handle,
      token,
    );
    expect(view?.observation).toEqual({ kind: 'matched' });
    expect(projectedOrigins).toHaveLength(1);
    expect(view?.proof?.nativeOrigin).toBe(projectedOrigins[0]);
    expect(
      backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(store!, handle, token),
    ).toBeNull();

    const origin = view?.proof?.nativeOrigin;
    if (!origin) throw new Error('Expected the backend-owned origin proof view');
    expect(origin.terminalReceipt.kind).toBe(receipt);
    const actual = await store!.exportGraph(seed.request.namespace);
    const terminal = actual.automatic_operations_v1?.operations.find(
      (operation) => operation.operationId === origin.terminalReceipt.operationId,
    );
    expect(terminal?.state).toBe('committed');
    if (terminal?.version !== 4 || terminal.state !== 'committed')
      throw new Error('Expected a committed operation');
    expect(terminal.identity).toEqual(origin.identity);
    expect(terminal.terminalReceipt).toEqual(origin.terminalReceipt);
    const claims = actual.edges.filter(
      (edge) =>
        edge.group_id === seed.request.namespace &&
        Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'),
    );
    if (mode === 'response') expect(claims).toHaveLength(1);
    else expect(claims).toHaveLength(0);
  });

  it('keeps DATA-only completion free of native-origin projection and proof output', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    const originProjector = jest.spyOn(
      nativeOriginProjector,
      'projectAutonomousPersonalNativeOriginV4',
    );
    const aggregate = jest.spyOn(
      completionHandles,
      'assertAutonomousPersonalCompletionNativeAggregateBytesV4',
    );
    const registerOutcome = jest.spyOn(
      backendOutcomes.AutonomousPersonalCompletionBackendRegistryV4.prototype,
      'registerCoreOutcome',
    );

    const result = await store!.completeAutonomousPersonalCaptureV4!(handle);
    expect(result).toEqual({ kind: 'matched' });
    expect(Object.keys(result)).toEqual(['kind']);
    expect(originProjector).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
    expect(registerOutcome).not.toHaveBeenCalled();
  });

  it.each(['invalid_input', 'conflict', 'capacity'] as const)(
    'preserves native-origin %s failure before any graph diff',
    async (reason) => {
      const prepared = await prepareCompletion(store!, seed);
      handle = prepared.handle;
      const before = await store!.exportGraph();
      const internals = store as unknown as {
        writeExtractionDiff: (...args: unknown[]) => Promise<void>;
      };
      const writeDiff = jest.spyOn(internals, 'writeExtractionDiff');
      const projector = jest
        .spyOn(nativeOriginProjector, 'projectAutonomousPersonalNativeOriginV4')
        .mockImplementation(() => {
          throw new AutonomousPersonalNativeOriginV4Error(reason);
        });

      const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
      const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
        store!,
        handle,
        token,
      );
      expect(view?.observation).toEqual({ kind: 'no_write', reason });
      expect(view?.proof).toBeNull();
      expect(projector).toHaveBeenCalledTimes(1);
      expect(writeDiff).not.toHaveBeenCalled();
      expect(withoutExportedAt(await store!.exportGraph())).toEqual(withoutExportedAt(before));
    },
  );

  it('does not mint proof after an actual commit whose source changes before readback', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    const graphBeforeCompletion = await store!.exportGraph(seed.request.namespace);
    const leased = graphBeforeCompletion.automatic_operations_v1?.operations.find(
      (operation) =>
        operation.identity.namespace === seed.request.namespace && operation.state === 'leased',
    );
    if (!leased) throw new Error('Expected a leased operation before completion');

    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const originalDriverSession = internals.driver.session.bind(internals.driver);
    let managedWrites = 0;
    let readbackSessions = 0;
    let changedSource = false;
    jest.spyOn(internals.driver, 'session').mockImplementation((config) => {
      const session = originalDriverSession(config);
      if (
        config !== undefined &&
        typeof config === 'object' &&
        config.defaultAccessMode === neo4j.session.WRITE
      ) {
        readbackSessions++;
      }
      return session;
    });
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const originalExecuteWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        managedWrites++;
        const result = await originalExecuteWrite(work, config);
        const changed = await query(
          `MATCH (source:Episode {uuid:$sourceId})
           SET source.review_status='rejected'
           RETURN source.uuid AS uuid`,
          { sourceId: leased.identity.sourceId },
        );
        changedSource = changed.records.length === 1;
        return result;
      });
      return session;
    });

    const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
    const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
      store!,
      handle,
      token,
    );
    expect(changedSource).toBe(true);
    expect(managedWrites).toBe(1);
    expect(readbackSessions).toBe(1);
    expect(view?.observation).toEqual({ kind: 'unconfirmed' });
    expect(view?.proof).toBeNull();
  });

  it('returns matched DATA without proof when the managed write acknowledgement is lost', async () => {
    const prepared = await prepareCompletion(store!, seed);
    handle = prepared.handle;
    const internals = store as unknown as { getSession: () => Session; driver: Driver };
    const originalGetSession = internals.getSession.bind(store);
    const originalDriverSession = internals.driver.session.bind(internals.driver);
    let managedWrites = 0;
    let readbackSessions = 0;
    let rejectAfterCommit = true;
    jest.spyOn(internals.driver, 'session').mockImplementation((config) => {
      const session = originalDriverSession(config);
      if (
        config !== undefined &&
        typeof config === 'object' &&
        config.defaultAccessMode === neo4j.session.WRITE
      ) {
        readbackSessions++;
      }
      return session;
    });
    jest.spyOn(internals, 'getSession').mockImplementation(() => {
      const session = originalGetSession();
      const originalExecuteWrite = session.executeWrite.bind(session);
      jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
        managedWrites++;
        const result = await originalExecuteWrite(work, config);
        if (rejectAfterCommit) {
          rejectAfterCommit = false;
          throw new Error('synthetic outer commit acknowledgement loss');
        }
        return result;
      });
      return session;
    });

    const token = await store!.completeAutonomousPersonalCaptureForNativeV4!(handle);
    const view = backendOutcomes.consumeAutonomousPersonalCompletionBackendOutcomeV4(
      store!,
      handle,
      token,
    );
    expect(managedWrites).toBe(1);
    expect(readbackSessions).toBe(1);
    expect(view?.observation).toEqual({ kind: 'matched' });
    expect(view?.proof).toBeNull();
  });
});
