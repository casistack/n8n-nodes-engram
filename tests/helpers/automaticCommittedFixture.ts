import { createHash, randomUUID } from 'crypto';
import { buildAutomaticOperationDescriptorV2 } from '../../src/extraction/AutomaticCaptureDescriptor';
import {
  planAutomaticClaims,
  validateAutomaticPlan,
  committedAutomaticReceipt,
} from '../../src/extraction/AutomaticClaims';
import { ExtractionDiagnostics } from '../../src/extraction/ExtractionDiagnostics';
import { captureEnvelope, compileAutomaticPolicy } from '../../src/extraction/AutomaticEvidence';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  hashAutomaticCaptureV2,
  type AutomaticOperationDescriptorV2,
} from '../../src/schemas/AutomaticCapture.schema';
import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from '../../src/schemas/AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../../src/schemas/AutomaticCaptureReceipt.schema';
import {
  EntityNodeSchema,
  EpisodicNodeSchema,
  GraphDataSchema,
  type GraphData,
  type EpisodicNode,
} from '../../src/schemas';
import type { AutomaticWriteOwner } from '../../src/schemas/AutomaticClaim.schema';
import {
  applyAutomaticBindingCommand,
  automaticCaptureOperationIdentityForOwnedSource,
  automaticWriteOwnerIdempotencyKey,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../../src/storage/AutomaticIdentity';
const NOW = '2026-10-25T12:00:00.000Z';
const ISSUER = 'synthetic-workflow';
const ACTOR = 'synthetic-human-actor';
const TURN = 'synthetic-turn-001';
const STORE_HASH = digest('synthetic logical store');
function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeAcceptedSubject(namespace: string): ReturnType<typeof EntityNodeSchema.parse> {
  return EntityNodeSchema.parse({
    uuid: randomUUID(),
    group_id: namespace,
    name: 'Synthetic manually reviewed subject',
    entity_type: 'person',
    summary: '',
    created_at: NOW,
    updated_at: NOW,
    attributes: {
      engram_extraction: {
        version: 2,
        source: 'manual',
        confidence: null,
        review_status: 'accepted',
        threshold_decision: 'manually_reviewed',
        extracted_at: NOW,
        episode_uuids: [],
        reviewed_at: NOW,
        reviewed_by: 'synthetic-reviewer',
      },
    },
  });
}

function producerHash(episode: EpisodicNode): string {
  return hashAutomaticCaptureV2({
    source_workflow_id: episode.source_workflow_id,
    source_message_id: episode.source_message_id,
    conversation_id: episode.conversation_id,
    sender_id: episode.sender_id,
    source_type: episode.source_type,
    episode_kind: episode.episode_kind,
    quoted_message_id: episode.quoted_message_id,
  });
}

function makeCommittedHumanOperation(
  episode: EpisodicNode,
  descriptor: AutomaticOperationDescriptorV2,
  identity: ReturnType<typeof automaticCaptureOperationIdentityForOwnedSource>,
  outcome: ReturnType<ExtractionDiagnostics['finish']>,
): AutomaticCaptureOperationV2 {
  const receipt = outcome.automatic;
  if (!receipt) throw new Error('Expected a planned automatic receipt');
  const operationId = randomUUID();
  const descriptorHash = hashAutomaticCaptureV2(descriptor);
  const dependencies = receipt.items.map((item, itemIndex) => ({
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
  }));
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
    terminalAt: NOW,
    receiptInspectionComplete: receipt.coverageComplete,
    interpretationCoverage: 'complete',
    acceptedCoverage:
      accepted.length === 0 ? 'none' : accepted.length === receipt.items.length ? 'all' : 'partial',
    dependencies,
    receipt,
  });
  return AutomaticCaptureOperationV2Schema.parse({
    version: 2,
    operationId,
    identity,
    descriptor,
    createdAt: NOW,
    lastObservedAt: NOW,
    attempts: [],
    overflowCount: 0,
    beginCallHash: hashAutomaticCaptureV2({ operationId, call: 'begin-human' }),
    retryCount: 0,
    state: 'committed',
    generation: 1,
    completionCallHash: hashAutomaticCaptureV2({ operationId, call: 'complete-human' }),
    terminalReceipt,
  });
}

interface HumanFixture {
  graph: GraphData;
  human: EpisodicNode;
  humanDescriptor: AutomaticOperationDescriptorV2;
  humanIdentity: ReturnType<typeof automaticCaptureOperationIdentityForOwnedSource>;
  humanOperation: AutomaticCaptureOperationV2;
  binding: {
    bindingId: string;
    revision: number;
    subjectId: string;
    fingerprint: string;
  };
}

