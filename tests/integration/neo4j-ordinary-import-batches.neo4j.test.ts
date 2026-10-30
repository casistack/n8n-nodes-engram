import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import neo4j, { type Driver } from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { completeNativeAutonomousPersonalCaptureV4 } from '../../src/storage/AutonomousPersonalNativeCompletionV4';
import { buildAutonomousPersonalExistingStoreFixture } from '../helpers/autonomousPersonalExistingStoreFixture';
import {
  nativeAutonomousPersonalCaptureContext,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import { QUEUE_ATTRIBUTE } from '../../src/extraction/QueueState';
import type { GraphData } from '../../src/schemas';

jest.setTimeout(90_000);
const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
const describeNeo = uri ? describe : describe.skip;
const copy = <T>(value: T): T => structuredClone(value);
const withoutTime = (graph: GraphData) =>
  Object.fromEntries(Object.entries(graph).filter(([key]) => key !== 'exported_at'));

describeNeo('ordinary Neo4j import ordered batches', () => {
  let driver: Driver;
  let store: Neo4jStorage;
  let namespaces: string[];
  let protectedNamespace: string;
  let protectedBefore: GraphData;
  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };
  const shape = (counts = { episodes: 4, entities: 3, edges: 2 }) => {
    const namespace = `ordinary-batches-${randomUUID()}`;
    namespaces.push(namespace);
    return buildAutonomousPersonalExistingStoreFixture({ groupId: namespace, counts }).graph;
  };
  const assertRows = (expected: GraphData, actual: GraphData) => {
    for (const kind of ['entities', 'episodes', 'edges'] as const) {
      expect(actual[kind]).toHaveLength(expected[kind].length);
      const rows = new Map(actual[kind].map((row) => [row.uuid, row]));
      for (const row of expected[kind]) expect(rows.get(row.uuid)).toEqual(row);
    }
  };
  const protectedWithoutEpoch = (graph: GraphData) =>
    Object.fromEntries(Object.entries(withoutTime(graph)).filter(([key]) => key !== 'metadata'));
  const assertProtected = async () => {
    const current = await store.exportGraph(protectedNamespace);
    expect(protectedWithoutEpoch(current)).toEqual(protectedWithoutEpoch(protectedBefore));
  };

  beforeEach(async () => {
    namespaces = [];
    driver = neo4j.driver(
      uri!.replace('://localhost:', '://127.0.0.1:'),
      neo4j.auth.basic(username, password),
    );
    store = new Neo4jStorage(uri!, username, password, database);
    await store.initialize();
    const seed = await seedAutonomousPersonalCaptureSubject(store);
    protectedNamespace = seed.request.namespace;
    namespaces.push(protectedNamespace);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const input = JSON.parse(body.messages[1].content) as { units: Array<{ unitId: string }> };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  version: 1,
                  units: input.units.map(({ unitId }) => ({
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
    const captured = await completeNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed),
      store,
    );
    expect(captured.kind).toBe('original_turn');
    protectedBefore = await store.exportGraph(protectedNamespace);
    expect(
      protectedBefore.automatic_operations_v1?.operations.some(
        (operation) => operation.state === 'committed',
      ),
    ).toBe(true);
    expect(
      protectedBefore.edges.some(
        (edge) =>
          (edge.attributes.engram_claim_v1 as { version?: number } | undefined)?.version === 3,
      ),
    ).toBe(true);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
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
    }
  });

  // First test deliberately leaves these import query plans cold on a fresh qualified server.
  it('imports the genuine enrolled 860-row ordinary graph under the unchanged guard and preserves existing authority', async () => {
    const graph = shape({ episodes: 592, entities: 155, edges: 113 });
    const lockBefore = (
      await query(
        "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN properties(lock) AS props",
      )
    ).records[0].get('props') as Record<string, unknown>;
    const observations: unknown[] = [];
    const started = performance.now();
    await store.withExtractionDiagnostics(
      (event) => observations.push(event),
      () => store.importGraph(graph),
    );
    const durationMs = performance.now() - started;
    const loaded = await store.exportGraph(graph.group_id);
    assertRows(graph, loaded);
    const pairs = await query(
      'MATCH (previous:Episode)-[:NEXT_EPISODE]->(current:Episode {group_id:$namespace}) RETURN previous.uuid AS previous, current.uuid AS current',
      { namespace: graph.group_id },
    );
    expect(
      pairs.records.map((row) => `${row.get('previous')}->${row.get('current')}`).sort(),
    ).toEqual(
      graph.episodes
        .filter((row) => row.previous_episode_uuid)
        .map((row) => `${row.previous_episode_uuid}->${row.uuid}`)
        .sort(),
    );
    await assertProtected();
    const lockAfter = (
      await query(
        "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN properties(lock) AS props",
      )
    ).records[0].get('props') as Record<string, unknown>;
    const stable = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== 'epoch' && key !== 'revision'),
      );
    expect(stable(lockAfter)).toEqual(stable(lockBefore));
    expect(lockAfter.epoch).not.toBe(lockBefore.epoch);
    expect(Number(lockAfter.revision)).toBe(Number(lockBefore.revision) + 1);
    console.info(
      JSON.stringify({
        qualification: 'ordinary_import_860_enrolled',
        duration_ms: durationMs,
        storage: observations,
      }),
    );
  });

  it('preserves duplicate UUID order, null removal and dedup-key release/reuse across batch boundaries', async () => {
    const initial = shape({ episodes: 2, entities: 2, edges: 0 });
    initial.episodes[0].source_message_id = 'release-source-key';
    initial.episodes[0].idempotency_key = 'release-idempotency-key';
    await store.importGraph(initial);
    const namespace = initial.group_id!;
    const a = copy(initial.episodes[0]);
    const b = { ...copy(initial.episodes[1]), role: a.role, episode_kind: a.episode_kind };
    const first = copy(initial.entities[0]);
    const final = {
      ...copy(first),
      name: 'Last duplicate row',
      summary: 'Last summary',
      name_embedding: null,
      attributes: { ordinal: 'ordinary attribute data' },
    };
    const entities = [
      first,
      ...Array.from({ length: 99 }, (_v, index) => ({
        ...copy(first),
        uuid: randomUUID(),
        name: `Ordinary filler ${index}`,
      })),
      { ...copy(first), name: 'Middle duplicate' },
      final,
    ];
    const release = {
      ...a,
      content: 'released',
      source_message_id: null,
      idempotency_key: null,
      sender_name: null,
      confidence: null,
      updated_at: null,
    };
    const reuse = {
      ...b,
      content: 'reused',
      source_message_id: 'release-source-key',
      idempotency_key: 'release-idempotency-key',
    };
    const episodes = [
      release,
      ...Array.from({ length: 99 }, (_v, index) => ({
        ...copy(a),
        uuid: randomUUID(),
        content: `Ordinary episode ${index}`,
        source_message_id: `filler:${index}`,
        idempotency_key: null,
        previous_episode_uuid: null,
      })),
      reuse,
      { ...release, content: 'last release row' },
    ];
    const beforeReverse = await store.exportGraph();
    // The prior sequential implementation rejects claiming a still-owned key before releasing it.
    await expect(
      store.importGraph({ ...initial, entities: [], episodes: [reuse, release], edges: [] }),
    ).rejects.toThrow();
    expect(withoutTime(await store.exportGraph())).toEqual(withoutTime(beforeReverse));
    await store.importGraph({ ...initial, entities, episodes });
    const loaded = await store.exportGraph(namespace);
    expect(loaded.entities.find((row) => row.uuid === first.uuid)).toEqual(final);
    expect(loaded.episodes.find((row) => row.uuid === a.uuid)).toEqual({
      ...release,
      content: 'last release row',
    });
    expect(loaded.episodes.find((row) => row.uuid === b.uuid)).toEqual(reuse);
    const raw = await query(
      'MATCH (ep:Episode {uuid:$uuid}) RETURN ep.source_dedup_key AS sourceKey, ep.idempotency_dedup_key AS idempotencyKey, ep.sender_name AS senderName, ep.ordinal AS ordinal',
      { uuid: b.uuid },
    );
    expect(raw.records[0].get('sourceKey')).toBe(
      JSON.stringify([namespace, 'release-source-key', b.episode_kind]),
    );
    expect(raw.records[0].get('idempotencyKey')).toBe(
      JSON.stringify([namespace, 'release-idempotency-key']),
    );
    expect(raw.records[0].get('ordinal')).toBeNull();
    const released = await query(
      'MATCH (ep:Episode {uuid:$uuid}) RETURN ep.source_message_id AS sourceKey, ep.idempotency_key AS idempotencyKey, ep.sender_name AS senderName',
      { uuid: a.uuid },
    );
    expect(released.records[0].get('sourceKey')).toBeNull();
    expect(released.records[0].get('idempotencyKey')).toBeNull();
    expect(released.records[0].get('senderName')).toBeNull();
    await assertProtected();
  });

  it('keeps missing endpoint and missing chain rows as no-ops while subsequent ordered rows still execute', async () => {
    const graph = shape({ episodes: 4, entities: 3, edges: 2 });
    const repeated = copy(graph.edges[0]);
    const missingEdge = { ...copy(repeated), uuid: randomUUID(), source_node_uuid: randomUUID() };
    graph.edges = [
      repeated,
      ...Array.from({ length: 99 }, (_v, index) => ({
        ...copy(repeated),
        uuid: randomUUID(),
        fact: `Filler fact ${index}`,
      })),
      missingEdge,
      { ...repeated, fact: 'Last repeated relation', fact_embedding: null, valid_at: null },
    ];
    const missingPrevious = randomUUID();
    graph.episodes[1].previous_episode_uuid = missingPrevious;
    graph.episodes[2].previous_episode_uuid = graph.episodes[0].uuid;
    await store.importGraph(graph);
    const loaded = await store.exportGraph(graph.group_id);
    expect(loaded.edges).toHaveLength(100);
    expect(loaded.edges.some((row) => row.uuid === missingEdge.uuid)).toBe(false);
    expect(loaded.edges.find((row) => row.uuid === repeated.uuid)).toEqual({
      ...repeated,
      fact: 'Last repeated relation',
      fact_embedding: null,
      valid_at: null,
    });
    const missing = await query(
      'MATCH (:Episode)-[r:NEXT_EPISODE]->(:Episode {uuid:$uuid}) RETURN count(r) AS count',
      { uuid: graph.episodes[1].uuid },
    );
    expect(Number(missing.records[0].get('count'))).toBe(0);
    const following = await query(
      'MATCH (:Episode {uuid:$previous})-[r:NEXT_EPISODE]->(:Episode {uuid:$current}) RETURN count(r) AS count',
      { previous: graph.episodes[0].uuid, current: graph.episodes[2].uuid },
    );
    expect(Number(following.records[0].get('count'))).toBe(1);
    await assertProtected();
  });

  it('chunks large parameter payloads without rejecting a previously valid oversized individual row', async () => {
    const graph = shape({ episodes: 1, entities: 3, edges: 0 });
    graph.entities[0].summary = 'a'.repeat(300 * 1024);
    graph.entities[1].summary = 'b'.repeat(300 * 1024);
    graph.entities[2].summary = 'c'.repeat(700 * 1024);
    await store.importGraph(graph);
    assertRows(graph, await store.exportGraph(graph.group_id));
    const ordinal = await query(
      'MATCH (n {group_id:$namespace}) WHERE n.ordinal IS NOT NULL RETURN count(n) AS count',
      { namespace: graph.group_id },
    );
    expect(Number(ordinal.records[0].get('count'))).toBe(0);
    await assertProtected();
  });

  it('rolls back all earlier batches and epoch changes on a later uniqueness failure', async () => {
    const graph = shape({ episodes: 102, entities: 3, edges: 0 });
    graph.episodes[101].source_message_id = graph.episodes[0].source_message_id;
    graph.episodes[101].episode_kind = graph.episodes[0].episode_kind;
    const before = await store.exportGraph();
    await expect(store.importGraph(graph)).rejects.toThrow();
    expect(withoutTime(await store.exportGraph())).toEqual(withoutTime(before));
    const remaining = await query('MATCH (n {group_id:$namespace}) RETURN count(n) AS count', {
      namespace: graph.group_id,
    });
    expect(Number(remaining.records[0].get('count'))).toBe(0);
  });

  it('still rejects protected Source4, claimed records and queue imports without changing epoch or authority', async () => {
    const source = protectedBefore.episodes[0];
    const edge = protectedBefore.edges[0];
    const original = await store.exportGraph();
    await expect(
      store.importGraph({
        ...shape({ episodes: 1, entities: 1, edges: 0 }),
        episodes: [copy(source)],
      }),
    ).rejects.toThrow();
    await expect(
      store.importGraph({ ...shape({ episodes: 1, entities: 1, edges: 0 }), edges: [copy(edge)] }),
    ).rejects.toThrow();
    const queued = shape({ episodes: 1, entities: 1, edges: 0 });
    queued.episodes[0].attributes[QUEUE_ATTRIBUTE] = { state: 'pending' };
    await expect(store.importGraph(queued)).rejects.toThrow();
    expect(withoutTime(await store.exportGraph())).toEqual(withoutTime(original));
  });

  it('preserves ordinary namespaces and native records under concurrent managed imports', async () => {
    const first = shape({ episodes: 20, entities: 10, edges: 10 });
    const second = shape({ episodes: 20, entities: 10, edges: 10 });
    const other = new Neo4jStorage(uri!, username, password, database);
    try {
      await other.initialize();
      await Promise.all([store.importGraph(first), other.importGraph(second)]);
      assertRows(first, await store.exportGraph(first.group_id));
      assertRows(second, await store.exportGraph(second.group_id));
      await assertProtected();
    } finally {
      await other.close();
    }
  });
});
