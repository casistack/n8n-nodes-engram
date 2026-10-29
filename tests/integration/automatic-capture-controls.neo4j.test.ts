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
      lock: lock.records.map((record) => ({
        epoch: record.get('epoch'),
        revision: record.get('revision')?.toString(),
        present: record.get('present'),
      })),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

function interceptStorageExecuteWrite(
  storage: Neo4jStorage,
  mode: 'throw_after_callback' | 'reenter_same_callback',
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
                throw new Error('synthetic pre-commit failure');
              });
            }
            await executeWrite(work);
            return executeWrite(work);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Session;
  });
}

describeNeo4j('Neo4j human capture controls', () => {
  let namespace: string;
  let storage: Neo4jStorage;
  let request: AutomaticCaptureBeginRequestV2;

  const locator = () => ({
    version: 2 as const,
    namespace,
    issuer: 'synthetic-app',
    actorReference: 'synthetic-actor',
    turn: 'synthetic-event',
    role: 'human' as const,
  });
  const fence = (expectedGeneration = 1, attemptIdHash = 'b'.repeat(64)) => ({
    ...locator(),
    expectedGeneration,
    attemptIdHash,
  });
  const makePlan = async (sourceId: string, operationId: string): Promise<StagedExtraction> => {
    const graph = await storage.readExtractionSnapshot();
    const operation = graph.automatic_operations_v1?.operations.find(
      (item) => item.operationId === operationId,
    );
    if (
      operation?.version !== 2 ||
      operation.state !== 'leased' ||
      operation.descriptor.purpose !== 'human_turn_memory'
    ) {
      throw new Error('Expected the current human capture lease');
    }
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    return planAutomaticClaims(
      graph,
      namespace,
      [sourceId],
      operation.descriptor.policy,
      outcome,
      operation.lease.renewedAt,
    );
  };
  const begin = async () => {
    const result = await storage.beginAndClaimAutomaticCaptureV2(request);
    if (result.kind !== 'claimed' || result.purpose !== 'human_turn_memory')
      throw new Error(`Expected a human capture lease; received ${result.kind}`);
    return result;
  };
  const failCurrentLease = async () => {
    const captured = await begin();
    const invalid = await makePlan(captured.sourceId, captured.operationId);
    invalid.outcome.status = 'failed';
    invalid.outcome.error_count = 1;
    expect(await storage.completeHumanCaptureV2(captured.leaseHandle, invalid)).toMatchObject({
      kind: 'invalid_plan',
      eligibleFirstCommit: false,
    });
    const graph = await storage.readExtractionSnapshot();
    expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({ state: 'failed' });
    return captured;
  };

  beforeEach(async () => {
    if (!uri) throw new Error('NEO4J_TEST_URI is required');
    namespace = `neo-controls-${randomUUID()}`;
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
    await storage.automaticBindingCommand({
      action: 'create',
      namespace,
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      subjectId: subject.uuid,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic verification',
    });
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

  it('reads without changing the common revision and rolls back an unexpired resume decision', async () => {
    await begin();
    const before = await nativeNamespaceState(namespace);
    expect(await storage.getAutomaticCaptureOutcomeV2(locator())).toMatchObject({
      status: 'in_progress',
      should_process: false,
      sourcePersistence: 'persisted',
    });
    expect(await storage.resumeAutomaticCaptureV2(fence())).toEqual({ kind: 'in_progress' });
    expect(await nativeNamespaceState(namespace)).toEqual(before);
  });

  it('cancels atomically and permanently fences the original handle', async () => {
    const captured = await begin();
    const plan = await makePlan(captured.sourceId, captured.operationId);
    const before = await nativeNamespaceState(namespace);
    const result = await storage.cancelAutomaticCaptureV2(fence());
    expect(result).toMatchObject({ kind: 'cancelled', eligibleFirstCommit: false });
    const after = await nativeNamespaceState(namespace);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.operations).toHaveLength(1);
    expect(JSON.parse(after.operations[0].record_json as string)).toMatchObject({
      state: 'cancelled',
      terminalReceipt: { acceptedCoverage: 'none' },
    });
    expect(Number(after.lock[0].revision) - Number(before.lock[0].revision)).toBe(1);
    expect(await storage.completeHumanCaptureV2(captured.leaseHandle, plan)).toMatchObject({
      eligibleFirstCommit: false,
    });
    expect(await storage.getAutomaticCaptureOutcomeV2(locator())).toMatchObject({
      status: 'cancelled',
      should_process: false,
    });
  });

  it('returns private-source-free conflicts and does not change revision for stale fences', async () => {
    await begin();
    const before = await nativeNamespaceState(namespace);
    expect(await storage.resumeAutomaticCaptureV2(fence(2))).toEqual({ kind: 'fenced' });
    expect(
      await storage.cancelAutomaticCaptureV2({ ...fence(), actorReference: 'other-actor' }),
    ).toMatchObject({ kind: 'conflict', eligibleFirstCommit: false });
    const read = await storage.getAutomaticCaptureOutcomeV2({
      ...locator(),
      actorReference: 'other-actor',
    });
    expect(read).toMatchObject({ sourceId: null, should_process: false, status: 'conflict' });
    expect(await nativeNamespaceState(namespace)).toEqual(before);
  });

  it('resumes failed work after reopening, then a resumed completion remains ineligible', async () => {
    await failCurrentLease();
    await storage.close();
    storage = new Neo4jStorage(uri!, username, password, database);
    await storage.initialize();

    const resumed = await storage.resumeAutomaticCaptureV2(fence());
    if (resumed.kind !== 'resumed' || resumed.purpose !== 'human_turn_memory')
      throw new Error(`Expected an explicit resume handle; received ${resumed.kind}`);
    const result = await storage.completeHumanCaptureV2(
      resumed.leaseHandle,
      await makePlan(resumed.sourceId, resumed.operationId),
    );
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'explicit_resume',
      eligibleFirstCommit: false,
    });
    expect(await storage.getAutomaticCaptureOutcomeV2(locator())).toMatchObject({
      status: 'committed_replay',
      should_process: false,
    });
    expect(await storage.resumeAutomaticCaptureV2(fence(2))).toEqual({ kind: 'committed_replay' });
  });

  it('recovers a committed callback replay for one exact resume token without another revision', async () => {
    await failCurrentLease();
    const before = await nativeNamespaceState(namespace);
    const intercept = interceptStorageExecuteWrite(storage, 'reenter_same_callback');
    let resumed: Awaited<ReturnType<Neo4jStorage['resumeAutomaticCaptureV2']>> | undefined;
    try {
      resumed = await storage.resumeAutomaticCaptureV2(fence());
    } finally {
      intercept.mockRestore();
    }
    expect(resumed?.kind).toBe('resumed');
    if (resumed?.kind !== 'resumed' || resumed.purpose !== 'human_turn_memory')
      throw new Error('Expected callback-recovered resume handle');
    expect(Object.keys(resumed.leaseHandle)).toEqual([]);
    const after = await nativeNamespaceState(namespace);
    expect(after.operations).toHaveLength(1);
    expect(JSON.parse(after.operations[0].record_json as string)).toMatchObject({
      state: 'leased',
      generation: 2,
      lease: { claimKind: 'resume' },
    });
    expect(Number(after.lock[0].revision) - Number(before.lock[0].revision)).toBe(1);
    expect(await storage.resumeAutomaticCaptureV2(fence())).toEqual({ kind: 'fenced' });
    const committed = await storage.completeHumanCaptureV2(
      resumed.leaseHandle,
      await makePlan(resumed.sourceId, resumed.operationId),
    );
    expect(committed).toMatchObject({ kind: 'committed', eligibleFirstCommit: false });
  });

  it('rolls back an unacknowledged resume write and allows a later explicit retry', async () => {
    await failCurrentLease();
    const before = await nativeNamespaceState(namespace);
    const intercept = interceptStorageExecuteWrite(storage, 'throw_after_callback');
    try {
      await expect(storage.resumeAutomaticCaptureV2(fence())).rejects.toThrow(
        'Engram automatic capture: storage_error',
      );
    } finally {
      intercept.mockRestore();
    }
    expect(await nativeNamespaceState(namespace)).toEqual(before);
    const resumed = await storage.resumeAutomaticCaptureV2(fence());
    expect(resumed.kind).toBe('resumed');
  });

  it('serializes concurrent explicit resumes to one new generation and handle', async () => {
    await failCurrentLease();
    const other = new Neo4jStorage(uri!, username, password, database);
    await other.initialize();
    try {
      const results = await Promise.all([
        storage.resumeAutomaticCaptureV2(fence()),
        other.resumeAutomaticCaptureV2(fence()),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['fenced', 'resumed']);
      const graph = await storage.readExtractionSnapshot();
      expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
      expect(graph.automatic_operations_v1?.operations[0]).toMatchObject({
        version: 2,
        state: 'leased',
        generation: 2,
        lease: { claimKind: 'resume' },
      });
    } finally {
      await other.close();
    }
  });
});
