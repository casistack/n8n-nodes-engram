import { randomUUID } from 'crypto';
import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import {
  AutomaticCaptureBeginRequestV2Schema,
  type AutomaticCaptureBeginRequestV2,
} from '../../src/schemas/AutomaticCapture.schema';
import type { GraphData } from '../../src/schemas';
import { makeHumanFixture } from '../helpers/automaticCommittedFixture';
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

function serializedWithOwnProto(attributes: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(attributes)) as Record<string, unknown>;
  Object.defineProperty(copy, '__proto__', {
    value: { synthetic: 'preserve' },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return JSON.stringify(copy);
}

async function seedNativeGraph(graph: GraphData, namespace: string): Promise<void> {
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
      for (const entity of graph.entities) {
        await tx.run('CREATE (n:Entity) SET n += $props', {
          props: { ...entity, attributes: JSON.stringify(entity.attributes) },
        });
      }
      for (const [index, episode] of graph.episodes.entries()) {
        await tx.run('CREATE (n:Episode) SET n += $props', {
          props: {
            ...episode,
            attributes: JSON.stringify(episode.attributes),
            append_sequence: index + 1,
            source_dedup_key:
              episode.source_message_id && episode.episode_kind
                ? JSON.stringify([
                    episode.group_id,
                    episode.source_message_id,
                    episode.episode_kind,
                  ])
                : null,
            idempotency_dedup_key: episode.idempotency_key
              ? JSON.stringify([episode.group_id, episode.idempotency_key])
              : null,
          },
        });
        if (episode.previous_episode_uuid) {
          await tx.run(
            'MATCH (previous:Episode {uuid:$previous}), (current:Episode {uuid:$current}) CREATE (previous)-[:NEXT_EPISODE]->(current)',
            { previous: episode.previous_episode_uuid, current: episode.uuid },
          );
        }
      }
      for (const edge of graph.edges) {
        await tx.run(
          'MATCH (source:Entity {uuid:$source}), (target:Entity {uuid:$target}) CREATE (source)-[r:RELATES_TO]->(target) SET r += $props',
          {
            source: edge.source_node_uuid,
            target: edge.target_node_uuid,
            props: { ...edge, attributes: JSON.stringify(edge.attributes) },
          },
        );
      }
      for (const [position, operation] of (
        graph.automatic_operations_v1?.operations ?? []
      ).entries()) {
        await tx.run('CREATE (op:AutomaticOperation) SET op += $props', {
          props: {
            operation_id: operation.operationId,
            store_hash: operation.identity.storeHash,
            namespace: operation.identity.namespace,
            source_id: operation.identity.sourceId,
            role: operation.identity.role,
            position,
            record_json: JSON.stringify(operation),
          },
        });
      }
      await tx.run(
        "MERGE (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.automatic_operations_v1_present=true, lock.revision=coalesce(lock.revision,0)+1",
      );
      if (graph.episodes.length > 0) {
        await tx.run(
          'MERGE (lock:EpisodeGroupLock {group_id:$namespace}) SET lock.sequence=$sequence',
          { namespace, sequence: neo4j.int(graph.episodes.length) },
        );
      }
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

async function rawNamespaceRows(namespace: string) {
  const driver = driverForTests();
  const session = driver.session({ database });
  try {
    const entities = await session.run(
      'MATCH (e:Entity {group_id:$namespace}) RETURN properties(e) AS properties ORDER BY e.uuid',
      { namespace },
    );
    const episodes = await session.run(
      'MATCH (ep:Episode {group_id:$namespace}) RETURN properties(ep) AS properties ORDER BY ep.uuid',
      { namespace },
    );
    const edges = await session.run(
      'MATCH ()-[r:RELATES_TO {group_id:$namespace}]->() RETURN properties(r) AS properties ORDER BY r.uuid',
      { namespace },
    );
    const operations = await session.run(
      'MATCH (op:AutomaticOperation {namespace:$namespace}) RETURN properties(op) AS properties ORDER BY op.position, op.operation_id',
      { namespace },
    );
    const lock = await session.run(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.automatic_operations_v1_present AS present, lock.revision AS revision",
    );
    return {
      entities: entities.records.map((record) => record.get('properties')),
      edges: edges.records.map((record) => record.get('properties')),
      episodes: episodes.records.map((record) => record.get('properties')),
      operations: operations.records.map((record) => record.get('properties')),
      lock: lock.records.map((record) => [
        record.get('present'),
        record.get('revision')?.toString(),
      ]),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

async function setRawEntityAttributes(uuid: string, attributes: string): Promise<void> {
  const driver = driverForTests();
  const session = driver.session({ database });
  try {
    await session.run('MATCH (e:Entity {uuid:$uuid}) SET e.attributes=$attributes', {
      uuid,
      attributes,
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

async function setRawEpisodeAttributes(uuid: string, attributes: string): Promise<void> {
  const driver = driverForTests();
  const session = driver.session({ database });
  try {
    await session.run('MATCH (ep:Episode {uuid:$uuid}) SET ep.attributes=$attributes', {
      uuid,
      attributes,
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

function interceptStorageExecuteWrite(
  storage: Neo4jStorage,
  mode: 'throw_after_callback' | 'reenter_same_callback',
  onFirstCommit?: () => void,
) {
  const storageWithSession = storage as unknown as { getSession: () => Session };
  const getSession = storageWithSession.getSession.bind(storage);
  return jest.spyOn(storageWithSession, 'getSession').mockImplementation(() => {
    const session = getSession();
    const executeWrite = session.executeWrite.bind(session);
    return new Proxy(session, {
      get(target, property) {
        if (property === 'executeWrite') {
          return async <T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> => {
            if (mode === 'throw_after_callback') {
              return executeWrite(async (tx) => {
                const result = await work(tx);
                onFirstCommit?.();
                throw new Error('synthetic pre-commit failure');
                return result;
              });
            }
            await executeWrite(work);
            onFirstCommit?.();
            return executeWrite(work);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Session;
  });
}

describeNeo4j('Neo4j atomic human capture begin', () => {
  let namespace: string;
  let storage: Neo4jStorage;
  let request: AutomaticCaptureBeginRequestV2;
  let subjectId: string;

  beforeEach(async () => {
    if (!uri) throw new Error('NEO4J_TEST_URI is required');
    namespace = `neo-begin-${randomUUID()}`;
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
    subjectId = subject.uuid;
    await storage.automaticBindingCommand({
      action: 'create',
      namespace,
      issuer: 'synthetic-app',
      actorReference: 'synthetic-actor',
      subjectId,
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

  it('atomically persists the source and lease using the native append tail and sequence', async () => {
    const predecessor = await storage.appendEpisode({
      group_id: namespace,
      content: 'Earlier human message.',
      role: 'human',
      reference_time: new Date().toISOString(),
      source_message_id: null,
      sender_id: null,
      episode_kind: 'legacy',
    });

    const result = await storage.beginAndClaimAutomaticCaptureV2(request);
    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') throw new Error('Expected a private initial lease');
    expect(Object.keys(result.leaseHandle)).toHaveLength(0);
    expect(Object.isFrozen(result.leaseHandle)).toBe(true);
    expect(result).not.toHaveProperty('should_process');

    const graph = await storage.readExtractionSnapshot();
    const source = graph.episodes.find((episode) => episode.uuid === result.sourceId);
    expect(source).toMatchObject({
      group_id: namespace,
      content: request.source.content,
      previous_episode_uuid: predecessor.episode.uuid,
    });
    expect(graph.episodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
    const operation = graph.automatic_operations_v1?.operations.find(
      (item) => item.operationId === result.operationId,
    );
    expect(operation).toMatchObject({
      version: 2,
      state: 'leased',
      identity: { sourceId: result.sourceId, namespace },
      lease: { claimKind: 'initial' },
    });

    const driver = driverForTests();
    const session = driver.session({ database });
    try {
      const persisted = await session.run(
        `MATCH (previous:Episode {uuid:$previous}), (source:Episode {uuid:$source})
         OPTIONAL MATCH (previous)-[next:NEXT_EPISODE]->(source)
         RETURN source.append_sequence AS sequence, count(next) AS links`,
        { previous: predecessor.episode.uuid, source: result.sourceId },
      );
      const sequence = persisted.records[0]?.get('sequence');
      expect(neo4j.isInt(sequence) ? sequence.toNumber() : Number(sequence)).toBe(2);
      expect(persisted.records[0]?.get('links').toNumber()).toBe(1);
    } finally {
      await session.close();
      await driver.close();
    }
  });

  it('serializes concurrent arrivals from separate storage instances without a second source', async () => {
    const other = new Neo4jStorage(uri!, username, password, database);
    await other.initialize();
    try {
      const [first, second] = await Promise.all([
        storage.beginAndClaimAutomaticCaptureV2(request),
        other.beginAndClaimAutomaticCaptureV2({ ...request, attemptIdHash: 'b'.repeat(64) }),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(['claimed', 'in_progress']);
      const graph = await storage.readExtractionSnapshot();
      expect(graph.episodes).toHaveLength(1);
      expect(graph.episodes[0].group_id).toBe(namespace);
      expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
      expect(graph.automatic_operations_v1?.operations[0].attempts).toHaveLength(2);
      expect(graph.edges).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('rolls back source and operation when a native transaction fails after staging both', async () => {
    const before = await storage.readExtractionSnapshot();
    let callbackCompleted = 0;
    const spy = interceptStorageExecuteWrite(storage, 'throw_after_callback', () => {
      callbackCompleted += 1;
    });
    try {
      await expect(storage.beginAndClaimAutomaticCaptureV2(request)).rejects.toThrow(
        'synthetic pre-commit failure',
      );
    } finally {
      spy.mockRestore();
    }
    expect(callbackCompleted).toBe(1);

    const afterRollback = await storage.readExtractionSnapshot();
    expect(afterRollback.entities).toEqual(before.entities);
    expect(afterRollback.edges).toEqual(before.edges);
    expect(afterRollback.episodes).toEqual(before.episodes);
    expect(afterRollback.automatic_operations_v1).toEqual(before.automatic_operations_v1);

    const retry = await storage.beginAndClaimAutomaticCaptureV2(request);
    expect(retry.kind).toBe('claimed');
    const afterRetry = await storage.readExtractionSnapshot();
    expect(afterRetry.episodes).toHaveLength(1);
    expect(afterRetry.automatic_operations_v1?.operations).toHaveLength(1);
  });

  it('recovers only the same invocation after a committed callback is replayed', async () => {
    let firstTransactionCommitted = 0;
    const spy = interceptStorageExecuteWrite(storage, 'reenter_same_callback', () => {
      firstTransactionCommitted += 1;
    });
    let result;
    try {
      result = await storage.beginAndClaimAutomaticCaptureV2(request);
    } finally {
      spy.mockRestore();
    }
    expect(firstTransactionCommitted).toBe(1);
    expect(result?.kind).toBe('claimed');
    if (result?.kind !== 'claimed') throw new Error('Expected same-call initial handle recovery');
    expect(Object.keys(result.leaseHandle)).toEqual([]);

    const graph = await storage.readExtractionSnapshot();
    expect(graph.episodes).toHaveLength(1);
    expect(graph.episodes[0].uuid).toBe(result.sourceId);
    expect(graph.automatic_operations_v1?.operations).toHaveLength(1);
    expect(graph.automatic_operations_v1?.operations[0].operationId).toBe(result.operationId);
    expect(graph.automatic_operations_v1?.operations[0].attempts).toHaveLength(1);

    expect(await storage.beginAndClaimAutomaticCaptureV2(request)).toEqual({
      kind: 'in_progress',
    });
    const afterIndependentCall = await storage.readExtractionSnapshot();
    expect(afterIndependentCall.episodes).toHaveLength(1);
    expect(afterIndependentCall.automatic_operations_v1?.operations).toHaveLength(1);
    expect(afterIndependentCall.automatic_operations_v1?.operations[0].attempts).toHaveLength(1);
  });

  it('fails closed for assistant final-save before touching storage', async () => {
    const before = await storage.readExtractionSnapshot();
    const assistant = AutomaticCaptureBeginRequestV2Schema.parse({
      ...request,
      purpose: 'assistant_final_save',
      settings: {
        ...request.settings,
        profileId: null,
        requestedTrustLevel: null,
        intentSetting: null,
      },
    });
    expect(await storage.beginAndClaimAutomaticCaptureV2(assistant)).toEqual({
      kind: 'unsupported_mode',
    });
    const after = await storage.readExtractionSnapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('rejects embedded URI userinfo before opening a session', async () => {
    const withUserinfo = uri!.replace('://', '://synthetic-user:synthetic-password@');
    const unboundStore = new Neo4jStorage(withUserinfo, username, password, database);
    const privateStorage = unboundStore as unknown as { getSession: () => Session };
    const getSession = jest.spyOn(privateStorage, 'getSession');
    try {
      expect(await unboundStore.beginAndClaimAutomaticCaptureV2(request)).toEqual({
        kind: 'unsupported_mode',
      });
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      getSession.mockRestore();
      await unboundStore.close();
    }
  });

  it('rejects an uninitialized backend before opening a session', async () => {
    const uninitialized = new Neo4jStorage(uri!, username, password, database);
    const privateStorage = uninitialized as unknown as { getSession: () => Session };
    const getSession = jest.spyOn(privateStorage, 'getSession');
    try {
      expect(await uninitialized.beginAndClaimAutomaticCaptureV2(request)).toEqual({
        kind: 'unsupported_mode',
      });
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      getSession.mockRestore();
      await uninitialized.close();
    }
  });

  it('rejects own __proto__ metadata in a rootless store without changing native rows', async () => {
    const graph = await storage.readExtractionSnapshot();
    const subject = graph.entities.find((entity) => entity.uuid === subjectId);
    if (!subject) throw new Error('Expected the synthetic binding subject');
    await setRawEntityAttributes(subjectId, serializedWithOwnProto(subject.attributes));
    const before = await rawNamespaceRows(namespace);

    await expect(storage.beginAndClaimAutomaticCaptureV2(request)).rejects.toThrow(
      'record_normalization',
    );

    expect(await rawNamespaceRows(namespace)).toEqual(before);
  });

  it('rejects own __proto__ metadata before mutating a ledger-bearing native store', async () => {
    const committed = makeHumanFixture(namespace);
    await seedNativeGraph(committed.graph, namespace);
    const sourceWithSpecialMetadata = committed.graph.episodes.find(
      (episode) => episode.uuid === committed.human.uuid,
    );
    if (!sourceWithSpecialMetadata) throw new Error('Expected the committed synthetic source');
    await setRawEpisodeAttributes(
      sourceWithSpecialMetadata.uuid,
      serializedWithOwnProto(sourceWithSpecialMetadata.attributes),
    );
    const before = await rawNamespaceRows(namespace);
    const requestForFixture = AutomaticCaptureBeginRequestV2Schema.parse({
      ...request,
      namespace,
      issuer: 'synthetic-workflow',
      actorReference: 'synthetic-human-actor',
    });

    await expect(storage.beginAndClaimAutomaticCaptureV2(requestForFixture)).rejects.toThrow(
      'record_normalization',
    );

    expect(await rawNamespaceRows(namespace)).toEqual(before);
  });
});
