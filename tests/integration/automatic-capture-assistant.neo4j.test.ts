import { createHash, randomUUID } from 'crypto';
import neo4j, { type ManagedTransaction, type Session } from 'neo4j-driver';
import {
  AutomaticCaptureBeginRequestV2Schema,
  type AutomaticCaptureBeginRequestV2,
} from '../../src/schemas/AutomaticCapture.schema';
import { AutomaticAssistantCaptureIntentV2Schema } from '../../src/schemas/AutomaticAssistantCapture.schema';
import type { GraphData } from '../../src/schemas';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { planAutomaticClaims } from '../../src/extraction/AutomaticClaims';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import { neo4jAutomaticCaptureStoreHash } from '../../src/storage/AutomaticCaptureStore';
import {
  makeAssistantIntentForCompositionalParent,
  makeCompositionalAssistantHumanParentFixture,
} from '../helpers/compositionalAssistantParentFixture';

jest.setTimeout(60_000);

const enabled = Boolean(process.env.NEO4J_TEST_URI);
const describeNeo4j = enabled ? describe : describe.skip;
const uri = process.env.NEO4J_TEST_URI;
const username = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
const password = process.env.NEO4J_TEST_PASSWORD ?? 'password';
const database = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function driverForTests() {
  if (!uri) throw new Error('NEO4J_TEST_URI is required for Neo4j integration tests');
  return neo4j.driver(
    uri.replace('://localhost:', '://127.0.0.1:'),
    neo4j.auth.basic(username, password),
  );
}

