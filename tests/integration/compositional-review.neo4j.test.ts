import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import { compositionalClaimReviewPairHashV3 } from '../../src/storage/CompositionalClaimReviewV3';
import { makeCompositionalCommittedClaimFixture } from '../helpers/compositionalCommittedClaimFixture';
import type { GraphData } from '../../src/schemas';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

describeNeo('native Neo4j atomic compositional operator review', () => {
  let store: Neo4jStorage;
  let driver: ReturnType<typeof neo4j.driver>;
  let f: ReturnType<typeof makeCompositionalCommittedClaimFixture>;
  const query = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  };
  beforeEach(async () => {
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    f = makeCompositionalCommittedClaimFixture(
      'proposed',
      neo4jAutomaticCaptureStoreHash(uri, database)!,
    );
    // Backend-native fixture installation, not a privileged generic JSON import.
    for (const row of f.graph.entities)
      await query('CREATE (e:Entity) SET e += $props', {
        props: { ...row, attributes: JSON.stringify(row.attributes) },
      });
    await query('CREATE (e:Episode) SET e += $props', {
      props: { ...f.source, attributes: JSON.stringify(f.source.attributes), append_sequence: 1 },
    });
    const edge = f.graph.edges[0];
    await query(
      'MATCH (a:Entity {uuid:$source}), (b:Entity {uuid:$target}) CREATE (a)-[r:RELATES_TO]->(b) SET r += $props',
      {
        source: edge.source_node_uuid,
        target: edge.target_node_uuid,
        props: { ...edge, attributes: JSON.stringify(edge.attributes) },
      },
    );
    const op = f.operation;
    await query('CREATE (op:AutomaticOperation) SET op += $props', {
      props: {
        operation_id: op.operationId,
        namespace: op.identity.namespace,
        source_id: op.identity.sourceId,
        store_hash: op.identity.storeHash,
        role: op.identity.role,
        position: 0,
        record_json: JSON.stringify(op),
      },
    });
    await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) SET l.automatic_operations_v1_present=true",
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    if (f) {
      await query('MATCH (op:AutomaticOperation {namespace:$ns}) DETACH DELETE op', {
        ns: f.request.namespace,
      });
      await query('MATCH (n) WHERE n.group_id=$ns AND (n:Entity OR n:Episode) DETACH DELETE n', {
        ns: f.request.namespace,
      });
    }
    await driver?.close();
  });
  const command = async (reviewStatus: 'accepted' | 'rejected' | 'proposed' = 'accepted') => {
    const edge = (await store.getEdge(f.request.edgeId))!;
    const value = (await store.getEntity(edge.target_node_uuid))!;
    return {
      version: 3 as const,
      namespace: f.request.namespace,
      edgeId: edge.uuid,
      expectedPairHash: compositionalClaimReviewPairHashV3({
        namespace: f.request.namespace,
        edge,
        value,
      }),
      reviewStatus,
      reviewedBy: 'synthetic-operator',
    };
  };
  const physical = async () => {
    const rows = await query(
      'MATCH (n) WHERE n.group_id=$ns AND (n:Entity OR n:Episode) RETURN properties(n) AS row ORDER BY n.uuid',
      { ns: f.request.namespace },
    );
    const edges = await query(
      'MATCH ()-[r:RELATES_TO {group_id:$ns}]->() RETURN properties(r) AS row ORDER BY r.uuid',
      { ns: f.request.namespace },
    );
    const op = await query(
      'MATCH (op:AutomaticOperation {namespace:$ns}) RETURN properties(op) AS row',
      { ns: f.request.namespace },
    );
    const revision = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS rev",
    );
    return {
      rows: rows.records.map((r) => r.get('row')),
      edges: edges.records.map((r) => r.get('row')),
      operations: op.records.map((r) => r.get('row')),
      revision: revision.records.map((r) => String(r.get('rev'))),
    };
  };

  it('persists coherent state transitions and unchanged original source/receipt across reopen', async () => {
    const before = await physical();
    for (const state of ['accepted', 'rejected', 'proposed'] as const) {
      expect((await store.reviewCompositionalClaimV3(await command(state))).kind).toBe('reviewed');
      const edge = (await store.getEdge(f.request.edgeId))!;
      const value = (await store.getEntity(edge.target_node_uuid))!;
      expect(edge.attributes.engram_extraction).toEqual(value.attributes.engram_extraction);
      expect(edge.attributes.engram_extraction).toMatchObject({ review_status: state });
    }
    await store.close();
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    const after = await physical();
    expect(after.operations).toEqual(before.operations);
    expect(await store.getEpisode(f.source.uuid)).toEqual(f.source);
    expect((await store.getEdge(f.request.edgeId))!.attributes.engram_claim_v1).toEqual(
      f.graph.edges[0].attributes.engram_claim_v1,
    );
  });

  it('rolls back revision changes for unchanged review, stale edits and wrong namespace', async () => {
    const input = await command();
    expect((await store.reviewCompositionalClaimV3(input)).kind).toBe('reviewed');
    const before = await physical();
    expect((await store.reviewCompositionalClaimV3(await command())).kind).toBe('unchanged');
    expect(await store.reviewCompositionalClaimV3(input)).toEqual({
      kind: 'decision',
      reason: 'conflict',
    });
    expect(
      await store.reviewCompositionalClaimV3({ ...input, namespace: `${input.namespace} ` }),
    ).toMatchObject({ kind: 'decision' });
    expect(await physical()).toEqual(before);
  });

  it('fences concurrent operators using the common database writer lock', async () => {
    const other = new Neo4jStorage(uri, username, password, database);
    await other.initialize();
    try {
      const input = await command();
      const results = await Promise.all([
        store.reviewCompositionalClaimV3(input),
        other.reviewCompositionalClaimV3({ ...input, reviewedBy: 'other-synthetic-operator' }),
      ]);
      expect(results.filter((r) => r.kind === 'reviewed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'decision' && r.reason === 'conflict')).toHaveLength(
        1,
      );
    } finally {
      await other.close();
    }
  });

  it('rolls back the first paired write if failure occurs before the relationship update', async () => {
    const input = await command();
    const before = await physical();
    const internal = store as unknown as {
      writeExtractionDiff: (
        tx: ManagedTransaction,
        before: GraphData,
        after: GraphData,
      ) => Promise<void>;
    };
    jest.spyOn(internal, 'writeExtractionDiff').mockImplementation(async (tx, _before, after) => {
      const edge = after.edges.find((row) => row.uuid === input.edgeId)!;
      const value = after.entities.find((row) => row.uuid === edge.target_node_uuid)!;
      await tx.run('MATCH (n:Entity {uuid:$id}) SET n.attributes=$attrs', {
        id: value.uuid,
        attrs: JSON.stringify(value.attributes),
      });
      throw new Error('synthetic-between-pair-writes');
    });
    expect(await store.reviewCompositionalClaimV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
    });
    expect(await physical()).toEqual(before);
  });

  it('retains an atomic committed pair and reports uncertainty when the commit acknowledgement is lost', async () => {
    const input = await command();
    const before = await physical();
    const internal = store as unknown as {
      executeWrite: (
        session: Session,
        fn: (tx: ManagedTransaction) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const run = internal.executeWrite.bind(store);
    const spy = jest.spyOn(internal, 'executeWrite').mockImplementation(async (session, fn) => {
      await run(session, fn);
      throw new Error('synthetic-after-commit');
    });
    expect(await store.reviewCompositionalClaimV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const edge = (await store.getEdge(input.edgeId))!;
    const value = (await store.getEntity(edge.target_node_uuid))!;
    expect(edge.attributes.engram_extraction).toEqual(value.attributes.engram_extraction);
    expect(edge.attributes.engram_extraction).toMatchObject({ review_status: 'accepted' });
    expect((await physical()).operations).toEqual(before.operations);
  });
});
