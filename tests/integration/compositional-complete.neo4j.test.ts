import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import { validateCompositionalQualifiedClaimReadV3 } from '../../src/extraction/CompositionalQualifiedClaimReadV3';
import * as SourceEvidence from '../../src/extraction/CompositionalAutomaticCaptureV3Evidence';
import { performance } from 'perf_hooks';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

describeNeo('actual Neo4j V3 atomic complete preference capture', () => {
  let store: Neo4jStorage;
  let input: CompositionalCaptureBeginMethodRequestV3;
  const internal = () =>
    store as unknown as {
      executeWrite(s: Session, fn: (tx: ManagedTransaction) => Promise<unknown>): Promise<unknown>;
      getSession(): Session;
    };
  beforeEach(async () => {
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    input = {
      mode: 'existingStore',
      request: CompositionalAutomaticCaptureBeginRequestV3Schema.parse({
        ...seeded.request,
        version: 3,
        preferenceInterpreter: 'compositionalV2',
        source: {
          ...seeded.request.source,
          content:
            'I prefer explanations in plain British English, with one practical example before any technical terminology.',
        },
      }),
    };
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.close();
    if (!input) return;
    const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    const session = driver.session({ database });
    try {
      const ns = input.request.namespace;
      await session.run('MATCH (op:AutomaticOperation {namespace:$ns}) DETACH DELETE op', { ns });
      await session.run(
        'MATCH (n) WHERE n.group_id=$ns AND (n:Entity OR n:Episode) DETACH DELETE n',
        { ns },
      );
      await session.run('MATCH (l:EpisodeGroupLock {group_id:$ns}) DELETE l', { ns });
    } finally {
      await session.close();
      await driver.close();
    }
  });
  const snapshot = () => store.readExtractionSnapshot(input.request.namespace);
  const begin = async () => {
    const result = await store.beginAndClaimCompositionalCaptureV3(input);
    if (result.kind !== 'claimed') throw new Error(JSON.stringify(result));
    return result.handle;
  };

  it.each(['conservative', 'reviewFirst'] as const)(
    'persists the complete language and ordering claim atomically under %s',
    async (profileId) => {
      input.request.settings.profileId = profileId;
      const handle = await begin();
      const before = await snapshot();
      const result = await store.completeCompositionalHumanCaptureV3(handle);
      expect(result.eligibleFirstCommit).toBe(true);
      const after = await snapshot();
      expect(after.episodes).toEqual(before.episodes);
      for (const row of before.entities)
        expect(after.entities.find((e) => e.uuid === row.uuid)).toEqual(row);
      expect(after.edges).toHaveLength(1);
      expect(after.edges[0].fact).toContain('British English');
      expect(after.edges[0].fact).toContain('before');
      const full = await store.readExtractionSnapshot();
      const qualified = validateCompositionalQualifiedClaimReadV3(full, {
        namespace: input.request.namespace,
        edgeId: after.edges[0].uuid,
        now: new Date().toISOString(),
      });
      expect(qualified.status).toBe('valid_data');
      if (qualified.status === 'valid_data')
        expect(qualified.currentReview).toBe(
          profileId === 'conservative' ? 'accepted' : 'proposed',
        );
      const op = after.automatic_operations_v1!.operations[0];
      expect(op.state).toBe('committed');
      expect(op.attempts.map((a) => a.disposition)).toEqual(['claim_won', 'committed']);
      await store.close();
      store = new Neo4jStorage(uri, username, password, database);
      await store.initialize();
      expect((await snapshot()).edges).toEqual(after.edges);
      const replay = structuredClone(input);
      replay.request.attemptIdHash = 'c'.repeat(64);
      const historical = await store.beginAndClaimCompositionalCaptureV3(replay);
      expect(historical.kind).toBe('committed');
      expect(historical.eligibleFirstCommit).toBe(false);
      expect((await snapshot()).edges).toEqual(after.edges);
    },
  );

  it('commits an honest zero-fact receipt for a temporary question', async () => {
    input.request.source.content = 'What games are on today?';
    const handle = await begin();
    const result = await store.completeCompositionalHumanCaptureV3(handle);
    expect(result.eligibleFirstCommit).toBe(true);
    const graph = await snapshot();
    expect(graph.edges).toHaveLength(0);
    expect(graph.entities).toHaveLength(1);
    const op = graph.automatic_operations_v1!.operations[0];
    if (op.version !== 3 || op.state !== 'committed') throw new Error('Expected commit');
    expect(op.terminalReceipt.kind).toBe('human_compositional_source_verdict_committed');
    expect(op.terminalReceipt.acceptedCoverage).toBe('none');
  });

  it.each([
    ['I prefer concise explanations.', 1],
    ['What games are on today?', 2],
  ] as const)('bounds interpretation calls for %s', async (content, calls) => {
    input.request.source.content = content;
    const handle = await begin();
    const spy = jest.spyOn(
      SourceEvidence,
      'interpretCompositionalHumanSourceV3EvidenceWithExecutionReport',
    );
    const result = await store.completeCompositionalHumanCaptureV3(handle);
    expect(result.eligibleFirstCommit).toBe(true);
    expect(spy).toHaveBeenCalledTimes(calls);
  });

  it('never returns processing permission after session cleanup crosses the deadline', async () => {
    const handle = await begin();
    const target = internal();
    const getSession = target.getSession.bind(store);
    let clock: jest.SpyInstance | undefined;
    jest.spyOn(target, 'getSession').mockImplementation(() => {
      const session = getSession();
      const close = session.close.bind(session);
      jest.spyOn(session, 'close').mockImplementation(async () => {
        await close();
        clock = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 120_001);
      });
      return session;
    });
    const result = await store.completeCompositionalHumanCaptureV3(handle);
    clock?.mockRestore();
    jest.restoreAllMocks();
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    const graph = await snapshot();
    expect(graph.edges).toHaveLength(1);
    expect(graph.automatic_operations_v1!.operations[0].state).toBe('committed');
  });

  it('rolls back new pairs if the operation write fails', async () => {
    const handle = await begin();
    const before = await snapshot();
    const target = internal();
    const write = target.executeWrite.bind(store);
    jest.spyOn(target, 'executeWrite').mockImplementation((session, fn) =>
      write(session, (tx) => {
        const wrapped = new Proxy(tx, {
          get(object, key) {
            if (key === 'run')
              return (query: string, params: Record<string, unknown>) => {
                if (query.includes('MERGE (op:AutomaticOperation'))
                  throw new Error('synthetic operation failure');
                return tx.run(query, params);
              };
            const value = Reflect.get(object, key);
            return typeof value === 'function' ? value.bind(object) : value;
          },
        });
        return fn(wrapped);
      }),
    );
    expect((await store.completeCompositionalHumanCaptureV3(handle)).eligibleFirstCommit).toBe(
      false,
    );
    const after = await snapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('recovers one lost commit acknowledgement without a second write', async () => {
    const handle = await begin();
    const target = internal();
    const write = target.executeWrite.bind(store);
    const spy = jest.spyOn(target, 'executeWrite').mockImplementation(async (session, fn) => {
      await write(session, fn);
      throw new Error('synthetic lost acknowledgement');
    });
    const result = await store.completeCompositionalHumanCaptureV3(handle);
    expect(result.eligibleFirstCommit).toBe(true);
    if (result.eligibleFirstCommit) expect(result.invocation).toBe('same_call_ack_recovered');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await snapshot()).edges).toHaveLength(1);
  });

  it('rejects copied and concurrently reused handles before opening another session', async () => {
    const handle = await begin();
    const spy = jest.spyOn(internal(), 'getSession');
    expect(await store.completeCompositionalHumanCaptureV3(structuredClone(handle))).toEqual({
      kind: 'invalid_handle',
      eligibleFirstCommit: false,
    });
    expect(spy).not.toHaveBeenCalled();
    const results = await Promise.all([
      store.completeCompositionalHumanCaptureV3(handle),
      store.completeCompositionalHumanCaptureV3(handle),
    ]);
    expect(results.filter((r) => r.eligibleFirstCommit)).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'invalid_handle')).toHaveLength(1);
    expect((await snapshot()).edges).toHaveLength(1);
  });
});
