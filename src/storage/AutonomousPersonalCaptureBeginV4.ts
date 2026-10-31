import { createHash } from 'crypto';
import { z } from 'zod';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../schemas/AutonomousPersonalDescriptorV4.schema';
import {
  AutonomousPersonalBeginV4ContextOwnedDataSchema,
  AutonomousPersonalFreshSourceV4OwnedDataSchema,
  AutonomousPersonalFreshSourceV4InputOwnedDataSchema,
  AutonomousPersonalStableRequestV4InputOwnedDataSchema,
  parseAutonomousPersonalBeginV4Input,
  type AutonomousPersonalBeginV4Context,
  type AutonomousPersonalBeginV4Request,
  type AutonomousPersonalFreshSourceV4,
} from '../schemas/AutonomousPersonalBeginV4.schema';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticOperationAttemptDispositionSchema } from '../schemas/AutomaticLedgerPrimitives.schema';
import {
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
  AutonomousPersonalCaptureFenceV4OwnedDataSchema,
} from '../schemas/AutonomousPersonalCaptureAdmissionV4.schema';
import {
  AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema,
  AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema,
  type AutonomousPersonalCaptureSnapshotPreparationV4,
} from '../schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from '../schemas/AutonomousPersonalOperationV4.schema';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  AutonomousPersonalSourceOwnerV4OwnedDataSchema,
  AutonomousPersonalSourceProducerV4OwnedDataSchema,
  compileAutonomousPersonalSourceTupleV4,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  type AutonomousPersonalSourceTupleV4Input,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import { COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { compileAutonomousSourceGeometryV3 } from '../schemas/AutonomousSourceGeometryV3.schema';
import { EpisodicNodeSchema, type EpisodicNode } from '../schemas/EpisodicNode.schema';
import { type GraphData } from '../schemas/GraphData.schema';
import {
  assertAutomaticBindingIdentity,
  assertAutomaticBindingRegistryIntegrity,
  assertAutomaticLedgerSourceIntegrity,
  automaticWriteOwnerIdempotencyKey,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';
import {
  applyAutomaticCaptureAttemptV1,
  compileAutomaticCaptureInitialLeaseFieldsV1,
} from './AutomaticCaptureStateCoreV1';
import { hasAutomaticCaptureCapacity } from './AutomaticCaptureCapacity';
import { projectAutonomousPersonalTerminalReserveV4 } from './AutonomousPersonalTerminalReserveV4';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { getOwnedImmutableGraphData } from './ImmutableGraphSnapshot';
import { getRegisteredAutonomousPersonalClaimIndexGraphV4 } from './AutonomousPersonalRecordIntegrityV4';

const MAX_BEGIN_BYTES = 512 * 1024;
type SnapshotInput = z.infer<
  typeof AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema
>;
type AttemptDisposition = z.infer<typeof AutomaticOperationAttemptDispositionSchema>;
type OperationV4 = AutonomousPersonalOperationV4;
type StoredOperation = NonNullable<GraphData['automatic_operations_v1']>['operations'][number];
export { parseAutonomousPersonalBeginV4Input };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function fixedError(code: string): z.ZodError {
  const path: (string | number)[] = [];
  const issue: z.ZodIssue = { code: z.ZodIssueCode.custom, path, message: code };
  const error = new z.ZodError([issue]);
  Object.freeze(path);
  Object.freeze(issue);
  Object.freeze(error.issues);
  return Object.freeze(error) as z.ZodError;
}

function exactUtf8Sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertScopeMatchesRequest(
  request: AutonomousPersonalBeginV4Request,
  context: AutonomousPersonalBeginV4Context,
): void {
  if (
    request.namespace !== context.namespace ||
    request.issuer !== context.issuer ||
    request.actorReference !== context.actorReference ||
    request.turn !== context.turn
  ) {
    throw new Error('scope_mismatch');
  }
}

function compileDescriptor(request: AutonomousPersonalBeginV4Request) {
  return compileAutonomousPersonalDescriptorV4(request.settings);
}

/**
 * Hash stable event DATA. Processing instance/workflow/execution values are not
 * part of this recipe; the function does not prove that context is native.
 */
export function hashAutonomousPersonalStableRequestV4(input: unknown): string {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const checked = AutonomousPersonalStableRequestV4InputOwnedDataSchema.parse(owned);
    assertScopeMatchesRequest(checked.request, checked.context);
    const descriptor = compileDescriptor(checked.request);
    const descriptorHash = hashAutonomousPersonalDescriptorV4(descriptor);
    const eventTime = checked.request.source.eventTime;
    const source = checked.request.source;

    return hashAutomaticCaptureV2({
      domain: 'engram-autonomous-begin-event-v1',
      event: {
        lifecycle: checked.request.lifecycle,
        purpose: checked.request.purpose,
        interpretationFamily: checked.request.interpretationFamily,
        storeHash: checked.context.storeHash,
        namespace: checked.context.namespace,
        issuer: checked.context.issuer,
        actorReference: checked.context.actorReference,
        turn: checked.context.turn,
        originMode: 'processing_first_capture',
        source: {
          contentHash: exactUtf8Sha256(source.content),
          sourceMessageId: source.sourceMessageId,
          conversationId: source.conversationId,
          senderId: source.senderId,
          sourceWorkflowId: source.sourceWorkflowId,
          sourceType: 'message',
          episodeKind: 'active_human',
          quotedMessageId: source.quotedMessageId,
          eventTime:
            eventTime.mode === 'explicit'
              ? { mode: 'explicit', value: eventTime.value }
              : { mode: 'first_capture' },
          mapping: source.mapping,
          quoteRegions: source.quoteRegions,
        },
        descriptorHash,
        binding: {
          bindingId: checked.context.binding.bindingId,
          revision: checked.context.binding.revision,
          subjectId: checked.context.binding.subjectId,
          fingerprint: checked.context.binding.fingerprint,
        },
      },
    });
  } catch {
    throw fixedError('invalid_autonomous_begin_v4_hash_data');
  }
}

/** Hash the current processing-attempt DATA; this is not native provenance proof. */
export function hashAutonomousPersonalAttemptV4(input: unknown): string {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const context = AutonomousPersonalBeginV4ContextOwnedDataSchema.parse(owned);
    return hashAutomaticCaptureV2({
      domain: 'engram-native-human-processing-v4',
      instance: context.instance,
      workflow: context.workflow,
      execution: context.execution,
      namespace: context.namespace,
      issuer: context.issuer,
      actorReference: context.actorReference,
      turn: context.turn,
    });
  } catch {
    throw fixedError('invalid_autonomous_begin_v4_hash_data');
  }
}

function assertFreshSourceResultSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BEGIN_BYTES) {
    throw new Error('source_result_limit');
  }
}

/**
 * Compile a fresh Source4 producer projection and tuple from owned DATA. The
 * output is only a candidate; context and generated fields are not authority.
 */
export function compileAutonomousPersonalFreshSourceV4(
  input: unknown,
): AutonomousPersonalFreshSourceV4 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    const checked = AutonomousPersonalFreshSourceV4InputOwnedDataSchema.parse(owned);
    assertScopeMatchesRequest(checked.request, checked.context);
    const descriptor = compileDescriptor(checked.request);
    const source = checked.request.source;
    const producer: AutonomousPersonalSourceTupleV4Input['producer'] =
      AutonomousPersonalSourceProducerV4OwnedDataSchema.parse({
        uuid: checked.sourceId,
        group_id: checked.context.namespace,
        content: source.content,
        role: 'human',
        source_type: 'message',
        episode_kind: 'active_human',
        reference_time:
          source.eventTime.mode === 'explicit' ? source.eventTime.value : checked.createdAt,
        previous_episode_uuid: checked.previousEpisodeUuid,
        source_message_id: source.sourceMessageId,
        idempotency_key: automaticWriteOwnerIdempotencyKey({
          turn: checked.context.turn,
          role: 'human',
        }),
        conversation_id: source.conversationId,
        sender_id: source.senderId,
        source_workflow_id: source.sourceWorkflowId,
        source_execution_id: checked.context.execution,
        quoted_message_id: source.quotedMessageId,
        created_at: checked.createdAt,
      });
    const tuple = compileAutonomousPersonalSourceTupleV4({
      scope: {
        storeHash: checked.context.storeHash,
        namespace: checked.context.namespace,
        issuer: checked.context.issuer,
        actorReference: checked.context.actorReference,
        turn: checked.context.turn,
        binding: checked.context.binding,
      },
      descriptor,
      producer,
      eventTimeMode: source.eventTime.mode,
      mapping: source.mapping,
      quoteRegions: source.quoteRegions,
    });
    const candidate = { version: 4 as const, descriptor, producer, tuple };
    assertFreshSourceResultSize(candidate);
    return deepFreeze(AutonomousPersonalFreshSourceV4OwnedDataSchema.parse(candidate));
  } catch {
    throw fixedError('invalid_autonomous_begin_v4_source_data');
  }
}

