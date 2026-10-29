import { createHash } from 'crypto';
import { captureEnvelope } from '../extraction/AutomaticEvidence';
import {
  buildAutomaticOperationDescriptorV2,
  BuildAutomaticOperationDescriptorV2InputSchema,
} from '../extraction/AutomaticCaptureDescriptor';
import { EpisodicNodeSchema, type GraphData } from '../schemas';
import {
  AutomaticHumanSourceBuildV2Schema,
  type AutomaticHumanSourceBuildV2,
} from '../schemas/AutomaticCaptureSourceBuild.schema';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import {
  findAutomaticBinding,
  assertAutomaticBinding,
  automaticWriteOwnerIdempotencyKey,
  automaticCaptureOperationIdentityForOwnedSource,
  prepareAutomaticEpisodeInput,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';

/**
 * Pure construction only. The backend must derive these inputs and atomically
 * validate ownership, append sequencing, capacity and current authority itself.
 * This function neither appends a source nor mints processing permission.
 */
export function buildHumanCaptureSourceV2(
  graph: GraphData,
  input: AutomaticHumanSourceBuildV2,
  check: () => void = () => {},
) {
  check();
  const parsed = AutomaticHumanSourceBuildV2Schema.parse(input);
  const request = parsed.request;
  if (request.purpose !== 'human_turn_memory') throw new Error('Engram capture: invalid_input');
  if (
    [...graph.entities, ...graph.edges, ...graph.episodes].some((record) => {
      check();
      return record.uuid === parsed.sourceId;
    })
  )
    throw new Error('Engram capture: source_id_conflict');
  if (
    parsed.previousEpisodeId !== null &&
    !graph.episodes.some(
      (episode) =>
        episode.uuid === parsed.previousEpisodeId && episode.group_id === request.namespace,
    )
  )
    throw new Error('Engram capture: invalid_predecessor');
  const built = buildAutomaticOperationDescriptorV2(
    BuildAutomaticOperationDescriptorV2InputSchema.parse({
      purpose: 'human_turn_memory',
      ...request.settings,
    }),
  );
  const descriptor = built.descriptor;
  if (descriptor.purpose !== 'human_turn_memory')
    throw new Error('Engram capture: invalid_descriptor');
  const binding = findAutomaticBinding(
    graph,
    request.namespace,
    request.issuer,
    request.actorReference,
    check,
  );
  if (!binding) throw new Error('Engram capture: authority_changed');
  const bindingRef = {
    bindingId: binding.bindingId,
    revision: binding.revision,
    subjectId: binding.subjectId,
    fingerprint: binding.fingerprint,
  };
  const source = request.source;
  const content = source.humanRegion
    ? source.content.slice(source.humanRegion.start, source.humanRegion.end)
    : source.content;
  const captured = captureEnvelope(
    content,
    source.content,
    {
      namespace: request.namespace,
      issuer: request.issuer,
      actorReference: request.actorReference,
      quoteRegions: source.quoteRegions,
      ...(source.applicationOwnedWrapper
        ? { applicationOwnedWrapper: true as const, humanRegion: source.humanRegion! }
        : {}),
    },
    bindingRef,
    descriptor.intentSetting,
    descriptor.policy,
  );
  if (!captured.ok) throw new Error('Engram capture: invalid_mapping');
  assertAutomaticBinding(graph, captured.envelope, check);
  const contentHash = createHash('sha256').update(source.content, 'utf8').digest('hex');
  const owner = AutomaticWriteOwnerSchema.parse({
    version: 1,
    store: parsed.storeHash,
    namespace: request.namespace,
    turn: request.turn,
    role: 'human',
    actor: request.actorReference,
    issuer: request.issuer,
    binding: bindingRef,
    policy: descriptor.policy,
    contentHash,
  });
  const referenceTime =
    source.eventTime.mode === 'explicit' ? source.eventTime.value : parsed.capturedAt;
  const episode = EpisodicNodeSchema.parse({
    uuid: parsed.sourceId,
    group_id: request.namespace,
    content: source.content,
    role: 'human',
    episode_kind: 'active_human',
    source_type: 'message',
    reference_time: referenceTime,
    created_at: parsed.capturedAt,
    updated_at: parsed.capturedAt,
    previous_episode_uuid: parsed.previousEpisodeId,
    source_message_id: source.sourceMessageId,
    conversation_id: source.conversationId,
    sender_id: source.senderId,
    sender_name: source.senderName,
    source_workflow_id: source.sourceWorkflowId,
    source_execution_id: source.originalSourceExecutionId,
    quoted_message_id: source.quotedMessageId,
    trust_level: descriptor.requestedTrustLevel,
    review_status: 'accepted',
    idempotency_key: automaticWriteOwnerIdempotencyKey(owner),
    attributes: { [SOURCE_ENVELOPE_ATTRIBUTE]: captured.envelope, [WRITE_OWNER_ATTRIBUTE]: owner },
  });
  episode.attributes[WRITE_OWNER_V2_ATTRIBUTE] = AutomaticCaptureSourceOwnerV2Schema.parse({
    version: 2,
    lifecycle: 'replaySafeV2',
    storeHash: parsed.storeHash,
    namespace: request.namespace,
    turn: request.turn,
    role: 'human',
    issuer: request.issuer,
    actorReference: request.actorReference,
    binding: bindingRef,
    assistantWriteAuthority: null,
    purpose: 'human_turn_memory',
    requestedTrustLevel: descriptor.requestedTrustLevel,
    intentSetting: descriptor.intentSetting,
    intentEvidence: captured.envelope.explicitIntent,
    settingsHash: descriptor.settingsHash,
    policy: descriptor.policy,
    sourceContentHash: contentHash,
    eventTimeMode: source.eventTime.mode,
    eventTimeHash: hashAutomaticCaptureV2({
      mode: source.eventTime.mode,
      normalizedReferenceTime: new Date(referenceTime).toISOString(),
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
  });
  const validated = prepareAutomaticEpisodeInput(episode);
  const identity = automaticCaptureOperationIdentityForOwnedSource(validated, descriptor);
  check();
  return { episode: validated, descriptor, descriptorHash: built.descriptorHash, identity };
}
