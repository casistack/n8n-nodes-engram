import { performance } from 'perf_hooks';
import { types as utilTypes } from 'util';
import { z } from 'zod';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AUTOMATIC_LEDGER_LIMITS } from '../schemas/AutomaticLedgerPrimitives.schema';
import {
  buildCommittedCompositionalCaptureOperationV3,
  CompositionalCaptureTerminalOperationFailureV3,
} from './CompositionalCaptureTerminalOperationV3';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE,
  compositionalCaptureBundleHashV3,
  compositionalCaptureMeaningHashV3,
  compositionalCaptureOperationIdentityHashV3,
  compositionalCapturePredicateDependenciesV3,
  compositionalCaptureSourceHashV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  CompositionalAutomaticClaimMetadataV2Schema,
  compositionalAutomaticClaimKeyV2,
  hashCompositionalAutomaticDescriptorV3,
} from '../schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalCaptureLeaseFenceV3Schema,
  type CompositionalCaptureLeaseFenceV3,
} from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import {
  CompositionalCaptureRegistryActualV3Schema,
  parseCompositionalCaptureCompletionInvocationV3,
  type CompositionalCaptureCompletionInvocationV3,
  type CompositionalCaptureRegistryActualV3,
} from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import { CompositionalAutomaticValueMarkerV2Schema } from '../schemas/CompositionalAutomaticMemory.schema';
import {
  CompositionalQualifiedClaimCommitProofV3Schema,
  CompositionalQualifiedClaimReadContextV3Schema,
} from '../schemas/CompositionalQualifiedClaimReadV3.schema';
import {
  CompositionalMaterializationPreparedV3Schema,
  type PreparedCompositionalBundleDecisionV3,
  type PreparedCompositionalSourceGuardV3,
} from '../schemas/CompositionalMaterializationPreparedV3.schema';
import {
  type CompositionalMaterializationInterpretationV3,
  CompositionalMaterializationSelectorV3Schema,
} from '../schemas/CompositionalMaterializationV3.schema';
import {
  CompositionalCompletionPreparedApplyCandidateV3Schema,
  CompositionalCompletionPreparedApplyResultV3Schema,
  CompositionalCompletionPreparedStageDataV3Schema,
  CompositionalCompletionPreparedStageResultV3Schema,
  CompositionalCompletionOperationProjectionV3Schema,
  CompositionalCompletionRowGuardV3Schema,
  CompositionalCompletionStageAuditV3Schema,
  CompositionalCompletionStageMetadataV3Schema,
  type CompositionalCompletionOperationAuditGuardV3,
  type CompositionalCompletionPreparedApplyCandidateV3,
  type CompositionalCompletionPreparedStageDataV3,
  type CompositionalCompletionPreparedStageResultV3,
  type CompositionalCompletionPreparedApplyResultV3,
  type CompositionalCompletionRowGuardV3,
  type CompositionalCompletionStageAuditV3,
  type CompositionalCompletionStageFactoryCallbacksV3,
  type CompositionalCompletionStageV3,
  type CompositionalCompletionStageDeferredReasonV3,
} from '../schemas/CompositionalCompletionStageV3.schema';
import type { GraphData, EntityNode, EntityEdge, EpisodicNode } from '../schemas';
import { primaryCompositionalBundleReceiptReasonV3 } from './CompositionalBundleReceiptReasonV3';
import { planCompositionalMaterializationV3 } from '../extraction/CompositionalMaterializationV3';
import {
  createCompositionalOperationSnapshotIndexV3,
  getOwnedCompositionalSnapshotV3,
  CompositionalSnapshotIndexErrorV3,
} from '../extraction/CompositionalSnapshotIndexV3';
import {
  getAutomaticClaimReadScope,
  canUseAutomaticClaimReadScope,
  type AutomaticClaimReadScope,
} from './AutomaticClaimReadScope';
import { resolveCompositionalBatchResourcesV3 } from '../extraction/CompositionalOverlapBatchV3';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { hasAutomaticCaptureCapacity } from './AutomaticCaptureCapacity';
import { assertCompositionalRecordIdentityV3 } from './CompositionalRecordIdentityV3';
import { assertAutomaticLedgerSourceIntegrity } from './AutomaticIdentity';

const sourceSelector = CompositionalMaterializationSelectorV3Schema;
const operationSchema = CompositionalAutomaticCaptureOperationV3Schema;
const receiptSchema = CompositionalAutomaticCaptureTerminalReceiptV3Schema;
const planSchema = CompositionalMaterializationPreparedV3Schema;
const rowGuardSchema = CompositionalCompletionRowGuardV3Schema;
const stageCacheSchema = CompositionalCompletionPreparedStageDataV3Schema;
const projectionSchema = CompositionalCompletionOperationProjectionV3Schema;
const stageResultSchema = CompositionalCompletionPreparedStageResultV3Schema;
const applyResultSchema = CompositionalCompletionPreparedApplyResultV3Schema;

type StageOperation = z.infer<typeof operationSchema>;
type CommittedOperation = Extract<StageOperation, { state: 'committed' }>;
type LeasedOperation = Extract<StageOperation, { state: 'leased' }>;
type Receipt = z.infer<typeof receiptSchema>;
type ReceiptItem = Extract<
  Receipt,
  { kind: 'human_compositional_capture_committed' }
>['selection']['items'][number];
type StageRecordRow = EntityNode | EntityEdge | EpisodicNode | StageOperation;
type StageRecordKind = 'entity' | 'edge' | 'episode' | 'operation';

export class CompositionalCompletionStageFailureV3 extends Error {
  constructor(readonly reason: CompositionalCompletionStageDeferredReasonV3) {
    super(`Engram compositional completion stage: ${reason}`);
  }
}