async function nativeRevision(): Promise<string | null> {
  const driver = driverForTests();
  const session = driver.session({ database });
  try {
    const result = await session.run(
      "MATCH (lock:EngramStoreLock {id:'extraction-v1'}) RETURN lock.revision AS revision",
    );
    return result.records[0]?.get('revision')?.toString() ?? null;
  } finally {
    await session.close();
    await driver.close();
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type GetSessionOwner = { getSession: () => Session };
type ManagedExecuteWrite = <T>(work: (tx: ManagedTransaction) => Promise<T>) => Promise<T>;
type ExecuteWriteIntercept = <T>(
  original: ManagedExecuteWrite,
  work: (tx: ManagedTransaction) => Promise<T>,
) => Promise<T>;

function proxiedSession(storage: Neo4jStorage, executeWrite: ExecuteWriteIntercept) {
  const owner = storage as unknown as GetSessionOwner;
  const getSession = owner.getSession.bind(storage);
  return jest.spyOn(owner, 'getSession').mockImplementation(() => {
    const session = getSession();
    const original = session.executeWrite.bind(session) as <T>(
      work: (tx: ManagedTransaction) => Promise<T>,
    ) => Promise<T>;
    return new Proxy(session, {
      get(target, property) {
        if (property === 'executeWrite') {
          return <T>(work: (tx: ManagedTransaction) => Promise<T>) => executeWrite(original, work);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Session;
  });
}

describeNeo4j('Neo4j assistant final capture', () => {
  let namespace: string;
  let storage: Neo4jStorage;
  let request: AutomaticCaptureBeginRequestV2;
  let bindingId: string;
  let bindingRevision: number;
  let getSessionSpy: jest.SpyInstance | null;
  let nativeFixtureNamespaces: string[];

  beforeEach(async () => {
    if (!uri) throw new Error('NEO4J_TEST_URI is required');
    namespace = `neo-assistant-${randomUUID()}`;
    getSessionSpy = null;
    nativeFixtureNamespaces = [];
    storage = new Neo4jStorage(uri, username, password, database);
    await storage.initialize();
    const now = new Date().toISOString();
    const subject = await storage.addEntity({
      group_id: namespace,
      name: 'Synthetic manually reviewed subject',
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
      reason: 'Synthetic integration fixture',
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
      turn: `turn-${namespace}`,
      attemptIdHash: digest(`human-first-attempt-${namespace}`),
      settings: {
        profileId: 'conservative',
        requestedTrustLevel: 'standard',
        intentSetting: false,
        invocationDeadlineMs: 30_000,
      },
      source: {
        content: 'I prefer concise explanations.',
        sourceMessageId: `human-source-${namespace}`,
        conversationId: `conversation-${namespace}`,
        senderId: 'synthetic-actor',
        senderName: 'Synthetic Human',
        sourceWorkflowId: 'synthetic-workflow',
        originalSourceExecutionId: `human-execution-${namespace}`,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
        applicationOwnedWrapper: null,
        humanRegion: null,
        quoteRegions: [],
      },
    });
    await createCommittedHumanParent();
  });

  afterEach(async () => {
    getSessionSpy?.mockRestore();
    await storage.close();
    const driver = driverForTests();
    const session = driver.session({ database });
    try {
      await session.executeWrite(async (tx) => {
        for (const group of [namespace, ...nativeFixtureNamespaces]) {
          await tx.run('MATCH (op:AutomaticOperation {namespace:$namespace}) DETACH DELETE op', {
            namespace: group,
          });
          await tx.run(
            'MATCH (n) WHERE n.group_id=$namespace AND (n:Entity OR n:Episode) DETACH DELETE n',
            { namespace: group },
          );
          await tx.run('MATCH (lock:EpisodeGroupLock {group_id:$namespace}) DELETE lock', {
            namespace: group,
          });
        }
      });
    } finally {
      await session.close();
      await driver.close();
    }
  });

  async function createCommittedHumanParent(): Promise<void> {
    const begun = await storage.beginAndClaimAutomaticCaptureV2(request);
    if (begun.kind !== 'claimed' || begun.purpose !== 'human_turn_memory')
      throw new Error('Expected a persisted human capture lease');
    const graph = await storage.readExtractionSnapshot();
    const operation = graph.automatic_operations_v1?.operations.find(
      (item) => item.operationId === begun.operationId,
    );
    if (
      operation?.version !== 2 ||
      operation.state !== 'leased' ||
      operation.descriptor.purpose !== 'human_turn_memory'
    )
      throw new Error('Expected a human operation suitable for final receipt completion');
    const outcome = new ExtractionDiagnostics().finish();
    outcome.status = 'succeeded';
    const plan = planAutomaticClaims(
      graph,
      namespace,
      [begun.sourceId],
      operation.descriptor.policy,
      outcome,
      operation.lease.renewedAt,
    );
    const completed = await storage.completeHumanCaptureV2(begun.leaseHandle, plan);
    if (
      completed.kind !== 'committed' ||
      completed.terminalReceipt.kind !== 'human_capture_committed' ||
      !completed.terminalReceipt.receipt.persisted
    )
      throw new Error('Expected a committed human parent receipt');
  }

  async function seedNativeGraph(graph: GraphData, group: string): Promise<void> {
    const seedDriver = driverForTests();
    const session = seedDriver.session({ database });
    try {
      await session.executeWrite(async (tx) => {
        for (const entity of graph.entities) {
          await tx.run(
            `CREATE (e:Entity {uuid:$uuid, group_id:$group_id, name:$name,
               entity_type:$entity_type, summary:$summary, name_embedding:$name_embedding,
               attributes:$attributes, created_at:$created_at, updated_at:$updated_at})`,
            {
              uuid: entity.uuid,
              group_id: entity.group_id,
              name: entity.name,
              entity_type: entity.entity_type,
              summary: entity.summary,
              name_embedding: entity.name_embedding,
              attributes: JSON.stringify(entity.attributes),
              created_at: entity.created_at,
              updated_at: entity.updated_at,
            },
          );
        }
        for (const edge of graph.edges) {
          await tx.run(
            `MATCH (source:Entity {uuid:$source_node_uuid})
             MATCH (target:Entity {uuid:$target_node_uuid})
             CREATE (source)-[:RELATES_TO {uuid:$uuid, group_id:$group_id,
               source_node_uuid:$source_node_uuid, target_node_uuid:$target_node_uuid,
               name:$name, fact:$fact, fact_embedding:$fact_embedding, episodes:$episodes,
               valid_at:$valid_at, invalid_at:$invalid_at, expired_at:$expired_at,
               attributes:$attributes, created_at:$created_at, updated_at:$updated_at}]->(target)`,
            { ...edge, attributes: JSON.stringify(edge.attributes) },
          );
        }
        let sequence = 0;
        for (const episode of graph.episodes) {
          sequence += 1;
          await tx.run(
            `CREATE (ep:Episode {uuid:$uuid, group_id:$group_id, content:$content,
               role:$role, source_type:$source_type, reference_time:$reference_time,
               created_at:$created_at, updated_at:$updated_at,
               previous_episode_uuid:$previous_episode_uuid, source_message_id:$source_message_id,
               conversation_id:$conversation_id, sender_id:$sender_id, sender_name:$sender_name,
               source_workflow_id:$source_workflow_id, source_execution_id:$source_execution_id,
               quoted_message_id:$quoted_message_id, idempotency_key:$idempotency_key,
               episode_kind:$episode_kind, trust_level:$trust_level, review_status:$review_status,
               attributes:$attributes, append_sequence:$append_sequence})`,
            {
              ...episode,
              attributes: JSON.stringify(episode.attributes),
              append_sequence: neo4j.int(sequence),
            },
          );
        }
        for (const [position, operation] of (
          graph.automatic_operations_v1?.operations ?? []
        ).entries()) {
          await tx.run(
            `CREATE (op:AutomaticOperation {operation_id:$operation_id,
               store_hash:$store_hash, namespace:$namespace, source_id:$source_id,
               role:$role, position:$position, record_json:$record_json})`,
            {
              operation_id: operation.operationId,
              store_hash: operation.identity.storeHash,
              namespace: operation.identity.namespace,
              source_id: operation.identity.sourceId,
              role: operation.identity.role,
              position: neo4j.int(position),
              record_json: JSON.stringify(operation),
            },
          );
        }
        await tx.run(
          `MERGE (lock:EpisodeGroupLock {group_id:$group_id})
           SET lock.sequence=$sequence, lock.updated_at=$updated_at`,
          { group_id: group, sequence: neo4j.int(sequence), updated_at: new Date().toISOString() },
        );
        await tx.run(
          "MERGE (lock:EngramStoreLock {id:'extraction-v1'}) SET lock.automatic_operations_v1_present=true",
        );
      });
    } finally {
      await session.close();
      await seedDriver.close();
    }
  }

  function assistantIntent(attemptIdHash = digest(`assistant-first-attempt-${namespace}`)) {
    return AutomaticAssistantCaptureIntentV2Schema.parse({
      version: 2,
      lifecycle: 'replaySafeV2',
      purpose: 'assistant_final_save',
      humanTurn: {
        namespace,
        issuer: request.issuer,
        actorReference: request.actorReference,
        turn: request.turn,
        input: {
          content: request.source.content,
          applicationOwnedWrapper: null,
          humanRegion: null,
          quoteRegions: [],
        },
      },
      finalAssistant: {
        content: 'I will keep future explanations concise.',
        sourceMessageId: `assistant-source-${namespace}`,
        conversationId: `conversation-${namespace}`,
        senderId: 'synthetic-agent',
        senderName: 'Synthetic Agent',
        sourceWorkflowId: 'synthetic-workflow',
        originalSourceExecutionId: `assistant-execution-${namespace}`,
        sourceType: 'message',
        quotedMessageId: null,
        eventTime: { mode: 'first_capture' },
      },
      attemptIdHash,
      invocationDeadlineMs: 30_000,
    });
  }

  async function graph(): Promise<GraphData> {
    return storage.readExtractionSnapshot();
  }

  function assistantOperation(snapshot: GraphData) {
    const matches = (snapshot.automatic_operations_v1?.operations ?? []).filter(
      (operation) =>
        operation.identity.namespace === namespace &&
        operation.identity.turn === request.turn &&
        operation.identity.role === 'assistant',
    );
    if (matches.length !== 1 || matches[0].version !== 2)
      throw new Error('Expected exactly one assistant final-save operation');
    return matches[0];
  }

  it('commits a write-only final receipt and audits exact replays without changing facts', async () => {
    const intent = assistantIntent();
    const before = await graph();
    const result = await storage.saveAssistantFinalV2(intent);
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'initial_owner',
      currentAuthority: 'active',
      eligibleFirstCommit: false,
      terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
    });
    if (result.kind !== 'committed') throw new Error('Expected committed final receipt');

    const after = await graph();
    const operation = assistantOperation(after);
    expect(operation.state).toBe('committed');
    if (operation.state !== 'committed') throw new Error('Expected committed assistant operation');
    expect(operation.terminalReceipt).toEqual(result.terminalReceipt);
    expect(operation.terminalReceipt.kind).toBe('assistant_final_saved');
    expect(after.entities).toEqual(before.entities);
    expect(after.edges).toEqual(before.edges);
    expect(after.episodes).toHaveLength(before.episodes.length + 1);
    expect(after.metadata?.extraction_epoch).toBe(before.metadata?.extraction_epoch);
    const assistantSources = after.episodes.filter(
      (episode) => episode.group_id === namespace && episode.role === 'ai',
    );
    expect(assistantSources).toHaveLength(1);
    expect(assistantSources[0].content).toBe(intent.finalAssistant.content);
    expect(assistantSources[0].source_execution_id).toBe(
      intent.finalAssistant.originalSourceExecutionId,
    );
    expect(assistantSources[0].attributes.engram_write_owner_v1).toBeUndefined();
    expect(assistantSources[0].attributes.engram_source_envelope_v1).toBeUndefined();

    const revisionBeforeDuplicate = await nativeRevision();
    const duplicate = await storage.saveAssistantFinalV2(intent);
    expect(duplicate).toMatchObject({
      kind: 'committed_replay',
      terminalReceipt: result.terminalReceipt,
      currentAuthority: 'active',
      eligibleFirstCommit: false,
    });
    expect(await nativeRevision()).toBe(revisionBeforeDuplicate);

    const anotherAttempt = assistantIntent(digest(`assistant-replay-${namespace}`));
    const replay = await storage.saveAssistantFinalV2(anotherAttempt);
    expect(replay).toMatchObject({
      kind: 'committed_replay',
      terminalReceipt: result.terminalReceipt,
      eligibleFirstCommit: false,
    });
    const audited = assistantOperation(await graph());
    expect(audited.state).toBe('committed');
    if (audited.state !== 'committed') throw new Error('Expected committed assistant operation');
    expect(audited.terminalReceipt).toEqual(result.terminalReceipt);
    expect(audited.attempts.map((attempt) => attempt.attemptHash)).toContain(
      anotherAttempt.attemptIdHash,
    );
  });

  it.each(['accepted_bundle', 'proposed_bundle', 'source_verdict'] as const)(
    'writes a final assistant episode from a native committed V3 %s parent',
    async (kind) => {
      if (!uri) throw new Error('NEO4J_TEST_URI is required');
      const storeHash = neo4jAutomaticCaptureStoreHash(uri, database);
      if (!storeHash) throw new Error('Expected stable Neo4j store identity');
      const parent = makeCompositionalAssistantHumanParentFixture(kind, storeHash);
      nativeFixtureNamespaces.push(parent.source.group_id);
      await seedNativeGraph(parent.graph, parent.source.group_id);
      const intent = makeAssistantIntentForCompositionalParent(parent);

      const before = await storage.readExtractionSnapshot(parent.source.group_id);
      const saved = await storage.saveAssistantFinalV2(intent);
      expect(saved).toMatchObject({
        kind: 'committed',
        invocation: 'initial_owner',
        currentAuthority: 'active',
        eligibleFirstCommit: false,
        terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
      });
      const after = await storage.readExtractionSnapshot(parent.source.group_id);
      expect(after.entities).toEqual(before.entities);
      expect(after.edges).toEqual(before.edges);
      expect(after.episodes).toHaveLength(before.episodes.length + 1);
      expect(after.episodes.find((episode) => episode.uuid === parent.source.uuid)).toEqual(
        parent.source,
      );
      expect(
        after.automatic_operations_v1?.operations.find(
          (operation) => operation.operationId === parent.operation.operationId,
        ),
      ).toEqual(parent.operation);
      expect(
        after.episodes.find(
          (episode) => episode.role === 'ai' && episode.group_id === parent.source.group_id,
        ),
      ).toMatchObject({
        content: intent.finalAssistant.content,
        episode_kind: 'assistant_reply',
        trust_level: 'unverified',
        review_status: 'proposed',
      });

      await storage.close();
      storage = new Neo4jStorage(uri, username, password, database);
      await storage.initialize();
      const reopened = await storage.readExtractionSnapshot(parent.source.group_id);
      expect(reopened.episodes).toEqual(after.episodes);
      expect(reopened.entities).toEqual(after.entities);
      expect(reopened.edges).toEqual(after.edges);
    },
  );

  it('inspects an exact V3-parent assistant receipt after revocation without a new attempt', async () => {
    if (!uri) throw new Error('NEO4J_TEST_URI is required');
    const storeHash = neo4jAutomaticCaptureStoreHash(uri, database);
    if (!storeHash) throw new Error('Expected stable Neo4j store identity');
    const parent = makeCompositionalAssistantHumanParentFixture('source_verdict', storeHash);
    nativeFixtureNamespaces.push(parent.source.group_id);
    await seedNativeGraph(parent.graph, parent.source.group_id);
    const intent = makeAssistantIntentForCompositionalParent(parent);
    const first = await storage.saveAssistantFinalV2(intent);
    if (first.kind !== 'committed') throw new Error('Expected committed assistant receipt');

    const binding = parent.operation.identity.binding;
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace: parent.operation.identity.namespace,
      bindingId: binding.bindingId,
      expectedRevision: binding.revision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic V3 parent revocation',
    });
    const revision = await nativeRevision();
    const before = await storage.readExtractionSnapshot(parent.source.group_id);
    const replay = await storage.saveAssistantFinalV2({ ...intent, attemptIdHash: 'f'.repeat(64) });
    expect(replay).toEqual({
      kind: 'committed_replay',
      terminalReceipt: first.terminalReceipt,
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    });
    expect(await nativeRevision()).toBe(revision);
    const after = await storage.readExtractionSnapshot(parent.source.group_id);
    expect(after.episodes).toEqual(before.episodes);
    expect(after.automatic_operations_v1).toEqual(before.automatic_operations_v1);
  });

  it('returns acknowledgement_unknown after a pre-commit failure and lets an explicit retry create one source', async () => {
    const intent = assistantIntent();
    let first = true;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      if (!first) return executeWrite(work);
      first = false;
      return executeWrite(async (tx) => {
        await work(tx);
        throw new Error('synthetic pre-commit failure');
      });
    });

    const failed = await storage.saveAssistantFinalV2(intent);
    expect(failed).toMatchObject({
      kind: 'decision',
      reason: 'acknowledgement_unknown',
      eligibleFirstCommit: false,
    });
    getSessionSpy.mockRestore();
    getSessionSpy = null;
    const afterRollback = await graph();
    expect(afterRollback.episodes.filter((episode) => episode.group_id === namespace)).toHaveLength(
      1,
    );
    expect(
      (afterRollback.automatic_operations_v1?.operations ?? []).filter(
        (operation) =>
          operation.identity.namespace === namespace && operation.identity.role === 'assistant',
      ),
    ).toHaveLength(0);

    const retried = await storage.saveAssistantFinalV2(intent);
    expect(retried).toMatchObject({ kind: 'committed', eligibleFirstCommit: false });
    expect(
      (await graph()).episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
  });

  it('recovers a managed callback re-entry without duplicating the source or receipt', async () => {
    const intent = assistantIntent();
    let first = true;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      if (!first) return executeWrite(work);
      first = false;
      await executeWrite(work);
      return executeWrite(work);
    });

    const result = await storage.saveAssistantFinalV2(intent);
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'initial_owner',
      eligibleFirstCommit: false,
    });
    getSessionSpy.mockRestore();
    getSessionSpy = null;
    const snapshot = await graph();
    expect(
      snapshot.episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
    expect(assistantOperation(snapshot).state).toBe('committed');
  });

  it('does not issue a handle or auto-apply after a committed begin acknowledgement is lost', async () => {
    const intent = assistantIntent();
    let first = true;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      if (!first) return executeWrite(work);
      first = false;
      await executeWrite(work);
      throw new Error('synthetic lost begin acknowledgement');
    });

    const uncertain = await storage.saveAssistantFinalV2(intent);
    expect(uncertain).toMatchObject({
      kind: 'decision',
      reason: 'acknowledgement_unknown',
      eligibleFirstCommit: false,
    });
    getSessionSpy.mockRestore();
    getSessionSpy = null;

    const afterUnknownAck = await graph();
    expect(
      afterUnknownAck.episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
    expect(assistantOperation(afterUnknownAck).state).toBe('leased');

    const separateCall = await storage.saveAssistantFinalV2(
      assistantIntent(digest(`assistant-after-unknown-begin-${namespace}`)),
    );
    expect(separateCall).toMatchObject({
      kind: 'decision',
      reason: 'in_progress',
      eligibleFirstCommit: false,
    });
    const stillLeased = assistantOperation(await graph());
    expect(stillLeased.state).toBe('leased');
    expect(
      (await graph()).episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
  });

  it('recovers a lost completion acknowledgement by reading only the exact persisted receipt', async () => {
    const intent = assistantIntent();
    let writeCalls = 0;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      writeCalls += 1;
      const result = await executeWrite(work);
      if (writeCalls === 2) throw new Error('synthetic lost completion acknowledgement');
      return result;
    });

    const result = await storage.saveAssistantFinalV2(intent);
    expect(writeCalls).toBe(2);
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'same_call_ack_recovered',
      currentAuthority: 'active',
      eligibleFirstCommit: false,
      terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
    });
    getSessionSpy.mockRestore();
    getSessionSpy = null;
    const snapshot = await graph();
    expect(
      snapshot.episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
    expect(assistantOperation(snapshot).state).toBe('committed');
  });

  it('records a concurrent active attempt as in_progress while the first save owns the lease', async () => {
    const intent = assistantIntent();
    let signalCommitted!: () => void;
    let releaseFirst!: () => void;
    const firstCommitted = new Promise<void>((resolve) => {
      signalCommitted = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let paused = false;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      const result = await executeWrite(work);
      if (!paused) {
        paused = true;
        signalCommitted();
        await waitForRelease;
      }
      return result;
    });

    const firstSave = storage.saveAssistantFinalV2(intent);
    try {
      await firstCommitted;
      const secondIntent = assistantIntent(digest(`assistant-concurrent-${namespace}`));
      const secondSave = await storage.saveAssistantFinalV2(secondIntent);
      expect(secondSave).toMatchObject({
        kind: 'decision',
        reason: 'in_progress',
        eligibleFirstCommit: false,
      });
      const midGraph = await graph();
      const midOperation = assistantOperation(midGraph);
      expect(midOperation.state).toBe('leased');
      expect(midOperation.attempts.map((attempt) => attempt.attemptHash)).toContain(
        secondIntent.attemptIdHash,
      );
      expect(
        midGraph.episodes.filter(
          (episode) => episode.group_id === namespace && episode.role === 'ai',
        ),
      ).toHaveLength(1);
    } finally {
      releaseFirst();
    }

    const firstResult = await firstSave;
    expect(firstResult).toMatchObject({ kind: 'committed', eligibleFirstCommit: false });
    getSessionSpy.mockRestore();
    getSessionSpy = null;
    expect(assistantOperation(await graph()).state).toBe('committed');
  });

  it('rechecks parent authority at completion and leaves a revoked turn uncommitted', async () => {
    const intent = assistantIntent();
    let signalCommitted!: () => void;
    let releaseFirst!: () => void;
    const firstCommitted = new Promise<void>((resolve) => {
      signalCommitted = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let paused = false;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      const result = await executeWrite(work);
      if (!paused) {
        paused = true;
        signalCommitted();
        await waitForRelease;
      }
      return result;
    });

    const pendingSave = storage.saveAssistantFinalV2(intent);
    try {
      await firstCommitted;
      await storage.automaticBindingCommand({
        action: 'revoke',
        namespace,
        bindingId,
        expectedRevision: bindingRevision,
        authorizedBy: 'synthetic-reviewer',
        reason: 'Synthetic revocation between assistant begin and completion',
      });
    } finally {
      releaseFirst();
    }

    const result = await pendingSave;
    expect(result).toMatchObject({
      kind: 'decision',
      reason: 'authority_changed',
      eligibleFirstCommit: false,
    });
    getSessionSpy.mockRestore();
    getSessionSpy = null;
    const after = await graph();
    const operation = assistantOperation(after);
    expect(operation.state).toBe('leased');
    expect(
      after.episodes.filter((episode) => episode.group_id === namespace && episode.role === 'ai'),
    ).toHaveLength(1);
  });

  it('allows exact historical receipt inspection after revocation without adding an attempt', async () => {
    const intent = assistantIntent();
    const committed = await storage.saveAssistantFinalV2(intent);
    if (committed.kind !== 'committed') throw new Error('Expected committed assistant receipt');
    const priorOperation = assistantOperation(await graph());
    if (priorOperation.state !== 'committed')
      throw new Error('Expected committed assistant operation');
    const revisionBeforeRead = await nativeRevision();
    await storage.automaticBindingCommand({
      action: 'revoke',
      namespace,
      bindingId,
      expectedRevision: bindingRevision,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic post-commit revocation',
    });
    const revisionAfterRevocation = await nativeRevision();

    const replay = await storage.saveAssistantFinalV2(
      assistantIntent(digest(`assistant-after-revocation-${namespace}`)),
    );
    expect(replay).toMatchObject({
      kind: 'committed_replay',
      terminalReceipt: committed.terminalReceipt,
      currentAuthority: 'revoked',
      eligibleFirstCommit: false,
    });
    expect(await nativeRevision()).toBe(revisionAfterRevocation);
    expect(revisionAfterRevocation).not.toBe(revisionBeforeRead);
    const after = assistantOperation(await graph());
    if (after.state !== 'committed') throw new Error('Expected committed assistant operation');
    expect(after.attempts).toEqual(priorOperation.attempts);
    expect(after.terminalReceipt).toEqual(priorOperation.terminalReceipt);
  });

  it('keeps the per-call work budget outside the persisted assistant identity', async () => {
    const intent = assistantIntent();
    const first = await storage.saveAssistantFinalV2(intent, { remainingMs: 25_000 });
    expect(first.kind).toBe('committed');
    if (first.kind !== 'committed') throw new Error('Expected a committed assistant receipt');
    const firstGraph = await graph();
    const firstOperation = assistantOperation(firstGraph);
    if (firstOperation.state !== 'committed')
      throw new Error('Expected a committed assistant operation');
    const firstSource = firstGraph.episodes.find(
      (episode) => episode.group_id === namespace && episode.role === 'ai',
    );
    if (!firstSource) throw new Error('Expected a persisted assistant source');

    const replay = await storage.saveAssistantFinalV2(intent, { remainingMs: 15_000 });
    expect(replay).toMatchObject({
      kind: 'committed_replay',
      terminalReceipt: first.terminalReceipt,
      eligibleFirstCommit: false,
    });
    const secondGraph = await graph();
    const secondOperation = assistantOperation(secondGraph);
    if (secondOperation.state !== 'committed')
      throw new Error('Expected the operation to remain committed');
    const secondSource = secondGraph.episodes.find(
      (episode) => episode.group_id === namespace && episode.role === 'ai',
    );
    expect(secondOperation.identity).toEqual(firstOperation.identity);
    expect(secondOperation.descriptor).toEqual(firstOperation.descriptor);
    expect(secondOperation.terminalReceipt).toEqual(firstOperation.terminalReceipt);
    expect(secondSource?.attributes.engram_write_owner_v2).toEqual(
      firstSource.attributes.engram_write_owner_v2,
    );
    expect(secondSource?.attributes.engram_source_envelope_v1).toEqual(
      firstSource.attributes.engram_source_envelope_v1,
    );
  });

  it('rejects malformed work budgets without falling back to the intent deadline', async () => {
    const intent = assistantIntent();
    const revisionBefore = await nativeRevision();
    const result = await storage.saveAssistantFinalV2(intent, { remainingMs: 0 } as never);
    expect(result).toMatchObject({ kind: 'decision', reason: 'invalid_input' });
    expect(await nativeRevision()).toBe(revisionBefore);
    expect(
      (await graph()).episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(0);
  });

  it('does not issue a completion handle when a confirmed begin returns after the work budget', async () => {
    const intent = assistantIntent();
    let writeCalls = 0;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      const result = await executeWrite(work);
      writeCalls += 1;
      if (writeCalls === 1) await pause(1_100);
      return result;
    });

    const result = await storage.saveAssistantFinalV2(intent, { remainingMs: 1_000 });
    expect(result).toMatchObject({ kind: 'decision', reason: 'budget_exhausted' });
    expect(writeCalls).toBe(1);
    getSessionSpy.mockRestore();
    getSessionSpy = null;

    const snapshot = await graph();
    expect(
      snapshot.episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
    expect(assistantOperation(snapshot).state).toBe('leased');
  });

  it('reads the exact committed receipt after completion acknowledgement arrives past budget', async () => {
    const intent = assistantIntent();
    let writeCalls = 0;
    getSessionSpy = proxiedSession(storage, async (executeWrite, work) => {
      const result = await executeWrite(work);
      writeCalls += 1;
      if (writeCalls === 2) await pause(3_100);
      return result;
    });

    const result = await storage.saveAssistantFinalV2(intent, { remainingMs: 3_000 });
    expect(writeCalls).toBe(2);
    expect(result).toMatchObject({
      kind: 'committed',
      invocation: 'same_call_ack_recovered',
      eligibleFirstCommit: false,
      terminalReceipt: { kind: 'assistant_final_saved', persisted: true },
    });
    getSessionSpy.mockRestore();
    getSessionSpy = null;

    const snapshot = await graph();
    expect(
      snapshot.episodes.filter(
        (episode) => episode.group_id === namespace && episode.role === 'ai',
      ),
    ).toHaveLength(1);
    expect(assistantOperation(snapshot).state).toBe('committed');
  });
});