export function makeHumanFixture(
  namespace = 'assistant-integrity-fixture',
  applicationPrefix = '',
): HumanFixture {
  const subject = makeAcceptedSubject(namespace);
  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: NOW,
    group_id: namespace,
    entities: [subject],
    edges: [],
    episodes: [],
  });
  const bindingRecord = applyAutomaticBindingCommand(
    graph,
    {
      action: 'create',
      namespace: namespace,
      issuer: ISSUER,
      actorReference: ACTOR,
      subjectId: subject.uuid,
      authorizedBy: 'synthetic-reviewer',
      reason: 'Synthetic manual identity verification',
    },
    randomUUID(),
    NOW,
  );
  const binding = {
    bindingId: bindingRecord.bindingId,
    revision: bindingRecord.revision,
    subjectId: bindingRecord.subjectId,
    fingerprint: bindingRecord.fingerprint,
  };
  const policy = compileAutomaticPolicy({ profileId: 'conservative' });
  const body = 'I prefer concise explanations.';
  const content = applicationPrefix + body;
  const captured = captureEnvelope(
    body,
    content,
    {
      namespace: namespace,
      issuer: ISSUER,
      actorReference: ACTOR,
      ...(applicationPrefix
        ? {
            applicationOwnedWrapper: true as const,
            humanRegion: { start: applicationPrefix.length, end: content.length },
          }
        : {}),
    },
    binding,
    false,
    policy,
  );
  if (!captured.ok) throw new Error(`Synthetic human capture failed: ${captured.reason}`);

  const legacyOwner: AutomaticWriteOwner = {
    version: 1,
    store: STORE_HASH,
    namespace: namespace,
    turn: TURN,
    role: 'human',
    actor: ACTOR,
    issuer: ISSUER,
    binding,
    policy,
    contentHash: digest(content),
  };
  const humanDescriptor = buildAutomaticOperationDescriptorV2({
    purpose: 'human_turn_memory',
    profileId: 'conservative',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    invocationDeadlineMs: 30_000,
  }).descriptor;
  const human = EpisodicNodeSchema.parse({
    uuid: randomUUID(),
    group_id: namespace,
    content,
    role: 'human',
    source_type: 'message',
    reference_time: NOW,
    previous_episode_uuid: null,
    created_at: NOW,
    updated_at: NOW,
    source_message_id: 'synthetic-human-source',
    source_workflow_id: 'synthetic-producer',
    source_execution_id: 'synthetic-original-execution',
    conversation_id: 'synthetic-conversation',
    sender_id: ACTOR,
    sender_name: 'Synthetic human display',
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
  human.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: STORE_HASH,
    namespace: namespace,
    turn: TURN,
    role: 'human',
    issuer: ISSUER,
    actorReference: ACTOR,
    binding,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: 'standard',
    intentSetting: false,
    intentEvidence: captured.envelope.explicitIntent,
    eventTimeMode: 'first_capture',
    eventTimeHash: hashAutomaticCaptureV2({
      mode: 'first_capture',
      normalizedReferenceTime: new Date(NOW).toISOString(),
    }),
    stableProducerHash: producerHash(human),
    sourceContentHash: digest(content),
    settingsHash: humanDescriptor.settingsHash,
    policy,
  });
  const humanIdentity = automaticCaptureOperationIdentityForOwnedSource(human, humanDescriptor);
  graph.episodes.push(human);

  const outcome = new ExtractionDiagnostics().finish();
  outcome.status = 'succeeded';
  const plan = planAutomaticClaims(graph, namespace, [human.uuid], policy, outcome, NOW);
  if (!validateAutomaticPlan(graph, plan)) throw new Error('Expected the V2 plan to validate');
  if (plan.entities.length === 0 || plan.edges.length === 0) {
    throw new Error('Expected the synthetic human preference to produce stored claims');
  }
  graph.entities.push(...plan.entities);
  graph.edges.push(...plan.edges);
  committedAutomaticReceipt(plan.outcome, NOW);
  const humanOperation = makeCommittedHumanOperation(
    human,
    humanDescriptor,
    humanIdentity,
    plan.outcome,
  );
  graph.automatic_operations_v1 = {
    version: 1,
    operations: [humanOperation],
  };

  return {
    graph: GraphDataSchema.parse(graph),
    human,
    humanDescriptor,
    humanIdentity,
    humanOperation,
    binding,
  };
}
