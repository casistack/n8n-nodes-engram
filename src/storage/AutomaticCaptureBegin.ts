import { withAutomaticCaptureAttemptV2 } from './AutomaticCaptureAudit';
import { validateAutomaticCaptureCandidate } from './AutomaticCaptureCapacity';
import { type GraphData, type EpisodicNode } from '../schemas';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import {
  AutomaticHumanCaptureBeginInputV2Schema,
  type AutomaticHumanCaptureBeginInputV2,
  type AutomaticHumanCaptureBeginPreparationV2,
} from '../schemas/AutomaticCaptureBegin.schema';
import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from '../schemas/AutomaticCaptureOperation.schema';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  canonicalAutomaticCaptureV2 as canonical,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import { COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  AutonomousPersonalSourceOwnerV4OwnedDataSchema,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import { type AutomaticCaptureBeginDecisionV2 } from '../schemas/AutomaticCaptureApi.schema';
import { AUTOMATIC_LEDGER_LIMITS as limits } from '../schemas/AutomaticLedgerPrimitives.schema';
import { captureEnvelope } from '../extraction/AutomaticEvidence';
import {
  buildAutomaticOperationDescriptorV2,
  BuildAutomaticOperationDescriptorV2InputSchema,
} from '../extraction/AutomaticCaptureDescriptor';
import { buildHumanCaptureSourceV2 } from './AutomaticCaptureSource';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import {
  assertAutomaticBinding,
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  reconcileAutomaticCaptureOperationIdentity,
  automaticWriteOwnerIdempotencyKey,
  prepareAutomaticEpisodeInput,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
  SOURCE_ENVELOPE_ATTRIBUTE,
} from './AutomaticIdentity';

const active = (state: string) => ['captured', 'leased', 'failed', 'interrupted'].includes(state);
const decision = (
  value: AutomaticCaptureBeginDecisionV2,
): AutomaticHumanCaptureBeginPreparationV2 => ({ kind: 'decision', decision: value });

function sameRequest(source: EpisodicNode, input: AutomaticHumanCaptureBeginInputV2) {
  const request = input.request;
  const owner = AutomaticWriteOwnerSchema.parse(source.attributes[WRITE_OWNER_ATTRIBUTE]);
  if (
    owner.store !== input.storeHash ||
    owner.namespace !== request.namespace ||
    owner.issuer !== request.issuer ||
    owner.actor !== request.actorReference ||
    owner.turn !== request.turn ||
    owner.role !== 'human'
  )
    return false;
  const expected: Array<[unknown, unknown]> = [
    [source.content, request.source.content],
    [source.source_message_id, request.source.sourceMessageId],
    [source.conversation_id, request.source.conversationId],
    [source.sender_id, request.source.senderId],
    [source.source_workflow_id, request.source.sourceWorkflowId],
    [source.source_execution_id, request.source.originalSourceExecutionId],
    [source.quoted_message_id, request.source.quotedMessageId],
    [source.source_type, request.source.sourceType],
  ];
  if (expected.some(([actual, wanted]) => actual !== wanted)) return false;
  if (
    request.source.eventTime.mode === 'explicit' &&
    new Date(source.reference_time).toISOString() !== request.source.eventTime.value
  )
    return false;
  const built = buildAutomaticOperationDescriptorV2(
    BuildAutomaticOperationDescriptorV2InputSchema.parse({
      purpose: 'human_turn_memory',
      ...request.settings,
    }),
  );
  const descriptor = built.descriptor;
  if (descriptor.purpose !== 'human_turn_memory') return false;
  if (canonical(owner.policy) !== canonical(descriptor.policy)) return false;
  const body = request.source.humanRegion
    ? request.source.content.slice(request.source.humanRegion.start, request.source.humanRegion.end)
    : request.source.content;
  if (!owner.binding) return false;
  const captured = captureEnvelope(
    body,
    request.source.content,
    {
      namespace: request.namespace,
      issuer: request.issuer,
      actorReference: request.actorReference,
      quoteRegions: request.source.quoteRegions,
      ...(request.source.applicationOwnedWrapper
        ? { applicationOwnedWrapper: true as const, humanRegion: request.source.humanRegion! }
        : {}),
    },
    owner.binding,
    descriptor.intentSetting,
    descriptor.policy,
  );
  if (
    !captured.ok ||
    canonical(captured.envelope) !== canonical(source.attributes[SOURCE_ENVELOPE_ATTRIBUTE])
  )
    return false;
  if (source.attributes[WRITE_OWNER_V2_ATTRIBUTE] !== undefined) {
    const v2 = AutomaticCaptureSourceOwnerV2Schema.parse(
      source.attributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    if (
      v2.purpose !== 'human_turn_memory' ||
      v2.settingsHash !== descriptor.settingsHash ||
      v2.eventTimeMode !== request.source.eventTime.mode
    )
      return false;
  }
  return true;
}

function audited(
  graph: GraphData,
  operation: AutomaticCaptureOperationV2,
  input: AutomaticHumanCaptureBeginInputV2,
  status: AutomaticCaptureBeginDecisionV2,
  check: () => void,
): AutomaticHumanCaptureBeginPreparationV2 {
  const next = withAutomaticCaptureAttemptV2(operation, {
    attemptHash: input.request.attemptIdHash,
    at: input.backendNow,
    disposition:
      status.kind === 'resume_available'
        ? 'resume_available'
        : status.kind === 'cancelled_replay'
          ? 'cancelled_replay'
          : status.kind === 'committed_replay'
            ? 'committed_replay'
            : 'in_progress',
  });
  if (!next || next === operation) return decision(status);
  const candidate = validateAutomaticCaptureCandidate(
    {
      ...graph,
      automatic_operations_v1: {
        version: 1,
        operations: graph.automatic_operations_v1!.operations.map((record) =>
          record.operationId === operation.operationId ? next : record,
        ),
      },
    },
    check,
  );
  return candidate
    ? { kind: 'prepared_decision', graph: candidate, decision: status }
    : decision(status);
}

/**
 * Pure admission only: backend time/predecessor are fresh transaction inputs;
 * UUIDs/hash/token are allocated once outside retry callbacks. The backend must
 * persist a prepared candidate before issuing any registry handle or reporting
 * source persistence. No registry, I/O, extraction or processing permit is used.
 */
export function prepareHumanCaptureBeginV2(
  graphValue: GraphData,
  inputValue: AutomaticHumanCaptureBeginInputV2,
  workCheck: () => void = () => {},
): AutomaticHumanCaptureBeginPreparationV2 {
  let checkFailure: { value: unknown } | undefined;
  const check = () => {
    try {
      workCheck();
    } catch (error) {
      checkFailure = { value: error };
      throw error;
    }
  };
  check();
  let graph: GraphData;
  let input: AutomaticHumanCaptureBeginInputV2;
  try {
    graph = parseLosslessAutomaticCaptureGraph(graphValue);
    input = AutomaticHumanCaptureBeginInputV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(inputValue, 'beginRequest'),
    );
    assertAutomaticLedgerSourceIntegrity(graph);
  } catch {
    check();
    return decision({ kind: 'invalid_input' });
  }
  check();
  const request = input.request;
  const key = automaticWriteOwnerIdempotencyKey({ turn: request.turn, role: 'human' });
  const operations = (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
    check();
    return (
      operation.identity.namespace === request.namespace &&
      operation.identity.turn === request.turn &&
      operation.identity.role === 'human'
    );
  });
  const sourceHasV4Locator = (source: EpisodicNode): boolean => {
    if (
      !Object.prototype.hasOwnProperty.call(
        source.attributes,
        AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
      )
    )
      return false;
    const owner = AutonomousPersonalSourceOwnerV4OwnedDataSchema.safeParse(
      source.attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE],
    );
    return (
      owner.success &&
      owner.data.namespace === request.namespace &&
      owner.data.turn === request.turn &&
      owner.data.role === 'human'
    );
  };
  const sources = graph.episodes.filter((source) => {
    check();
    return (
      source.group_id === request.namespace &&
      (source.idempotency_key === key ||
        sourceHasV4Locator(source) ||
        (request.source.sourceMessageId !== null &&
          source.source_message_id === request.source.sourceMessageId &&
          source.episode_kind === 'active_human'))
    );
  });
  if (operations.length > 1 || sources.length > 1) return decision({ kind: 'conflict' });
  const operation = operations[0];
  const source = sources[0];
  if (
    (operation && !source) ||
    (operation && source && operation.identity.sourceId !== source.uuid)
  )
    return decision({ kind: 'conflict' });
  if (source) {
    if (
      operation?.version === 4 ||
      Object.prototype.hasOwnProperty.call(
        source.attributes,
        AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
      ) ||
      Object.prototype.hasOwnProperty.call(
        source.attributes,
        AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
      ) ||
      operation?.version === 3 ||
      Object.prototype.hasOwnProperty.call(
        source.attributes,
        COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
      )
    )
      return decision({ kind: 'unsupported_mode' });
    try {
      prepareAutomaticEpisodeInput(source);
      if (!sameRequest(source, input)) return decision({ kind: 'conflict' });
    } catch {
      return decision({ kind: 'conflict' });
    }
    if (source.attributes[WRITE_OWNER_V2_ATTRIBUTE] === undefined || operation?.version === 1)
      return decision({ kind: 'legacy_unconfirmed' });
    if (!operation) return decision({ kind: 'source_only_unconfirmed' });
    if (operation.version !== 2) return decision({ kind: 'legacy_unconfirmed' });
    const observed = automaticCaptureOperationIdentityForOwnedSource(source, operation.descriptor);
    if (!reconcileAutomaticCaptureOperationIdentity(observed, operation.identity))
      return decision({ kind: 'conflict' });
    if (Date.parse(input.backendNow) < Date.parse(operation.lastObservedAt))
      return decision({ kind: 'clock_regression' });
    try {
      const envelope = AutomaticSourceEnvelopeSchema.parse(
        source.attributes[SOURCE_ENVELOPE_ATTRIBUTE],
      );
      assertAutomaticBinding(graph, envelope, check);
      if (
        active(operation.state) &&
        (source.review_status !== 'accepted' ||
          source.trust_level !== operation.descriptor.requestedTrustLevel)
      )
        return decision({ kind: 'authority_changed' });
    } catch {
      if (checkFailure) throw checkFailure.value;
      return decision({ kind: 'authority_changed' });
    }
    if (
      operation.state === 'leased' &&
      operation.generation === 1 &&
      operation.lease.claimKind === 'initial' &&
      operation.retryCount === 0 &&
      operation.lastRetryCallHash === undefined &&
      operation.beginCallHash === input.beginCallHash &&
      operation.lease.token === input.leaseToken &&
      operation.identity.sourceId === input.sourceId &&
      operation.operationId === input.operationId &&
      Date.parse(input.backendNow) < Date.parse(operation.lease.expiresAt)
    ) {
      return {
        kind: 'prepared_claim',
        graph,
        operation,
        writeRequired: false,
        leaseFence: {
          purpose: 'human_turn_memory',
          operationId: operation.operationId,
          sourceId: source.uuid,
          descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
          identityHash: hashAutomaticCaptureV2(operation.identity),
          beginCallHash: operation.beginCallHash,
          state: 'leased',
          generation: 1,
          token: operation.lease.token,
          claimKind: 'initial',
          retryCount: operation.retryCount,
          ...(operation.lastRetryCallHash
            ? { lastRetryCallHash: operation.lastRetryCallHash }
            : {}),
          planTimestamp: operation.lease.renewedAt,
        },
      };
    }
    const status: AutomaticCaptureBeginDecisionV2 = {
      kind:
        operation.state === 'committed'
          ? 'committed_replay'
          : operation.state === 'cancelled'
            ? 'cancelled_replay'
            : operation.state === 'failed' ||
                operation.state === 'interrupted' ||
                (operation.state === 'leased' &&
                  Date.parse(input.backendNow) >= Date.parse(operation.lease.expiresAt))
              ? 'resume_available'
              : 'in_progress',
    };
    return audited(graph, operation, input, status, check);
  }
  if (
    input.sourceId === input.operationId ||
    graph.automatic_operations_v1?.operations.some(
      (op) => op.operationId === input.operationId || op.operationId === input.sourceId,
    ) ||
    [...graph.entities, ...graph.edges, ...graph.episodes].some(
      (row) => row.uuid === input.sourceId || row.uuid === input.operationId,
    )
  )
    return decision({ kind: 'conflict' });
  let built: ReturnType<typeof buildHumanCaptureSourceV2>;
  try {
    built = buildHumanCaptureSourceV2(
      graph,
      {
        request,
        storeHash: input.storeHash,
        sourceId: input.sourceId,
        previousEpisodeId: input.previousEpisodeId,
        capturedAt: input.backendNow,
      },
      check,
    );
  } catch (error) {
    if (checkFailure) throw checkFailure.value;
    return decision({
      kind:
        error instanceof Error && error.message.includes('authority_changed')
          ? 'authority_changed'
          : 'invalid_input',
    });
  }
  const duration = Math.min(
    limits.maxLeaseMs,
    Math.max(limits.minLeaseMs, request.settings.invocationDeadlineMs + limits.storageGraceMs),
  );
  const expires = Date.parse(input.backendNow) + duration;
  if (!Number.isFinite(expires) || expires > 8.64e15) return decision({ kind: 'clock_regression' });
  const candidateOperation = AutomaticCaptureOperationV2Schema.safeParse({
    version: 2,
    operationId: input.operationId,
    identity: built.identity,
    descriptor: built.descriptor,
    createdAt: input.backendNow,
    lastObservedAt: input.backendNow,
    attempts: [
      { attemptHash: request.attemptIdHash, at: input.backendNow, disposition: 'claim_won' },
    ],
    overflowCount: 0,
    auditTruncated: false,
    beginCallHash: input.beginCallHash,
    retryCount: 0,
    state: 'leased',
    generation: 1,
    lease: {
      token: input.leaseToken,
      acquiredAt: input.backendNow,
      renewedAt: input.backendNow,
      expiresAt: new Date(expires).toISOString(),
      claimKind: 'initial',
    },
  });
  if (!candidateOperation.success || candidateOperation.data.state !== 'leased')
    return decision({ kind: 'invalid_input' });
  const withSource = { ...graph, episodes: [...graph.episodes, built.episode] };
  const admitted = validateAutomaticCaptureCandidate(
    {
      ...withSource,
      automatic_operations_v1: {
        version: 1,
        operations: [...(graph.automatic_operations_v1?.operations ?? []), candidateOperation.data],
      },
    },
    check,
  );
  if (admitted)
    return {
      kind: 'prepared_claim',
      graph: admitted,
      operation: candidateOperation.data,
      writeRequired: true,
      leaseFence: {
        purpose: 'human_turn_memory',
        operationId: input.operationId,
        sourceId: input.sourceId,
        descriptorHash: built.descriptorHash,
        identityHash: hashAutomaticCaptureV2(candidateOperation.data.identity),
        beginCallHash: input.beginCallHash,
        state: 'leased',
        generation: 1,
        token: input.leaseToken,
        claimKind: 'initial',
        retryCount: 0,
        planTimestamp: input.backendNow,
      },
    };
  const sourceOnly = validateAutomaticCaptureCandidate(withSource, check);
  return sourceOnly
    ? { kind: 'prepared_source_only', graph: sourceOnly }
    : decision({ kind: 'capacity', sourcePersistence: 'not_persisted' });
}
