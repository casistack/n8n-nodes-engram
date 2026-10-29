import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import neo4j from 'neo4j-driver';
import { captureEnvelope, compileAutomaticPolicy } from '../../src/extraction/AutomaticEvidence';
import { buildAutomaticOperationDescriptorV2 } from '../../src/extraction/AutomaticCaptureDescriptor';
import { graphFingerprint, sourceFingerprint } from '../../src/extraction/QueueState';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  hashAutomaticCaptureV2,
} from '../../src/schemas/AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from '../../src/schemas/AutomaticCaptureOperation.schema';
import { AutomaticLedgerSchema, type GraphData } from '../../src/schemas';
import { EpisodicNodeSchema } from '../../src/schemas/EpisodicNode.schema';
import {
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../src/storage/AutomaticIdentity';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { Neo4jStorage } from '../../src/storage/Neo4jStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';
import type { AutomaticWriteOwner } from '../../src/schemas/AutomaticClaim.schema';
import type { EpisodicNode } from '../../src/schemas/EpisodicNode.schema';
import type { AutomaticCaptureOperationV2 } from '../../src/schemas/AutomaticCaptureOperation.schema';

jest.setTimeout(30000);

const timestamp = '2026-10-25T12:00:00.000Z';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function legacyEpisode(group: string, turn: string) {
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const content = `Legacy source for ${turn}`;
  const owner: AutomaticWriteOwner = {
    version: 1,
    store: 'a'.repeat(64),
    namespace: group,
    turn,
    role: 'human',
    actor: 'legacy-actor',
    issuer: 'synthetic-workflow',
    binding: null,
    policy,
    contentHash: digest(content),
  };
  return {
    owner,
    input: {
      group_id: group,
      content,
      role: 'human' as const,
      source_type: 'message' as const,
      reference_time: timestamp,
      previous_episode_uuid: null,
      source_message_id: `message-${turn}`,
      source_execution_id: 'legacy-execution',
      idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
      conversation_id: 'synthetic-conversation',
      sender_id: 'synthetic-sender',
      episode_kind: 'active_human' as const,
      trust_level: 'trusted' as const,
      review_status: 'accepted' as const,
      attributes: { [WRITE_OWNER_ATTRIBUTE]: owner },
    },
  };
}

function v2HumanFixture(
  group: string,
  subjectId: string,
  suffix = 'leased',
): {
  episode: EpisodicNode;
  operation: AutomaticCaptureOperationV2;
} {
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const binding = {
    bindingId: randomUUID(),
    revision: 1,
    subjectId,
    fingerprint: 'b'.repeat(64),
  };
  const content = 'I prefer concise explanations.';
  const captured = captureEnvelope(
    content,
    content,
    { namespace: group, issuer: 'synthetic-workflow', actorReference: 'v2-actor' },
    binding,
    false,
    policy,
  );
  if (!captured.ok) throw new Error('Synthetic source envelope fixture failed');

  const legacyOwner: AutomaticWriteOwner = {
    version: 1,
    store: 'a'.repeat(64),
    namespace: group,
    turn: `v2-human-turn-${suffix}`,
    role: 'human',
    actor: 'v2-actor',
    issuer: 'synthetic-workflow',
    binding,
    policy,
    contentHash: digest(content),
  };
  const descriptor = buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    invocationDeadlineMs: 30_000,
  }).descriptor;
  const episode = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: group,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: timestamp,
    previous_episode_uuid: null,
    created_at: timestamp,
    updated_at: timestamp,
    source_message_id: `v2-source-message-${suffix}`,
    source_workflow_id: 'synthetic-producer',
    source_execution_id: `synthetic-original-execution-${suffix}`,
    conversation_id: 'synthetic-conversation',
    sender_id: 'synthetic-sender',
    sender_name: 'Synthetic display',
    idempotency_key: automaticWriteOwnerIdempotencyKey(legacyOwner),
    episode_kind: 'active_human',
    quoted_message_id: null,
    trust_level: 'standard',
    review_status: 'accepted',
    attributes: {
      [SOURCE_ENVELOPE_ATTRIBUTE]: captured.envelope,
      [WRITE_OWNER_ATTRIBUTE]: legacyOwner,
    },
  });
  const v2Owner = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: legacyOwner.store,
    namespace: group,
    turn: legacyOwner.turn,
    role: 'human',
    issuer: legacyOwner.issuer,
    actorReference: legacyOwner.actor,
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    intentEvidence: false,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({
      mode: 'first_capture',
      normalizedReferenceTime: timestamp,
    }),
    stableProducerHash: hashAutomaticCaptureV2({
      source_workflow_id: episode.source_workflow_id,
      source_message_id: episode.source_message_id,
      conversation_id: episode.conversation_id,
      sender_id: episode.sender_id,
      source_type: episode.source_type,
      episode_kind: episode.episode_kind,
      quoted_message_id: episode.quoted_message_id,
    }),
    sourceContentHash: digest(content),
    settingsHash: descriptor.settingsHash,
    policy,
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = v2Owner;

  const identity = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
  const operation = AutomaticCaptureOperationV2Schema.parse({
    version: 2,
    operationId: randomUUID(),
    identity,
    descriptor,
    createdAt: timestamp,
    lastObservedAt: timestamp,
    attempts: [],
    overflowCount: 0,
    beginCallHash: digest('synthetic-private-begin-call'),
    retryCount: 0,
    state: 'leased',
    generation: 1,
    lease: {
      token: randomUUID(),
      acquiredAt: timestamp,
      renewedAt: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + 60_000).toISOString(),
      claimKind: 'initial',
    },
  });
  return { episode, operation };
}