type StageRecord = {
  readonly owner: object;
  readonly capability: object;
  readonly scope: AutomaticClaimReadScope;
  readonly budget: object;
  readonly invocation: CompositionalCaptureCompletionInvocationV3;
  readonly audit: CompositionalCompletionStageAuditV3;
  data: CompositionalCompletionPreparedStageDataV3;
  readonly selector: z.infer<typeof sourceSelector>;
  applied: boolean;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function stageFailure(
  reason: CompositionalCompletionStageDeferredReasonV3,
): CompositionalCompletionStageFailureV3 {
  return new CompositionalCompletionStageFailureV3(reason);
}

function deferred(reason: CompositionalCompletionStageDeferredReasonV3) {
  return stageResultSchema.parse({ status: 'deferred', reason });
}

function deferredApply(reason: CompositionalCompletionStageDeferredReasonV3) {
  return applyResultSchema.parse({ status: 'deferred', reason });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  )
    return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function resolveBudget(value: unknown): { budget: object } | null {
  const resolved = resolveCompositionalBatchResourcesV3({
    budget: value,
    now: '2000-01-01T00:00:00.000Z',
  });
  return resolved ? { budget: resolved.budget } : null;
}

function operationAuditGuard(
  operation: StageOperation,
): CompositionalCompletionOperationAuditGuardV3 {
  return {
    operationId: operation.operationId,
    prefixCount: operation.attempts.length,
    prefixHash: hashAutomaticCaptureV2(operation.attempts),
    overflowCount: operation.overflowCount,
    ...(operation.auditTruncated === undefined ? {} : { auditTruncated: operation.auditTruncated }),
    lastObservedAt: operation.lastObservedAt,
  };
}

function operationWithoutVolatileAudit(operation: StageOperation): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(operation).filter(
      ([key]) => !['attempts', 'overflowCount', 'auditTruncated', 'lastObservedAt'].includes(key),
    ),
  );
}

function rowHash(kind: StageRecordKind, id: string, row: StageRecordRow): string {
  const payload = kind === 'operation' ? operationWithoutVolatileAudit(row as StageOperation) : row;
  return hashAutomaticCaptureV2({
    domain: 'engram-compositional-selected-row-v3',
    kind,
    id,
    row: payload,
  });
}

function auditPrefixMatches(
  guard: CompositionalCompletionOperationAuditGuardV3,
  operation: StageOperation,
  suffixDisposition: 'committed_replay' | 'committed' = 'committed_replay',
  exact = false,
): boolean {
  if (
    operation.operationId !== guard.operationId ||
    operation.overflowCount !== guard.overflowCount ||
    operation.attempts.length < guard.prefixCount ||
    hashAutomaticCaptureV2(operation.attempts.slice(0, guard.prefixCount)) !== guard.prefixHash
  )
    return false;
  const currentTruncated = operation.auditTruncated;
  const sameTruncated = currentTruncated === guard.auditTruncated;
  const allowedTruncation =
    (guard.auditTruncated === undefined || guard.auditTruncated === false) &&
    currentTruncated === true &&
    operation.attempts.length === AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation;
  if (!sameTruncated && !allowedTruncation) return false;
  if (exact) {
    return (
      operation.attempts.length === guard.prefixCount &&
      operation.lastObservedAt === guard.lastObservedAt
    );
  }
  if (Date.parse(operation.lastObservedAt) < Date.parse(guard.lastObservedAt)) return false;
  if (operation.attempts.length > guard.prefixCount) {
    let previousAt = Date.parse(guard.lastObservedAt);
    const seen = new Set(
      operation.attempts.slice(0, guard.prefixCount).map((attempt) => attempt.attemptHash),
    );
    for (const attempt of operation.attempts.slice(guard.prefixCount)) {
      if (
        attempt.disposition !== suffixDisposition ||
        Date.parse(attempt.at) < previousAt ||
        Date.parse(attempt.at) > Date.parse(operation.lastObservedAt) ||
        seen.has(attempt.attemptHash)
      )
        return false;
      previousAt = Date.parse(attempt.at);
      seen.add(attempt.attemptHash);
    }
  }
  return true;
}