function stickyWorkCheck(checkWork: () => void): () => void {
  let failed = false;
  let failure: unknown;
  return () => {
    if (failed) throw failure;
    try {
      checkWork();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
}

function sameData(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value: unknown, key: string): unknown {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  return value[key];
}

function outputData(
  value: unknown,
  check: () => void = () => undefined,
): AutonomousPersonalCaptureSnapshotPreparationV4 {
  check();
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  const serialized = JSON.stringify(owned);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BEGIN_BYTES) {
    throw new Error('output_limit');
  }
  const parsed = deepFreeze(
    AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema.parse(owned),
  );
  check();
  return parsed;
}

function noWrite(
  kind: Exclude<
    z.infer<typeof AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema>['kind'],
    'claimed' | 'committed_observed' | 'cancelled_observed' | 'failed' | 'interrupted'
  >,
  check?: () => void,
): AutonomousPersonalCaptureSnapshotPreparationV4 {
  return outputData(
    {
      kind: 'no_write',
      resultProjection: {
        kind,
        eligibleFirstCommit: false,
      },
    },
    check,
  );
}

function noWriteWithFailure(
  kind: 'failed' | 'interrupted',
  failureCode: string,
  check?: () => void,
): AutonomousPersonalCaptureSnapshotPreparationV4 {
  return outputData(
    {
      kind: 'no_write',
      resultProjection: { kind, failureCode, eligibleFirstCommit: false },
    },
    check,
  );
}

function isBoundedResourceFailure(error: unknown): boolean {
  return (
    error instanceof BoundedAutomaticCaptureJsonError &&
    (error.reason === 'bytes' || error.reason === 'nodes' || error.reason === 'depth')
  );
}

function matchesOwnerTurn(ownerValue: unknown, namespace: string, turn: string): boolean {
  if (isRecord(ownerValue)) {
    return (
      ownerValue.namespace === namespace && ownerValue.turn === turn && ownerValue.role === 'human'
    );
  }
  return false;
}

function sourceCandidates(
  graph: GraphData,
  request: AutonomousPersonalBeginV4Request,
  check: () => void,
): EpisodicNode[] {
  const wantedKey = automaticWriteOwnerIdempotencyKey({ turn: request.turn, role: 'human' });
  const matches: EpisodicNode[] = [];
  for (const episode of graph.episodes) {
    check();
    if (episode.group_id !== request.namespace) continue;
    const attributes = episode.attributes;
    const isCurrentOwner =
      matchesOwnerTurn(
        own(attributes, AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE),
        request.namespace,
        request.turn,
      ) ||
      matchesOwnerTurn(
        own(attributes, COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE),
        request.namespace,
        request.turn,
      ) ||
      matchesOwnerTurn(
        own(attributes, WRITE_OWNER_V2_ATTRIBUTE),
        request.namespace,
        request.turn,
      ) ||
      matchesOwnerTurn(own(attributes, WRITE_OWNER_ATTRIBUTE), request.namespace, request.turn);
    const hasStableKey = episode.idempotency_key === wantedKey;
    const hasMessageId =
      episode.role === 'human' &&
      request.source.sourceMessageId !== null &&
      episode.source_message_id === request.source.sourceMessageId;
    if (isCurrentOwner || hasStableKey || hasMessageId) matches.push(episode);
  }
  return matches;
}

function operationCandidates(
  graph: GraphData,
  request: AutonomousPersonalBeginV4Request,
  sourceIds: ReadonlySet<string>,
  check: () => void,
): StoredOperation[] {
  const result: StoredOperation[] = [];
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (
      sourceIds.has(operation.identity.sourceId) ||
      (operation.identity.namespace === request.namespace &&
        operation.identity.turn === request.turn &&
        operation.identity.role === 'human')
    ) {
      result.push(operation);
    }
  }
  return result;
}

