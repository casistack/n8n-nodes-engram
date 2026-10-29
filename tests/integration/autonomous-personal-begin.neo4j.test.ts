import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import type { GraphData } from '../../src/schemas';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import {
  dispatchNativeAutonomousPersonalCaptureV4,
  getAutonomousPersonalCaptureBeginV4InternalResultSchema,
} from '../../src/storage/AutonomousPersonalCaptureHandlesV4';
import {
  nativeAutonomousPersonalCaptureContext,
  readNativeAutonomousRequest,
  seedAutonomousPersonalCaptureSubject,
} from '../helpers/autonomousPersonalCaptureBackend';
import type { AutonomousPersonalCaptureSeed } from '../helpers/autonomousPersonalCaptureBackend';

jest.setTimeout(90_000);

const describeNeo = process.env.NEO4J_TEST_URI ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI ?? '';
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

interface RawNamespaceState {
  readonly episodes: unknown[];
  readonly operations: unknown[];
  readonly witness: unknown;
  readonly epoch: unknown;
}

describeNeo('actual Neo4j native Autonomous Personal V4 initial admission', () => {
  let store: Neo4jStorage;
  let driver: ReturnType<typeof neo4j.driver>;
  let seed: AutonomousPersonalCaptureSeed;
  let providerFetch: jest.SpyInstance;

  const query = async (text: string, params: Record<string, unknown> = {}) => {
    const session = driver.session({ database });
    try {
      return await session.run(text, params);
    } finally {
      await session.close();
    }
  };

  const namespaceState = async (namespace: string): Promise<RawNamespaceState> => {
    const [episodes, operations, lock] = await Promise.all([
      query(
        `MATCH (ep:Episode {group_id:$namespace})
         RETURN ep.uuid AS uuid, ep.attributes AS attributes,
                ep.created_at AS created_at, ep.append_sequence AS append_sequence
         ORDER BY ep.append_sequence, ep.uuid`,
        { namespace },
      ),
      query(
        `MATCH (op:AutomaticOperation {namespace:$namespace})
         RETURN op.operation_id AS operation_id, op.record_json AS record_json
         ORDER BY op.operation_id`,
        { namespace },
      ),
      query(
        `OPTIONAL MATCH (lock:EngramStoreLock {id:'extraction-v1'})
         RETURN lock.autonomous_source_format_v4 AS witness, lock.epoch AS epoch`,
      ),
    ]);
    return {
      episodes: episodes.records.map((record) => ({
        uuid: record.get('uuid'),
        attributes: record.get('attributes'),
        created_at: record.get('created_at'),
        append_sequence: record.get('append_sequence')?.toString?.() ?? null,
      })),
      operations: operations.records.map((record) => ({
        operation_id: record.get('operation_id'),
        record_json: record.get('record_json'),
      })),
      witness: lock.records[0]?.get('witness') ?? null,
      epoch: lock.records[0]?.get('epoch')?.toString?.() ?? lock.records[0]?.get('epoch') ?? null,
    };
  };

  const snapshot = async (): Promise<GraphData> =>
    store.readExtractionSnapshot(seed.request.namespace);
  const begin = (options: Parameters<typeof nativeAutonomousPersonalCaptureContext>[1] = {}) =>
    dispatchNativeAutonomousPersonalCaptureV4(
      nativeAutonomousPersonalCaptureContext(seed, options),
      store,
    );

  beforeEach(async () => {
    providerFetch = jest.spyOn(globalThis, 'fetch');
    driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    seed = await seedAutonomousPersonalCaptureSubject(store);
  });

  afterEach(async () => {
    const providerFetchCalls = providerFetch.mock.calls.length;
    jest.restoreAllMocks();
    await store?.close();
    if (seed) {
      const namespace = seed.request.namespace;
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
    await driver?.close();
    expect(providerFetchCalls).toBe(0);
  });

  it('refuses a missing native store lock without recreating it or writing a capture', async () => {
    const before = await snapshot();
    await query("MATCH (lock:EngramStoreLock {id:'extraction-v1'}) DELETE lock");
    const internal = store as unknown as { getSession: () => Session };
    const writer = jest.spyOn(internal, 'getSession');
    expect(await begin()).toEqual({ kind: 'conflict', eligibleFirstCommit: false });
    expect(writer).not.toHaveBeenCalled();
    writer.mockRestore();
    const count = await query(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN count(lock) AS count",
    );
    expect(count.records[0].get('count').toNumber()).toBe(0);
    const after = await snapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('rolls back after validating the newly enrolled witness with source, operation, and witness all absent', async () => {
    const before = await snapshot();
    const beforeState = await namespaceState(seed.request.namespace);
    const internal = store as unknown as {
      readAutonomousSource4FormatInTransaction(
        tx: Pick<ManagedTransaction, 'run'>,
        read?: unknown,
        onPositiveFormatWithoutRead?: unknown,
      ): Promise<boolean>;
    };
    const validate = internal.readAutonomousSource4FormatInTransaction.bind(store);
    const observedFormats: boolean[] = [];
    const injectedFailure = new Error('synthetic failure after first witness validation');
    const check = jest
      .spyOn(internal, 'readAutonomousSource4FormatInTransaction')
      .mockImplementation(async (tx, read, onPositiveFormatWithoutRead) => {
        const registered = await validate(tx, read, onPositiveFormatWithoutRead);
        observedFormats.push(registered);
        if (registered) throw injectedFailure;
        return registered;
      });

    const result = await begin({ executionId: 'execution:known-rollback' });
    expect(result).toEqual({ kind: 'storage_error', eligibleFirstCommit: false });
    expect(observedFormats.filter(Boolean)).toHaveLength(1);
    expect(check).toHaveBeenCalled();
    check.mockRestore();
    const after = await snapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    const afterState = await namespaceState(seed.request.namespace);
    expect(afterState.episodes).toEqual(beforeState.episodes);
    expect(afterState.operations).toEqual(beforeState.operations);
    expect(afterState.witness).toEqual(beforeState.witness);
    expect(afterState.epoch).toBe(beforeState.epoch);
  });

  it('commits one exact Source4/Operation4 pair, atomically enrolls int(1), and preserves A on replay B/reopen', async () => {
    const previous = await store.appendEpisode({
      group_id: seed.request.namespace,
      content: 'Prior synthetic human event.',
      role: 'human',
      reference_time: '2026-01-01T00:00:00.000Z',
    });
    const before = await snapshot();
    const first = await begin({ executionId: 'execution:A' });
    expect(first.kind).toBe('claimed');
    expect(first.eligibleFirstCommit).toBe(false);
    if (first.kind !== 'claimed') throw new Error('Expected initial V4 handle');
    expect(Object.keys(first.handle)).toEqual([]);
    expect(JSON.parse(JSON.stringify(first.handle))).toEqual({});
    const resultSchema = getAutonomousPersonalCaptureBeginV4InternalResultSchema();
    expect(resultSchema.safeParse(first).success).toBe(true);
    expect(resultSchema.safeParse({ ...first, handle: { ...first.handle } }).success).toBe(false);
    expect(
      resultSchema.safeParse({ ...first, sourceId: '30000000-0000-4000-8000-000000000001' })
        .success,
    ).toBe(false);
    expect(
      resultSchema.safeParse({
        ...first,
        operationId: '30000000-0000-4000-8000-000000000002',
      }).success,
    ).toBe(false);
    expect(resultSchema.safeParse({ ...first, descriptorHash: 'e'.repeat(64) }).success).toBe(
      false,
    );

    const original = await snapshot();
    const sourceA = original.episodes.find((episode) => episode.uuid === first.sourceId)!;
    const operationA = original.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === first.operationId,
    )!;
    expect(original.entities).toEqual(before.entities);
    expect(original.edges).toEqual(before.edges);
    expect(original.episodes).toHaveLength(2);
    expect(sourceA).toMatchObject({
      group_id: seed.request.namespace,
      content: seed.request.source.content,
      role: 'human',
      source_execution_id: 'execution:A',
      source_workflow_id: 'workflow:source',
      previous_episode_uuid: previous.episode.uuid,
      episode_kind: 'active_human',
      review_status: 'accepted',
    });
    expect(sourceA.reference_time).toBe(sourceA.created_at);
    expect(sourceA.attributes).toHaveProperty('engram_write_owner_v4');
    expect(sourceA.attributes).toHaveProperty('engram_source_envelope_v3');
    expect(operationA).toMatchObject({
      version: 4,
      state: 'leased',
      generation: 1,
      retryCount: 0,
      identity: {
        sourceId: first.sourceId,
        namespace: seed.request.namespace,
        issuer: seed.request.issuer,
        actorReference: seed.request.actorReference,
        turn: seed.request.turn,
      },
      lease: { claimKind: 'initial' },
      attempts: [{ disposition: 'claim_won', at: operationA.createdAt }],
    });
    expect(sourceA.created_at).toBe(operationA.createdAt);
    expect(neo4j.isInt((await namespaceState(seed.request.namespace)).witness)).toBe(true);
    const witness = (await namespaceState(seed.request.namespace)).witness;
    expect(neo4j.isInt(witness) && witness.equals(neo4j.int(1))).toBe(true);

    const epochBeforeReplay = (await namespaceState(seed.request.namespace)).epoch;
    const replay = await begin({ executionId: 'execution:B' });
    expect(replay).toEqual({ kind: 'in_progress', eligibleFirstCommit: false });
    const replayed = await snapshot();
    expect(replayed.entities).toEqual(original.entities);
    expect(replayed.edges).toEqual(original.edges);
    expect(replayed.episodes).toEqual(original.episodes);
    expect((await namespaceState(seed.request.namespace)).epoch).toBe(epochBeforeReplay);
    const operationB = replayed.automatic_operations_v1!.operations.find(
      (operation) => operation.operationId === first.operationId,
    )!;
    expect(operationB.attempts[0]).toEqual(operationA.attempts[0]);
    expect(operationB.attempts).toHaveLength(2);
    expect(operationB.attempts[1].disposition).toBe('in_progress');
    expect(
      replayed.episodes.find((episode) => episode.uuid === first.sourceId)?.source_execution_id,
    ).toBe('execution:A');

    await store.close();
    store = new Neo4jStorage(uri, username, password, database);
    await store.initialize();
    expect(await begin({ executionId: 'execution:C' })).toEqual({
      kind: 'in_progress',
      eligibleFirstCommit: false,
    });
    const reopened = await snapshot();
    expect(reopened.episodes.find((episode) => episode.uuid === first.sourceId)).toEqual(sourceA);
    expect(reopened.automatic_operations_v1!.operations[0].attempts[0].disposition).toBe(
      'claim_won',
    );
  });

  it('keeps existing source/op state on changed content, changed provider config, and revoked binding', async () => {
    expect((await begin({ executionId: 'execution:A' })).kind).toBe('claimed');
    const original = await snapshot();
    const changedContent = await begin({
      executionId: 'execution:B',
      content: 'I prefer a different format.',
    });
    expect(changedContent.kind).not.toBe('claimed');
    expect((await snapshot()).episodes).toEqual(original.episodes);
    expect((await snapshot()).automatic_operations_v1).toEqual(original.automatic_operations_v1);

    const changedConfig = await begin({ executionId: 'execution:B', routeId: 'route:changed' });
    expect(changedConfig.kind).not.toBe('claimed');
    expect((await snapshot()).episodes).toEqual(original.episodes);
    expect((await snapshot()).automatic_operations_v1).toEqual(original.automatic_operations_v1);

    await store.automaticBindingCommand!({
      action: 'revoke',
      namespace: seed.binding.namespace,
      bindingId: seed.binding.bindingId,
      expectedRevision: seed.binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic revoked-binding replay check',
    });
    const afterRevoke = await snapshot();
    const revoked = await begin({ executionId: 'execution:C' });
    expect(revoked).toEqual({ kind: 'authority_changed', eligibleFirstCommit: false });
    const after = await snapshot();
    expect(after.episodes).toEqual(afterRevoke.episodes);
    expect(after.automatic_operations_v1).toEqual(afterRevoke.automatic_operations_v1);
  });

  it('serializes independent native first attempts to one initial lease and one B audit', async () => {
    const other = new Neo4jStorage(uri, username, password, database);
    await other.initialize();
    try {
      const results = await Promise.all([
        begin({ executionId: 'execution:A' }),
        dispatchNativeAutonomousPersonalCaptureV4(
          nativeAutonomousPersonalCaptureContext(seed, { executionId: 'execution:B' }),
          other,
        ),
      ]);
      expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'in_progress')).toHaveLength(1);
      const graph = await snapshot();
      expect(
        graph.episodes.filter((episode) => episode.episode_kind === 'active_human'),
      ).toHaveLength(1);
      expect(graph.automatic_operations_v1!.operations).toHaveLength(1);
      expect(graph.automatic_operations_v1!.operations[0].attempts).toHaveLength(2);
    } finally {
      await other.close();
    }
  });

  it('rejects a concurrently reused key on its owner and another initialized store without consuming the owner', async () => {
    const other = new Neo4jStorage(uri, username, password, database);
    await other.initialize();
    const originalBegin = store.beginAndClaimAutonomousPersonalCaptureV4!.bind(store);
    let capturedInput: unknown;
    let capturedAttempt: unknown;
    let releaseAttempt!: () => void;
    const attemptReady = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    jest
      .spyOn(store, 'beginAndClaimAutonomousPersonalCaptureV4')
      .mockImplementation((input, attempt) => {
        capturedInput = input;
        capturedAttempt = attempt;
        releaseAttempt();
        return originalBegin(input, attempt);
      });
    const ownerInternal = store as unknown as {
      readAutonomousPersonalSnapshotV4: (...args: unknown[]) => Promise<unknown>;
    };
    const otherInternal = other as unknown as {
      readAutonomousPersonalSnapshotV4: (...args: unknown[]) => Promise<unknown>;
    };
    const ownerRead = jest.spyOn(ownerInternal, 'readAutonomousPersonalSnapshotV4');
    const otherRead = jest.spyOn(otherInternal, 'readAutonomousPersonalSnapshotV4');
    try {
      const original = begin({ executionId: 'execution:live-owner' });
      await attemptReady;
      const ownerReadsBeforeDuplicate = ownerRead.mock.calls.length;
      expect(
        await store.beginAndClaimAutonomousPersonalCaptureV4!(capturedInput, capturedAttempt),
      ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
      expect(ownerRead).toHaveBeenCalledTimes(ownerReadsBeforeDuplicate);
      expect(
        await other.beginAndClaimAutonomousPersonalCaptureV4!(capturedInput, capturedAttempt),
      ).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
      expect(otherRead).not.toHaveBeenCalled();
      expect((await original).kind).toBe('claimed');
      expect((await snapshot()).episodes).toHaveLength(1);
      expect((await namespaceState(seed.request.namespace)).operations).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it('returns invalid_handle for copied or fabricated attempt keys before preflight reads', async () => {
    const request = await readNativeAutonomousRequest(
      nativeAutonomousPersonalCaptureContext(seed, { executionId: 'execution:A' }),
    );
    const internal = store as unknown as {
      readAutonomousPersonalSnapshotV4(
        namespace: string,
        deadlineAtMonotonicMs: number,
        check: () => void,
      ): Promise<unknown>;
    };
    const preflight = jest.spyOn(internal, 'readAutonomousPersonalSnapshotV4');
    const input = { mode: 'existingStore', request };
    const fabricated = Object.freeze({});
    expect(await store.beginAndClaimAutonomousPersonalCaptureV4!(input, fabricated)).toEqual({
      kind: 'invalid_handle',
      eligibleFirstCommit: false,
    });
    expect(preflight).not.toHaveBeenCalled();
    const trapKey = new Proxy(
      {},
      {
        get() {
          throw new Error('should_not_read_key');
        },
        ownKeys() {
          throw new Error('should_not_enumerate_key');
        },
        getPrototypeOf() {
          throw new Error('should_not_inspect_key');
        },
      },
    );
    expect(await store.beginAndClaimAutonomousPersonalCaptureV4!(input, trapKey)).toEqual({
      kind: 'invalid_handle',
      eligibleFirstCommit: false,
    });
    expect(preflight).not.toHaveBeenCalled();
  });

  it('recovers one actual lost commit acknowledgment through the writer-routed read-only path', async () => {
    const internal = store as unknown as { getSession: () => Session };
    const getSession = internal.getSession.bind(store);
    let threwAfterCommit = false;
    let executeSpy: jest.SpyInstance | undefined;
    jest.spyOn(internal, 'getSession').mockImplementation(() => {
      const session = getSession();
      if (!executeSpy) {
        const executeWrite = session.executeWrite.bind(session);
        executeSpy = jest
          .spyOn(session, 'executeWrite')
          .mockImplementation(async (work, config) => {
            const result = await executeWrite(work, config);
            if (!threwAfterCommit) {
              threwAfterCommit = true;
              throw new Error('synthetic lost acknowledgment after commit');
            }
            return result;
          });
      }
      return session;
    });
    const persist = store as unknown as {
      persistAutomaticCaptureBeginCandidate: (...args: unknown[]) => Promise<void>;
    };
    const persistSpy = jest.spyOn(persist, 'persistAutomaticCaptureBeginCandidate');

    const result = await begin({ executionId: 'execution:ack-lost' });
    expect(result.kind).toBe('claimed');
    expect(result.eligibleFirstCommit).toBe(false);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect((await snapshot()).episodes).toHaveLength(1);
    expect((await namespaceState(seed.request.namespace)).operations).toHaveLength(1);
    expect(neo4j.isInt((await namespaceState(seed.request.namespace)).witness)).toBe(true);
  });

  it('keeps a committed pair but returns no handle when the commit acknowledgment arrives after the deadline', async () => {
    const internal = store as unknown as { getSession: () => Session };
    const getSession = internal.getSession.bind(store);
    let delayed = false;
    jest.spyOn(internal, 'getSession').mockImplementation(() => {
      const session = getSession();
      if (!delayed) {
        delayed = true;
        const executeWrite = session.executeWrite.bind(session);
        jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) => {
          const result = await executeWrite(work, config);
          await new Promise((resolve) => setTimeout(resolve, 1_150));
          return result;
        });
      }
      return session;
    });
    const persist = store as unknown as {
      persistAutomaticCaptureBeginCandidate: (...args: unknown[]) => Promise<void>;
    };
    const persistSpy = jest.spyOn(persist, 'persistAutomaticCaptureBeginCandidate');

    const result = await begin({ executionId: 'execution:late-commit', deadlineMs: 1_000 });
    expect(result).toEqual({ kind: 'budget_exhausted', eligibleFirstCommit: false });
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const graph = await snapshot();
    expect(graph.episodes).toHaveLength(1);
    expect(graph.episodes[0].source_execution_id).toBe('execution:late-commit');
    expect(graph.automatic_operations_v1!.operations).toHaveLength(1);
    expect(graph.automatic_operations_v1!.operations[0].attempts[0].disposition).toBe('claim_won');
    expect(neo4j.isInt((await namespaceState(seed.request.namespace)).witness)).toBe(true);
  });

  it('keeps absent rows unconfirmed after callback success followed by rollback before commit', async () => {
    const before = await snapshot();
    const beforeState = await namespaceState(seed.request.namespace);
    const internal = store as unknown as { getSession: () => Session };
    const getSession = internal.getSession.bind(store);
    let callbackCompleted = false;
    let executeSpy: jest.SpyInstance | undefined;
    jest.spyOn(internal, 'getSession').mockImplementation(() => {
      const session = getSession();
      if (!executeSpy) {
        const executeWrite = session.executeWrite.bind(session);
        executeSpy = jest.spyOn(session, 'executeWrite').mockImplementation(async (work, config) =>
          executeWrite(async (tx) => {
            await work(tx);
            callbackCompleted = true;
            throw new Error('synthetic rollback after callback but before commit');
          }, config),
        );
      }
      return session;
    });
    const persist = store as unknown as {
      persistAutomaticCaptureBeginCandidate: (...args: unknown[]) => Promise<void>;
    };
    const persistSpy = jest.spyOn(persist, 'persistAutomaticCaptureBeginCandidate');

    const result = await begin({ executionId: 'execution:unknown-ack-absent' });
    expect(callbackCompleted).toBe(true);
    expect(result).toEqual({ kind: 'acknowledgement_unknown', eligibleFirstCommit: false });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const after = await snapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
    const afterState = await namespaceState(seed.request.namespace);
    expect(afterState.episodes).toEqual(beforeState.episodes);
    expect(afterState.operations).toEqual(beforeState.operations);
    expect(afterState.witness).toEqual(beforeState.witness);
    expect(afterState.epoch).toBe(beforeState.epoch);
  });

  it('does not adopt or rewrite valid V4 rows when the store witness is missing', async () => {
    const first = await begin({ executionId: 'execution:A' });
    expect(first.kind).toBe('claimed');
    const before = await namespaceState(seed.request.namespace);
    expect(neo4j.isInt(before.witness) && before.witness.equals(neo4j.int(1))).toBe(true);
    await query(
      `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
       REMOVE lock.autonomous_source_format_v4`,
    );
    const markerlessBefore = await namespaceState(seed.request.namespace);
    expect(markerlessBefore.episodes).toEqual(before.episodes);
    expect(markerlessBefore.operations).toEqual(before.operations);
    expect(markerlessBefore.witness).toBeNull();

    try {
      const replay = await begin({ executionId: 'execution:B' });
      expect(replay.kind).not.toBe('claimed');
      const markerlessAfter = await namespaceState(seed.request.namespace);
      expect(markerlessAfter).toEqual(markerlessBefore);
    } finally {
      await query(
        `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
         SET lock.autonomous_source_format_v4=$witness`,
        { witness: neo4j.int(1) },
      );
    }
  });

  it('keeps the existing V2 API available to ordinary callers', async () => {
    const legacy = await store.beginAndClaimAutomaticCaptureV2(seed.request);
    expect(legacy.kind).toBe('claimed');
  });
});
