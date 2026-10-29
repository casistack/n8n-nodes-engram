import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import { makeCompositionalCaptureFixture } from '../helpers/compositionalCaptureFixture';
import { makeHumanFixture } from '../helpers/automaticCommittedFixture';
import { AutomaticCaptureBeginRequestV2Schema } from '../../src/schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalOperationV4Schema,
  type AutonomousPersonalOperationV4,
} from '../../src/schemas/AutonomousPersonalOperationV4.schema';
import {
  compileAutonomousPersonalDescriptorV4,
  type AutonomousPersonalDescriptorV4,
} from '../../src/schemas/AutonomousPersonalDescriptorV4.schema';
import { compileAutonomousPersonalSourceTupleV4 } from '../../src/schemas/AutonomousPersonalSourceV4.schema';
import {
  AutomaticOperationSchema,
  EntityNodeSchema,
  EpisodicNodeSchema,
  GraphDataSchema,
  type GraphData,
} from '../../src/schemas';
import type { AutomaticWriteOwner } from '../../src/schemas/AutomaticClaim.schema';
import {
  assertAutomaticLedgerSourceIntegrity,
  automaticOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
  WRITE_OWNER_V3_ATTRIBUTE,
  WRITE_OWNER_V4_ATTRIBUTE,
  SOURCE_ENVELOPE_V3_ATTRIBUTE,
} from '../../src/storage/AutomaticIdentity';
import {
  embeddedAutomaticCaptureStoreHash,
  neo4jAutomaticCaptureStoreHash,
} from '../../src/storage/AutomaticCaptureStore';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import { exportQueueBackup } from '../../src/extraction/QueueState';

jest.setTimeout(30000);

const NOW = '2026-10-26T12:00:00.000Z';
const NEXT = '2026-10-27T12:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function descriptor(): AutonomousPersonalDescriptorV4 {
  return compileAutonomousPersonalDescriptorV4({
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    invocationDeadlineMs: 30_000,
    providerReference: {
      routeId: 'synthetic-native-fixture',
      configurationFingerprint: 'b'.repeat(64),
      protocol: 'openai-compatible-json-v1',
      configuredRequestLimit: 2,
      configuredTimeoutMs: 30_000,
      configuredRequestBytes: 262_144,
      configuredResponseBytes: 65_536,
      temperature: { mode: 'providerDefault' },
      responseFormat: 'json_object',
      outputTokenLimit: { mode: 'omit' },
    },
  });
}

describe('V4-scoped global native identity checks', () => {
  it('rejects cross-kind UUID reuse only when the V4 family is present', () => {
    const { graph, v4 } = makeMixedGraph('d'.repeat(64));
    const duplicateWithV4 = structuredClone(graph);
    duplicateWithV4.entities.push({
      ...duplicateWithV4.entities[0],
      uuid: v4.source.uuid,
    });
    expect(() => assertAutomaticLedgerSourceIntegrity(duplicateWithV4)).toThrow(
      'duplicate_global_id',
    );

    const legacyOnly = structuredClone(graph);
    legacyOnly.episodes = legacyOnly.episodes.filter((episode) => episode.uuid !== v4.source.uuid);
    legacyOnly.automatic_operations_v1!.operations =
      legacyOnly.automatic_operations_v1!.operations.filter((operation) => operation.version !== 4);
    legacyOnly.entities.push({
      ...legacyOnly.entities[0],
      uuid: legacyOnly.episodes[0].uuid,
    });
    expect(() => assertAutomaticLedgerSourceIntegrity(legacyOnly)).not.toThrow();
  });
});

type V4Fixture = {
  source: ReturnType<typeof EpisodicNodeSchema.parse>;
  descriptor: AutonomousPersonalDescriptorV4;
  operation: AutonomousPersonalOperationV4;
  tuple: ReturnType<typeof compileAutonomousPersonalSourceTupleV4>;
};

function makeV4Fixture(options: {
  storeHash: string;
  namespace: string;
  binding: {
    bindingId: string;
    revision: number;
    subjectId: string;
    fingerprint: string;
  };
  turn?: string;
  sourceId?: string;
  previousEpisodeUuid?: string | null;
  sourceMessageId?: string | null;
}): V4Fixture {
  const descriptorValue = descriptor();
  const sourceId = options.sourceId ?? randomUUID();
  const turn = options.turn ?? `v4-turn-${randomUUID()}`;
  const content = 'I like 😀 and “quoted words.”';
  const quoteStart = content.indexOf('“quoted words.”');
  const tuple = compileAutonomousPersonalSourceTupleV4({
    scope: {
      storeHash: options.storeHash,
      namespace: options.namespace,
      issuer: 'synthetic-native-workflow',
      actorReference: 'synthetic-v4-actor',
      turn,
      binding: options.binding,
    },
    descriptor: descriptorValue,
    producer: {
      uuid: sourceId,
      group_id: options.namespace,
      content,
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: NEXT,
      previous_episode_uuid: options.previousEpisodeUuid ?? null,
      source_message_id: options.sourceMessageId ?? `v4-message-${sourceId}`,
      idempotency_key: `v4-event-${sourceId}`,
      conversation_id: 'synthetic-v4-conversation',
      sender_id: 'synthetic-v4-actor',
      source_workflow_id: 'synthetic-v4-workflow',
      source_execution_id: `original-v4-execution-${sourceId}`,
      quoted_message_id: null,
      created_at: NEXT,
    },
    eventTimeMode: 'first_capture',
    mapping: { mode: 'full_body' },
    quoteRegions: [{ start: quoteStart, end: quoteStart + '“quoted words.”'.length }],
  });
  const source = EpisodicNodeSchema.parse({
    uuid: sourceId,
    group_id: options.namespace,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: NEXT,
    previous_episode_uuid: options.previousEpisodeUuid ?? null,
    created_at: NEXT,
    updated_at: NEXT,
    source_message_id: options.sourceMessageId ?? `v4-message-${sourceId}`,
    idempotency_key: `v4-event-${sourceId}`,
    conversation_id: 'synthetic-v4-conversation',
    sender_id: 'synthetic-v4-actor',
    sender_name: 'Synthetic V4 display name',
    episode_kind: 'active_human',
    quoted_message_id: null,
    trust_level: 'standard',
    confidence: null,
    review_status: 'accepted',
    source_workflow_id: 'synthetic-v4-workflow',
    source_execution_id: `original-v4-execution-${sourceId}`,
    attributes: {
      [WRITE_OWNER_V4_ATTRIBUTE]: tuple.owner,
      [SOURCE_ENVELOPE_V3_ATTRIBUTE]: tuple.envelope,
      external_tag: { exact: 'preserve-me' },
    },
  });
  const operation = AutonomousPersonalOperationV4Schema.parse({
    version: 4,
    operationId: randomUUID(),
    identity: tuple.identity,
    descriptor: descriptorValue,
    createdAt: NEXT,
    lastObservedAt: NEXT,
    attempts: [],
    overflowCount: 0,
    beginCallHash: digest(`v4-begin-${sourceId}`),
    retryCount: 0,
    state: 'captured',
    generation: 0,
  });
  return { source, descriptor: descriptorValue, operation, tuple };
}

