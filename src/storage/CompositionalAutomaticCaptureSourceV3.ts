import { captureEnvelope } from '../extraction/AutomaticEvidence';
import { EpisodicNodeSchema, type EpisodicNode, type GraphData } from '../schemas';
import { AutomaticBindingReferenceSchema } from '../schemas/AutomaticMemory.schema';
import {
  CompositionalAutomaticDescriptorInputV3Schema,
  CompositionalAutomaticEnvelopeV2Schema,
  compileCompositionalAutomaticDescriptorV3,
  hashCompositionalAutomaticDescriptorV3,
  type CompositionalAutomaticDescriptorV3,
} from '../schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureOwnedSourceV3Schema,
  CompositionalAutomaticCaptureSourceOwnerV3Schema,
  CompositionalAutomaticOperationIdentityV3Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  compositionalCaptureEventTimeHashV3,
  compositionalCaptureOriginalProducerHashV3,
  compositionalCaptureRequestedAuthorityHashV3,
  compositionalCaptureSourceContentHashV3,
  compositionalCaptureSourceHashV3,
  compositionalCaptureStableProducerHashV3,
  type CompositionalAutomaticOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticHumanSourceBuildV3Schema,
  type CompositionalAutomaticHumanSourceBuildV3,
} from '../schemas/CompositionalAutomaticCaptureSourceBuildV3.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import {
  assertAutomaticBindingIdentity,
  automaticWriteOwnerIdempotencyKey,
  findAutomaticBinding,
} from './AutomaticIdentity';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));
    Object.freeze(value);
  }
  return value;
}

function fail(code: string): never {
  throw new Error(`Engram compositional capture: ${code}`);
}

function rejectSourceIdCollision(graph: GraphData, sourceId: string, check: () => void): void {
  for (const record of graph.entities) {
    check();
    if (record.uuid === sourceId) fail('source_id_conflict');
  }
  for (const record of graph.edges) {
    check();
    if (record.uuid === sourceId) fail('source_id_conflict');
  }
  for (const record of graph.episodes) {
    check();
    if (record.uuid === sourceId) fail('source_id_conflict');
  }
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (operation.operationId === sourceId || operation.identity.sourceId === sourceId) {
      fail('source_id_conflict');
    }
  }
}

function findPredecessor(
  graph: GraphData,
  previousEpisodeId: string | null,
  namespace: string,
  check: () => void,
): EpisodicNode | null {
  if (previousEpisodeId === null) return null;
  for (const episode of graph.episodes) {
    check();
    if (episode.uuid === previousEpisodeId) {
      if (episode.group_id !== namespace) fail('invalid_predecessor');
      return episode;
    }
  }
  fail('invalid_predecessor');
}

/**
 * Pure construction only. The backend must revalidate the logical store,
 * source locator, current binding, and actual predecessor under its common
 * writer lock before atomically persisting the source and V3 operation.
 * This function never appends data or creates a processing capability.
 */