async function seedNativeV2Record(
  backend: 'embedded' | 'neo4j',
  data: GraphData,
  persistPath: string,
  group: string,
  episodes: EpisodicNode[],
  operation: AutomaticCaptureOperationV2,
): Promise<void> {
  const ledger = AutomaticLedgerSchema.parse(data.automatic_operations_v1);
  const seeded: GraphData = {
    ...data,
    episodes: [...data.episodes, ...episodes],
    automatic_operations_v1: {
      version: 1,
      operations: [...ledger.operations, operation],
    },
  };
  assertAutomaticLedgerSourceIntegrity(seeded);

  if (backend === 'embedded') {
    fs.writeFileSync(persistPath, JSON.stringify(seeded, null, 2), 'utf8');
    return;
  }

  const driver = neo4j.driver(
    process.env.NEO4J_TEST_URI!.replace('://localhost:', '://127.0.0.1:'),
    neo4j.auth.basic('neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'password'),
  );
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      for (const episode of episodes) {
        await tx.run('CREATE (ep:Episode) SET ep += $props', {
          props: { ...episode, attributes: JSON.stringify(episode.attributes) },
        });
      }
      await tx.run(
        `CREATE (op:AutomaticOperation {
          operation_id:$operation_id, store_hash:$store_hash, namespace:$namespace,
          source_id:$source_id, role:$role, position:$position, record_json:$record_json
        })`,
        {
          operation_id: operation.operationId,
          store_hash: operation.identity.storeHash,
          namespace: operation.identity.namespace,
          source_id: operation.identity.sourceId,
          role: operation.identity.role,
          position: ledger.operations.length,
          record_json: JSON.stringify(operation),
        },
      );
      await tx.run(
        `MATCH (lock:EngramStoreLock {id:'extraction-v1'})
         SET lock.automatic_operations_v1_present=true`,
      );
    });
  } finally {
    await session.close();
    await driver.close();
  }

  if (episodes.some((episode) => episode.group_id !== group)) {
    throw new Error('Native fixture episodes must stay in the seeded namespace');
  }
}