function makeFence(
  actual: CompositionalCaptureRegistryActualV3,
  source: EpisodicNode,
): CompositionalCaptureLeaseFenceV3 | null {
  const operation = actual.operation;
  if (operation.state !== 'leased') return null;
  const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.safeParse(
    source.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
  );
  if (!envelope.success) return null;
  return CompositionalCaptureLeaseFenceV3Schema.parse({
    version: 3,
    purpose: 'human_turn_memory',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    descriptorHash: hashCompositionalAutomaticDescriptorV3(operation.descriptor),
    identityHash: compositionalCaptureOperationIdentityHashV3(operation.identity),
    sourceHash: operation.identity.sourceHash,
    envelopeHash: hashAutomaticCaptureV2(envelope.data),
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

function sameInvocation(
  expected: CompositionalCaptureCompletionInvocationV3,
  actual: CompositionalCaptureCompletionInvocationV3,
): boolean {
  return (
    expected.audit === actual.audit &&
    expected.completionCallHash === actual.completionCallHash &&
    expected.invocationDeadlineAtMonotonicMs === actual.invocationDeadlineAtMonotonicMs &&
    expected.leaseRemainingMsAtMonotonicAnchor === actual.leaseRemainingMsAtMonotonicAnchor &&
    expected.acknowledgedBackendNow === actual.acknowledgedBackendNow &&
    expected.expiresAt === actual.expiresAt &&
    expected.claimKind === actual.claimKind &&
    expected.sourceHash === actual.sourceHash &&
    expected.envelopeHash === actual.envelopeHash &&
    expected.namespace === actual.namespace &&
    expected.storeHash === actual.storeHash &&
    same(expected.boundFence, actual.boundFence)
  );
}

function currentSourceGuard(
  actual: CompositionalCaptureRegistryActualV3,
  source: EpisodicNode,
): PreparedCompositionalSourceGuardV3 | null {
  const operation = actual.operation;
  const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.safeParse(
    source.attributes[COMPOSITIONAL_CAPTURE_V2_ENVELOPE_ATTRIBUTE],
  );
  if (!envelope.success) return null;
  return {
    version: 3,
    operationId: operation.operationId,
    sourceId: source.uuid,
    storeHash: operation.identity.storeHash,
    namespace: operation.identity.namespace,
    issuer: operation.identity.issuer,
    actorReference: operation.identity.actorReference,
    bindingRef: operation.identity.binding,
    capturedIdentityHash: compositionalCaptureOperationIdentityHashV3(operation.identity),
    capturedSourceHash: operation.identity.sourceHash,
    observedSourceHash: compositionalCaptureSourceHashV3(source),
    rawContentHash: envelope.data.sourceEnvelope.rawContentHash,
    mappedContentHash: envelope.data.sourceEnvelope.contentHash,
    originalProducerHash: operation.identity.originalProducerHash,
    stableProducerHash: operation.identity.stableProducerHash,
    requestedAuthorityHash: operation.identity.requestedAuthorityHash,
    envelopeHash: hashAutomaticCaptureV2(envelope.data),
    descriptorHash: operation.identity.descriptorHash,
    settingsHash: operation.identity.settingsHash,
    policyFingerprint: operation.identity.policyFingerprint,
  };
}

type IndexedRecords = {
  readonly byId: Map<string, { kind: StageRecordKind; row: StageRecordRow }>;
  readonly bySource: Map<string, StageOperation[]>;
};

function indexRecords(graph: GraphData, check: () => void): IndexedRecords | null {
  const byId = new Map<string, { kind: StageRecordKind; row: StageRecordRow }>();
  const bySource = new Map<string, StageOperation[]>();
  const add = (kind: StageRecordKind, id: string, row: StageRecordRow) => {
    check();
    if (byId.has(id)) return false;
    byId.set(id, { kind, row });
    return true;
  };
  for (const row of graph.entities) if (!add('entity', row.uuid, row)) return null;
  for (const row of graph.edges) if (!add('edge', row.uuid, row)) return null;
  for (const row of graph.episodes) if (!add('episode', row.uuid, row)) return null;
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    if (!add('operation', operation.operationId, operation as StageOperation)) return null;
    const rows = bySource.get(operation.identity.sourceId) ?? [];
    rows.push(operation as StageOperation);
    bySource.set(operation.identity.sourceId, rows);
  }
  return { byId, bySource };
}

function addRowGuard(
  guards: Map<string, CompositionalCompletionRowGuardV3>,
  kind: StageRecordKind,
  id: string,
  row: StageRecordRow,
): boolean {
  const guard = rowGuardSchema.parse({ kind, id, expectedHash: rowHash(kind, id, row) });
  const previous = guards.get(id);
  if (previous) return previous.kind === guard.kind && previous.expectedHash === guard.expectedHash;
  guards.set(id, guard);
  return true;
}

function referenceReceiptMatches(
  graph: GraphData,
  planItem: PreparedCompositionalBundleDecisionV3,
  records: IndexedRecords,
  check: () => void,
): {
  edge: EntityEdge;
  value: EntityNode;
  source: EpisodicNode;
  operation: CommittedOperation;
} | null {
  if (!('claimId' in planItem) || !('valueId' in planItem) || !('referenceGuardHash' in planItem))
    return null;
  const edgeRecord = records.byId.get(planItem.claimId);
  const valueRecord = records.byId.get(planItem.valueId);
  if (edgeRecord?.kind !== 'edge' || valueRecord?.kind !== 'entity') return null;
  const edge = edgeRecord.row as EntityEdge;
  const value = valueRecord.row as EntityNode;
  const claimResult = CompositionalAutomaticClaimMetadataV2Schema.safeParse(
    edge.attributes.engram_claim_v1,
  );
  const markerResult = CompositionalAutomaticValueMarkerV2Schema.safeParse(
    value.attributes.engram_literal_v1,
  );
  if (!claimResult.success || !markerResult.success) return null;
  const claim = claimResult.data;
  if (
    claim.key !== planItem.semanticKey ||
    compositionalAutomaticClaimKeyV2(claim.meaning) !== planItem.semanticKey ||
    compositionalCaptureMeaningHashV3(claim.meaning) !== planItem.meaningHash ||
    canonicalAutomaticCaptureV2(compositionalCapturePredicateDependenciesV3(claim.meaning)) !==
      canonicalAutomaticCaptureV2(planItem.predicateDependencies) ||
    markerResult.data.key !== planItem.semanticKey ||
    edge.fact !== claim.bundle.evidence.lexicalForm ||
    value.name !== edge.fact ||
    edge.name !== 'PREFERS' ||
    edge.target_node_uuid !== value.uuid ||
    edge.source_node_uuid !== claim.subjectId ||
    edge.episodes.length !== 1 ||
    edge.episodes[0] !== claim.sourceId
  )
    return null;
  const sourceRecord = records.byId.get(claim.sourceId);
  if (sourceRecord?.kind !== 'episode') return null;
  const source = sourceRecord.row as EpisodicNode;
  const creatorRecords = records.bySource.get(source.uuid) ?? [];
  if (creatorRecords.length !== 1) return null;
  const creatorResult = operationSchema.safeParse(creatorRecords[0]);
  if (!creatorResult.success || creatorResult.data.state !== 'committed') return null;
  const operation = creatorResult.data;
  if (operation.terminalReceipt.kind !== 'human_compositional_capture_committed') return null;
  const creatorMatches = operation.terminalReceipt.selection.items.filter(
    (item) => item.claimId === edge.uuid && item.mutation === 'created',
  );
  if (creatorMatches.length !== 1) return null;
  const creator = creatorMatches[0];
  if (
    !creator.persisted ||
    (creator.state !== 'accepted' && creator.state !== 'proposed') ||
    creator.bundleHash !== compositionalCaptureBundleHashV3(claim.bundle) ||
    creator.meaningHash !== compositionalCaptureMeaningHashV3(claim.meaning) ||
    canonicalAutomaticCaptureV2(creator.predicateDependencies) !==
      canonicalAutomaticCaptureV2(compositionalCapturePredicateDependenciesV3(claim.meaning))
  )
    return null;
  const subjectRecord = records.byId.get(claim.subjectId);
  if (subjectRecord?.kind !== 'entity') return null;
  const proof = CompositionalQualifiedClaimCommitProofV3Schema.safeParse({
    version: 1,
    kind: 'committed_compositional_human_creation',
    operationId: operation.operationId,
    identity: operation.identity,
    descriptor: operation.descriptor,
    terminalReceipt: operation.terminalReceipt,
  });
  if (!proof.success) return null;
  const context = CompositionalQualifiedClaimReadContextV3Schema.safeParse({
    version: 1,
    namespace: claim.namespace,
    edge,
    subject: subjectRecord.row,
    value,
    source,
    proof: proof.data,
  });
  if (!context.success) return null;
  check();
  const expectedReferenceGuard = hashAutomaticCaptureV2({
    domain: 'engram-compositional-qualified-reference-v3',
    context: context.data,
  });
  return expectedReferenceGuard === planItem.referenceGuardHash
    ? { edge, value, source, operation }
    : null;
}

function buildSelectedGuards(
  graph: GraphData,
  actual: CompositionalCaptureRegistryActualV3,
  plan: z.infer<typeof planSchema>,
  check: () => void,
): {
  guards: CompositionalCompletionRowGuardV3[];
  operationAudits: CompositionalCompletionOperationAuditGuardV3[];
} | null {
  const records = indexRecords(graph, check);
  if (!records) return null;
  const operation = actual.operation;
  const sourceRecord = records.byId.get(operation.identity.sourceId);
  const subjectRecord = records.byId.get(operation.identity.binding.subjectId);
  if (sourceRecord?.kind !== 'episode' || subjectRecord?.kind !== 'entity') return null;
  const source = sourceRecord.row as EpisodicNode;
  const subject = subjectRecord.row as EntityNode;
  const guards = new Map<string, CompositionalCompletionRowGuardV3>();
  const operationAudits = new Map<string, CompositionalCompletionOperationAuditGuardV3>();
  if (
    !addRowGuard(guards, 'episode', source.uuid, source) ||
    !addRowGuard(guards, 'entity', subject.uuid, subject)
  )
    return null;

  const addOperation = (row: StageOperation, guardRow = true): boolean => {
    if (guardRow && !addRowGuard(guards, 'operation', row.operationId, row)) return false;
    const audit = operationAuditGuard(row);
    const prior = operationAudits.get(row.operationId);
    if (prior && !same(prior, audit)) return false;
    operationAudits.set(row.operationId, audit);
    return true;
  };

  for (const entity of plan.createEntities) {
    check();
    if (records.byId.has(entity.uuid)) return null;
    if (!addRowGuard(guards, 'entity', entity.uuid, entity)) return null;
  }
  for (const edge of plan.createEdges) {
    check();
    if (records.byId.has(edge.uuid)) return null;
    if (!addRowGuard(guards, 'edge', edge.uuid, edge)) return null;
  }

  for (const item of plan.items) {
    check();
    if (
      item.decision !== 'reference_accepted' &&
      item.decision !== 'reference_proposed' &&
      item.decision !== 'reference_rejected'
    )
      continue;
    const reference = referenceReceiptMatches(graph, item, records, check);
    if (!reference) return null;
    if (
      !addRowGuard(guards, 'edge', reference.edge.uuid, reference.edge) ||
      !addRowGuard(guards, 'entity', reference.value.uuid, reference.value) ||
      !addRowGuard(guards, 'episode', reference.source.uuid, reference.source) ||
      !addOperation(reference.operation)
    )
      return null;
  }
  // The current leased operation is fenced separately. Its volatile audit is
  // checked through this prefix guard; it must not also become a selected row.
  if (!addOperation(operation, false)) return null;
  if (guards.size > 130 || operationAudits.size > 33) return null;
  return {
    guards: [...guards.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    operationAudits: [...operationAudits.values()].sort((a, b) =>
      a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
    ),
  };
}

function expectedStageBindingHash(
  plan: z.infer<typeof planSchema>,
  interpretation: CompositionalMaterializationInterpretationV3,
  fence: CompositionalCaptureLeaseFenceV3,
  completionCallHash: string,
): { planHash: string; bindingHash: string } {
  const planHash = hashAutomaticCaptureV2(plan);
  const bindingHash = hashAutomaticCaptureV2({
    domain: 'engram-compositional-completion-stage-v3',
    planHash,
    interpretation,
    sourceGuard: plan.sourceGuard,
    fence,
    completionCallHash,
  });
  return { planHash, bindingHash };
}

function sourceAuthorityIsCurrent(
  view: NonNullable<ReturnType<typeof getOwnedCompositionalSnapshotV3>>,
  actual: CompositionalCaptureRegistryActualV3,
  check: () => void,
  latch: { failed: boolean; error?: unknown },
): boolean {
  const operation = actual.operation;
  const source = view.episode(operation.identity.sourceId);
  if (
    !source ||
    source.group_id !== operation.identity.namespace ||
    source.review_status !== 'accepted' ||
    source.trust_level !== operation.descriptor.requestedTrustLevel
  )
    return false;
  try {
    const subject = view.assertBinding(
      operation.identity.namespace,
      operation.identity.issuer,
      operation.identity.actorReference,
      operation.identity.binding,
      check,
    );
    return (
      subject.uuid === operation.identity.binding.subjectId && subject.group_id === actual.namespace
    );
  } catch (error) {
    if (latch.failed) throw latch.error;
    if (error instanceof CompositionalSnapshotIndexErrorV3 && error.reason === 'budget_exhausted')
      throw stageFailure('budget_exhausted');
    throw stageFailure('authority_changed');
  }
}

function makeReceipt(
  plan: z.infer<typeof planSchema>,
  interpretation: CompositionalMaterializationInterpretationV3,
  operation: LeasedOperation,
  terminalAt: string,
): Receipt {
  const items: ReceiptItem[] = plan.items.map((item) => {
    const reason = primaryCompositionalBundleReceiptReasonV3(item);
    const dependencies = item.predicateDependencies;
    switch (item.decision) {
      case 'create_accepted':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: 'accepted',
          persisted: true,
          mutation: 'created',
          reason,
          claimId: item.claimId,
          predicateDependencies: dependencies,
        };
      case 'create_proposed':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: 'proposed',
          persisted: true,
          mutation: 'created',
          reason,
          claimId: item.claimId,
          predicateDependencies: dependencies,
        };
      case 'reference_accepted':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: 'unchanged',
          persisted: true,
          mutation: 'none',
          reason,
          claimId: item.claimId,
          predicateDependencies: dependencies,
        };
      case 'reference_proposed':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: 'proposed',
          persisted: true,
          mutation: 'none',
          reason,
          claimId: item.claimId,
          predicateDependencies: dependencies,
        };
      case 'reference_rejected':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: 'rejected',
          persisted: true,
          mutation: 'none',
          reason,
          claimId: item.claimId,
          predicateDependencies: dependencies,
        };
      case 'reference_prepared':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: item.intendedReview === 'accepted' ? 'unchanged' : 'proposed',
          persisted: true,
          mutation: 'none',
          reason,
          claimId: item.claimId,
          predicateDependencies: dependencies,
        };
      case 'not_selected':
        return {
          bundleIndex: item.bundleIndex,
          bundleHash: item.bundleHash,
          meaningHash: item.meaningHash,
          state: 'not_selected',
          persisted: false,
          mutation: 'none',
          reason,
          predicateDependencies: dependencies,
        };
    }
  });
  const acceptedCount = items.filter(
    (item) => item.persisted && (item.state === 'accepted' || item.state === 'unchanged'),
  ).length;
  const acceptedCoverage =
    acceptedCount === 0 ? 'none' : acceptedCount === items.length ? 'all' : 'partial';
  return receiptSchema.parse({
    version: 3,
    kind: 'human_compositional_capture_committed',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: operation.identity.descriptorHash,
    policyFingerprint: operation.descriptor.policy.fingerprint,
    terminalAt,
    reasons: interpretation.reasons,
    interpretationCoverage: 'complete',
    acceptedCoverage,
    selection: { kind: 'bundles', items },
  });
}

