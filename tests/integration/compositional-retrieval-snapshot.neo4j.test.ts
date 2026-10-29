import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { performance } from 'perf_hooks';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import {
  getAutomaticClaimReadScope,
  reserveAutomaticClaimSnapshotBytes,
} from '../../src/storage/AutomaticClaimReadScope';
import { createCompositionalRetrievalSessionFactoryV3 } from '../../src/search/CompositionalRetrievalSessionV3';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';
describeNeo('actual Neo4j unscoped bounded retrieval snapshot', () => {
  let store: Neo4jStorage;
  let driver: ReturnType<typeof neo4j.driver>;
  let namespaces: string[];
  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };
  beforeEach(async () => {
    namespaces = [];
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    for (let i = 0; i < 2; i++) {
      const f = await seedAutomaticCaptureSubject(store);
      namespaces.push(f.request.namespace);
    }
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    for (const ns of namespaces) {
      await query('MATCH (n) WHERE n.group_id=$ns AND (n:Entity OR n:Episode) DETACH DELETE n', {
        ns,
      });
      await query('MATCH (l:EpisodeGroupLock {group_id:$ns}) DELETE l', { ns });
    }
    await driver.close();
  });
  const internal = () =>
    store as unknown as {
      getSession(): ReturnType<ReturnType<typeof neo4j.driver>['session']>;
      automaticCaptureRevision(tx: ManagedTransaction, read?: unknown): Promise<string>;
    };

  it('returns one coherent full root and clock with no revision writes and honest double reservation', async () => {
    const before = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS revision",
    );
    const budget = { remaining: 512, deferred: 0 };
    const factory = createCompositionalRetrievalSessionFactoryV3();
    const intake = factory.begin({ namespace: namespaces[0], mode: 'current' }, { budget });
    if (intake.status !== 'intake') throw new Error(JSON.stringify(intake));
    expect(budget.remaining).toBe(508);
    const scope = factory.getScope(intake.intake);
    if (!scope) throw new Error('Expected live scope');
    const result = await store.readCompositionalRetrievalSnapshotV3(scope);
    expect(result.status).toBe('snapshot');
    expect(budget.remaining).toBe(504);
    if (result.status !== 'snapshot') throw new Error(JSON.stringify(result));
    expect(Object.prototype.hasOwnProperty.call(result.graph, 'group_id')).toBe(false);
    for (const ns of namespaces)
      expect(result.graph.entities.some((e) => e.group_id === ns)).toBe(true);
    expect(new Date(result.backendNow).toISOString()).toBe(result.backendNow);
    expect(
      factory.prepare(intake.intake, { graph: result.graph, backendNow: result.backendNow }).status,
    ).toBe('prepared_data');
    const after = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS revision",
    );
    expect(after.records[0].get('revision').toString()).toBe(
      before.records[0].get('revision').toString(),
    );
  });

  it('rejects fake and expired scopes before opening a session', async () => {
    const spy = jest.spyOn(internal(), 'getSession');
    let traps = 0;
    const fake = new Proxy({}, { get: () => ++traps });
    expect(await store.readCompositionalRetrievalSnapshotV3(fake as never)).toEqual({
      status: 'invalid',
      reason: 'invalid_scope',
    });
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const clock = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000);
    try {
      expect(await store.readCompositionalRetrievalSnapshotV3(scope)).toEqual({
        status: 'deferred',
        reason: 'budget_exhausted',
      });
    } finally {
      clock.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(traps).toBe(0);
  });

  it('preserves native append order when later-appended episodes have older creation times', async () => {
    const group_id = namespaces[0];
    const a = await store.addEpisode({
      group_id,
      content: 'Synthetic first',
      role: 'human',
      reference_time: new Date().toISOString(),
    });
    const b = await store.addEpisode({
      group_id,
      content: 'Synthetic second',
      role: 'human',
      reference_time: new Date().toISOString(),
    });
    await query('MATCH (e:Episode {uuid:$id}) SET e.created_at=$time', {
      id: a.uuid,
      time: '2026-10-24T13:00:00.000Z',
    });
    await query('MATCH (e:Episode {uuid:$id}) SET e.created_at=$time', {
      id: b.uuid,
      time: '2026-10-24T12:00:00.000Z',
    });
    const recent = await store.getRecentEpisodes(group_id, 100);
    expect(recent.map((episode) => episode.uuid)).toEqual([a.uuid, b.uuid]);
    const result = await store.readCompositionalRetrievalSnapshotV3(
      getAutomaticClaimReadScope({ remaining: 512, deferred: 0 }),
    );
    if (result.status !== 'snapshot') throw new Error(JSON.stringify(result));
    expect(result.graph.episodes.filter((episode) => episode.group_id === group_id)).toEqual(
      recent,
    );
  });

  it('rejects exhausted physical bytes before native reads', async () => {
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    expect(reserveAutomaticClaimSnapshotBytes(scope, 100 * 1024 * 1024)).toBe(true);
    const spy = jest.spyOn(internal(), 'getSession');
    expect(await store.readCompositionalRetrievalSnapshotV3(scope)).toEqual({
      status: 'deferred',
      reason: 'resource_exhausted',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('charges every coherent-read retry and fails closed after the bounded revision race', async () => {
    const budget = { remaining: 512, deferred: 0 };
    const scope = getAutomaticClaimReadScope(budget);
    let revisions = 0;
    const spy = jest
      .spyOn(internal(), 'automaticCaptureRevision')
      .mockImplementation(async () => String(++revisions));
    expect(await store.readCompositionalRetrievalSnapshotV3(scope)).toEqual({
      status: 'deferred',
      reason: 'concurrent_snapshot',
    });
    expect(spy).toHaveBeenCalledTimes(6);
    expect(budget.remaining).toBe(500);
  });

  it('does not expose a snapshot after final cleanup crosses its scope deadline', async () => {
    const scope = getAutomaticClaimReadScope({ remaining: 512, deferred: 0 });
    const target = internal();
    const original = target.getSession.bind(store);
    let clock: jest.SpyInstance | undefined;
    jest.spyOn(target, 'getSession').mockImplementation(() => {
      const session = original();
      const close = session.close.bind(session);
      jest.spyOn(session, 'close').mockImplementation(async () => {
        await close();
        clock = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 6000);
      });
      return session;
    });
    const result = await store.readCompositionalRetrievalSnapshotV3(scope);
    clock?.mockRestore();
    expect(result).toEqual({ status: 'deferred', reason: 'budget_exhausted' });
  });
});