function makeV1Record(base: ReturnType<typeof makeHumanFixture>) {
  const source = structuredClone(base.human);
  const sourceId = randomUUID();
  source.uuid = sourceId;
  source.previous_episode_uuid = null;
  source.source_message_id = `v1-message-${sourceId}`;
  source.source_execution_id = `original-v1-execution-${sourceId}`;
  delete source.attributes[WRITE_OWNER_V2_ATTRIBUTE];
  const owner = {
    ...(source.attributes[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner),
    turn: `v1-turn-${sourceId}`,
  };
  source.attributes[WRITE_OWNER_ATTRIBUTE] = owner;
  source.idempotency_key = automaticWriteOwnerIdempotencyKey(owner);
  const parsedSource = EpisodicNodeSchema.parse(source);
  const identity = automaticOperationIdentityForOwnedSource(parsedSource, owner);
  const operation = AutomaticOperationSchema.parse({
    version: 1,
    operationId: randomUUID(),
    identity,
    descriptor: null,
    createdAt: NOW,
    lastObservedAt: NOW,
    attempts: [],
    overflowCount: 0,
    state: 'legacy_unconfirmed',
    generation: 0,
  });
  return { source: parsedSource, operation };
}

function makeMixedGraph(storeHash: string): {
  graph: GraphData;
  v4: V4Fixture;
  groups: string[];
} {
  const v2Base = makeHumanFixture(`ledger-v4-mixed-${randomUUID()}`);
  const v1 = makeV1Record(v2Base);
  const v3Base = makeCompositionalCaptureFixture(undefined, storeHash);
  const v4 = makeV4Fixture({
    storeHash,
    namespace: v2Base.human.group_id,
    binding: v2Base.binding,
    turn: `v4-mixed-turn-${randomUUID()}`,
    previousEpisodeUuid: v1.source.uuid,
  });
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: NEXT,
    entities: [...v2Base.graph.entities, ...v3Base.graph.entities],
    edges: [...v2Base.graph.edges, ...v3Base.graph.edges],
    episodes: [v1.source, v2Base.human, v3Base.source, v4.source],
    automatic_operations_v1: {
      version: 1,
      operations: [v1.operation, v2Base.humanOperation, v3Base.operation, v4.operation],
    },
  });
  return {
    graph,
    v4,
    groups: [...new Set(graph.episodes.map((episode) => episode.group_id))],
  };
}

function makeUnownedPredecessor(namespace: string) {
  return EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: namespace,
    content: 'Earlier synthetic episode.',
    role: 'human',
    source_type: 'message',
    reference_time: NOW,
    previous_episode_uuid: null,
    created_at: NOW,
    updated_at: NOW,
    source_message_id: `predecessor-${randomUUID()}`,
    idempotency_key: null,
    conversation_id: 'synthetic-conversation',
    sender_id: 'synthetic-user',
    sender_name: 'Synthetic User',
    episode_kind: 'active_human',
    quoted_message_id: null,
    trust_level: 'untrusted',
    confidence: null,
    review_status: 'proposed',
    source_workflow_id: null,
    source_execution_id: null,
    attributes: {},
  });
}

function makeV2Request(v4: V4Fixture) {
  const owner = v4.tuple.owner;
  const source = v4.source;
  const quote = v4.tuple.envelope.geometry.quoteRegions[0];
  return AutomaticCaptureBeginRequestV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    purpose: 'human_turn_memory',
    namespace: owner.namespace,
    issuer: owner.issuer,
    actorReference: owner.actorReference,
    turn: owner.turn,
    settings: {
      profileId: 'conservative',
      requestedTrustLevel: 'standard',
      intentSetting: false,
      invocationDeadlineMs: 30_000,
    },
    source: {
      content: source.content,
      sourceMessageId: source.source_message_id,
      conversationId: source.conversation_id,
      senderId: source.sender_id,
      senderName: source.sender_name,
      sourceWorkflowId: source.source_workflow_id,
      originalSourceExecutionId: source.source_execution_id,
      sourceType: 'message',
      quotedMessageId: source.quoted_message_id,
      eventTime: { mode: 'first_capture' },
      applicationOwnedWrapper: null,
      humanRegion: null,
      quoteRegions: quote ? [quote] : [],
    },
    attemptIdHash: 'c'.repeat(64),
  });
}

function expectSourceRowsAndOperationsEqual(actual: GraphData, expected: GraphData): void {
  const byUuid = <T extends { uuid: string }>(values: T[]) =>
    [...values].sort((left, right) => left.uuid.localeCompare(right.uuid));
  expect(byUuid(actual.episodes)).toEqual(byUuid(expected.episodes));
  expect(byUuid(actual.entities)).toEqual(byUuid(expected.entities));
  expect(byUuid(actual.edges)).toEqual(byUuid(expected.edges));
  const actualOperations = actual.automatic_operations_v1?.operations ?? [];
  const expectedOperations = expected.automatic_operations_v1?.operations ?? [];
  expect(actualOperations).toHaveLength(expectedOperations.length);
  for (const expectedOperation of expectedOperations) {
    const actualOperation = actualOperations.find(
      (operation) => operation.operationId === expectedOperation.operationId,
    );
    expect(actualOperation).toBeDefined();
    expect(actualOperation).toEqual(expectedOperation);
  }
}