function committedOperationProjection(
  operation: CommittedOperation,
): z.infer<typeof projectionSchema> {
  const projection = { ...operation };
  delete (projection as Partial<CommittedOperation>).terminalReceipt;
  return projectionSchema.parse(projection);
}

function committedOperationFromLease(
  leased: LeasedOperation,
  receipt: Receipt,
  completionCallHash: string,
  terminalAt: string,
  audit: CompositionalCompletionStageAuditV3,
  check: () => void,
): CommittedOperation {
  if (receipt.terminalAt !== terminalAt) throw stageFailure('invalid_receipt');
  try {
    return buildCommittedCompositionalCaptureOperationV3(
      {
        leasedOperation: leased,
        terminalReceipt: receipt,
        completionCallHash,
        audit,
      },
      check,
    );
  } catch (error) {
    if (error instanceof CompositionalCaptureTerminalOperationFailureV3)
      throw stageFailure(error.reason);
    throw error;
  }
}

function expectedStageMetadataMatches(
  record: StageRecord,
  actual: CompositionalCaptureRegistryActualV3,
  invocation: CompositionalCaptureCompletionInvocationV3,
  source: EpisodicNode,
): boolean {
  const operation = actual.operation;
  const fence = makeFence(actual, source);
  const audit = operationAuditGuard(operation);
  const storedAudit = record.data.operationAudits.find(
    (entry) => entry.operationId === operation.operationId,
  );
  return (
    operation.state === 'leased' &&
    !!fence &&
    same(fence, record.data.metadata.fence) &&
    same(fence, invocation.boundFence) &&
    sameInvocation(record.invocation, invocation) &&
    operation.operationId === record.data.metadata.operationId &&
    operation.identity.sourceId === record.data.metadata.sourceId &&
    operation.identity.namespace === record.data.metadata.namespace &&
    actual.storeHash === record.data.metadata.storeHash &&
    actual.backendNow >= record.data.metadata.stagedBackendNow &&
    Date.parse(actual.backendNow) < Date.parse(invocation.expiresAt) &&
    Date.parse(actual.backendNow) >= Date.parse(record.data.metadata.stagedBackendNow) &&
    !!storedAudit &&
    audit.prefixHash === storedAudit.prefixHash &&
    audit.prefixCount === storedAudit.prefixCount &&
    audit.overflowCount === storedAudit.overflowCount &&
    audit.auditTruncated === storedAudit.auditTruncated &&
    audit.lastObservedAt === storedAudit.lastObservedAt
  );
}