function hasV4Pair(episode: EpisodicNode): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      episode.attributes,
      AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
    ) &&
    Object.prototype.hasOwnProperty.call(
      episode.attributes,
      AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
    )
  );
}

function geometryForRequest(request: AutonomousPersonalBeginV4Request) {
  return compileAutonomousSourceGeometryV3({
    rawContent: request.source.content,
    mapping: request.source.mapping,
    quoteRegions: request.source.quoteRegions,
  });
}

function assertRequestScope(
  request: AutonomousPersonalBeginV4Request,
  context: AutonomousPersonalBeginV4Context,
): void {
  assertScopeMatchesRequest(request, context);
}

function assertCurrentBinding(
  graph: GraphData,
  request: AutonomousPersonalBeginV4Request,
  context: AutonomousPersonalBeginV4Context,
  episode: EpisodicNode,
  descriptor: ReturnType<typeof compileAutonomousPersonalDescriptorV4>,
  check: () => void,
): void {
  const owner = AutonomousPersonalSourceOwnerV4OwnedDataSchema.parse(
    own(episode.attributes, AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE),
  );
  if (
    owner.storeHash !== context.storeHash ||
    owner.namespace !== request.namespace ||
    owner.issuer !== request.issuer ||
    owner.actorReference !== request.actorReference ||
    owner.turn !== request.turn ||
    owner.descriptorHash !== hashAutonomousPersonalDescriptorV4(descriptor) ||
    owner.settingsHash !== descriptor.settingsHash ||
    owner.policyFingerprint !== descriptor.policy.fingerprint ||
    owner.requestedTrustLevel !== descriptor.requestedTrustLevel ||
    !sameData(owner.binding, context.binding)
  ) {
    throw new Error('authority_changed');
  }
  let subject: ReturnType<typeof assertAutomaticBindingIdentity>;
  try {
    subject = assertAutomaticBindingIdentity(
      graph,
      request.namespace,
      request.issuer,
      request.actorReference,
      context.binding,
      check,
    );
  } catch {
    check();
    throw new Error('authority_changed');
  }
  if (
    episode.review_status !== 'accepted' ||
    episode.trust_level !== descriptor.requestedTrustLevel ||
    subject.uuid !== context.binding.subjectId
  ) {
    throw new Error('authority_changed');
  }
}

function assertStoredSourceMatchesRequest(
  episode: EpisodicNode,
  descriptor: ReturnType<typeof compileAutonomousPersonalDescriptorV4>,
  request: AutonomousPersonalBeginV4Request,
  context: AutonomousPersonalBeginV4Context,
  expectedGeometry: ReturnType<typeof compileAutonomousSourceGeometryV3>,
): ReturnType<typeof reconstructAutonomousPersonalStoredSourceIdentityV4> {
  const reconstructed = reconstructAutonomousPersonalStoredSourceIdentityV4({
    source: episode,
    descriptor,
  });
  const producer = reconstructed.source;
  const owner = reconstructed.tuple.owner;
  const requestedReferenceTime =
    request.source.eventTime.mode === 'explicit'
      ? request.source.eventTime.value
      : episode.created_at;
  if (
    episode.group_id !== request.namespace ||
    producer.role !== 'human' ||
    producer.source_type !== 'message' ||
    producer.episode_kind !== 'active_human' ||
    producer.content !== request.source.content ||
    producer.source_message_id !== request.source.sourceMessageId ||
    producer.conversation_id !== request.source.conversationId ||
    producer.sender_id !== request.source.senderId ||
    producer.source_workflow_id !== request.source.sourceWorkflowId ||
    producer.quoted_message_id !== request.source.quotedMessageId ||
    producer.idempotency_key !==
      automaticWriteOwnerIdempotencyKey({ turn: request.turn, role: 'human' }) ||
    producer.reference_time !== requestedReferenceTime ||
    owner.eventTimeMode !== request.source.eventTime.mode ||
    owner.storeHash !== context.storeHash ||
    owner.namespace !== request.namespace ||
    owner.issuer !== request.issuer ||
    owner.actorReference !== request.actorReference ||
    owner.turn !== request.turn ||
    !sameData(owner.binding, context.binding) ||
    !sameData(reconstructed.tuple.envelope.geometry, expectedGeometry.geometry)
  ) {
    throw new Error('stored_source_mismatch');
  }
  return reconstructed;
}

