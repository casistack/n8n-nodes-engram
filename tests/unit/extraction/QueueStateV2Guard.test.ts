import { createHash, randomUUID } from 'crypto';
import { buildAutomaticOperationDescriptorV2 } from '../../../src/extraction/AutomaticCaptureDescriptor';
import { captureEnvelope, compileAutomaticPolicy } from '../../../src/extraction/AutomaticEvidence';
import { ExtractionDiagnostics } from '../../../src/extraction/ExtractionDiagnostics';
import {
  committedAutomaticReceipt,
  planAutomaticClaims,
} from '../../../src/extraction/AutomaticClaims';
import {
  hashAutomaticCaptureV2,
  AutomaticCaptureSourceOwnerV2Schema,
} from '../../../src/schemas/AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from '../../../src/schemas/AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../../src/schemas/AutomaticCaptureReceipt.schema';
import {
  EntityNodeSchema,
  EpisodicNodeSchema,
  StagedExtractionSchema,
  type GraphData,
  type StagedExtraction,
} from '../../../src/schemas';
import {
  applyAutomaticBindingCommand,
  automaticCaptureOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  assertAutomaticLedgerSourceIntegrity,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../../src/storage/AutomaticIdentity';
import type { AutomaticWriteOwner } from '../../../src/schemas/AutomaticClaim.schema';
import {
  applyPlan,
  enqueue,
  graphFingerprint,
  jobs,
  sourceFingerprint,
} from '../../../src/extraction/QueueState';
import type { AppendEpisodeResult } from '../../../src/storage/IGraphStorage';

const now = '2026-10-25T12:00:00.000Z';
const namespace = 'queue-v2-guard';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture() {
  const subjectId = randomUUID();
  const subject = EntityNodeSchema.parse({
    uuid: subjectId,
    group_id: namespace,
    name: 'Synthetic subject',
    entity_type: 'person',
    summary: '',
    created_at: now,
    updated_at: now,
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
  const graph: GraphData = {
    version: '2.0',
    exported_at: now,
    group_id: namespace,
    entities: [subject],
    edges: [],
    episodes: [],
  };
  const record = applyAutomaticBindingCommand(
    graph,
    {
      action: 'create',
      namespace,
      issuer: 'synthetic-workflow',
      actorReference: 'synthetic-actor',
      subjectId,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic source binding',
    },
    randomUUID(),
    now,
  );
  const binding = {
    bindingId: record.bindingId,
    revision: record.revision,
    subjectId: record.subjectId,
    fingerprint: record.fingerprint,
  };
  const policy = compileAutomaticPolicy({ profileId: 'explicit' });
  const content = 'I prefer concise explanations.';
  const captured = captureEnvelope(
    content,
    content,
    { namespace, issuer: 'synthetic-workflow', actorReference: 'synthetic-actor' },
    binding,
    true,
    policy,
  );
  if (!captured.ok) throw new Error('Synthetic source envelope fixture failed');

  const legacyOwner: AutomaticWriteOwner = {
    version: 1,
    store: 'a'.repeat(64),
    namespace,
    turn: 'synthetic-human-turn',
    role: 'human',
    actor: 'synthetic-actor',
    issuer: 'synthetic-workflow',
    binding,
    policy,
    contentHash: digest(content),
  };
  const descriptor = buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'explicit',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    invocationDeadlineMs: 30_000,
  }).descriptor;
  const episode = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: namespace,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: now,
    previous_episode_uuid: null,
    created_at: now,
    updated_at: now,
    source_message_id: 'synthetic-source-message',
    source_workflow_id: 'synthetic-producer',
    source_execution_id: 'synthetic-original-execution',
    conversation_id: 'synthetic-conversation',
    sender_id: 'synthetic-actor',
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
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: legacyOwner.store,
    namespace,
    turn: legacyOwner.turn,
    role: 'human',
    issuer: legacyOwner.issuer,
    actorReference: legacyOwner.actor,
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting: true,
    intentEvidence: true,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({
      mode: 'first_capture',
      normalizedReferenceTime: now,
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
  const identity = automaticCaptureOperationIdentityForOwnedSource(episode, descriptor);
  graph.episodes.push(episode);
  assertAutomaticLedgerSourceIntegrity(graph);

  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(graph, namespace, [episode.uuid], policy, outcome, now);
  return { graph, episode, plan, descriptor, identity };
}

function committedFixture() {
  const { graph, episode, plan, descriptor, identity } = fixture();
  graph.entities.push(...structuredClone(plan.entities));
  graph.edges.push(...structuredClone(plan.edges));
  committedAutomaticReceipt(plan.outcome, now);
  const receipt = plan.outcome.automatic;
  if (!receipt) throw new Error('Synthetic V2 plan did not contain its literal receipt');

  const operationId = randomUUID();
  const descriptorHash = hashAutomaticCaptureV2(descriptor);
  const accepted = receipt.items.filter(
    (item) => item.persisted && (item.state === 'accepted' || item.state === 'unchanged'),
  );
  const terminalReceipt = AutomaticCaptureTerminalReceiptV2Schema.parse({
    version: 2,
    kind: 'human_capture_committed',
    operationId,
    sourceId: episode.uuid,
    sourceHash: identity.sourceHash,
    descriptorHash,
    terminalAt: now,
    receiptInspectionComplete: receipt.coverageComplete,
    interpretationCoverage: 'complete',
    acceptedCoverage:
      accepted.length === 0 ? 'none' : accepted.length === receipt.items.length ? 'all' : 'partial',
    dependencies: receipt.items.map((item, itemIndex) => ({
      sourceId: episode.uuid,
      dependencyHash: hashAutomaticCaptureV2({
        sourceId: episode.uuid,
        sourceHash: identity.sourceHash,
        itemIndex,
        item,
      }),
      itemIndex,
      ...(item.claimId === undefined ? {} : { claimId: item.claimId }),
      state: item.state,
      persisted: item.persisted,
      reasons: item.reasons,
    })),
    receipt,
  });
  const operation = AutomaticCaptureOperationV2Schema.parse({
    version: 2,
    operationId,
    identity,
    descriptor,
    createdAt: now,
    lastObservedAt: now,
    attempts: [],
    overflowCount: 0,
    beginCallHash: hashAutomaticCaptureV2({ operationId, call: 'begin-human' }),
    retryCount: 0,
    state: 'committed',
    generation: 1,
    completionCallHash: hashAutomaticCaptureV2({ operationId, call: 'complete-human' }),
    terminalReceipt,
  });
  graph.automatic_operations_v1 = { version: 1, operations: [operation] };
  assertAutomaticLedgerSourceIntegrity(graph);
  return { graph, episode };
}

function addUnownedLegacySource(graph: GraphData, base: GraphData['episodes'][number]) {
  const uuid = randomUUID();
  const source = EpisodicNodeSchema.parse({
    ...base,
    uuid,
    content: 'A legacy source unrelated to the protected preference.',
    source_message_id: `legacy-message-${uuid}`,
    source_execution_id: `legacy-execution-${uuid}`,
    idempotency_key: `legacy-unowned-${uuid}`,
    attributes: {},
  });
  graph.episodes.push(source);
  return source;
}

function makeLegacyPlan(
  graph: GraphData,
  source: GraphData['episodes'][number],
  entities: StagedExtraction['entities'],
  edges: StagedExtraction['edges'],
): StagedExtraction {
  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  return StagedExtractionSchema.parse({
    version: 1,
    group_id: namespace,
    graph_hash: graphFingerprint(graph, namespace),
    source_guards: [{ uuid: source.uuid, hash: sourceFingerprint(source) }],
    entities,
    edges,
    outcome,
  });
}

describe('legacy queue and plan guards for replay-safe v2 sources', () => {
  it('prevents queued and unqueued legacy applyPlan from mutating a dual-owner v2 source graph', () => {
    const { graph, episode, plan } = fixture();
    expect(plan.entities.length + plan.edges.length).toBeGreaterThan(0);
    expect(plan.source_guards).toEqual([{ uuid: episode.uuid, hash: sourceFingerprint(episode) }]);

    for (const queued of [false, true]) {
      const target = structuredClone(graph);
      const before = structuredClone(target);
      expect(() => applyPlan(target, plan, queued)).toThrow(
        'Engram automatic memory: capture_operation_required',
      );
      expect(target).toEqual(before);
    }
  });

  it.each([true, false])(
    'rejects legacy enqueue for a stored v2 source when append created=%s without mutation',
    (created) => {
      const { graph, episode } = fixture();
      const result: AppendEpisodeResult = { episode, created };
      const before = structuredClone(graph);
      const jobsBefore = jobs(graph);

      expect(() =>
        enqueue(
          graph,
          [result],
          [0],
          { route_id: 'synthetic-route', config_hash: 'c'.repeat(64) },
          {
            max_jobs: 10,
            max_namespace_bytes: 1024 * 1024,
            max_store_bytes: 10 * 1024 * 1024,
          },
          now,
          randomUUID(),
        ),
      ).toThrow('Engram automatic memory: capture_operation_required');

      expect(graph).toEqual(before);
      expect(jobs(graph)).toEqual(jobsBefore);
    },
  );

  it.each([false, true])(
    'rejects a stripped legacy mutation of a committed v2-derived entity before any write (queued=%s)',
    (queued) => {
      const { graph, episode } = committedFixture();
      const legacySource = addUnownedLegacySource(graph, episode);
      const protectedEntity = graph.entities.find(
        (entity) => entity.entity_type === 'preference_value',
      );
      expect(protectedEntity).toBeDefined();
      const editedEntity = EntityNodeSchema.parse({
        ...protectedEntity!,
        name: `${protectedEntity!.name} legacy edit`,
        attributes: {},
      });
      const plan = makeLegacyPlan(graph, legacySource, [editedEntity], []);
      const before = structuredClone(graph);

      expect(() => applyPlan(graph, plan, queued)).toThrow(
        'Engram automatic memory: capture_operation_required',
      );
      expect(graph).toEqual(before);
    },
  );

  it.each([false, true])(
    'preflights all existing targets before applying earlier legacy items when a committed v2 edge is targeted (queued=%s)',
    (queued) => {
      const { graph, episode } = committedFixture();
      const legacySource = addUnownedLegacySource(graph, episode);
      const protectedEdge = graph.edges.find((edge) => edge.episodes.includes(episode.uuid));
      expect(protectedEdge).toBeDefined();

      const earlierLegacyEntity = EntityNodeSchema.parse({
        uuid: randomUUID(),
        group_id: namespace,
        name: 'Unowned proposed legacy target',
        entity_type: 'concept',
        summary: '',
        created_at: now,
        updated_at: now,
        attributes: {
          engram_extraction: {
            version: 2,
            source: 'llm',
            confidence: null,
            review_status: 'proposed',
            threshold_decision: 'pending_review',
            extracted_at: now,
            episode_uuids: [legacySource.uuid],
            reviewed_at: null,
            reviewed_by: null,
          },
        },
      });
      const strippedEdge = {
        ...protectedEdge!,
        fact: 'A legacy writer changed the protected preference.',
        episodes: [legacySource.uuid],
        attributes: {},
      };
      const plan = makeLegacyPlan(graph, legacySource, [earlierLegacyEntity], [strippedEdge]);
      const before = structuredClone(graph);

      expect(() => applyPlan(graph, plan, queued)).toThrow(
        'Engram automatic memory: capture_operation_required',
      );
      expect(graph).toEqual(before);
      expect(graph.entities.some((entity) => entity.uuid === earlierLegacyEntity.uuid)).toBe(false);
    },
  );

  it('allows legacy provenance that resolves only to a v1-owned source', () => {
    const { graph, episode } = committedFixture();
    const legacyV1Source = structuredClone(episode);
    const sourceId = randomUUID();
    legacyV1Source.uuid = sourceId;
    legacyV1Source.source_message_id = `legacy-v1-message-${sourceId}`;
    legacyV1Source.source_execution_id = `legacy-v1-execution-${sourceId}`;
    delete legacyV1Source.attributes[WRITE_OWNER_V2_ATTRIBUTE];
    delete legacyV1Source.attributes[SOURCE_ENVELOPE_ATTRIBUTE];
    const v1Owner = {
      ...(legacyV1Source.attributes[WRITE_OWNER_ATTRIBUTE] as AutomaticWriteOwner),
      turn: `legacy-v1-turn-${sourceId}`,
    };
    legacyV1Source.attributes[WRITE_OWNER_ATTRIBUTE] = v1Owner;
    legacyV1Source.idempotency_key = automaticWriteOwnerIdempotencyKey(v1Owner);
    graph.episodes.push(EpisodicNodeSchema.parse(legacyV1Source));

    const legacyTarget = EntityNodeSchema.parse({
      uuid: randomUUID(),
      group_id: namespace,
      name: 'Legacy target',
      entity_type: 'concept',
      summary: 'before',
      created_at: now,
      updated_at: now,
      attributes: {
        engram_extraction: {
          version: 2,
          source: 'llm',
          confidence: null,
          review_status: 'proposed',
          threshold_decision: 'pending_review',
          extracted_at: now,
          episode_uuids: [sourceId],
          reviewed_at: null,
          reviewed_by: null,
        },
      },
    });
    graph.entities.push(legacyTarget);
    const editedTarget = EntityNodeSchema.parse({ ...legacyTarget, summary: 'legacy update' });
    const plan = makeLegacyPlan(graph, legacyV1Source, [editedTarget], []);

    expect(() => applyPlan(graph, plan)).not.toThrow();
    expect(graph.entities.find((entity) => entity.uuid === legacyTarget.uuid)?.summary).toBe(
      'legacy update',
    );
  });
});
