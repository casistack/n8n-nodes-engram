import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { seedAutomaticCaptureSubject } from '../helpers/automaticCaptureBackend';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from '../../src/schemas/CompositionalAutomaticCaptureV3.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../../src/schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type { GraphData, EpisodicNode } from '../../src/schemas';

jest.setTimeout(60_000);
const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

describeNeo('actual Neo4j V3 atomic initial capture admission', () => {
  let store: Neo4jStorage;
  let driver: ReturnType<typeof neo4j.driver>;
  let input: CompositionalCaptureBeginMethodRequestV3;
  let binding: Awaited<ReturnType<typeof seedAutomaticCaptureSubject>>['binding'];
  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };
  beforeEach(async () => {
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    const seeded = await seedAutomaticCaptureSubject(store);
    binding = seeded.binding;
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
    if (input) {
      const ns = input.request.namespace;
      await query('MATCH (op:AutomaticOperation {namespace:$ns}) DETACH DELETE op', { ns });
      await query('MATCH (n) WHERE n.group_id=$ns AND (n:Entity OR n:Episode) DETACH DELETE n', {
        ns,
      });
      await query('MATCH (l:EpisodeGroupLock {group_id:$ns}) DELETE l', { ns });
    }
    await driver?.close();
  });
  const snapshot = () => store.readExtractionSnapshot(input.request.namespace);

  it('commits one native source/op and preserves their original producer metadata on redelivery/reopen', async () => {
    const before = await snapshot();
    const first = await store.beginAndClaimCompositionalCaptureV3(input);
    expect(first.kind).toBe('claimed');
    expect(first.eligibleFirstCommit).toBe(false);
    const original = await snapshot();
    expect(original.entities).toEqual(before.entities);
    expect(original.episodes).toHaveLength(1);
    expect(original.episodes[0].content).toBe(input.request.source.content);
    expect(original.episodes[0].source_execution_id).toBeNull();
    const replay = structuredClone(input);
    replay.request.attemptIdHash = 'c'.repeat(64);
    expect(await store.beginAndClaimCompositionalCaptureV3(replay)).toEqual({
      kind: 'in_progress',
      eligibleFirstCommit: false,
    });
    await store.close();
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    const after = await snapshot();
    expect(after.episodes).toEqual(original.episodes);
    expect(after.automatic_operations_v1!.operations).toHaveLength(1);
    expect(after.automatic_operations_v1!.operations[0].attempts).toHaveLength(2);
  });

  it('serializes first arrivals from independent instances and appends the native chain once', async () => {
    const previous = await store.appendEpisode({
      group_id: input.request.namespace,
      content: 'Prior synthetic turn',
      role: 'human',
      reference_time: new Date().toISOString(),
    });
    const other = new Neo4jStorage(uri, username, password, database);
    await other.initialize();
    try {
      const second = structuredClone(input);
      second.request.attemptIdHash = 'd'.repeat(64);
      const results = await Promise.all([
        store.beginAndClaimCompositionalCaptureV3(input),
        other.beginAndClaimCompositionalCaptureV3(second),
      ]);
      expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'in_progress')).toHaveLength(1);
      const graph = await snapshot();
      expect(graph.episodes).toHaveLength(2);
      expect(
        graph.episodes.find((ep) => ep.content === input.request.source.content)!
          .previous_episode_uuid,
      ).toBe(previous.episode.uuid);
      const links = await query(
        'MATCH (a:Episode {group_id:$ns})-[r:NEXT_EPISODE]->() RETURN count(r) AS count',
        { ns: input.request.namespace },
      );
      expect(Number(links.records[0].get('count'))).toBe(1);
    } finally {
      await other.close();
    }
  });

  it('rejects changed content without mutating native source/op/revision', async () => {
    await store.beginAndClaimCompositionalCaptureV3(input);
    const before = await snapshot();
    const revision = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS value",
    );
    const changed = structuredClone(input);
    changed.request.source.content += ' Changed.';
    expect((await store.beginAndClaimCompositionalCaptureV3(changed)).kind).toBe('conflict');
    const after = await snapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    const next = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS value",
    );
    expect(String(next.records[0].get('value'))).toBe(String(revision.records[0].get('value')));
  });

  it('rolls back an operation write if failure occurs before the source is created', async () => {
    const before = await snapshot();
    const internal = store as unknown as {
      persistAutomaticCaptureBeginCandidate: (
        tx: ManagedTransaction,
        before: GraphData,
        after: GraphData,
        source: EpisodicNode,
        time: string,
        check: () => void,
      ) => Promise<void>;
      writeExtractionDiff: (
        tx: ManagedTransaction,
        before: GraphData,
        after: GraphData,
      ) => Promise<void>;
    };
    const write = internal.writeExtractionDiff.bind(store);
    const spy = jest
      .spyOn(internal, 'persistAutomaticCaptureBeginCandidate')
      .mockImplementation(async (tx, prior, after) => {
        await write(tx, prior, after);
        throw new Error('synthetic-between-source-and-op');
      });
    expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
      kind: 'acknowledgement_unknown',
      eligibleFirstCommit: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const after = await snapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('performs one same-invocation read recovery after an actual commit acknowledgement is lost', async () => {
    const internal = store as unknown as {
      executeWrite: (
        s: Session,
        fn: (tx: ManagedTransaction) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const write = internal.executeWrite.bind(store);
    const spy = jest.spyOn(internal, 'executeWrite').mockImplementation(async (session, fn) => {
      await write(session, fn);
      throw new Error('synthetic-ack-loss');
    });
    expect((await store.beginAndClaimCompositionalCaptureV3(input)).kind).toBe('claimed');
    expect(spy).toHaveBeenCalledTimes(1);
    const graph = await snapshot();
    expect(graph.episodes).toHaveLength(1);
    expect(graph.automatic_operations_v1!.operations).toHaveLength(1);
  });

  it('does not expose a handle after a committed acknowledgement arrives past the deadline', async () => {
    input.request.settings.invocationDeadlineMs = 1000;
    const internal = store as unknown as {
      executeWrite: (
        s: Session,
        fn: (tx: ManagedTransaction) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const write = internal.executeWrite.bind(store);
    const spy = jest.spyOn(internal, 'executeWrite').mockImplementation(async (session, fn) => {
      const result = await write(session, fn);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return result;
    });
    expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
      kind: 'budget_exhausted',
      eligibleFirstCommit: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await snapshot()).episodes).toHaveLength(1);
  });

  it('rejects caller accessors before opening a write transaction', async () => {
    let traps = 0;
    const inputValue = Object.defineProperty({}, 'request', {
      enumerable: true,
      get: () => ++traps,
    });
    const internal = store as unknown as {
      executeWrite: (
        s: Session,
        fn: (tx: ManagedTransaction) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    const spy = jest.spyOn(internal, 'executeWrite');
    expect(await store.beginAndClaimCompositionalCaptureV3(inputValue as never)).toEqual({
      kind: 'invalid_input',
      eligibleFirstCommit: false,
    });
    expect(traps).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not convert an existing V2 event into a V3 source or operation', async () => {
    const { preferenceInterpreter: _interpreter, ...legacy } = input.request;
    expect((await store.beginAndClaimAutomaticCaptureV2({ ...legacy, version: 2 })).kind).toBe(
      'claimed',
    );
    const before = await snapshot();
    expect((await store.beginAndClaimCompositionalCaptureV3(input)).kind).toBe('unsupported_mode');
    const after = await snapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('keeps revoked current authority from observing a new attempt', async () => {
    await store.beginAndClaimCompositionalCaptureV3(input);
    await store.automaticBindingCommand({
      action: 'revoke',
      namespace: input.request.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic revocation',
    });
    const before = await snapshot();
    const replay = structuredClone(input);
    replay.request.attemptIdHash = 'f'.repeat(64);
    expect(await store.beginAndClaimCompositionalCaptureV3(replay)).toEqual({
      kind: 'authority_changed',
      eligibleFirstCommit: false,
    });
    const after = await snapshot();
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('checks the local deadline after awaited session cleanup before exposing a lease', async () => {
    input.request.settings.invocationDeadlineMs = 1000;
    const internal = store as unknown as { getSession: () => Session };
    const get = internal.getSession.bind(store);
    const spy = jest.spyOn(internal, 'getSession').mockImplementation(() => {
      const session = get();
      const close = session.close.bind(session);
      jest.spyOn(session, 'close').mockImplementation(async () => {
        await close();
        await new Promise((resolve) => setTimeout(resolve, 1200));
      });
      return session;
    });
    try {
      expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
        kind: 'budget_exhausted',
        eligibleFirstCommit: false,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect((await snapshot()).episodes).toHaveLength(1);
  });

  it('does not append to a malformed native root with an unrelated entity/relationship UUID collision', async () => {
    const graph = await snapshot();
    const subject = graph.entities[0];
    await query('MATCH (n:Entity {uuid:$id}) CREATE (n)-[r:RELATES_TO]->(n) SET r += $props', {
      id: subject.uuid,
      props: {
        uuid: subject.uuid,
        group_id: subject.group_id,
        source_node_uuid: subject.uuid,
        target_node_uuid: subject.uuid,
        name: 'SYNTHETIC',
        fact: 'Unrelated synthetic record',
        episodes: [],
        attributes: '{}',
        created_at: subject.created_at,
        updated_at: subject.updated_at,
      },
    });
    const before = await snapshot();
    const revision = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS value",
    );
    expect(await store.beginAndClaimCompositionalCaptureV3(input)).toEqual({
      kind: 'invalid_input',
      eligibleFirstCommit: false,
    });
    const after = await snapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    const next = await query(
      "MATCH (l:EngramStoreLock {id:'extraction-v1'}) RETURN l.revision AS value",
    );
    expect(String(next.records[0].get('value'))).toBe(String(revision.records[0].get('value')));
  });
});