function makeFence(
  operation: Extract<OperationV4, { state: 'leased' }>,
  episode: EpisodicNode,
): z.infer<typeof AutonomousPersonalCaptureFenceV4OwnedDataSchema> {
  const envelope = own(episode.attributes, AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE);
  return AutonomousPersonalCaptureFenceV4OwnedDataSchema.parse({
    version: 4,
    purpose: 'human_turn_memory',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    descriptorHash: operation.identity.descriptorHash,
    identityHash: hashAutomaticCaptureV2(operation.identity),
    sourceHash: operation.identity.sourceHash,
    envelopeHash: hashAutomaticCaptureV2(envelope),
    beginCallHash: operation.beginCallHash,
    state: 'leased',
    generation: 1,
    token: operation.lease.token,
    claimKind: 'initial',
    retryCount: 0,
    planTimestamp: operation.lease.renewedAt,
  });
}

function sameScopeMatches(
  input: SnapshotInput,
  episode: EpisodicNode,
  operation: Extract<OperationV4, { state: 'leased' }>,
  expectedDescriptor: ReturnType<typeof compileAutonomousPersonalDescriptorV4>,
): boolean {
  if (operation.state !== 'leased') return false;
  const firstAttempt = operation.attempts[0];
  return (
    operation.state === 'leased' &&
    operation.generation === 1 &&
    operation.retryCount === 0 &&
    operation.lastRetryCallHash === undefined &&
    operation.lease.claimKind === 'initial' &&
    operation.operationId === input.operationId &&
    operation.identity.sourceId === input.sourceId &&
    operation.lease.token === input.leaseToken &&
    operation.beginCallHash === input.stableBeginHash &&
    firstAttempt?.attemptHash === input.attemptHash &&
    firstAttempt.disposition === 'claim_won' &&
    firstAttempt.at === operation.createdAt &&
    operation.createdAt === episode.created_at &&
    operation.lease.acquiredAt === operation.createdAt &&
    operation.lease.renewedAt === operation.createdAt &&
    episode.source_execution_id === input.context.execution &&
    episode.reference_time ===
      (input.request.source.eventTime.mode === 'explicit'
        ? input.request.source.eventTime.value
        : episode.created_at) &&
    !operation.attempts.slice(1).some((attempt) => attempt.disposition === 'claim_won') &&
    sameData(operation.descriptor, expectedDescriptor)
  );
}

function buildFreshEpisode(
  fresh: AutonomousPersonalFreshSourceV4,
  operation: OperationV4,
): EpisodicNode {
  const producer = fresh.producer;
  const proposed = {
    uuid: producer.uuid,
    group_id: producer.group_id,
    content: producer.content,
    role: producer.role,
    source_type: producer.source_type,
    reference_time: producer.reference_time,
    previous_episode_uuid: producer.previous_episode_uuid,
    created_at: producer.created_at,
    updated_at: null,
    source_message_id: producer.source_message_id,
    idempotency_key: producer.idempotency_key,
    conversation_id: producer.conversation_id,
    sender_id: producer.sender_id,
    sender_name: null,
    episode_kind: producer.episode_kind,
    quoted_message_id: producer.quoted_message_id,
    trust_level: fresh.descriptor.requestedTrustLevel,
    confidence: null,
    review_status: 'accepted' as const,
    source_workflow_id: producer.source_workflow_id,
    source_execution_id: producer.source_execution_id,
    attributes: {
      [AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE]: fresh.tuple.owner,
      [AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE]: fresh.tuple.envelope,
    },
  };
  const episode = EpisodicNodeSchema.parse(proposed);
  if (!sameData(episode, proposed) || operation.identity.sourceId !== episode.uuid) {
    throw new Error('episode_normalized');
  }
  return episode;
}

function isCurrentOperationV4(operation: StoredOperation): operation is OperationV4 {
  return operation.version === 4;
}