export function buildCompositionalHumanCaptureSourceV3(
  graphValue: GraphData,
  inputValue: CompositionalAutomaticHumanSourceBuildV3,
  check: () => void = () => {},
): {
  episode: EpisodicNode;
  descriptor: CompositionalAutomaticDescriptorV3;
  descriptorHash: string;
  identity: CompositionalAutomaticOperationIdentityV3;
} {
  check();
  const input = CompositionalAutomaticHumanSourceBuildV3Schema.parse(
    cloneBoundedAutomaticCaptureJson(inputValue, 'beginRequest'),
  );
  check();
  const graph = parseLosslessAutomaticCaptureGraph(graphValue);
  check();
  const request = input.request;
  if (request.purpose !== 'human_turn_memory') fail('unsupported_purpose');

  rejectSourceIdCollision(graph, input.sourceId, check);
  findPredecessor(graph, input.previousEpisodeId, request.namespace, check);

  const matchingBinding = findAutomaticBinding(
    graph,
    request.namespace,
    request.issuer,
    request.actorReference,
    check,
  );
  if (!matchingBinding || matchingBinding.state !== 'active') fail('authority_changed');
  const binding = AutomaticBindingReferenceSchema.parse({
    bindingId: matchingBinding.bindingId,
    revision: matchingBinding.revision,
    subjectId: matchingBinding.subjectId,
    fingerprint: matchingBinding.fingerprint,
  });
  assertAutomaticBindingIdentity(
    graph,
    request.namespace,
    request.issuer,
    request.actorReference,
    binding,
    check,
  );
  check();

  const descriptor = compileCompositionalAutomaticDescriptorV3(
    CompositionalAutomaticDescriptorInputV3Schema.parse({
      profileId: request.settings.profileId,
      requestedTrustLevel: request.settings.requestedTrustLevel,
      intentSetting: request.settings.intentSetting,
      invocationDeadlineMs: request.settings.invocationDeadlineMs,
    }),
  );
  const descriptorHash = hashCompositionalAutomaticDescriptorV3(descriptor);
  const rawContent = request.source.content;
  const humanRegion = request.source.humanRegion ?? { start: 0, end: rawContent.length };
  const mappedContent = rawContent.slice(humanRegion.start, humanRegion.end);
  const actor = {
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    quoteRegions: request.source.quoteRegions,
    ...(request.source.applicationOwnedWrapper === true
      ? {
          applicationOwnedWrapper: true as const,
          humanRegion,
        }
      : {}),
  };

  // Reuse the reviewed literal evidence helper only for its exact intent cue
  // and mapping validation. Its V1-shaped envelope is transient and discarded.
  check();
  const intentEvidenceProjection = captureEnvelope(
    mappedContent,
    rawContent,
    actor,
    binding,
    descriptor.intentSetting,
  );
  if (!intentEvidenceProjection.ok) fail('invalid_mapping');
  const explicitIntent = intentEvidenceProjection.envelope.explicitIntent;
  check();
  const sourceEnvelope = CompositionalAutomaticEnvelopeV2Schema.parse({
    version: 2,
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    bindingRef: binding,
    contentHash: compositionalCaptureSourceContentHashV3(mappedContent),
    rawContentHash: compositionalCaptureSourceContentHashV3(rawContent),
    mappingAuthority:
      request.source.applicationOwnedWrapper === true ? 'application_region' : 'whole_source',
    humanRegion,
    mappings: [
      {
        contentStart: 0,
        contentEnd: mappedContent.length,
        rawStart: humanRegion.start,
        rawEnd: humanRegion.end,
      },
    ],
    quoteRegions: request.source.quoteRegions,
    explicitIntent,
    policy: descriptor.policy,
  });
  const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse({
    version: 2,
    sourceEnvelope,
    settingsHash: descriptor.settingsHash,
    descriptorHash,
  });
  const canonicalCapturedAt = input.capturedAt;
  const referenceTime =
    request.source.eventTime.mode === 'explicit'
      ? request.source.eventTime.value
      : canonicalCapturedAt;
  const idempotencyKey = automaticWriteOwnerIdempotencyKey({
    turn: request.turn,
    role: 'human',
  });
  const sourceContentHash = compositionalCaptureSourceContentHashV3(rawContent);
  const stableProducerHash = compositionalCaptureStableProducerHashV3({
    source_workflow_id: request.source.sourceWorkflowId,
    source_message_id: request.source.sourceMessageId,
    conversation_id: request.source.conversationId,
    sender_id: request.source.senderId,
    source_type: 'message',
    episode_kind: 'active_human',
    quoted_message_id: request.source.quotedMessageId,
  });
  const eventTimeHash = compositionalCaptureEventTimeHashV3(
    request.source.eventTime.mode,
    referenceTime,
  );
  const owner = CompositionalAutomaticCaptureSourceOwnerV3Schema.parse({
    version: 3,
    lifecycle: request.lifecycle,
    purpose: 'human_turn_memory',
    role: 'human',
    storeHash: input.storeHash,
    namespace: request.namespace,
    turn: request.turn,
    issuer: request.issuer,
    actorReference: request.actorReference,
    binding,
    eventTimeMode: request.source.eventTime.mode,
    eventTimeHash,
    stableProducerHash,
    sourceContentHash,
    settingsHash: descriptor.settingsHash,
    descriptorHash,
    policyFingerprint: descriptor.policy.fingerprint,
    requestedTrustLevel: descriptor.requestedTrustLevel,
    intentSetting: descriptor.intentSetting,
    intentEvidence: explicitIntent,
  });
  const ownedSource = CompositionalAutomaticCaptureOwnedSourceV3Schema.parse({
    owner,
    envelope,
    descriptor,
  });

  const episode = EpisodicNodeSchema.parse({
    uuid: input.sourceId,
    group_id: request.namespace,
    content: rawContent,
    role: 'human',
    episode_kind: 'active_human',
    source_type: 'message',
    reference_time: referenceTime,
    created_at: canonicalCapturedAt,
    updated_at: canonicalCapturedAt,
    previous_episode_uuid: input.previousEpisodeId,
    source_message_id: request.source.sourceMessageId,
    idempotency_key: idempotencyKey,
    conversation_id: request.source.conversationId,
    sender_id: request.source.senderId,
    sender_name: request.source.senderName,
    source_workflow_id: request.source.sourceWorkflowId,
    source_execution_id: request.source.originalSourceExecutionId,
    quoted_message_id: request.source.quotedMessageId,
    trust_level: descriptor.requestedTrustLevel,
    review_status: 'accepted',
    attributes: {
      [COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE]: ownedSource.envelope,
      [COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE]: ownedSource.owner,
    },
  });

  const originalProducerHash = compositionalCaptureOriginalProducerHashV3(
    ownedSource.owner,
    ownedSource.envelope,
    {
      uuid: episode.uuid,
      group_id: episode.group_id,
      content: episode.content,
      role: 'human',
      source_type: 'message',
      episode_kind: 'active_human',
      reference_time: episode.reference_time,
      previous_episode_uuid: episode.previous_episode_uuid,
      source_message_id: episode.source_message_id,
      idempotency_key: episode.idempotency_key,
      conversation_id: episode.conversation_id,
      sender_id: episode.sender_id,
      source_workflow_id: episode.source_workflow_id,
      source_execution_id: episode.source_execution_id,
      quoted_message_id: episode.quoted_message_id,
      created_at: episode.created_at,
    },
  );
  const identityBase = {
    version: 3 as const,
    lifecycle: request.lifecycle,
    storeHash: input.storeHash,
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    turn: request.turn,
    role: 'human' as const,
    purpose: 'human_turn_memory' as const,
    binding,
    sourceId: episode.uuid,
    sourceContentHash,
    sourceHash: compositionalCaptureSourceHashV3(episode),
    originalProducerHash,
    stableProducerHash,
    eventTimeMode: request.source.eventTime.mode,
    eventTimeHash,
    settingsHash: descriptor.settingsHash,
    descriptorHash,
    policyFingerprint: descriptor.policy.fingerprint,
  };
  const requestedAuthorityHash = compositionalCaptureRequestedAuthorityHashV3({
    lifecycle: identityBase.lifecycle,
    storeHash: identityBase.storeHash,
    namespace: identityBase.namespace,
    issuer: identityBase.issuer,
    actorReference: identityBase.actorReference,
    turn: identityBase.turn,
    role: identityBase.role,
    purpose: identityBase.purpose,
    sourceId: identityBase.sourceId,
    sourceContentHash: identityBase.sourceContentHash,
    stableProducerHash: identityBase.stableProducerHash,
    eventTimeMode: identityBase.eventTimeMode,
    eventTimeHash: identityBase.eventTimeHash,
    settingsHash: identityBase.settingsHash,
    descriptorHash: identityBase.descriptorHash,
    policyFingerprint: identityBase.policyFingerprint,
    binding: identityBase.binding,
  });
  const identity = CompositionalAutomaticOperationIdentityV3Schema.parse({
    ...identityBase,
    requestedAuthorityHash,
  });
  check();
  return deepFreeze({ episode, descriptor, descriptorHash, identity });
}