function actualRecordsMatchGuards(
  graph: GraphData,
  record: StageRecord,
  mode: 'preapply' | 'acknowledgement',
  check: () => void,
): boolean {
  const records = indexRecords(graph, check);
  if (!records) return false;
  const createIds = new Set([
    ...record.data.plan.createEntities.map((row) => row.uuid),
    ...record.data.plan.createEdges.map((row) => row.uuid),
  ]);
  for (const guard of record.data.guards) {
    check();
    const existing = records.byId.get(guard.id);
    if (createIds.has(guard.id)) {
      const planned =
        guard.kind === 'entity'
          ? record.data.plan.createEntities.find((row) => row.uuid === guard.id)
          : guard.kind === 'edge'
            ? record.data.plan.createEdges.find((row) => row.uuid === guard.id)
            : undefined;
      if (!planned || rowHash(guard.kind, guard.id, planned) !== guard.expectedHash) return false;
      if (mode === 'preapply' ? existing !== undefined : existing?.kind !== guard.kind)
        return false;
      if (
        mode === 'acknowledgement' &&
        rowHash(existing!.kind, guard.id, existing!.row) !== guard.expectedHash
      )
        return false;
      continue;
    }
    if (!existing || existing.kind !== guard.kind) return false;
    if (rowHash(existing.kind, guard.id, existing.row) !== guard.expectedHash) return false;
  }

  for (const auditGuard of record.data.operationAudits) {
    check();
    const existing = records.byId.get(auditGuard.operationId);
    if (existing?.kind !== 'operation') return false;
    const operation = existing.row as StageOperation;
    if (operation.operationId === record.data.metadata.operationId) {
      if (mode === 'preapply' && !auditPrefixMatches(auditGuard, operation, 'committed', true))
        return false;
      continue;
    }
    if (!auditPrefixMatches(auditGuard, operation, 'committed_replay', false)) return false;
  }
  return true;
}

function plannedIdsAreVacant(
  graph: GraphData,
  plan: z.infer<typeof planSchema>,
  check: () => void,
): boolean {
  const ids = new Set<string>();
  for (const entity of graph.entities) {
    check();
    ids.add(entity.uuid);
  }
  for (const edge of graph.edges) {
    check();
    ids.add(edge.uuid);
  }
  for (const episode of graph.episodes) {
    check();
    ids.add(episode.uuid);
  }
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    ids.add(operation.operationId);
  }
  return [...plan.createEntities, ...plan.createEdges].every((row) => !ids.has(row.uuid));
}

function candidateGraph(
  graph: GraphData,
  plan: z.infer<typeof planSchema>,
  operation: CommittedOperation,
  check: () => void,
): GraphData | null {
  const operations = graph.automatic_operations_v1?.operations ?? [];
  let replaced = 0;
  const nextOperations = operations.map((candidate) => {
    check();
    if (candidate.operationId !== operation.operationId) return candidate;
    replaced += 1;
    return operation;
  });
  if (replaced !== 1) return null;
  let parsed: GraphData;
  try {
    parsed = parseLosslessAutomaticCaptureGraph({
      ...graph,
      entities: [...graph.entities, ...plan.createEntities],
      edges: [...graph.edges, ...plan.createEdges],
      automatic_operations_v1: { version: 1, operations: nextOperations },
    });
    assertCompositionalRecordIdentityV3(parsed, check);
    assertAutomaticLedgerSourceIntegrity(parsed);
  } catch (error) {
    if (error instanceof CompositionalCompletionStageFailureV3) throw error;
    // A cancellation may be raised from the cooperative guard inside a
    // validator. Recheck so the latched original object propagates unchanged.
    check();
    return null;
  }
  return hasAutomaticCaptureCapacity(parsed, check) ? parsed : null;
}