function resultForOperation(
  input: SnapshotInput,
  operation: OperationV4,
  check: () => void,
): AutonomousPersonalCaptureSnapshotPreparationV4 {
  if (Date.parse(input.backendNow) < Date.parse(operation.lastObservedAt)) {
    return noWrite('clock_regression', check);
  }

  if (operation.state === 'failed')
    return noWriteWithFailure('failed', operation.failureCode, check);
  if (operation.state === 'interrupted')
    return noWriteWithFailure('interrupted', operation.failureCode, check);
  if (operation.state === 'captured') return noWrite('conflict', check);

  const observation: AttemptDisposition =
    operation.state === 'committed'
      ? 'committed_replay'
      : operation.state === 'cancelled'
        ? 'cancelled_replay'
        : Date.parse(input.backendNow) < Date.parse(operation.lease.expiresAt)
          ? 'in_progress'
          : 'resume_available';
  const applied = applyAutomaticCaptureAttemptV1({
    familyVersion: 4,
    operation,
    observation: {
      attemptHash: input.attemptHash,
      at: input.backendNow,
      disposition: observation,
    },
  });
  check();
  const projection =
    operation.state === 'committed'
      ? {
          kind: 'committed_observed' as const,
          terminalReceipt: operation.terminalReceipt,
          eligibleFirstCommit: false as const,
        }
      : operation.state === 'cancelled'
        ? {
            kind: 'cancelled_observed' as const,
            terminalReceipt: operation.terminalReceipt,
            eligibleFirstCommit: false as const,
          }
        : {
            kind: observation as 'in_progress' | 'resume_available',
            eligibleFirstCommit: false as const,
          };
  if (applied.kind === 'updated') {
    return outputData(
      { kind: 'audit_candidate', operation: applied.operation, resultProjection: projection },
      check,
    );
  }
  return outputData({ kind: 'no_write', resultProjection: projection }, check);
}

/**
 * Pure, bounded preparation over untrusted request and graph DATA. Candidate
 * rows are consistency projections only; this helper has no storage or authority capability.
 */