for (const backend of ['embedded', 'neo4j'] as const) {
  const suite = backend === 'neo4j' && !process.env.NEO4J_TEST_URI ? describe.skip : describe;
  suite(`${backend} mixed automatic-ledger native preservation`, () => {
    const group = `mixed-ledger-${randomUUID()}`;
    let directory: string;
    let storage: IGraphStorage;
    const persistPath = () => join(directory, 'store.json');
    const create = (): IGraphStorage =>
      backend === 'embedded'
        ? new GraphologyStorage(persistPath())
        : new Neo4jStorage(
            process.env.NEO4J_TEST_URI!,
            'neo4j',
            process.env.NEO4J_TEST_PASSWORD ?? 'password',
          );

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), 'engram-mixed-ledger-'));
      storage = create();
      await storage.initialize();
    });

    afterEach(async () => {
      await storage.close();
      if (backend === 'embedded') {
        rmSync(directory, { recursive: true, force: true });
        return;
      }
      const driver = neo4j.driver(
        process.env.NEO4J_TEST_URI!.replace('://localhost:', '://127.0.0.1:'),
        neo4j.auth.basic('neo4j', process.env.NEO4J_TEST_PASSWORD ?? 'password'),
      );
      const session = driver.session();
      try {
        await session.executeWrite(async (tx) => {
          await tx.run('MATCH (op:AutomaticOperation {namespace:$group}) DETACH DELETE op', {
            group,
          });
          await tx.run(
            'MATCH (n) WHERE n.group_id=$group AND (n:Entity OR n:Episode) DETACH DELETE n',
            {
              group,
            },
          );
        });
      } finally {
        await session.close();
        await driver.close();
      }
    });

    it('preserves a native v2 lease through v1 observation, ordinary writes, exports and reopen', async () => {
      const legacy = legacyEpisode(group, 'legacy-turn');
      const [legacyAppend] = await storage.appendAutomaticEpisodes!([legacy.input]);
      const legacyObservation = await storage.observeLegacyAutomaticSource!({
        sourceId: legacyAppend.episode.uuid,
        expectedOwner: legacy.owner,
      });
      expect(legacyObservation.status).toBe('observed');

      const subject = await storage.addEntity({ group_id: group, name: 'Native v2 subject' });
      const { episode, operation } = v2HumanFixture(group, subject.uuid);
      const sourceOnly = v2HumanFixture(group, subject.uuid, 'source-only').episode;
      const beforeSeed = await storage.readExtractionSnapshot!();
      await storage.close();
      await seedNativeV2Record(
        backend,
        beforeSeed,
        persistPath(),
        group,
        [episode, sourceOnly],
        operation,
      );
      storage = create();
      await storage.initialize();

      const beforeObservation = await storage.readExtractionSnapshot!(group);
      const v2Before = beforeObservation.automatic_operations_v1!.operations.find(
        (candidate) => candidate.version === 2,
      )!;
      expect(v2Before).toEqual(operation);
      expect(JSON.stringify(v2Before)).toBe(JSON.stringify(operation));
      expect(
        beforeObservation.automatic_operations_v1!.operations.some(
          (candidate) => candidate.identity.sourceId === sourceOnly.uuid,
        ),
      ).toBe(false);
      expect(beforeObservation.episodes).toEqual(expect.arrayContaining([episode, sourceOnly]));
      await expect(storage.appendAutomaticEpisodes!([episode])).rejects.toThrow(
        'trusted_capture_writer_required',
      );
      await expect(storage.importGraph(beforeObservation)).rejects.toThrow(
        'native_restore_required',
      );
      await expect(
        storage.importGraph({
          version: '2.0',
          exported_at: timestamp,
          group_id: group,
          entities: [],
          edges: [],
          episodes: [episode],
        }),
      ).rejects.toThrow('owned_source_import_forbidden');
      const capturedSourceFingerprint = sourceFingerprint(episode);
      const graphBeforeObservation = graphFingerprint(beforeObservation, group);

      const repeated = await storage.observeLegacyAutomaticSource!({
        sourceId: legacyAppend.episode.uuid,
        expectedOwner: legacy.owner,
      });
      expect(repeated.status).toBe('already_unconfirmed');
      const afterObservation = await storage.readExtractionSnapshot!(group);
      const v2AfterObservation = afterObservation.automatic_operations_v1!.operations.find(
        (candidate) => candidate.version === 2,
      )!;
      expect(JSON.stringify(v2AfterObservation)).toBe(JSON.stringify(v2Before));
      expect(graphFingerprint(afterObservation, group)).toBe(graphBeforeObservation);
      expect(
        sourceFingerprint(
          afterObservation.episodes.find((source) => source.uuid === episode.uuid)!,
        ),
      ).toBe(capturedSourceFingerprint);

      const exported = await storage.exportGraph(group);
      expect(exported.automatic_operations_v1?.operations).toHaveLength(2);
      await storage.addEntity({ group_id: group, name: 'Ordinary mixed-ledger writer' });
      await storage.importGraph({
        version: '2.0',
        exported_at: timestamp,
        group_id: `unrelated-${group}`,
        entities: [],
        edges: [],
        episodes: [],
      });

      const full = await storage.readExtractionSnapshot!();
      expect(full.automatic_operations_v1?.operations).toHaveLength(2);
      expect(
        full.automatic_operations_v1?.operations.find((candidate) => candidate.version === 2),
      ).toEqual(operation);
      expect((await storage.exportGraph(group)).automatic_operations_v1?.operations).toHaveLength(
        2,
      );

      await storage.close();
      storage = create();
      await storage.initialize();
      const reopened = await storage.readExtractionSnapshot!(group);
      const v2AfterReopen = reopened.automatic_operations_v1!.operations.find(
        (candidate) => candidate.version === 2,
      )!;
      expect(JSON.stringify(v2AfterReopen)).toBe(JSON.stringify(operation));
      expect(v2AfterReopen).toEqual(operation);
      expect(reopened.episodes).toEqual(expect.arrayContaining([episode, sourceOnly]));
      expect(
        reopened.automatic_operations_v1!.operations.some(
          (candidate) => candidate.identity.sourceId === sourceOnly.uuid,
        ),
      ).toBe(false);
    });
  });
}