function isKnownOperationAudit(operation: StageOperation, check: () => void): boolean {
  check();
  const claimWon = operation.attempts.filter((attempt) => attempt.disposition === 'claim_won');
  return (
    claimWon.length === 1 &&
    operation.attempts[0]?.disposition === 'claim_won' &&
    Date.parse(operation.attempts[0].at) === Date.parse(operation.createdAt)
  );
}

function liveOperationScopeValid(
  scope: AutomaticClaimReadScope,
  invocation: CompositionalCaptureCompletionInvocationV3,
): boolean {
  const now = performance.now();
  return (
    canUseAutomaticClaimReadScope(scope) &&
    Number.isFinite(now) &&
    // The registry's private active-invocation authentication enforces its
    // independently issued lease deadline; this check enforces shared scope.
    now < invocation.invocationDeadlineAtMonotonicMs
  );
}

function projectAckOperation(operation: CommittedOperation): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(operation).filter(
      ([key]) =>
        ![
          'attempts',
          'overflowCount',
          'auditTruncated',
          'lastObservedAt',
          'terminalReceipt',
        ].includes(key),
    ),
  );
}

function operationExpectedForAck(
  expected: z.infer<typeof projectionSchema>,
  actual: CommittedOperation,
): boolean {
  return same(
    projectAckOperation(actual),
    operationWithoutVolatileAudit(expected as StageOperation),
  );
}

function ackOperationAuditMatches(
  expected: z.infer<typeof projectionSchema>,
  actual: CommittedOperation,
): boolean {
  if (
    actual.overflowCount !== expected.overflowCount ||
    actual.attempts.length < expected.attempts.length ||
    hashAutomaticCaptureV2(actual.attempts.slice(0, expected.attempts.length)) !==
      hashAutomaticCaptureV2(expected.attempts)
  )
    return false;
  const truncationSame = actual.auditTruncated === expected.auditTruncated;
  const truncationAllowed =
    (expected.auditTruncated === undefined || expected.auditTruncated === false) &&
    actual.auditTruncated === true &&
    actual.attempts.length === AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation;
  if (!truncationSame && !truncationAllowed) return false;
  if (Date.parse(actual.lastObservedAt) < Date.parse(expected.lastObservedAt)) return false;
  let previousAt = Date.parse(expected.lastObservedAt);
  const seen = new Set(expected.attempts.map((attempt) => attempt.attemptHash));
  for (const attempt of actual.attempts.slice(expected.attempts.length)) {
    if (
      attempt.disposition !== 'committed_replay' ||
      Date.parse(attempt.at) < previousAt ||
      Date.parse(attempt.at) > Date.parse(actual.lastObservedAt) ||
      seen.has(attempt.attemptHash)
    )
      return false;
    previousAt = Date.parse(attempt.at);
    seen.add(attempt.attemptHash);
  }
  return true;
}

/** Creates a same-registry, same-capability private completion stage. */
export type CompositionalCompletionStageFactoryV3 = Readonly<{
  prepare(
    capability: unknown,
    actual: unknown,
    budget: unknown,
  ): CompositionalCompletionPreparedStageResultV3;
  prepareApply(
    capability: unknown,
    stage: unknown,
    actual: unknown,
  ): CompositionalCompletionPreparedApplyResultV3;
  verifyAcknowledged(capability: unknown, actual: unknown): boolean;
}>;