export function prepareAutonomousPersonalCaptureSnapshotV4(
  input: unknown,
  rawGraph: unknown,
  checkWork: () => void,
): AutonomousPersonalCaptureSnapshotPreparationV4 {
  const check = stickyWorkCheck(checkWork);
  const stop = (
    kind: Exclude<
      z.infer<typeof AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema>['kind'],
      'claimed' | 'committed_observed' | 'cancelled_observed' | 'failed' | 'interrupted'
    >,
  ) => noWrite(kind, check);
  check();
  let inputOwned: unknown;
  let requestInput: SnapshotInput;
  try {
    inputOwned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'beginRequest');
    check();
    requestInput =
      AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema.parse(inputOwned);
    assertRequestScope(requestInput.request, requestInput.context);
  } catch {
    check();
    return stop('invalid_input');
  }

  let stableHash: string;
  let actualAttemptHash: string;
  let descriptor: ReturnType<typeof compileAutonomousPersonalDescriptorV4>;
  let geometry: ReturnType<typeof compileAutonomousSourceGeometryV3>;
  try {
    check();
    stableHash = hashAutonomousPersonalStableRequestV4({
      request: requestInput.request,
      context: requestInput.context,
    });
    check();
    actualAttemptHash = hashAutonomousPersonalAttemptV4(requestInput.context);
    check();
    if (
      stableHash !== requestInput.stableBeginHash ||
      actualAttemptHash !== requestInput.attemptHash
    ) {
      return stop('conflict');
    }
    descriptor = compileDescriptor(requestInput.request);
    geometry = geometryForRequest(requestInput.request);
    check();
  } catch {
    check();
    return stop('invalid_input');
  }

  // A known claim index supplies its frozen graph; its guard errors are not mapped below.
  const registered = getRegisteredAutonomousPersonalClaimIndexGraphV4(rawGraph);
  let graph: GraphData;
  try {
    check();
    graph =
      registered ??
      getOwnedImmutableGraphData(rawGraph) ??
      parseLosslessAutomaticCaptureGraph(rawGraph);
    check();
    assertAutomaticBindingRegistryIntegrity(graph, check);
    assertAutomaticLedgerSourceIntegrity(graph);
    check();
  } catch (error) {
    check();
    return stop(isBoundedResourceFailure(error) ? 'resource_exhausted' : 'conflict');
  }

  const sources = sourceCandidates(graph, requestInput.request, check);
  const sourceIds = new Set(sources.map((source) => source.uuid));
  check();
  const operations = operationCandidates(graph, requestInput.request, sourceIds, check);
  if (sources.length > 1 || operations.length > 1) return stop('conflict');
  const source = sources[0];
  const operationCandidate = operations[0];

  if ((source && !hasV4Pair(source)) || (operationCandidate && operationCandidate.version !== 4)) {
    return stop('conflict');
  }
  if (operationCandidate && !source) return stop('conflict');

  if (source) {
    if (!operationCandidate) {
      try {
        check();
        assertCurrentBinding(
          graph,
          requestInput.request,
          requestInput.context,
          source,
          descriptor,
          check,
        );
        const reconstructed = assertStoredSourceMatchesRequest(
          source,
          descriptor,
          requestInput.request,
          requestInput.context,
          geometry,
        );
        if (
          reconstructed.tuple.owner.sourceId !== source.uuid ||
          reconstructed.tuple.owner.eventTimeMode !== requestInput.request.source.eventTime.mode ||
          !sameData(reconstructed.tuple.envelope.geometry, geometry.geometry)
        ) {
          return stop('conflict');
        }
        return stop('source_only_unconfirmed');
      } catch (error) {
        check();
        return stop(
          error instanceof Error && error.message.includes('authority')
            ? 'authority_changed'
            : 'conflict',
        );
      }
    }

    if (!isCurrentOperationV4(operationCandidate)) return stop('conflict');
    const operation = operationCandidate;
    const firstAttempt = operation.attempts[0];
    if (
      operation.identity.sourceId !== source.uuid ||
      firstAttempt?.disposition !== 'claim_won' ||
      firstAttempt.at !== operation.createdAt ||
      operation.attempts.slice(1).some((attempt) => attempt.disposition === 'claim_won')
    ) {
      return stop('conflict');
    }
    try {
      check();
      assertCurrentBinding(
        graph,
        requestInput.request,
        requestInput.context,
        source,
        descriptor,
        check,
      );
      if (!sameData(operation.descriptor, descriptor)) return stop('authority_changed');
      if (source.created_at !== operation.createdAt) {
        throw new Error('stored_source_operation_time_mismatch');
      }
      assertStoredSourceMatchesRequest(
        source,
        operation.descriptor,
        requestInput.request,
        requestInput.context,
        geometry,
      );
      if (operation.beginCallHash !== stableHash) {
        throw new Error('stored_operation_mismatch');
      }
      check();
    } catch (error) {
      check();
      return stop(
        error instanceof Error && error.message.includes('authority')
          ? 'authority_changed'
          : 'conflict',
      );
    }

    if (
      source.uuid === requestInput.sourceId &&
      operation.operationId === requestInput.operationId
    ) {
      if (Date.parse(requestInput.backendNow) < Date.parse(operation.lastObservedAt)) {
        return stop('clock_regression');
      }
      if (operation.state === 'leased') {
        if (operation.lease.token !== requestInput.leaseToken) return stop('conflict');
        if (sameScopeMatches(requestInput, source, operation, descriptor)) {
          try {
            if (!projectAutonomousPersonalTerminalReserveV4(operation).withinLimit) {
              return stop('capacity');
            }
            check();
            if (Date.parse(requestInput.backendNow) >= Date.parse(operation.lease.expiresAt)) {
              return stop('resume_available');
            }
            const fence = makeFence(operation, source);
            return outputData(
              {
                kind: 'same_initial_scope_candidate',
                episode: source,
                operation,
                fence,
              },
              check,
            );
          } catch (error) {
            check();
            return stop(isBoundedResourceFailure(error) ? 'capacity' : 'conflict');
          }
        }
        return stop('conflict');
      }
      const initialAttempt = operation.attempts[0];
      if (
        initialAttempt?.disposition !== 'claim_won' ||
        initialAttempt.attemptHash !== requestInput.attemptHash ||
        initialAttempt.at !== operation.createdAt
      ) {
        return stop('conflict');
      }
      return resultForOperation(requestInput, operation, check);
    }

    if (
      source.uuid === requestInput.sourceId ||
      operation.operationId === requestInput.operationId ||
      (operation.state === 'leased' && operation.lease.token === requestInput.leaseToken)
    ) {
      return stop('conflict');
    }
    try {
      return resultForOperation(requestInput, operation, check);
    } catch (error) {
      check();
      return stop(isBoundedResourceFailure(error) ? 'resource_exhausted' : 'conflict');
    }
  }

  if (operationCandidate) return stop('conflict');

  const requestedIds = new Set([requestInput.sourceId, requestInput.operationId]);
  let globalIdExists = requestInput.sourceId === requestInput.operationId;
  for (const record of graph.entities) {
    check();
    if (requestedIds.has(record.uuid)) globalIdExists = true;
  }
  for (const record of graph.edges) {
    check();
    if (requestedIds.has(record.uuid)) globalIdExists = true;
  }
  for (const record of graph.episodes) {
    check();
    if (requestedIds.has(record.uuid)) globalIdExists = true;
  }
  for (const existingOperation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (
      requestedIds.has(existingOperation.operationId) ||
      requestedIds.has(existingOperation.identity.sourceId)
    ) {
      globalIdExists = true;
    }
  }
  if (globalIdExists) return stop('conflict');

  const namespaceEpisodes: EpisodicNode[] = [];
  let previousEpisodeExists = false;
  for (const episode of graph.episodes) {
    check();
    if (episode.group_id === requestInput.request.namespace) {
      namespaceEpisodes.push(episode);
      if (episode.uuid === requestInput.previousEpisodeId) previousEpisodeExists = true;
    }
  }
  if (
    (requestInput.previousEpisodeId === null && namespaceEpisodes.length !== 0) ||
    (requestInput.previousEpisodeId !== null &&
      (!previousEpisodeExists || requestInput.previousEpisodeId === requestInput.sourceId))
  ) {
    return stop('conflict');
  }

  try {
    check();
    assertAutomaticBindingIdentity(
      graph,
      requestInput.request.namespace,
      requestInput.request.issuer,
      requestInput.request.actorReference,
      requestInput.context.binding,
      check,
    );
  } catch {
    check();
    return stop('authority_changed');
  }

  let fresh: AutonomousPersonalFreshSourceV4;
  let operation: OperationV4;
  let episode: EpisodicNode;
  let fence: z.infer<typeof AutonomousPersonalCaptureFenceV4OwnedDataSchema>;
  try {
    check();
    fresh = compileAutonomousPersonalFreshSourceV4({
      request: requestInput.request,
      context: requestInput.context,
      sourceId: requestInput.sourceId,
      previousEpisodeUuid: requestInput.previousEpisodeId,
      createdAt: requestInput.backendNow,
    });
    check();
    const leaseFields = compileAutomaticCaptureInitialLeaseFieldsV1({
      createdAt: requestInput.backendNow,
      invocationDeadlineMs: descriptor.invocationDeadlineMs,
      beginCallHash: stableHash,
      leaseToken: requestInput.leaseToken,
      initialAttemptHash: actualAttemptHash,
    });
    operation = AutonomousPersonalOperationV4OwnedDataSchema.parse({
      version: 4,
      operationId: requestInput.operationId,
      identity: fresh.tuple.identity,
      descriptor: fresh.descriptor,
      ...leaseFields,
    });
    if (operation.state !== 'leased') throw new Error('operation_not_leased');
    if (!projectAutonomousPersonalTerminalReserveV4(operation).withinLimit) {
      return stop('capacity');
    }
    check();
    check();
    episode = buildFreshEpisode(fresh, operation);
    fence = makeFence(operation, episode);
    check();
  } catch (error) {
    check();
    return stop(isBoundedResourceFailure(error) ? 'resource_exhausted' : 'invalid_input');
  }

  const candidate: GraphData = {
    ...graph,
    episodes: [...graph.episodes, episode],
    automatic_operations_v1: {
      version: 1,
      operations: [...(graph.automatic_operations_v1?.operations ?? []), operation],
    },
  };
  try {
    check();
    const candidateRecordCount =
      candidate.entities.length + candidate.edges.length + candidate.episodes.length;
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    check();
    if (candidateRecordCount > 100_000 || candidateBytes > 100 * 1024 * 1024) {
      return stop('capacity');
    }
    const losslessCandidate = parseLosslessAutomaticCaptureGraph(candidate);
    assertAutomaticLedgerSourceIntegrity(losslessCandidate);
    check();
    if (!hasAutomaticCaptureCapacity(losslessCandidate, check)) return stop('capacity');
    return outputData({ kind: 'initial_candidate', episode, operation, fence }, check);
  } catch (error) {
    check();
    return stop(isBoundedResourceFailure(error) ? 'capacity' : 'conflict');
  }
}