function expectSourceRowsAndOperationsIncluded(actual: GraphData, expected: GraphData): void {
  const actualEpisodes = new Map(actual.episodes.map((episode) => [episode.uuid, episode]));
  const actualEntities = new Map(actual.entities.map((entity) => [entity.uuid, entity]));
  const actualEdges = new Map(actual.edges.map((edge) => [edge.uuid, edge]));
  for (const episode of expected.episodes)
    expect(actualEpisodes.get(episode.uuid)).toEqual(episode);
  for (const entity of expected.entities) expect(actualEntities.get(entity.uuid)).toEqual(entity);
  for (const edge of expected.edges) expect(actualEdges.get(edge.uuid)).toEqual(edge);
  const actualOperations = actual.automatic_operations_v1?.operations ?? [];
  for (const operation of expected.automatic_operations_v1?.operations ?? []) {
    expect(
      actualOperations.find((candidate) => candidate.operationId === operation.operationId),
    ).toEqual(operation);
  }
}

for (const backend of ['embedded', 'neo4j'] as const) {
  const suite = backend === 'neo4j' && !process.env.NEO4J_TEST_URI ? describe.skip : describe;
  suite(`${backend} native V4 ledger preservation`, () => {
    const nativeImportRejectionReason =
      backend === 'neo4j' ? 'reserved_native_record' : 'native_restore_required';
    const nativeAppendRejectionReason =
      backend === 'neo4j' ? 'reserved_native_record' : 'trusted_capture_writer_required';
    let directory: string;
    let filePath: string;
    let storage: IGraphStorage;
    let driver: ReturnType<typeof neo4j.driver> | undefined;
    let groups = new Set<string>();

    const createStorage = (): IGraphStorage =>
      backend === 'embedded'
        ? new GraphologyStorage(filePath)
        : new Neo4jStorage(
            process.env.NEO4J_TEST_URI!,
            process.env.NEO4J_TEST_USER ?? 'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'password',
            process.env.NEO4J_TEST_DATABASE,
          );

    const getStoreHash = () =>
      backend === 'embedded'
        ? embeddedAutomaticCaptureStoreHash(filePath)!
        : neo4jAutomaticCaptureStoreHash(
            process.env.NEO4J_TEST_URI!,
            process.env.NEO4J_TEST_DATABASE,
          )!;

    const seedNativeGraph = async (
      graph: GraphData,
      options: { registerV4?: boolean } = {},
    ): Promise<void> => {
      if (backend === 'embedded') {
        await storage.close();
        fs.writeFileSync(filePath, JSON.stringify(graph, null, 2), 'utf8');
        storage = createStorage();
        await storage.initialize();
        return;
      }

      const session = driver!.session(
        process.env.NEO4J_TEST_DATABASE ? { database: process.env.NEO4J_TEST_DATABASE } : undefined,
      );
      try {
        await session.executeWrite(async (tx: ManagedTransaction) => {
          for (const entity of graph.entities) {
            await tx.run('CREATE (e:Entity) SET e += $props', {
              props: { ...entity, attributes: JSON.stringify(entity.attributes) },
            });
          }
          for (const episode of graph.episodes) {
            await tx.run('CREATE (ep:Episode) SET ep += $props', {
              props: { ...episode, attributes: JSON.stringify(episode.attributes) },
            });
          }
          for (const edge of graph.edges) {
            await tx.run(
              `MATCH (source:Entity {uuid:$source_uuid})
               MATCH (target:Entity {uuid:$target_uuid})
               CREATE (source)-[r:RELATES_TO {uuid:$uuid}]->(target)
               SET r += $props`,
              {
                source_uuid: edge.source_node_uuid,
                target_uuid: edge.target_node_uuid,
                uuid: edge.uuid,
                props: { ...edge, attributes: JSON.stringify(edge.attributes) },
              },
            );
          }
          for (const [position, operation] of (
            graph.automatic_operations_v1?.operations ?? []
          ).entries()) {
            await tx.run(
              `CREATE (op:AutomaticOperation)
               SET op.operation_id=$operation_id, op.store_hash=$store_hash,
                   op.namespace=$namespace, op.source_id=$source_id, op.role=$role,
                   op.position=$position, op.record_json=$record_json`,
              {
                operation_id: operation.operationId,
                store_hash: operation.identity.storeHash,
                namespace: operation.identity.namespace,
                source_id: operation.identity.sourceId,
                role: operation.identity.role,
                position,
                record_json: JSON.stringify(operation),
              },
            );
          }
          const containsV4 =
            graph.episodes.some(
              (episode) =>
                Object.prototype.hasOwnProperty.call(
                  episode.attributes,
                  WRITE_OWNER_V4_ATTRIBUTE,
                ) ||
                Object.prototype.hasOwnProperty.call(
                  episode.attributes,
                  SOURCE_ENVELOPE_V3_ATTRIBUTE,
                ),
            ) ||
            (graph.automatic_operations_v1?.operations.some(
              (operation) => operation.version === 4,
            ) ??
              false);
          const registerV4 = options.registerV4 ?? containsV4;
          await tx.run(
            `MERGE (lock:EngramStoreLock {id:'extraction-v1'})
             SET lock.automatic_operations_v1_present=$present, lock.epoch=$epoch,
                 lock.autonomous_source_format_v4=CASE WHEN $register_v4 THEN 1 ELSE null END`,
            {
              present: graph.automatic_operations_v1 !== undefined,
              register_v4: registerV4,
              epoch: randomUUID(),
            },
          );
        });
      } finally {
        await session.close();
      }
    };

    const readNativeLock = async () => {
      if (backend !== 'neo4j') throw new Error('Native lock is Neo4j-only');
      const session = driver!.session(
        process.env.NEO4J_TEST_DATABASE ? { database: process.env.NEO4J_TEST_DATABASE } : undefined,
      );
      try {
        const result = await session.executeRead((tx: ManagedTransaction) =>
          tx.run(
            `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
             RETURN lock.autonomous_source_format_v4 AS source_format_v4,
                    lock.automatic_operations_v1_present AS ledger_present,
                    lock.revision AS revision`,
          ),
        );
        return result.records[0];
      } finally {
        await session.close();
      }
    };

    const executeRawNativeWrite = async <T>(work: (tx: ManagedTransaction) => Promise<T>) => {
      if (backend !== 'neo4j') throw new Error('Raw native write is Neo4j-only');
      const session = driver!.session(
        process.env.NEO4J_TEST_DATABASE ? { database: process.env.NEO4J_TEST_DATABASE } : undefined,
      );
      const executeWrite = (
        storage as unknown as {
          executeWrite<T>(
            session: Session,
            work: (tx: ManagedTransaction) => Promise<T>,
          ): Promise<T>;
        }
      ).executeWrite.bind(storage);
      try {
        return await executeWrite(session, work);
      } finally {
        await session.close();
      }
    };

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), 'engram-ledger-v4-preservation-'));
      filePath = join(directory, 'store.json');
      groups = new Set();
      if (backend === 'neo4j') {
        driver = neo4j.driver(
          process.env.NEO4J_TEST_URI!.replace('://localhost:', '://127.0.0.1:'),
          neo4j.auth.basic(
            process.env.NEO4J_TEST_USER ?? 'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'password',
          ),
        );
      }
      storage = createStorage();
      await storage.initialize();
    });

    afterEach(async () => {
      await storage.close();
      if (backend === 'embedded') {
        rmSync(directory, { recursive: true, force: true });
        return;
      }
      const session = driver!.session(
        process.env.NEO4J_TEST_DATABASE ? { database: process.env.NEO4J_TEST_DATABASE } : undefined,
      );
      try {
        await session.executeWrite(async (tx: ManagedTransaction) => {
          for (const namespace of groups) {
            await tx.run('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
              namespace,
            });
            await tx.run(
              'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
              { namespace },
            );
            await tx.run('MATCH ()-[r:RELATES_TO {group_id:$namespace}]->() DELETE r', {
              namespace,
            });
          }
          await tx.run(
            "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.automatic_operations_v1_present, lock.autonomous_source_format_v4",
          );
        });
      } finally {
        await session.close();
        await driver!.close();
        driver = undefined;
      }
    });

    async function installMixedGraph() {
      const fixture = makeMixedGraph(getStoreHash());
      groups = new Set(fixture.groups);
      await seedNativeGraph(fixture.graph);
      return fixture;
    }

    it('preserves a mixed V1/V2/V3/V4 snapshot exactly through ordinary writes, export and native reopen', async () => {
      const fixture = await installMixedGraph();
      if (backend === 'neo4j') {
        expect(await readNativeLock().then((row) => row?.get('source_format_v4'))).toEqual(
          neo4j.int(1),
        );
      }
      const before = await storage.readExtractionSnapshot!();
      const versions = (before.automatic_operations_v1?.operations ?? []).map(
        (operation) => operation.version,
      );
      for (const version of [1, 2, 3, 4]) expect(versions).toContain(version);
      expectSourceRowsAndOperationsIncluded(before, fixture.graph);

      await storage.addEntity({
        group_id: fixture.v4.source.group_id,
        name: 'Unrelated native write',
      });
      const afterOrdinaryWrite = await storage.readExtractionSnapshot!();
      if (backend === 'neo4j')
        expect(await readNativeLock().then((row) => row?.get('source_format_v4'))).toEqual(
          neo4j.int(1),
        );
      expect(afterOrdinaryWrite.episodes).toEqual(before.episodes);
      expect(afterOrdinaryWrite.edges).toEqual(before.edges);
      expect(afterOrdinaryWrite.automatic_operations_v1?.operations).toHaveLength(
        before.automatic_operations_v1?.operations.length ?? 0,
      );
      for (const operation of before.automatic_operations_v1!.operations) {
        const after = afterOrdinaryWrite.automatic_operations_v1!.operations.find(
          (candidate) => candidate.operationId === operation.operationId,
        );
        expect(JSON.stringify(after)).toBe(JSON.stringify(operation));
      }
      expect(
        afterOrdinaryWrite.episodes.find((episode) => episode.uuid === fixture.v4.source.uuid),
      ).toEqual(fixture.v4.source);
      const envelope = fixture.v4.source.attributes[SOURCE_ENVELOPE_V3_ATTRIBUTE] as {
        geometry: { quoteRegions: Array<{ start: number; end: number }> };
      };
      expect(envelope.geometry.quoteRegions).toEqual(
        fixture.v4.tuple.envelope.geometry.quoteRegions,
      );

      await storage.close();
      storage = createStorage();
      await storage.initialize();
      const reopened = await storage.readExtractionSnapshot!();
      if (backend === 'neo4j')
        expect(await readNativeLock().then((row) => row?.get('source_format_v4'))).toEqual(
          neo4j.int(1),
        );
      expectSourceRowsAndOperationsEqual(reopened, afterOrdinaryWrite);
    });

    if (backend === 'neo4j') {
      it('rolls back a transaction that tries to remove an existing V4 witness', async () => {
        const fixture = await installMixedGraph();
        const lockBefore = await readNativeLock();
        expect(lockBefore?.get('source_format_v4')).toEqual(neo4j.int(1));

        await expect(
          executeRawNativeWrite((tx) =>
            tx.run(
              "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) REMOVE lock.autonomous_source_format_v4",
            ),
          ),
        ).rejects.toThrow('invalid_native_format');

        const lockAfter = await readNativeLock();
        expect(lockAfter?.get('source_format_v4')).toEqual(neo4j.int(1));
        expect(lockAfter?.get('revision')).toEqual(lockBefore?.get('revision'));
        expectSourceRowsAndOperationsEqual(await storage.readExtractionSnapshot!(), fixture.graph);
      });

      it('does not allow an ordinary legacy transaction to enroll the V4 witness', async () => {
        const namespace = `ledger-v4-unapproved-enrollment-${randomUUID()}`;
        groups.add(namespace);
        await seedNativeGraph(
          GraphDataSchema.parse({
            version: '2.0',
            exported_at: NEXT,
            group_id: namespace,
            entities: [],
            edges: [],
            episodes: [],
          }),
        );
        const lockBefore = await readNativeLock();
        expect(lockBefore?.get('source_format_v4')).toBeNull();

        await expect(
          executeRawNativeWrite((tx) =>
            tx.run(
              "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.autonomous_source_format_v4=1",
            ),
          ),
        ).rejects.toThrow('invalid_native_format');

        const lockAfter = await readNativeLock();
        expect(lockAfter?.get('source_format_v4')).toBeNull();
        expect(lockAfter?.get('revision')).toEqual(lockBefore?.get('revision'));
      });
    }

    it('keeps source-only V4 rows protected when an operation or receipt is absent', async () => {
      const namespace = `ledger-v4-orphan-${randomUUID()}`;
      const base = makeHumanFixture(namespace);
      const predecessor = makeUnownedPredecessor(namespace);
      const v4 = makeV4Fixture({
        storeHash: getStoreHash(),
        namespace,
        binding: base.binding,
        previousEpisodeUuid: predecessor.uuid,
      });
      const subject = base.graph.entities.find((entity) => entity.uuid === base.binding.subjectId)!;
      const orphanGraph = GraphDataSchema.parse({
        version: '2.0',
        exported_at: NEXT,
        group_id: namespace,
        entities: [subject],
        edges: [],
        episodes: [predecessor, v4.source],
      });
      groups.add(namespace);
      await seedNativeGraph(orphanGraph);
      const before = await storage.readExtractionSnapshot!();
      expect(before.automatic_operations_v1).toBeUndefined();

      await expect(storage.deleteEpisode(v4.source.uuid)).rejects.toThrow(
        'source_delete_forbidden',
      );
      await expect(storage.deleteEpisode(predecessor.uuid)).rejects.toThrow(
        'source_delete_forbidden',
      );
      await expect(storage.clearGroup(namespace, { allowQueued: true })).rejects.toThrow(
        'source_delete_forbidden',
      );
      await expect(storage.clearAll({ allowQueued: true })).rejects.toThrow(
        'source_delete_forbidden',
      );
      expectSourceRowsAndOperationsEqual(await storage.readExtractionSnapshot!(), before);
    });

    it('does not delete an orphan V4 source owner’s referenced subject', async () => {
      const namespace = `ledger-v4-owner-${randomUUID()}`;
      const base = makeHumanFixture(namespace);
      const v4 = makeV4Fixture({
        storeHash: getStoreHash(),
        namespace,
        binding: base.binding,
      });
      const boundSubject = base.graph.entities.find(
        (entity) => entity.uuid === base.binding.subjectId,
      )!;
      // Keep the exact referenced subject identity while avoiding the legacy
      // binding-delete guard as the reason this V4-only integrity check fires.
      const subject = EntityNodeSchema.parse({ ...boundSubject, attributes: {} });
      const orphanGraph: GraphData = {
        version: '2.0',
        exported_at: NEXT,
        group_id: namespace,
        entities: [subject],
        edges: [],
        episodes: [v4.source],
      };
      groups.add(namespace);
      await seedNativeGraph(orphanGraph);
      const before = await storage.readExtractionSnapshot!();

      await expect(storage.deleteEntity(subject.uuid)).rejects.toThrow('invalid_source_reference');
      expectSourceRowsAndOperationsEqual(await storage.readExtractionSnapshot!(), before);
      expect(await storage.getEntity(subject.uuid)).toEqual(subject);
    });

    // These cross-namespace/corruption scenarios rely on native Neo4j storage semantics.
    if (backend === 'neo4j') {
      it('checks V4 global UUID collisions across namespaces before scoped reads or mutations', async () => {
        const namespaceA = `ledger-v4-global-a-${randomUUID()}`;
        const namespaceB = `ledger-v4-global-b-${randomUUID()}`;
        const base = makeHumanFixture(namespaceA);
        const v4 = makeV4Fixture({
          storeHash: getStoreHash(),
          namespace: namespaceA,
          binding: base.binding,
        });
        const subject = base.graph.entities.find(
          (entity) => entity.uuid === base.binding.subjectId,
        )!;
        const crossNamespaceEntity = EntityNodeSchema.parse({
          uuid: v4.source.uuid,
          group_id: namespaceB,
          name: 'Synthetic cross-namespace duplicate',
          entity_type: 'person',
          summary: '',
          created_at: NEXT,
          updated_at: NEXT,
          attributes: {},
        });
        const corrupted: GraphData = {
          version: '2.0',
          exported_at: NEXT,
          entities: [subject, crossNamespaceEntity],
          edges: [],
          episodes: [v4.source],
        };
        groups.add(namespaceA);
        groups.add(namespaceB);
        await seedNativeGraph(corrupted);

        const outcome = async (work: () => Promise<unknown>): Promise<string | null> => {
          try {
            await work();
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        };
        const outcomes = {
          fullRead: await outcome(() => storage.readExtractionSnapshot!()),
          groupARead: await outcome(() => storage.readExtractionSnapshot!(namespaceA)),
          groupBRead: await outcome(() => storage.readExtractionSnapshot!(namespaceB)),
          clearGroupB: await outcome(() => storage.clearGroup(namespaceB, { allowQueued: true })),
        };

        const session = driver!.session(
          process.env.NEO4J_TEST_DATABASE
            ? { database: process.env.NEO4J_TEST_DATABASE }
            : undefined,
        );
        try {
          const remaining = await session.executeRead((tx: ManagedTransaction) =>
            tx.run(
              'MATCH (n) WHERE n.uuid=$uuid RETURN labels(n) AS labels, n.group_id AS group_id ORDER BY group_id',
              { uuid: v4.source.uuid },
            ),
          );
          expect(outcomes.fullRead).toContain('duplicate_global_id');
          expect(outcomes.groupARead).toContain('duplicate_global_id');
          expect(outcomes.groupBRead).toContain('duplicate_global_id');
          expect(outcomes.clearGroupB).toContain('duplicate_global_id');
          expect(remaining.records.map((row) => row.get('group_id'))).toEqual(
            [namespaceA, namespaceB].sort(),
          );
          expect(remaining.records.map((row) => row.get('labels'))).toEqual([
            ['Episode'],
            ['Entity'],
          ]);
        } finally {
          await session.close();
        }
      });
    }

    if (backend === 'neo4j') {
      it('rolls back an otherwise-valid entity import that collides with a V4 episode UUID', async () => {
        const namespaceA = `ledger-v4-postcondition-a-${randomUUID()}`;
        const namespaceB = `ledger-v4-postcondition-b-${randomUUID()}`;
        const base = makeHumanFixture(namespaceA);
        const v4 = makeV4Fixture({
          storeHash: getStoreHash(),
          namespace: namespaceA,
          binding: base.binding,
        });
        const subject = base.graph.entities.find(
          (entity) => entity.uuid === base.binding.subjectId,
        )!;
        groups.add(namespaceA);
        groups.add(namespaceB);
        await seedNativeGraph({
          version: '2.0',
          exported_at: NEXT,
          entities: [subject],
          edges: [],
          episodes: [v4.source],
        });

        const collidingEntity = EntityNodeSchema.parse({
          uuid: v4.source.uuid,
          group_id: namespaceB,
          name: 'Synthetic postcondition collision',
          entity_type: 'person',
          summary: '',
          created_at: NEXT,
          updated_at: NEXT,
          attributes: {},
        });
        const importGraph = GraphDataSchema.parse({
          version: '2.0',
          exported_at: NEXT,
          entities: [collidingEntity],
          edges: [],
          episodes: [],
        });
        const importFailure = await (async (): Promise<string | null> => {
          try {
            await storage.importGraph(importGraph);
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        })();

        const session = driver!.session(
          process.env.NEO4J_TEST_DATABASE
            ? { database: process.env.NEO4J_TEST_DATABASE }
            : undefined,
        );
        try {
          const rows = await session.executeRead((tx: ManagedTransaction) =>
            tx.run(
              'MATCH (n) WHERE n.uuid=$uuid RETURN labels(n) AS labels, n.group_id AS group_id ORDER BY group_id',
              { uuid: v4.source.uuid },
            ),
          );
          expect(rows.records.map((row) => row.get('labels'))).toEqual([['Episode']]);
          expect(importFailure).toContain('duplicate_global_id');
          expect(rows.records.map((row) => row.get('group_id'))).toEqual([namespaceA]);
        } finally {
          await session.close();
        }
      });
    }

    if (backend === 'neo4j') {
      it('does not make a legacy cross-kind collision strict from ordinary metadata text', async () => {
        const namespaceA = `ledger-v4-rootless-a-${randomUUID()}`;
        const namespaceB = `ledger-v4-rootless-b-${randomUUID()}`;
        const v3Fixture = makeCompositionalCaptureFixture();
        const source = EpisodicNodeSchema.parse({
          ...makeUnownedPredecessor(namespaceA),
          attributes: { note: 'engram_write_owner_v4' },
        });
        const entity = EntityNodeSchema.parse({
          uuid: source.uuid,
          group_id: namespaceB,
          name: 'Legacy cross-kind duplicate',
          entity_type: 'person',
          summary: '',
          created_at: NEXT,
          updated_at: NEXT,
          attributes: {},
        });
        groups.add(namespaceA);
        groups.add(namespaceB);
        groups.add(v3Fixture.source.group_id);
        await seedNativeGraph({
          version: '2.0',
          exported_at: NEXT,
          entities: [...v3Fixture.graph.entities, entity],
          edges: [],
          episodes: [source, v3Fixture.source],
          automatic_operations_v1: {
            version: 1,
            operations: [v3Fixture.operation],
          },
        });

        const nativeLock = await readNativeLock();
        expect(nativeLock?.get('ledger_present')).toBe(true);
        expect(nativeLock?.get('source_format_v4')).toBeNull();

        const snapshot = await storage.readExtractionSnapshot!();
        expect(snapshot.entities).toHaveLength(v3Fixture.graph.entities.length + 1);
        expect(snapshot.episodes).toHaveLength(2);
        expect(
          snapshot.automatic_operations_v1?.operations.map((operation) => operation.version),
        ).toEqual([3]);
        await storage.addEntity({
          group_id: namespaceB,
          name: 'Legacy write with old ledger marker',
        });
        expect((await readNativeLock())?.get('source_format_v4')).toBeNull();
        await expect(
          storage.clearGroup(namespaceB, { allowQueued: true }),
        ).resolves.toBeUndefined();
        expect((await readNativeLock())?.get('source_format_v4')).toBeNull();
        const after = await storage.readExtractionSnapshot!();
        expect(after.entities).toEqual(v3Fixture.graph.entities);
        expect(after.episodes.map((episode) => episode.uuid).sort()).toEqual(
          [source.uuid, v3Fixture.source.uuid].sort(),
        );
        expect(after.automatic_operations_v1?.operations).toEqual([v3Fixture.operation]);
      });
    }

    if (backend === 'neo4j') {
      it('refuses markerless V4 rows on full and selected reads without adopting them', async () => {
        const namespace = `ledger-v4-unregistered-${randomUUID()}`;
        const base = makeHumanFixture(namespace);
        const predecessor = makeUnownedPredecessor(namespace);
        const v4 = makeV4Fixture({
          storeHash: getStoreHash(),
          namespace,
          binding: base.binding,
          previousEpisodeUuid: predecessor.uuid,
        });
        const subject = base.graph.entities.find(
          (entity) => entity.uuid === base.binding.subjectId,
        )!;
        groups.add(namespace);
        await seedNativeGraph(
          GraphDataSchema.parse({
            version: '2.0',
            exported_at: NEXT,
            group_id: namespace,
            entities: [subject],
            edges: [],
            episodes: [predecessor, v4.source],
          }),
          { registerV4: false },
        );

        const initialLock = await readNativeLock();
        expect(initialLock?.get('source_format_v4')).toBeNull();
        const fullRead = await (async () => {
          try {
            await storage.readExtractionSnapshot!();
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        })();
        const selectedRead = await (async () => {
          try {
            await storage.readExtractionSnapshot!(namespace);
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        })();

        expect(fullRead).toContain('unregistered_native_format');
        expect(selectedRead).toContain('unregistered_native_format');
        const afterLock = await readNativeLock();
        expect(afterLock?.get('source_format_v4')).toBeNull();
        const session = driver!.session(
          process.env.NEO4J_TEST_DATABASE
            ? { database: process.env.NEO4J_TEST_DATABASE }
            : undefined,
        );
        try {
          const actual = await session.executeRead((tx: ManagedTransaction) =>
            tx.run(
              `MATCH (ep:Episode {uuid:$uuid})
               OPTIONAL MATCH (op:AutomaticOperation {source_id:$uuid})
               RETURN ep.attributes AS attributes, count(op) AS operation_count`,
              { uuid: v4.source.uuid },
            ),
          );
          expect(actual.records[0]?.get('attributes')).toBe(JSON.stringify(v4.source.attributes));
          expect(actual.records[0]?.get('operation_count')).toEqual(neo4j.int(0));
        } finally {
          await session.close();
        }
      });
    }

    if (backend === 'neo4j') {
      it('fails closed on a malformed V4 format witness and rolls back ordinary writes', async () => {
        const namespace = `ledger-v4-invalid-format-${randomUUID()}`;
        groups.add(namespace);
        await seedNativeGraph(
          GraphDataSchema.parse({
            version: '2.0',
            exported_at: NEXT,
            group_id: namespace,
            entities: [],
            edges: [],
            episodes: [],
          }),
        );
        const session = driver!.session(
          process.env.NEO4J_TEST_DATABASE
            ? { database: process.env.NEO4J_TEST_DATABASE }
            : undefined,
        );
        let revisionBefore: unknown;
        try {
          await session.executeWrite((tx: ManagedTransaction) =>
            tx.run(
              "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.autonomous_source_format_v4=$value",
              { value: neo4j.int(2) },
            ),
          );
          const before = await session.executeRead((tx: ManagedTransaction) =>
            tx.run(
              "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.revision AS revision",
            ),
          );
          revisionBefore = before.records[0]?.get('revision');

          await expect(
            storage.addEntity({
              group_id: namespace,
              name: 'Must not be written',
            }),
          ).rejects.toThrow('invalid_native_format');

          const after = await session.executeRead((tx: ManagedTransaction) =>
            tx.run(
              `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
               OPTIONAL MATCH (e:Entity {group_id:$namespace})
               RETURN lock.revision AS revision, lock.autonomous_source_format_v4 AS source_format_v4,
                      count(e) AS entity_count`,
              { namespace },
            ),
          );
          expect(after.records[0]?.get('revision')).toEqual(revisionBefore);
          expect(after.records[0]?.get('source_format_v4')).toEqual(neo4j.int(2));
          expect(after.records[0]?.get('entity_count')).toEqual(neo4j.int(0));
        } finally {
          await session.close();
        }
      });
    }

    if (backend === 'neo4j') {
      it('does not let generic graph imports forge or clear the native V4 witness', async () => {
        const namespace = `ledger-v4-import-format-${randomUUID()}`;
        groups.add(namespace);
        const legacy = GraphDataSchema.parse({
          version: '2.0',
          exported_at: NEXT,
          group_id: namespace,
          entities: [
            EntityNodeSchema.parse({
              uuid: randomUUID(),
              group_id: namespace,
              name: 'Legacy import',
              entity_type: 'person',
              summary: '',
              created_at: NEXT,
              updated_at: NEXT,
              attributes: { autonomous_source_format_v4: 1 },
            }),
          ],
          edges: [],
          episodes: [],
        });
        await seedNativeGraph(legacy);

        await storage.importGraph({
          ...legacy,
          autonomous_source_format_v4: 1,
        } as never);
        expect((await readNativeLock())?.get('source_format_v4')).toBeNull();

        const registered = makeMixedGraph(getStoreHash());
        for (const registeredGroup of registered.groups) groups.add(registeredGroup);
        await seedNativeGraph(registered.graph);
        const registeredBefore = await readNativeLock();
        expect(registeredBefore?.get('source_format_v4')).toEqual(neo4j.int(1));
        await expect(storage.importGraph(registered.graph as never)).rejects.toThrow(
          nativeImportRejectionReason,
        );
        expect((await readNativeLock())?.get('source_format_v4')).toEqual(neo4j.int(1));
      });
    }

    if (backend === 'neo4j') {
      it('treats a present null V4 owner key as global protected state outside the read scope', async () => {
        const namespaceA = `ledger-v4-null-key-a-${randomUUID()}`;
        const namespaceB = `ledger-v4-null-key-b-${randomUUID()}`;
        const malformed = EpisodicNodeSchema.parse({
          ...makeUnownedPredecessor(namespaceA),
          attributes: { [WRITE_OWNER_V4_ATTRIBUTE]: null },
        });
        groups.add(namespaceA);
        groups.add(namespaceB);
        await seedNativeGraph({
          version: '2.0',
          exported_at: NEXT,
          entities: [],
          edges: [],
          episodes: [malformed],
        });

        await expect(storage.readExtractionSnapshot!(namespaceB)).rejects.toThrow(
          'invalid_autonomous_stored_source_data',
        );
      });
    }

    if (backend === 'neo4j') {
      it('detects a V4 operation outside a scoped read even without its source row', async () => {
        const namespaceA = `ledger-v4-operation-only-a-${randomUUID()}`;
        const namespaceB = `ledger-v4-operation-only-b-${randomUUID()}`;
        const base = makeHumanFixture(namespaceA);
        const v4 = makeV4Fixture({
          storeHash: getStoreHash(),
          namespace: namespaceA,
          binding: base.binding,
        });
        groups.add(namespaceA);
        groups.add(namespaceB);
        await seedNativeGraph({
          version: '2.0',
          exported_at: NEXT,
          entities: [],
          edges: [],
          episodes: [],
          automatic_operations_v1: {
            version: 1,
            operations: [v4.operation],
          },
        });

        await expect(storage.readExtractionSnapshot!(namespaceB)).rejects.toThrow(
          'invalid_source_reference',
        );
      });
    }

    it('rejects generic graph and queue-backup import of native operations and owned V4 rows', async () => {
      const fixture = await installMixedGraph();
      const before = await storage.readExtractionSnapshot!();
      await expect(storage.importGraph(fixture.graph as never)).rejects.toThrow(
        nativeImportRejectionReason,
      );
      await expect(
        storage.importExtractionBackup!(exportQueueBackup(fixture.graph)),
      ).rejects.toThrow(nativeImportRejectionReason);

      const sourceOnly = GraphDataSchema.parse({
        version: '2.0',
        exported_at: NEXT,
        group_id: fixture.v4.source.group_id,
        entities: [],
        edges: [],
        episodes: [fixture.v4.source],
      });
      await expect(storage.importGraph(sourceOnly as never)).rejects.toThrow(
        backend === 'neo4j' ? 'reserved_native_record' : 'owned_source_import_forbidden',
      );
      expectSourceRowsAndOperationsEqual(await storage.readExtractionSnapshot!(), before);
      if (backend === 'neo4j')
        expect((await readNativeLock())?.get('source_format_v4')).toEqual(neo4j.int(1));
    });

    it('does not create or adopt a V4 row through old trusted append or V2/V3 begin routes', async () => {
      const storeHash = getStoreHash();
      const namespace = `ledger-v4-old-route-${randomUUID()}`;
      const v2Base = makeHumanFixture(namespace);
      const v4 = makeV4Fixture({
        storeHash,
        namespace,
        binding: v2Base.binding,
      });
      const subject = v2Base.graph.entities.find(
        (entity) => entity.uuid === v2Base.binding.subjectId,
      )!;
      const orphanGraph = GraphDataSchema.parse({
        version: '2.0',
        exported_at: NEXT,
        group_id: namespace,
        entities: [subject],
        edges: [],
        episodes: [v4.source],
      });
      groups.add(namespace);
      groups.add('assistant-integrity-fixture');
      await seedNativeGraph(orphanGraph);
      const before = await storage.readExtractionSnapshot!();

      const newSource = makeV4Fixture({
        storeHash,
        namespace,
        binding: v2Base.binding,
        turn: `fresh-v4-${randomUUID()}`,
      }).source;
      await expect(storage.appendAutomaticEpisodes!([newSource] as never)).rejects.toThrow(
        nativeAppendRejectionReason,
      );

      const v2Result = await storage.beginAndClaimAutomaticCaptureV2!(makeV2Request(v4));
      expect(v2Result).toMatchObject({ kind: 'unsupported_mode' });

      const v3Fixture = makeCompositionalCaptureFixture(undefined, storeHash);
      groups.add(v3Fixture.source.group_id);
      const v3Owner = v3Fixture.source.attributes[WRITE_OWNER_V3_ATTRIBUTE] as {
        issuer: string;
        actorReference: string;
        turn: string;
        binding: V4Fixture['tuple']['owner']['binding'];
      };
      const v3AsV4 = makeV4Fixture({
        storeHash,
        namespace: v3Fixture.source.group_id,
        binding: v3Owner.binding,
        turn: v3Owner.turn,
        sourceId: v3Fixture.source.uuid,
      });
      const v3Subject = v3Fixture.graph.entities.find(
        (entity) => entity.uuid === v3Owner.binding.subjectId,
      )!;
      const v3OrphanGraph = GraphDataSchema.parse({
        version: '2.0',
        exported_at: NEXT,
        group_id: v3Fixture.source.group_id,
        entities: [v3Subject],
        edges: [],
        episodes: [v3AsV4.source],
      });
      await seedNativeGraph(v3OrphanGraph);
      const beforeV3 = await storage.readExtractionSnapshot!();
      const v3Result = await storage.beginAndClaimCompositionalCaptureV3!({
        request: v3Fixture.input.request,
        mode: 'existingStore',
      });
      expect(v3Result).toMatchObject({ kind: 'unsupported_mode' });
      expectSourceRowsAndOperationsEqual(await storage.readExtractionSnapshot!(), beforeV3);
      expect(beforeV3.automatic_operations_v1).toBeUndefined();
      expect(before.automatic_operations_v1).toBeUndefined();
    });

    it('rejects V4 producer-time and original-execution tampering without losing native rows', async () => {
      const fixture = await installMixedGraph();
      const valid = await storage.readExtractionSnapshot!();
      const source = fixture.v4.source;
      const originalDisk =
        backend === 'embedded'
          ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as GraphData)
          : undefined;

      for (const [field, value] of [
        ['reference_time', '2026-10-27T12:00:01.000Z'],
        ['source_execution_id', 'tampered-execution'],
      ] as const) {
        if (backend === 'embedded') {
          await storage.close();
          const tamperedDisk = structuredClone(originalDisk!);
          const stored = tamperedDisk.episodes.find((episode) => episode.uuid === source.uuid)!;
          (stored as unknown as Record<string, unknown>)[field] = value;
          fs.writeFileSync(filePath, JSON.stringify(tamperedDisk, null, 2), 'utf8');
          const rejectedStorage = createStorage();
          await expect(rejectedStorage.initialize()).rejects.toThrow(
            'invalid_autonomous_stored_source_data',
          );
          expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(tamperedDisk);
          expect(tamperedDisk.episodes).toHaveLength(valid.episodes.length);
          expect(tamperedDisk.automatic_operations_v1?.operations).toHaveLength(4);
          fs.writeFileSync(filePath, JSON.stringify(originalDisk, null, 2), 'utf8');
          storage = createStorage();
          await storage.initialize();
        } else {
          const session = driver!.session(
            process.env.NEO4J_TEST_DATABASE
              ? { database: process.env.NEO4J_TEST_DATABASE }
              : undefined,
          );
          try {
            await session.executeWrite((tx: ManagedTransaction) =>
              tx.run(`MATCH (ep:Episode {uuid:$uuid}) SET ep.${field}=$value`, {
                uuid: source.uuid,
                value,
              }),
            );
          } finally {
            await session.close();
          }
          await expect(storage.readExtractionSnapshot!()).rejects.toThrow(
            'invalid_autonomous_stored_source_data',
          );
          const inspect = driver!.session(
            process.env.NEO4J_TEST_DATABASE
              ? { database: process.env.NEO4J_TEST_DATABASE }
              : undefined,
          );
          try {
            const rows = await inspect.executeRead((tx: ManagedTransaction) =>
              tx.run(
                'MATCH (ep:Episode {uuid:$uuid}) OPTIONAL MATCH (op:AutomaticOperation {source_id:$uuid}) RETURN count(DISTINCT ep) AS episodes, count(DISTINCT op) AS operations',
                { uuid: source.uuid },
              ),
            );
            expect(rows.records[0].get('episodes').toNumber()).toBe(1);
            expect(rows.records[0].get('operations').toNumber()).toBe(1);
            await inspect.executeWrite((tx: ManagedTransaction) =>
              tx.run(`MATCH (ep:Episode {uuid:$uuid}) SET ep.${field}=$value`, {
                uuid: source.uuid,
                value:
                  field === 'reference_time' ? source.reference_time : source.source_execution_id,
              }),
            );
          } finally {
            await inspect.close();
          }
        }
        expectSourceRowsAndOperationsEqual(await storage.readExtractionSnapshot!(), valid);
      }
    });
  });
}