export function createCompositionalCompletionStageFactoryV3(
  callbacks: CompositionalCompletionStageFactoryCallbacksV3,
): CompositionalCompletionStageFactoryV3 {
  const owner = Object.freeze(Object.create(null)) as object;
  const stageByToken = new WeakMap<object, StageRecord>();
  const latestByCapability = new WeakMap<object, StageRecord>();
  const scopeByCapability = new WeakMap<
    object,
    { budget: object; scope: AutomaticClaimReadScope }
  >();

  const authenticate = (capability: unknown): object => {
    callbacks.authenticate(capability);
    if (capability === null || typeof capability !== 'object' || utilTypes.isProxy(capability))
      throw stageFailure('invalid_capability');
    return capability;
  };

  const checkFor = (
    capability: object,
    scope: AutomaticClaimReadScope,
    invocation: CompositionalCaptureCompletionInvocationV3,
    latch: { failed: boolean; error?: unknown },
  ) => {
    if (latch.failed) throw latch.error;
    try {
      callbacks.authenticate(capability);
    } catch (error) {
      latch.failed = true;
      latch.error = error;
      throw error;
    }
    if (!liveOperationScopeValid(scope, invocation)) throw stageFailure('budget_exhausted');
  };

  const resolveActual = (
    capability: object,
    raw: unknown,
    expectedState: 'leased' | 'committed',
  ): {
    actual: CompositionalCaptureRegistryActualV3;
    invocation: CompositionalCaptureCompletionInvocationV3;
  } | null => {
    const rawResolved = callbacks.resolve(capability, raw, expectedState);
    if (rawResolved === null) return null;
    const record = exactRecord(rawResolved, ['actual', 'invocation']);
    if (!record) return null;
    const actual = CompositionalCaptureRegistryActualV3Schema.safeParse(record.actual);
    if (!actual.success) return null;
    let invocation: CompositionalCaptureCompletionInvocationV3;
    try {
      invocation = parseCompositionalCaptureCompletionInvocationV3(record.invocation);
    } catch {
      return null;
    }
    if (actual.data.operation.state !== expectedState) return null;
    return { actual: deepFreeze(actual.data), invocation };
  };

  const readAudit = (capability: object, actual: CompositionalCaptureRegistryActualV3) => {
    const parsed = CompositionalCompletionStageAuditV3Schema.safeParse(
      callbacks.readCompletionAudit(capability),
    );
    if (
      !parsed.success ||
      parsed.data.operationId !== actual.operation.operationId ||
      parsed.data.sourceId !== actual.operation.identity.sourceId
    )
      return null;
    return deepFreeze(parsed.data);
  };

  const prepare = (capabilityValue: unknown, rawActual: unknown, budgetValue: unknown) => {
    let capability: object;
    try {
      capability = authenticate(capabilityValue);
    } catch (error) {
      if (error instanceof CompositionalCompletionStageFailureV3) return deferred(error.reason);
      throw error;
    }
    const resolvedBudget = resolveBudget(budgetValue);
    if (!resolvedBudget) return deferred('invalid_resources');
    const priorScope = scopeByCapability.get(capability);
    if (priorScope && priorScope.budget !== resolvedBudget.budget)
      return deferred('invalid_resources');
    const scope = priorScope?.scope ?? getAutomaticClaimReadScope(resolvedBudget.budget as never);
    if (!priorScope) scopeByCapability.set(capability, { budget: resolvedBudget.budget, scope });
    if (!canUseAutomaticClaimReadScope(scope)) return deferred('budget_exhausted');
    const latch: { failed: boolean; error?: unknown } = { failed: false };

    try {
      const resolved = resolveActual(capability, rawActual, 'leased');
      if (!resolved) return deferred('invalid_snapshot');
      const { actual, invocation } = resolved;
      const check = () => checkFor(capability, scope, invocation, latch);
      check();
      const operation = actual.operation as LeasedOperation;
      const audit = readAudit(capability, actual);
      if (!audit) return deferred('invalid_audit');
      if (!isKnownOperationAudit(operation, check)) return deferred('invalid_audit');
      const source = actual.graph.episodes.find((row) => row.uuid === operation.identity.sourceId);
      if (!source) return deferred('invalid_source');
      const fence = makeFence(actual, source);
      if (
        !fence ||
        !same(fence, invocation.boundFence) ||
        actual.storeHash !== invocation.storeHash ||
        actual.namespace !== invocation.namespace ||
        operation.identity.sourceHash !== invocation.sourceHash ||
        fence.envelopeHash !== invocation.envelopeHash ||
        operation.lease.expiresAt !== invocation.expiresAt ||
        operation.lease.claimKind !== invocation.claimKind ||
        audit.action !== 'completion'
      )
        return deferred('authority_changed');
      const parsedSelector = sourceSelector.safeParse({
        namespace: operation.identity.namespace,
        operationId: operation.operationId,
      });
      if (!parsedSelector.success) return deferred('invalid_input');
      const planned = planCompositionalMaterializationV3(actual.graph, parsedSelector.data, {
        budget: resolvedBudget.budget,
        now: actual.backendNow,
        check,
      });
      check();
      if (planned.status !== 'prepared_data') return deferred(planned.reason);
      const selected = buildSelectedGuards(actual.graph, actual, planned.plan, check);
      if (!selected) return deferred('invalid_plan');
      const hashes = expectedStageBindingHash(
        planned.plan,
        planned.interpretation,
        fence,
        invocation.completionCallHash,
      );
      const metadata = CompositionalCompletionStageMetadataV3Schema.parse({
        version: 1,
        operationId: operation.operationId,
        sourceId: operation.identity.sourceId,
        namespace: operation.identity.namespace,
        storeHash: actual.storeHash,
        completionCallHash: invocation.completionCallHash,
        audit,
        fence,
        expiresAt: invocation.expiresAt,
        acknowledgedBackendNow: invocation.acknowledgedBackendNow,
        leaseRemainingMsAtMonotonicAnchor: invocation.leaseRemainingMsAtMonotonicAnchor,
        invocationDeadlineAtMonotonicMs: invocation.invocationDeadlineAtMonotonicMs,
        invocationDeadlineMs: operation.descriptor.invocationDeadlineMs,
        claimKind: invocation.claimKind,
        stagedBackendNow: actual.backendNow,
        planTimestamp: planned.plan.planTimestamp,
        planHash: hashes.planHash,
        bindingHash: hashes.bindingHash,
      });
      let data: CompositionalCompletionPreparedStageDataV3;
      try {
        data = deepFreeze(
          stageCacheSchema.parse({
            version: 1,
            kind: 'compositional_completion_stage',
            metadata,
            interpretation: planned.interpretation,
            plan: planned.plan,
            guards: selected.guards,
            operationAudits: selected.operationAudits,
          }),
        );
      } catch (error) {
        if (error instanceof CompositionalCompletionStageFailureV3) return deferred(error.reason);
        return deferred('plan_too_large');
      }
      check();
      const token = Object.freeze(Object.create(null)) as CompositionalCompletionStageV3;
      const record: StageRecord = {
        owner,
        capability,
        scope,
        budget: resolvedBudget.budget,
        invocation,
        audit,
        data,
        selector: parsedSelector.data,
        applied: false,
      };
      const result = stageResultSchema.parse({ status: 'prepared_stage', stage: token });
      check();
      latestByCapability.set(capability, record);
      stageByToken.set(token as object, record);
      return result;
    } catch (error) {
      if (error instanceof CompositionalCompletionStageFailureV3 && !latch.failed)
        return deferred(error.reason);
      throw error;
    }
  };

  const lookupStage = (capability: object, stageValue: unknown): StageRecord | null => {
    if (stageValue === null || typeof stageValue !== 'object' || utilTypes.isProxy(stageValue))
      return null;
    const record = stageByToken.get(stageValue);
    return record &&
      record.owner === owner &&
      record.capability === capability &&
      latestByCapability.get(capability) === record
      ? record
      : null;
  };

  const createCurrentIndex = (
    actual: CompositionalCaptureRegistryActualV3,
    selector: z.infer<typeof sourceSelector>,
    scope: AutomaticClaimReadScope,
    check: () => void,
  ) => {
    try {
      const token = createCompositionalOperationSnapshotIndexV3(
        actual.graph,
        selector,
        scope,
        check,
      );
      const view = getOwnedCompositionalSnapshotV3(token);
      return view ? { token, view } : null;
    } catch (error) {
      if (error instanceof CompositionalSnapshotIndexErrorV3) {
        if (error.reason === 'budget_exhausted') throw stageFailure('budget_exhausted');
        if (error.reason === 'invalid_scope') throw stageFailure('invalid_resources');
        if (error.reason === 'missing_operation') throw stageFailure('missing_operation');
        if (error.reason === 'ambiguous_operation') throw stageFailure('ambiguous_operation');
        if (error.reason === 'unsupported_mode') throw stageFailure('unsupported_mode');
      }
      throw error;
    }
  };

  const apply = (capabilityValue: unknown, stageValue: unknown, rawActual: unknown) => {
    let capability: object;
    try {
      capability = authenticate(capabilityValue);
    } catch (error) {
      if (error instanceof CompositionalCompletionStageFailureV3)
        return deferredApply(error.reason);
      throw error;
    }
    const record = lookupStage(capability, stageValue);
    if (!record || record.applied) return deferredApply('invalid_stage');
    // Consume this opaque stage before inspecting the caller's actual snapshot.
    record.applied = true;
    const latch: { failed: boolean; error?: unknown } = { failed: false };
    try {
      const initialCheck = () => checkFor(capability, record.scope, record.invocation, latch);
      initialCheck();
      const resolved = resolveActual(capability, rawActual, 'leased');
      if (!resolved) return deferredApply('invalid_snapshot');
      const { actual, invocation } = resolved;
      const check = () => checkFor(capability, record.scope, record.invocation, latch);
      check();
      if (!sameInvocation(record.invocation, invocation)) return deferredApply('invalid_stage');
      const operation = actual.operation as LeasedOperation;
      if (operation.state !== 'leased') return deferredApply('operation_not_leased');
      const nowMs = Date.parse(actual.backendNow);
      const stageNowMs = Date.parse(record.data.metadata.stagedBackendNow);
      if (nowMs < stageNowMs || nowMs < Date.parse(operation.lastObservedAt))
        return deferredApply('clock_regression');
      if (nowMs >= Date.parse(invocation.expiresAt)) return deferredApply('lease_expired');
      const source = actual.graph.episodes.find((row) => row.uuid === operation.identity.sourceId);
      if (!source) return deferredApply('invalid_source');
      if (!expectedStageMetadataMatches(record, actual, invocation, source))
        return deferredApply('authority_changed');
      const sourceGuard = currentSourceGuard(actual, source);
      if (!sourceGuard || !same(sourceGuard, record.data.plan.sourceGuard))
        return deferredApply('authority_changed');
      const indexed = createCurrentIndex(actual, record.selector, record.scope, check);
      if (!indexed) return deferredApply('invalid_snapshot');
      check();
      if (indexed.view.snapshotHash !== record.data.plan.snapshotHash)
        return deferredApply('invalid_snapshot');
      if (!sourceAuthorityIsCurrent(indexed.view, actual, check, latch))
        return deferredApply('authority_changed');
      if (!plannedIdsAreVacant(actual.graph, record.data.plan, check))
        return deferredApply('identity_collision');
      if (!actualRecordsMatchGuards(actual.graph, record, 'preapply', check))
        return deferredApply('invalid_snapshot');

      const receipt = makeReceipt(
        record.data.plan,
        record.data.interpretation,
        operation,
        actual.backendNow,
      );
      const committed = committedOperationFromLease(
        operation,
        receipt,
        invocation.completionCallHash,
        actual.backendNow,
        record.audit,
        check,
      );
      if (!isKnownOperationAudit(committed, check)) return deferredApply('invalid_audit');
      const projection = committedOperationProjection(committed);
      const priorData = record.data;
      const nextData = {
        ...priorData,
        expectedReceipt: receipt,
        expectedOperation: projection,
      };
      let checkedData: CompositionalCompletionPreparedStageDataV3;
      try {
        checkedData = deepFreeze(stageCacheSchema.parse(nextData));
      } catch {
        return deferredApply('plan_too_large');
      }
      const candidate = CompositionalCompletionPreparedApplyCandidateV3Schema.safeParse({
        plan: checkedData.plan,
        receipt,
        operation: committed,
      });
      if (!candidate.success) return deferredApply('invalid_receipt');
      if (
        Buffer.byteLength(JSON.stringify(candidate.data.operation), 'utf8') >
        AUTOMATIC_LEDGER_LIMITS.operationBytes
      )
        return deferredApply('plan_too_large');
      const graphCandidate = candidateGraph(actual.graph, checkedData.plan, committed, check);
      if (!graphCandidate) return deferredApply('capacity');
      const result = deepFreeze(
        applyResultSchema.parse({
          status: 'prepared_apply',
          candidate: deepFreeze(candidate.data) as CompositionalCompletionPreparedApplyCandidateV3,
        }),
      );
      check();
      record.data = checkedData;
      return result;
    } catch (error) {
      if (error instanceof CompositionalCompletionStageFailureV3 && !latch.failed)
        return deferredApply(error.reason);
      throw error;
    }
  };

  const verifyAcknowledged = (capabilityValue: unknown, rawActual: unknown): boolean => {
    let capability: object;
    try {
      capability = authenticate(capabilityValue);
    } catch (error) {
      if (error instanceof CompositionalCompletionStageFailureV3) return false;
      throw error;
    }
    const record = latestByCapability.get(capability);
    if (
      !record ||
      record.owner !== owner ||
      record.capability !== capability ||
      !record.applied ||
      !record.data.expectedReceipt ||
      !record.data.expectedOperation
    )
      return false;
    const latch: { failed: boolean; error?: unknown } = { failed: false };
    try {
      const check = () => checkFor(capability, record.scope, record.invocation, latch);
      check();
      const resolved = resolveActual(capability, rawActual, 'committed');
      if (!resolved) return false;
      const { actual, invocation } = resolved;
      check();
      if (!sameInvocation(record.invocation, invocation)) return false;
      const operation = actual.operation as CommittedOperation;
      if (
        operation.state !== 'committed' ||
        !same(operation.terminalReceipt, record.data.expectedReceipt) ||
        operation.completionCallHash !== record.invocation.completionCallHash ||
        !operationExpectedForAck(record.data.expectedOperation, operation) ||
        !ackOperationAuditMatches(record.data.expectedOperation, operation) ||
        Date.parse(actual.backendNow) < Date.parse(record.data.expectedOperation.lastObservedAt) ||
        Date.parse(actual.backendNow) >= Date.parse(record.invocation.expiresAt)
      )
        return false;
      const indexed = createCurrentIndex(actual, record.selector, record.scope, check);
      if (!indexed || !sourceAuthorityIsCurrent(indexed.view, actual, check, latch)) return false;
      const source = indexed.view.episode(operation.identity.sourceId);
      if (!source) return false;
      const freshGuard = currentSourceGuard(actual, source);
      if (!freshGuard || !same(freshGuard, record.data.plan.sourceGuard)) return false;
      if (!actualRecordsMatchGuards(actual.graph, record, 'acknowledgement', check)) return false;
      check();
      return true;
    } catch (error) {
      if (error instanceof CompositionalCompletionStageFailureV3 && !latch.failed) return false;
      throw error;
    }
  };

  return Object.freeze({ prepare, prepareApply: apply, verifyAcknowledged });
}
