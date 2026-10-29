import { captureEnvelope } from '../extraction/AutomaticEvidence';
import { assertCompositionalRecordIdentityV3 } from './CompositionalRecordIdentityV3';
import {
  AutomaticOperationAttemptDispositionSchema,
  AUTOMATIC_LEDGER_LIMITS,
} from '../schemas/AutomaticLedgerPrimitives.schema';
import { z } from 'zod';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  AutonomousPersonalSourceOwnerV4OwnedDataSchema,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import { type GraphData } from '../schemas/GraphData.schema';
import { type EpisodicNode } from '../schemas/EpisodicNode.schema';
import {
  CompositionalAutomaticCaptureBeginContextV3Schema,
  CompositionalAutomaticCaptureBeginPreparationV3Schema,
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  type CompositionalAutomaticCaptureBeginContextV3,
  type CompositionalAutomaticCaptureBeginPreparationV3,
} from '../schemas/CompositionalAutomaticCaptureBeginV3.schema';
import {
  CompositionalCaptureLeaseFenceV3Schema,
  CompositionalCaptureNonPermitDecisionV3Schema,
  CompositionalCaptureNonPermitResultV3Schema,
} from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureSourceOwnerV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  compositionalCaptureEventTimeHashV3,
  compositionalCaptureOperationIdentityHashV3,
  compositionalCaptureSourceContentHashV3,
  compositionalCaptureStableProducerHashV3,
  reconcileCompositionalCaptureOperationIdentityV3,
  type CompositionalAutomaticOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticEnvelopeV2Schema,
  hashCompositionalAutomaticDescriptorV3,
} from '../schemas/CompositionalAutomaticMemory.schema';
import { buildCompositionalAutomaticDescriptorForRequestV3 } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalCaptureInitialBeginScopeSnapshotV3Schema,
  type CompositionalCaptureInitialBeginScopeSnapshotV3,
  type CompositionalCaptureAttemptAuditV3,
  type PrivateCompositionalCaptureBeginScopeV3,
  type PrivateCompositionalCaptureAuditCapV3,
} from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import { StoredAutomaticOperation } from '../schemas/AutomaticLedger.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';
import {
  applyAutomaticCaptureAttemptV1,
  compileAutomaticCaptureInitialLeaseFieldsV1,
} from './AutomaticCaptureStateCoreV1';
import {
  hasAutomaticCaptureCapacity,
  validateAutomaticCaptureCandidate,
} from './AutomaticCaptureCapacity';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { buildCompositionalHumanCaptureSourceV3 } from './CompositionalAutomaticCaptureSourceV3';
import {
  reconstructCompositionalAutomaticSourceIdentityV3,
  validateCompositionalAutomaticSourceTupleV3,
} from './CompositionalAutomaticCaptureSourceTupleV3';
import {
  assertAutomaticBindingIdentity,
  assertAutomaticBindingRegistryIntegrity,
  assertAutomaticLedgerSourceIntegrity,
  automaticWriteOwnerIdempotencyKey,
  findAutomaticBinding,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';
import type { CompositionalAutomaticCaptureHandleRegistryV3 } from './CompositionalAutomaticCaptureHandlesV3';

type Request = ReturnType<typeof CompositionalAutomaticCaptureBeginRequestV3Schema.parse>;
type Operation = ReturnType<typeof CompositionalAutomaticCaptureOperationV3Schema.parse>;
type StoredOperation = StoredAutomaticOperation;
type LeasedOperation = Extract<Operation, { state: 'leased' }>;
type SourceTuple = ReturnType<typeof validateCompositionalAutomaticSourceTupleV3>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function preparation(value: unknown): CompositionalAutomaticCaptureBeginPreparationV3 {
  return deepFreeze(CompositionalAutomaticCaptureBeginPreparationV3Schema.parse(value));
}

function checkedPreparation(
  value: unknown,
  check: () => void,
): CompositionalAutomaticCaptureBeginPreparationV3 {
  const result = preparation(value);
  check();
  return result;
}

function decision(kind: string): CompositionalAutomaticCaptureBeginPreparationV3 {
  return preparation({
    kind: 'decision',
    decision: CompositionalCaptureNonPermitDecisionV3Schema.parse({
      kind,
      eligibleFirstCommit: false,
    }),
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function decisionResult(result: unknown): CompositionalAutomaticCaptureBeginPreparationV3 {
  return preparation({
    kind: 'decision',
    decision: CompositionalCaptureNonPermitResultV3Schema.parse(result),
  });
}

function constructionFailureDecision(
  error: unknown,
): 'authority_changed' | 'conflict' | 'invalid_input' {
  if (!(error instanceof Error)) return 'invalid_input';
  const message = error.message;
  if (
    message.endsWith(': authority_changed') ||
    message.endsWith(': missing_binding') ||
    message.endsWith(': binding_changed') ||
    message.endsWith(': binding_revoked') ||
    message.endsWith(': subject_not_found') ||
    message.endsWith(': subject_not_accepted')
  ) {
    return 'authority_changed';
  }
  if (message.endsWith(': invalid_predecessor') || message.endsWith(': source_id_conflict')) {
    return 'conflict';
  }
  return 'invalid_input';
}

function getSourceEnvelope(tuple: SourceTuple) {
  return CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(tuple.envelope).sourceEnvelope;
}

function requestMatchesSource(
  request: Request,
  context: CompositionalAutomaticCaptureBeginContextV3,
  source: EpisodicNode,
  tuple: SourceTuple,
  identity: CompositionalAutomaticOperationIdentityV3,
  descriptor: ReturnType<typeof buildCompositionalAutomaticDescriptorForRequestV3>['descriptor'],
  check: () => void,
): boolean {
  check();
  const owner = CompositionalAutomaticCaptureSourceOwnerV3Schema.parse(tuple.owner);
  const storedEnvelope = getSourceEnvelope(tuple);
  const descriptorHash = hashCompositionalAutomaticDescriptorV3(descriptor);
  const requestedRegion = request.source.humanRegion ?? {
    start: 0,
    end: request.source.content.length,
  };
  const mappedContent = request.source.content.slice(requestedRegion.start, requestedRegion.end);
  const applicationOwnedWrapper = request.source.applicationOwnedWrapper === true;
  const actor = {
    namespace: request.namespace,
    issuer: request.issuer,
    actorReference: request.actorReference,
    quoteRegions: request.source.quoteRegions,
    ...(applicationOwnedWrapper
      ? { applicationOwnedWrapper: true as const, humanRegion: requestedRegion }
      : {}),
  };
  const intent = captureEnvelope(
    mappedContent,
    request.source.content,
    actor,
    owner.binding,
    descriptor.intentSetting,
  );
  if (!intent.ok) return false;

  const expectedEnvelope = CompositionalAutomaticEnvelopeV2Schema.safeParse({
    ...intent.envelope,
    version: 2,
    mappingAuthority: applicationOwnedWrapper ? 'application_region' : 'whole_source',
    humanRegion: requestedRegion,
    mappings: [
      {
        contentStart: 0,
        contentEnd: mappedContent.length,
        rawStart: requestedRegion.start,
        rawEnd: requestedRegion.end,
      },
    ],
    quoteRegions: request.source.quoteRegions,
    policy: descriptor.policy,
    contentHash: compositionalCaptureSourceContentHashV3(mappedContent),
    rawContentHash: compositionalCaptureSourceContentHashV3(request.source.content),
  });
  if (!expectedEnvelope.success || !same(expectedEnvelope.data, storedEnvelope)) return false;

  const expectedEventTime =
    request.source.eventTime.mode === 'explicit'
      ? new Date(Date.parse(request.source.eventTime.value)).toISOString()
      : source.reference_time;
  const expectedStableProducerHash = compositionalCaptureStableProducerHashV3({
    source_workflow_id: request.source.sourceWorkflowId,
    source_message_id: request.source.sourceMessageId,
    conversation_id: request.source.conversationId,
    sender_id: request.source.senderId,
    source_type: request.source.sourceType,
    episode_kind: 'active_human',
    quoted_message_id: request.source.quotedMessageId,
  });
  const expectedEventTimeHash = compositionalCaptureEventTimeHashV3(
    request.source.eventTime.mode,
    expectedEventTime,
  );

  check();
  return (
    source.uuid === identity.sourceId &&
    source.group_id === request.namespace &&
    source.content === request.source.content &&
    source.role === 'human' &&
    source.episode_kind === 'active_human' &&
    source.source_type === request.source.sourceType &&
    source.source_message_id === request.source.sourceMessageId &&
    source.conversation_id === request.source.conversationId &&
    source.sender_id === request.source.senderId &&
    source.source_workflow_id === request.source.sourceWorkflowId &&
    source.source_execution_id === request.source.originalSourceExecutionId &&
    source.quoted_message_id === request.source.quotedMessageId &&
    source.idempotency_key ===
      automaticWriteOwnerIdempotencyKey({
        turn: request.turn,
        role: 'human',
      }) &&
    identity.version === 3 &&
    identity.lifecycle === request.lifecycle &&
    identity.storeHash === context.storeHash &&
    identity.namespace === request.namespace &&
    identity.issuer === request.issuer &&
    identity.actorReference === request.actorReference &&
    identity.turn === request.turn &&
    identity.role === 'human' &&
    identity.purpose === 'human_turn_memory' &&
    identity.sourceId === source.uuid &&
    identity.sourceContentHash ===
      compositionalCaptureSourceContentHashV3(request.source.content) &&
    identity.stableProducerHash === expectedStableProducerHash &&
    identity.eventTimeMode === request.source.eventTime.mode &&
    identity.eventTimeHash === expectedEventTimeHash &&
    identity.settingsHash === descriptor.settingsHash &&
    identity.descriptorHash === descriptorHash &&
    identity.policyFingerprint === descriptor.policy.fingerprint &&
    owner.lifecycle === request.lifecycle &&
    owner.purpose === 'human_turn_memory' &&
    owner.role === 'human' &&
    owner.storeHash === context.storeHash &&
    owner.namespace === request.namespace &&
    owner.issuer === request.issuer &&
    owner.actorReference === request.actorReference &&
    owner.turn === request.turn &&
    owner.descriptorHash === descriptorHash &&
    owner.settingsHash === descriptor.settingsHash &&
    owner.policyFingerprint === descriptor.policy.fingerprint &&
    owner.requestedTrustLevel === descriptor.requestedTrustLevel &&
    owner.intentSetting === descriptor.intentSetting &&
    owner.eventTimeMode === request.source.eventTime.mode &&
    owner.eventTimeHash === expectedEventTimeHash &&
    owner.stableProducerHash === expectedStableProducerHash &&
    owner.sourceContentHash === compositionalCaptureSourceContentHashV3(request.source.content)
  );
}

function currentAuthority(
  graph: GraphData,
  source: EpisodicNode,
  tuple: SourceTuple,
  expectedTrust: string,
  check: () => void,
): 'active' | 'changed' | 'revoked' | 'unknown' {
  try {
    check();
    const owner = tuple.owner;
    const record = findAutomaticBinding(
      graph,
      owner.namespace,
      owner.issuer,
      owner.actorReference,
      check,
    );
    if (!record) return 'unknown';
    if (record.state === 'revoked') return 'revoked';
    assertAutomaticBindingIdentity(
      graph,
      owner.namespace,
      owner.issuer,
      owner.actorReference,
      owner.binding,
      check,
    );
    if (source.review_status !== 'accepted' || source.trust_level !== expectedTrust)
      return 'changed';
    return 'active';
  } catch {
    check();
    return 'changed';
  }
}

function sourceCandidates(graph: GraphData, request: Request, check: () => void): EpisodicNode[] {
  const idempotencyKey = automaticWriteOwnerIdempotencyKey({ turn: request.turn, role: 'human' });
  const found: EpisodicNode[] = [];
  for (const source of graph.episodes) {
    check();
    if (source.group_id !== request.namespace) continue;
    const attributes = source.attributes;
    let ownedLocatorMatches = false;
    if (Object.prototype.hasOwnProperty.call(attributes, AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE)) {
      const owner = AutonomousPersonalSourceOwnerV4OwnedDataSchema.parse(
        attributes[AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE],
      );
      ownedLocatorMatches =
        owner.namespace === request.namespace &&
        owner.turn === request.turn &&
        owner.role === 'human';
      check();
    } else if (
      Object.prototype.hasOwnProperty.call(attributes, COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE)
    ) {
      const owner = CompositionalAutomaticCaptureSourceOwnerV3Schema.parse(
        attributes[COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE],
      );
      ownedLocatorMatches =
        owner.namespace === request.namespace &&
        owner.turn === request.turn &&
        owner.role === 'human';
      check();
    } else if (Object.prototype.hasOwnProperty.call(attributes, WRITE_OWNER_V2_ATTRIBUTE)) {
      const owner = AutomaticCaptureSourceOwnerV2Schema.parse(attributes[WRITE_OWNER_V2_ATTRIBUTE]);
      ownedLocatorMatches =
        owner.namespace === request.namespace &&
        owner.turn === request.turn &&
        owner.role === 'human';
      check();
    } else if (Object.prototype.hasOwnProperty.call(attributes, WRITE_OWNER_ATTRIBUTE)) {
      const owner = AutomaticWriteOwnerSchema.parse(attributes[WRITE_OWNER_ATTRIBUTE]);
      ownedLocatorMatches =
        owner.namespace === request.namespace &&
        owner.turn === request.turn &&
        owner.role === 'human';
      check();
    }
    if (
      ownedLocatorMatches ||
      source.idempotency_key === idempotencyKey ||
      (request.source.sourceMessageId !== null &&
        source.source_message_id === request.source.sourceMessageId &&
        source.role === 'human')
    ) {
      found.push(source);
    }
  }
  return found;
}

function operationCandidates(
  graph: GraphData,
  request: Request,
  check: () => void,
): StoredOperation[] {
  const found: StoredOperation[] = [];
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (
      operation.identity.namespace === request.namespace &&
      operation.identity.turn === request.turn &&
      operation.identity.role === 'human'
    ) {
      found.push(operation);
    }
  }
  return found;
}

function generatedIdCollides(
  graph: GraphData,
  scope: CompositionalCaptureInitialBeginScopeSnapshotV3,
  existing: { source: EpisodicNode; operation: StoredOperation } | undefined,
  check: () => void,
): boolean {
  const generated = [scope.sourceId, scope.operationId];
  if (scope.sourceId === scope.operationId) return true;
  for (const row of [...graph.entities, ...graph.edges]) {
    check();
    if (generated.includes(row.uuid)) return true;
  }
  for (const row of graph.episodes) {
    check();
    if (generated.includes(row.uuid) && row !== existing?.source) return true;
  }
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (operation === existing?.operation) continue;
    if (
      generated.includes(operation.operationId) ||
      generated.includes(operation.identity.sourceId)
    ) {
      return true;
    }
  }
  return false;
}

function existingLocatorIdsAreUnique(
  graph: GraphData,
  source: EpisodicNode,
  operation: StoredOperation | undefined,
  check: () => void,
): boolean {
  const sourceId = source.uuid;
  const operationId = operation?.operationId;
  if (operationId !== undefined && operationId === sourceId) return false;
  let sourceRows = 0;
  let sourceReferences = 0;
  let operationRows = 0;
  for (const row of [...graph.entities, ...graph.edges, ...graph.episodes]) {
    check();
    if (row.uuid === sourceId) {
      sourceRows += 1;
      if (row !== source) return false;
    }
    if (operationId !== undefined && row.uuid === operationId) return false;
  }
  for (const candidate of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (candidate.identity.sourceId === sourceId) {
      sourceReferences += 1;
      if (candidate !== operation) return false;
    }
    if (operationId !== undefined && candidate.operationId === operationId) {
      operationRows += 1;
      if (candidate !== operation) return false;
    }
    if (
      operationId !== undefined &&
      (candidate.identity.sourceId === operationId || candidate.operationId === sourceId)
    ) {
      return false;
    }
  }
  return (
    sourceRows === 1 &&
    sourceReferences === (operation === undefined ? 0 : 1) &&
    operationRows === (operation === undefined ? 0 : 1)
  );
}

function makeFence(operation: LeasedOperation, tuple: SourceTuple) {
  return CompositionalCaptureLeaseFenceV3Schema.parse({
    version: 3,
    purpose: 'human_turn_memory',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    descriptorHash: operation.identity.descriptorHash,
    identityHash: compositionalCaptureOperationIdentityHashV3(operation.identity),
    sourceHash: operation.identity.sourceHash,
    envelopeHash: hashAutomaticCaptureV2(tuple.envelope),
    beginCallHash: operation.beginCallHash,
    state: 'leased',
    generation: operation.generation,
    token: operation.lease.token,
    claimKind: operation.lease.claimKind,
    retryCount: operation.retryCount,
    ...(operation.lastRetryCallHash === undefined
      ? {}
      : { lastRetryCallHash: operation.lastRetryCallHash }),
    planTimestamp: operation.lease.renewedAt,
  });
}

function terminalResult(
  operation: Operation,
  authority: 'active' | 'changed' | 'revoked' | 'unknown',
): ReturnType<typeof CompositionalCaptureNonPermitResultV3Schema.parse> {
  if (operation.state === 'committed') {
    const receipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(
      operation.terminalReceipt,
    );
    return CompositionalCaptureNonPermitResultV3Schema.parse({
      kind: 'committed',
      invocation: 'committed_replay',
      terminalReceipt: receipt,
      currentAuthority: authority,
      eligibleFirstCommit: false,
    });
  }
  if (operation.state === 'cancelled') {
    const receipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema.parse(
      operation.terminalReceipt,
    );
    return CompositionalCaptureNonPermitResultV3Schema.parse({
      kind: 'cancelled',
      terminalReceipt: receipt,
      eligibleFirstCommit: false,
    });
  }
  throw new Error('Engram compositional capture: invalid_terminal_state');
}

function sameInitialScopeLease(
  operation: Operation,
  source: EpisodicNode,
  scope: CompositionalCaptureInitialBeginScopeSnapshotV3,
  audit: CompositionalCaptureAttemptAuditV3,
  descriptorHash: string,
): operation is LeasedOperation {
  if (operation.state !== 'leased') return false;
  const leaseDurationMs = Math.min(
    AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
    Math.max(
      AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
      operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
    ),
  );
  return (
    operation.operationId === scope.operationId &&
    operation.identity.sourceId === scope.sourceId &&
    operation.identity.descriptorHash === descriptorHash &&
    operation.beginCallHash === scope.beginCallHash &&
    operation.lease.token === scope.leaseToken &&
    operation.lease.claimKind === 'initial' &&
    operation.generation === 1 &&
    operation.retryCount === 0 &&
    operation.lastRetryCallHash === undefined &&
    operation.overflowCount === 0 &&
    operation.auditTruncated === false &&
    operation.attempts.length === 1 &&
    operation.lease.acquiredAt === operation.createdAt &&
    operation.lease.renewedAt === operation.createdAt &&
    operation.lease.expiresAt ===
      new Date(Date.parse(operation.createdAt) + leaseDurationMs).toISOString() &&
    operation.lastObservedAt === operation.createdAt &&
    source.uuid === scope.sourceId &&
    source.created_at === operation.createdAt &&
    operation.attempts.some(
      (attempt) =>
        attempt.attemptHash === audit.attemptIdHash &&
        attempt.disposition === 'claim_won' &&
        attempt.at === operation.createdAt,
    )
  );
}

/**
 * Bounded pure attempt update. The cap authenticates the attempt hash; it does
 * not authorize selecting the operation. The caller must already have resolved
 * and validated the exact operation/source/request locator.
 */
export function withCompositionalCaptureAttemptV3(
  operation: Operation,
  auditCap: PrivateCompositionalCaptureAuditCapV3<'initial'>,
  backendNow: string,
  disposition: z.infer<typeof AutomaticOperationAttemptDispositionSchema>,
  registry: Pick<CompositionalAutomaticCaptureHandleRegistryV3, 'readAttemptAudit'>,
  check: () => void,
): Operation | null {
  check();
  const audit = registry.readAttemptAudit(auditCap);
  if (audit.action !== 'initial') return null;
  const attemptAt = Date.parse(backendNow);
  const lastObservedAt = Date.parse(operation.lastObservedAt);
  if (!Number.isFinite(attemptAt) || attemptAt < lastObservedAt) return null;
  const isTerminal = operation.state === 'committed' || operation.state === 'cancelled';
  if (isTerminal) {
    const receipt = operation.terminalReceipt;
    if (
      attemptAt < Date.parse(receipt.terminalAt) ||
      (operation.state === 'committed' && disposition !== 'committed_replay') ||
      (operation.state === 'cancelled' && disposition !== 'cancelled_replay')
    )
      return null;
  } else if (disposition !== 'in_progress' && disposition !== 'resume_available') {
    return null;
  }
  check();
  if (
    operation.attempts.some((attempt) => attempt.attemptHash === audit.attemptIdHash) ||
    operation.auditTruncated
  )
    return operation;

  let update: ReturnType<typeof applyAutomaticCaptureAttemptV1> | undefined;
  let dataInvalid = false;
  try {
    update = applyAutomaticCaptureAttemptV1({
      familyVersion: 3,
      operation,
      observation: {
        attemptHash: audit.attemptIdHash,
        at: backendNow,
        disposition,
      },
    });
  } catch (error) {
    const fixedAttemptDataError =
      error instanceof z.ZodError &&
      error.issues.length === 1 &&
      error.issues[0]?.code === z.ZodIssueCode.custom &&
      error.issues[0]?.path.length === 0 &&
      error.issues[0]?.message === 'invalid_autonomous_capture_attempt_data';
    if (!fixedAttemptDataError) throw error;
    dataInvalid = true;
  }
  check();
  if (dataInvalid) return null;
  if (update?.kind === 'same') return operation;
  if (update?.kind === 'updated' && update.familyVersion === 3) return update.operation;
  return null;
}

function attemptDispositionFor(
  operation: Operation,
  backendNow: string,
): 'in_progress' | 'resume_available' {
  if (operation.state !== 'leased') return 'resume_available';
  return Date.parse(backendNow) < Date.parse(operation.lease.expiresAt)
    ? 'in_progress'
    : 'resume_available';
}

function checkedScope(
  beginScope: PrivateCompositionalCaptureBeginScopeV3,
  registry: Pick<
    CompositionalAutomaticCaptureHandleRegistryV3,
    'readInitialBeginScope' | 'readAttemptAudit'
  >,
): {
  scope: CompositionalCaptureInitialBeginScopeSnapshotV3;
  audit: CompositionalCaptureAttemptAuditV3;
} {
  const scope = CompositionalCaptureInitialBeginScopeSnapshotV3Schema.parse(
    registry.readInitialBeginScope(beginScope),
  );
  const audit = registry.readAttemptAudit(scope.audit);
  if (
    audit.action !== 'initial' ||
    audit.operationId !== scope.operationId ||
    audit.sourceId !== scope.sourceId
  ) {
    throw new Error('Engram compositional capture: invalid_handle');
  }
  return { scope, audit };
}

function sourceOwnerVersion(source: EpisodicNode): 'v4' | 'v3' | 'legacy' | 'invalid' {
  const attributes = source.attributes;
  const hasV4 = Object.prototype.hasOwnProperty.call(
    attributes,
    AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  );
  const hasEnvelopeV3 = Object.prototype.hasOwnProperty.call(
    attributes,
    AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  );
  if (hasV4 && hasEnvelopeV3) return 'v4';
  if (hasV4 || hasEnvelopeV3) return 'invalid';
  const hasV3 = Object.prototype.hasOwnProperty.call(
    attributes,
    COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE,
  );
  const hasEnvelopeV2 = Object.prototype.hasOwnProperty.call(
    attributes,
    COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  );
  if (hasV3 && hasEnvelopeV2) return 'v3';
  if (hasV3 || hasEnvelopeV2) return 'invalid';
  return 'legacy';
}

/**
 * Pure V3 admission preparation. The backend must call this under its writer
 * lock with its actual graph, logical-store hash, backend clock, and append tail.
 * A prepared result is candidate data only; the registry issues a handle only
 * after durable acknowledgment of the exact source and operation.
 */
export function prepareCompositionalHumanCaptureBeginV3(
  graphValue: unknown,
  requestValue: unknown,
  contextValue: unknown,
  beginScope: PrivateCompositionalCaptureBeginScopeV3,
  registry: Pick<
    CompositionalAutomaticCaptureHandleRegistryV3,
    'readInitialBeginScope' | 'readAttemptAudit'
  >,
  workCheck: () => void,
): CompositionalAutomaticCaptureBeginPreparationV3 {
  let checkFailure: unknown;
  let failedCheck = false;
  let scopeSnapshot: CompositionalCaptureInitialBeginScopeSnapshotV3 | undefined;
  let audit: CompositionalCaptureAttemptAuditV3 | undefined;
  const check = () => {
    if (failedCheck) throw checkFailure;
    try {
      workCheck();
      const checked = checkedScope(beginScope, registry);
      if (scopeSnapshot) {
        if (
          checked.scope.scope !== scopeSnapshot.scope ||
          checked.scope.audit !== scopeSnapshot.audit ||
          checked.scope.sourceId !== scopeSnapshot.sourceId ||
          checked.scope.operationId !== scopeSnapshot.operationId ||
          checked.scope.leaseToken !== scopeSnapshot.leaseToken ||
          checked.scope.beginCallHash !== scopeSnapshot.beginCallHash ||
          checked.scope.descriptorHash !== scopeSnapshot.descriptorHash ||
          checked.scope.invocationDeadlineMs !== scopeSnapshot.invocationDeadlineMs ||
          checked.audit.attemptIdHash !== audit?.attemptIdHash
        ) {
          throw new Error('Engram compositional capture: invalid_handle');
        }
      } else {
        scopeSnapshot = checked.scope;
        audit = checked.audit;
      }
    } catch (error) {
      if (!failedCheck) {
        failedCheck = true;
        checkFailure = error;
      }
      throw checkFailure;
    }
  };
  const rethrowCheckFailure = () => {
    if (failedCheck) throw checkFailure;
    check();
  };

  check();
  let request: Request;
  let context: CompositionalAutomaticCaptureBeginContextV3;
  let descriptor: ReturnType<
    typeof buildCompositionalAutomaticDescriptorForRequestV3
  >['descriptor'];
  let descriptorHash: string;
  try {
    request = CompositionalAutomaticCaptureBeginRequestV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(requestValue, 'beginRequest'),
    );
    context = CompositionalAutomaticCaptureBeginContextV3Schema.parse(
      cloneBoundedAutomaticCaptureJson(contextValue, 'beginRequest'),
    );
    const built = buildCompositionalAutomaticDescriptorForRequestV3(request);
    descriptor = built.descriptor;
    descriptorHash = built.descriptorHash;
  } catch {
    rethrowCheckFailure();
    return decision('invalid_input');
  }
  check();
  const scope = scopeSnapshot!;
  const currentAudit = audit!;
  if (
    request.purpose !== 'human_turn_memory' ||
    request.lifecycle !== 'replaySafeV2' ||
    request.attemptIdHash !== currentAudit.attemptIdHash ||
    descriptorHash !== scope.descriptorHash ||
    descriptor.invocationDeadlineMs !== scope.invocationDeadlineMs
  ) {
    return decision('invalid_input');
  }

  let graph: GraphData;
  try {
    graph = parseLosslessAutomaticCaptureGraph(graphValue);
    assertCompositionalRecordIdentityV3(graph, check);
    assertAutomaticLedgerSourceIntegrity(graph);
    assertAutomaticBindingRegistryIntegrity(graph, check);
  } catch {
    rethrowCheckFailure();
    return decision('invalid_input');
  }
  check();

  const operations = operationCandidates(graph, request, check);
  const sources = sourceCandidates(graph, request, check);
  if (operations.length > 1 || sources.length > 1) return decision('conflict');
  const existingOperation = operations[0];
  const source = sources[0];
  if (existingOperation && existingOperation.version !== 3) return decision('unsupported_mode');
  if (existingOperation && !source) return decision('conflict');
  if (existingOperation && source && existingOperation.identity.sourceId !== source.uuid)
    return decision('conflict');
  if (source && !existingLocatorIdsAreUnique(graph, source, existingOperation, check)) {
    return decision('conflict');
  }

  if (source) {
    const sourceVersion = sourceOwnerVersion(source);
    if (sourceVersion === 'v4') return decision('unsupported_mode');
    if (sourceVersion !== 'v3') {
      return decision(sourceVersion === 'legacy' ? 'unsupported_mode' : 'conflict');
    }
    let tuple: SourceTuple;
    let reconstruction: ReturnType<typeof reconstructCompositionalAutomaticSourceIdentityV3>;
    try {
      tuple = validateCompositionalAutomaticSourceTupleV3(source, check);
      reconstruction = reconstructCompositionalAutomaticSourceIdentityV3(
        source,
        existingOperation?.version === 3 ? existingOperation.descriptor : descriptor,
        check,
      );
    } catch {
      rethrowCheckFailure();
      return decision('conflict');
    }
    check();
    if (
      !requestMatchesSource(
        request,
        context,
        source,
        tuple,
        reconstruction.identity,
        descriptor,
        check,
      )
    ) {
      return decision('conflict');
    }
    if (!existingOperation) {
      return decision('source_only_unconfirmed');
    }
    if (existingOperation.version !== 3) return decision('unsupported_mode');
    const operation = CompositionalAutomaticCaptureOperationV3Schema.parse(existingOperation);
    const reconciled = reconcileCompositionalCaptureOperationIdentityV3(
      reconstruction.identity,
      operation.identity,
    );
    if (
      !reconciled ||
      !same(reconciled, operation.identity) ||
      !same(operation.descriptor, descriptor) ||
      operation.identity.storeHash !== context.storeHash ||
      operation.descriptor.purpose !== 'human_turn_memory'
    ) {
      return decision('conflict');
    }

    const authority = currentAuthority(
      graph,
      source,
      tuple,
      operation.descriptor.requestedTrustLevel,
      check,
    );
    if (
      operation.state !== 'committed' &&
      operation.state !== 'cancelled' &&
      authority !== 'active'
    ) {
      return decision('authority_changed');
    }

    if (operation.state === 'committed' || operation.state === 'cancelled') {
      const result = terminalResult(operation, authority);
      const terminalAt = Date.parse(operation.terminalReceipt.terminalAt);
      const now = Date.parse(context.backendNow);
      if (
        authority !== 'active' ||
        now < Date.parse(operation.lastObservedAt) ||
        now < terminalAt
      ) {
        return decisionResult(result);
      }
      const updated = withCompositionalCaptureAttemptV3(
        operation,
        currentAuditCap(scope),
        context.backendNow,
        operation.state === 'committed' ? 'committed_replay' : 'cancelled_replay',
        registry,
        check,
      );
      if (!updated || updated === operation) return decisionResult(result);
      const candidate = replaceOperation(graph, operation, updated, check);
      if (!candidate) return decisionResult(result);
      return checkedPreparation(
        {
          kind: 'prepared_decision',
          graph: candidate,
          decision: result,
        },
        check,
      );
    }

    if (Date.parse(context.backendNow) < Date.parse(operation.lastObservedAt)) {
      return decision('clock_regression');
    }
    if (generatedIdCollides(graph, scope, { source, operation: existingOperation }, check)) {
      return decision('conflict');
    }
    if (sameInitialScopeLease(operation, source, scope, currentAudit, descriptorHash)) {
      if (Date.parse(context.backendNow) >= Date.parse(operation.lease.expiresAt)) {
        return decision('fenced');
      }
      let fence;
      try {
        fence = makeFence(operation, tuple);
      } catch {
        rethrowCheckFailure();
        return decision('conflict');
      }
      return checkedPreparation(
        {
          kind: 'prepared_claim',
          graph,
          leaseFence: fence,
          writeRequired: false,
        },
        check,
      );
    }

    const disposition = attemptDispositionFor(operation, context.backendNow);
    const updated = withCompositionalCaptureAttemptV3(
      operation,
      currentAuditCap(scope),
      context.backendNow,
      disposition,
      registry,
      check,
    );
    if (!updated || updated === operation) return decision(disposition);
    const candidate = replaceOperation(graph, operation, updated, check);
    if (!candidate) return decision(disposition);
    return checkedPreparation(
      {
        kind: 'prepared_decision',
        graph: candidate,
        decision: CompositionalCaptureNonPermitDecisionV3Schema.parse({
          kind: disposition,
          eligibleFirstCommit: false,
        }),
      },
      check,
    );
  }

  if (existingOperation) return decision('conflict');
  if (generatedIdCollides(graph, scope, undefined, check)) return decision('conflict');
  const existingOperations = graph.automatic_operations_v1?.operations ?? [];
  if (
    graph.entities.length + graph.edges.length + graph.episodes.length + 1 > 100_000 ||
    existingOperations.length + 1 > AUTOMATIC_LEDGER_LIMITS.operationsPerStore
  ) {
    return decision('capacity');
  }

  let built: ReturnType<typeof buildCompositionalHumanCaptureSourceV3>;
  try {
    built = buildCompositionalHumanCaptureSourceV3(
      graph,
      {
        request,
        sourceId: scope.sourceId,
        storeHash: context.storeHash,
        capturedAt: context.backendNow,
        previousEpisodeId: context.previousEpisodeId,
      },
      check,
    );
  } catch (error) {
    rethrowCheckFailure();
    return decision(constructionFailureDecision(error));
  }
  check();
  if (built.descriptorHash !== scope.descriptorHash || !same(built.descriptor, descriptor)) {
    return decision('conflict');
  }
  if (currentAudit.operationId !== scope.operationId || currentAudit.sourceId !== scope.sourceId) {
    throw new Error('Engram compositional capture: invalid_handle');
  }

  const initialLeaseFields = compileAutomaticCaptureInitialLeaseFieldsV1({
    createdAt: context.backendNow,
    invocationDeadlineMs: descriptor.invocationDeadlineMs,
    beginCallHash: scope.beginCallHash,
    leaseToken: scope.leaseToken,
    initialAttemptHash: currentAudit.attemptIdHash,
  });
  const operation = CompositionalAutomaticCaptureOperationV3Schema.parse({
    version: 3,
    operationId: scope.operationId,
    identity: built.identity,
    descriptor: built.descriptor,
    ...initialLeaseFields,
  });
  if (operation.state !== 'leased') throw new Error('Engram compositional capture: invalid_state');

  let candidate: GraphData;
  try {
    candidate = parseLosslessAutomaticCaptureGraph({
      ...graph,
      episodes: [...graph.episodes, built.episode],
      automatic_operations_v1: {
        version: 1,
        operations: [...(graph.automatic_operations_v1?.operations ?? []), operation],
      },
    });
    assertAutomaticLedgerSourceIntegrity(candidate);
  } catch (error) {
    rethrowCheckFailure();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
      return decision('capacity');
    return decision('invalid_input');
  }
  check();
  if (!hasAutomaticCaptureCapacity(candidate, check)) return decision('capacity');
  check();
  const tuple = validateCompositionalAutomaticSourceTupleV3(built.episode, check);
  const fence = makeFence(operation, tuple);
  return checkedPreparation(
    {
      kind: 'prepared_claim',
      graph: deepFreeze(candidate),
      leaseFence: deepFreeze(fence),
      writeRequired: true,
    },
    check,
  );
}

function currentAuditCap(
  scope: CompositionalCaptureInitialBeginScopeSnapshotV3,
): PrivateCompositionalCaptureAuditCapV3<'initial'> {
  return scope.audit;
}

function replaceOperation(
  graph: GraphData,
  previous: Operation,
  next: Operation,
  check: () => void,
): GraphData | null {
  const operations = graph.automatic_operations_v1?.operations;
  if (!operations) return null;
  let matches = 0;
  const updated = operations.map((operation) => {
    check();
    if (operation.operationId !== previous.operationId) return operation;
    matches += 1;
    if (!same(operation, previous)) return operation;
    return next;
  });
  if (
    matches !== 1 ||
    !same(
      operations.find((operation) => operation.operationId === previous.operationId),
      previous,
    )
  ) {
    return null;
  }
  const candidate = {
    ...graph,
    automatic_operations_v1: { version: 1 as const, operations: updated },
  };
  const validated = validateAutomaticCaptureCandidate(candidate, check);
  if (!validated) return null;
  return deepFreeze(validated);
}
