import { randomUUID } from 'crypto';
import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import {
  AutomaticCaptureBeginRequestV2Schema,
  type AutomaticCaptureBeginRequestV2,
} from '../../src/schemas/AutomaticCapture.schema';
import type { StagedExtraction } from '../../src/schemas';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { planAutomaticClaims } from '../../src/extraction/AutomaticClaims';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { PrivateOneUseAutomaticLeaseHandle } from '../../src/storage/AutomaticCaptureHandles';

jest.setTimeout(30000);

const enabled = Boolean(process.env.NEO4J_TEST_URI);
const describeNeo4j = enabled ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

function driverForTests() {
  if (!uri) throw new Error('NEO4J_TEST_URI is required for Neo4j integration tests');
  return neo4j.driver(
    uri.replace('://localhost:', '://127.0.0.1:'),
    neo4j.auth.basic(username, password),
  );
}

async function nativeNamespaceState(namespace: string) {
  const driver = driverForTests();
  const session = driver.session({ database });
  try {
    const entities = await session.run(
      'MATCH (e:Entity {group_id:$namespace}) RETURN properties(e) AS properties ORDER BY e.uuid',
      { namespace },
    );
    const edges = await session.run(
      'MATCH ()-[r:RELATES_TO {group_id:$namespace}]->() RETURN properties(r) AS properties ORDER BY r.uuid',
      { namespace },
    );
    const episodes = await session.run(
      'MATCH (ep:Episode {group_id:$namespace}) RETURN properties(ep) AS properties ORDER BY ep.uuid',
      { namespace },
    );
    const operations = await session.run(
      'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN properties(op) AS properties ORDER BY op.position, op.operation_id',
      { namespace },
    );
    const lock = await session.run(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.epoch AS epoch, lock.revision AS revision, lock.automatic_operations_v1_present AS present",
    );
    return {
      entities: entities.records.map((record) => record.get('properties')),
      edges: edges.records.map((record) => record.get('properties')),
      episodes: episodes.records.map((record) => record.get('properties')),
      operations: operations.records.map((record) => record.get('properties')),
      lock: lock.records.map((record) => record.toObject()),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

function interceptStorageExecuteWrite(
  storage: Neo4jStorage,
  mode: 'throw_after_callback' | 'reenter_same_callback',
  afterFirstCallback?: () => void | Promise<void>,
) {
  const storageWithSession = storage as unknown as { getSession: () => Session };
  const getSession = storageWithSession.getSession.bind(storage);
  let intercepted = false;
  return jest.spyOn(storageWithSession, 'getSession').mockImplementation(() => {
    const session = getSession();
    const executeWrite = session.executeWrite.bind(session);
    return new Proxy(session, {
      get(target, property) {
        if (property === 'executeWrite') {
          return async <T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> => {
            if (intercepted) return executeWrite(work);
            intercepted = true;
            if (mode === 'throw_after_callback') {
              return executeWrite(async (tx) => {
                await work(tx);
                await afterFirstCallback?.();
                throw new Error('synthetic pre-commit failure');
              });
            }
            await executeWrite(work);
            await afterFirstCallback?.();
            return executeWrite(work);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Session;
  });
}

describeNeo4j('Neo4j atomic human capture completion', () => {
  let namespace: string;
  let storage: Neo4jStorage;
  let request: AutomaticCaptureBeginRequestV2;
  let bindingId: string;
  let bindingRevision: number;

  beforeEach(async () => {
    if (!uri) throw new Error('NEO4J_TEST_URI is required');
    namespace = `neo-complete-${randomUUID()}`;
    storage = new Neo4jStorage(uri, username, password, database);
    await storage.initialize();
    const now = new Date().toISOString();
    const subject = await storage.addEntity({
      group_id: namespace,
      name: 'Synthetic reviewed human',
      entity_type: 'person',
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'manual',
          confidence: null,
          review_status: 'accepted',
          threshold_decision: 'manually_reviewed',
          extracted_at: now,
          episode_uuids: [],
          reviewed_at: now,
          reviewed_by: 'synthetic-reviewer',
        },
      },
    });
    const binding = await storage.automaticBindingCommand({
      action: 'create',
      namespace,
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      subjectId: subject.uuid,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic verification',
    });
    bindingId = binding.bindingId;
    bindingRevision = binding.revision;
    request = AutomaticCaptureBeginRequestV2Schema.parse({
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'human_turn_memory',
      namespace,
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      turn: 'synthetic-event',
      attemptIdHash: 'a'.repeat(64),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30000,
      },
      source: {
        content: 'I prefer concise explanations.',
        sourceMessageId: `source-${namespace}`,
        conversationId: `conversation-${namespace}`,
        senderId: 'synthetic-actor',
        senderName: 'Synthetic Display',
        sourceWorkflowId: 'synthetic-workflow',
        originalSourceExecutionId: 'synthetic-original-execution',
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    });
  });

  afterEach(async () => {
    await storage.close();
    const driver = driverForTests();
    const session = driver.session({ database });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
          namespace,
        });
        await tx.run(
          'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
          { namespace },
        );
        await tx.run('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
          namespace,
        });
      });
    } finally {
      await session.close();
      await driver.close();
    }
  });

  const prepare = async () => {
    const begun = await storage.beginAndClaimAutomaticCaptureV2(request);
    if (begun.kind !== 'claimed' || begun.purpose !== 'human_turn_memory')
      throw new Error('Expected initial human capture lease');
    const graph = await storage.readExtractionSnapshot();
    const operation = graph.automatic_operations_v1?.operations.find(
      (item) => item.operationId === begun.operationId,
    );
    if (
      operation?.version !== 2 ||
      operation.state !== 'leased' ||
      operation.descriptor.purpose !== 'human_turn_memory'
    )
      throw new Error('Expected the persisted leased human operation');
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    const plan = planAutomaticClaims(
      graph,
      request.namespace,
      [begun.sourceId],
      operation.descriptor.policy,
      outcome,
      operation.lease.renewedAt,
    );
    return { ...begun, plan };
  };

  const replan = async (sourceId: string, operationId: string): Promise<StagedExtraction> => {
    const graph = await storage.readExtractionSnapshot();
    const operation = graph.automatic_operations_v1?.operations.find(
      (item) => item.operationId === operationId,
    );
    if (
      operation?.version !== 2 ||
      operation.state !== 'leased' ||
      operation.descriptor.purpose !== 'human_turn_memory'
    )
      throw new Error('Expected the current leased human operation');
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    return planAutomaticClaims(
      graph,
      request.namespace,
      [sourceId],
      operation.descriptor.policy,
      outcome,
      operation.lease.renewedAt,
    );
  };

  it('commits facts, receipt, operation, and extraction epoch atomically', async () => {
    const captured = await prepare();
    const before = await nativeNamespaceState(namespace);
    const result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);

    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') throw new Error('Expected a durable commit result');
    expect(result.invocation).toBe('initial_owner');
    expect(result.eligibleFirstCommit).toBe(true);
    const after = await nativeNamespaceState(namespace);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.entities.length).toBeGreaterThan(before.entities.length);
    expect(after.edges).toHaveLength(1);
    expect(after.lock[0].epoch).toBeDefined();
    const stored = JSON.parse(after.operations[0].record_json as string) as {
      state: string;
      terminalReceipt: unknown;
    };
    expect(stored.state).toBe('committed');
    expect(stored.terminalReceipt).toEqual(result.terminalReceipt);
    const graph = await storage.readExtractionSnapshot();
    expect(graph.metadata?.extraction_epoch).toBe(after.lock[0].epoch);
    expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({ state: 'committed' });
  });

  it('rolls back staged facts and receipt after a pre-commit transaction failure', async () => {
    const captured = await prepare();
    const before = await nativeNamespaceState(namespace);
    let workRan = false;
    const intercept = interceptStorageExecuteWrite(storage, 'throw_after_callback', () => {
      workRan = true;
    });
    let result;
    try {
      result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    } finally {
      intercept.mockRestore();
    }

    expect(workRan).toBe(true);
    expect(result).toEqual({ kind: 'storage_error', eligibleFirstCommit: false });
    expect(await nativeNamespaceState(namespace)).toEqual(before);
  });

  it('recovers a committed callback replay once and does not double-increment revision', async () => {
    const captured = await prepare();
    const before = await nativeNamespaceState(namespace);
    const intercept = interceptStorageExecuteWrite(storage, 'reenter_same_callback');
    let result;
    try {
      result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    } finally {
      intercept.mockRestore();
    }

    expect(result?.kind).toBe('committed');
    if (result?.kind !== 'committed') throw new Error('Expected exact callback recovery');
    expect(result.invocation).toBe('same_call_ack_recovered');
    expect(result.eligibleFirstCommit).toBe(true);
    const after = await nativeNamespaceState(namespace);
    expect(after.edges).toHaveLength(1);
    expect(after.operations).toHaveLength(1);
    expect(after.lock[0].revision.toString()).toBe(
      (Number(before.lock[0].revision.toString()) + 1).toString(),
    );
  });

  it('rechecks authority after commit acknowledgment recovery and withholds eligibility if revoked', async () => {
    const captured = await prepare();
    const intercept = interceptStorageExecuteWrite(storage, 'reenter_same_callback', async () => {
      await storage.automaticBindingCommand({
        action: 'revoke',
        namespace,
        bindingId,
        expectedRevision: bindingRevision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic post-commit revocation',
      });
    });
    let result;
    try {
      result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    } finally {
      intercept.mockRestore();
    }

    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'same_call_ack_recovered',
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    });
    const graph = await storage.readExtractionSnapshot();
    expect(graph.edges).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({ state: 'committed' });
  });

  it('returns a bounded retry after a concurrent graph change and commits only a fresh plan', async () => {
    const captured = await prepare();
    await storage.addEntity({
      group_id: namespace,
      name: 'Synthetic concurrent graph change',
      entity_type: 'concept',
    });
    const retry = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    expect(retry.kind).toBe('graph_conflict_retry');
    if (retry.kind !== 'graph_conflict_retry') throw new Error('Expected a bounded retry handle');
    expect(retry.eligibleFirstCommit).toBe(false);
    let graph = await storage.readExtractionSnapshot();
    expect(graph.edges).toHaveLength(0);
    expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({
      state: 'leased',
      retryCount: 1,
    });

    const nextPlan = await replan(captured.sourceId, captured.operationId);
    const committed = await storage.completeHumanCaptureV2(retry.retryHandle, nextPlan);
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') throw new Error('Expected the successor lease to commit');
    expect(committed.invocation).toBe('initial_owner');
    expect(committed.eligibleFirstCommit).toBe(true);
    graph = await storage.readExtractionSnapshot();
    expect(graph.edges).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({
      state: 'committed',
      retryCount: 1,
    });
  });

  it('does not apply facts after current binding revocation', async () => {
    const captured = await prepare();
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace,
      bindingId,
      expectedRevision: bindingRevision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic pre-commit revocation',
    });

    const result = await storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan);
    expect(result).toEqual({ kind: 'authority_changed', eligibleFirstCommit: false });
    const graph = await storage.readExtractionSnapshot();
    expect(graph.edges).toHaveLength(0);
    expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({ state: 'leased' });
  });

  it('rejects invalid handles before reading a hostile plan or opening a session', async () => {
    let accessed = false;
    const hostilePlan = new Proxy(
      {},
      {
        get() {
          accessed = true;
          throw new Error('plan must remain unread');
        },
      },
    );
    const privateStorage = storage as unknown as { getSession: () => Session };
    const getSession = jest.spyOn(privateStorage, 'getSession');
    try {
      const result = await storage.completeHumanCaptureV2(
        Object.freeze(
          Object.create(null),
        ) as PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>,
        hostilePlan as StagedExtraction,
      );
      expect(result).toEqual({ kind: 'invalid_handle', eligibleFirstCommit: false });
      expect(accessed).toBe(false);
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      getSession.mockRestore();
    }
  });

  it('consumes the one-use handle before concurrent completion calls can both write', async () => {
    const captured = await prepare();
    const results = await Promise.all([
      storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan),
      storage.completeHumanCaptureV2(captured.leaseHandle, captured.plan),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['committed', 'invalid_handle']);
    const graph = await storage.readExtractionSnapshot();
    expect(graph.edges).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations[0].state).toBe('committed');
  });
});
