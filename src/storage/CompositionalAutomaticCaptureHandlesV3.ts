import { createHash, randomBytes, randomUUID } from 'crypto';
import { assertCompositionalRecordIdentityV3 } from './CompositionalRecordIdentityV3';
import {
  createCompositionalCompletionStageFactoryV3,
  CompositionalCompletionStageFailureV3,
} from './CompositionalCompletionStageV3';
import type {
  CompositionalCompletionPreparedStageResultV3,
  CompositionalCompletionPreparedApplyResultV3,
} from '../schemas/CompositionalCompletionStageV3.schema';
import { performance } from 'perf_hooks';
import { z } from 'zod';
import {
  CompositionalCaptureWorkBudgetV3Schema,
  type CompositionalCaptureWorkBudgetV3,
} from '../schemas/CompositionalCaptureWorkBudgetV3.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
  CompositionalAutomaticCaptureSourceEnvelopeV2Schema,
  type CompositionalAutomaticCaptureTerminalReceiptV3,
  compositionalCaptureOperationIdentityHashV3,
  compositionalCaptureSourceHashV3,
  reconcileCompositionalCaptureOperationIdentityV3,
} from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { type CompositionalPreferenceV2Reason } from '../schemas/CompositionalPreferenceV2.schema';
import type { CompositionalAutomaticCaptureEvidenceReportV3 } from '../schemas/CompositionalAutomaticCaptureEvidenceReportV3.schema';
import { interpretCompositionalHumanSourceV3EvidenceWithExecutionReport } from '../extraction/CompositionalAutomaticCaptureV3Evidence';
import {
  CompositionalAutomaticDescriptorV3Schema,
  hashCompositionalAutomaticDescriptorV3,
} from '../schemas/CompositionalAutomaticMemory.schema';
import { CompositionalCaptureLeaseFenceV3Schema } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import {
  CompositionalCaptureRegistryActualV3Schema,
  parseCompositionalCaptureAttemptAuditV3,
  parseCompositionalCaptureBeginInvocationV3,
  parseCompositionalCaptureCompletionInvocationV3,
  parseCompositionalCaptureInitialBeginScopeSnapshotV3,
  parseCompositionalCaptureEligibleFirstCommitResultBodyV3,
  parseCompositionalCaptureResumeInvocationV3,
  createCompositionalCaptureInternalResultSchemasV3,
  type CompositionalCaptureAttemptAuditV3,
  type CompositionalCaptureBeginInvocationV3,
  type CompositionalCaptureCompletionInvocationV3,
  type CompositionalCaptureInitialBeginScopeSnapshotV3,
  type CompositionalCaptureEligibleFirstCommitResultV3,
  type CompositionalCaptureRegistryActualV3,
  type CompositionalCaptureResumeInvocationV3,
  type PrivateCompositionalCaptureBeginScopeV3,
  type PrivateCompositionalCaptureFirstCommitProofV3,
  type PrivateCompositionalCaptureSourceVerdictWitnessV3,
  type PrivateCompositionalCaptureResumeScopeV3,
  type PrivateConsumedCompositionalCaptureInvocationV3,
  type PrivateOneUseCompositionalCaptureLeaseHandleV3,
} from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import { assertAutomaticBindingIdentity } from './AutomaticIdentity';
import {
  reconstructCompositionalAutomaticSourceIdentityV3,
  validateCompositionalAutomaticSourceTupleV3,
} from './CompositionalAutomaticCaptureSourceTupleV3';
import { AUTOMATIC_LEDGER_LIMITS } from '../schemas/AutomaticLedgerPrimitives.schema';

const attemptHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const descriptorSchema = CompositionalAutomaticDescriptorV3Schema;
const fenceSchema = CompositionalCaptureLeaseFenceV3Schema;
const receiptSchema = CompositionalAutomaticCaptureTerminalReceiptV3Schema;

type Operation = z.infer<typeof CompositionalAutomaticCaptureOperationV3Schema>;
type Fence = z.infer<typeof fenceSchema>;
type SourceVerdictTerminalReceipt = Extract<
  CompositionalAutomaticCaptureTerminalReceiptV3,
  { kind: 'human_compositional_source_verdict_committed' }
>;

type AckPath = 'acknowledged' | 'unknown_ack_recovery';

interface RegistryState {
  readonly scopes: WeakMap<object, BeginScopeRecord | ResumeScopeRecord>;
  /** Installed only by this registry's fixed, code-owned completion-stage factory. */
  verifyBundles?: (capability: object, actual: CompositionalCaptureRegistryActualV3) => boolean;
}

interface AuditRecord {
  readonly owner: RegistryState;
  readonly action: 'initial' | 'resume' | 'completion';
  readonly attemptIdHash: string;
  readonly operationId: string;
  readonly sourceId: string;
}

interface ResolvedActual {
  readonly actual: CompositionalCaptureRegistryActualV3;
  readonly source: CompositionalCaptureRegistryActualV3['graph']['episodes'][number];
  readonly operation: Operation;
  readonly identityHash: string;
  readonly descriptorHash: string;
  readonly sourceHash: string;
  readonly envelopeHash: string;
  readonly authorityActive: boolean;
  readonly authorityKey: string;
  readonly snapshotKey: string;
}

interface BeginScopeRecord {
  readonly owner: RegistryState;
  readonly kind: 'initial';
  readonly sourceId: string;
  readonly operationId: string;
  readonly token: string;
  readonly beginCallHash: string;
  readonly attemptIdHash: string;
  readonly descriptorHash: string;
  readonly invocationDeadlineMs: number;
  readonly startedAtMonotonicMs: number;
  readonly deadlineAtMonotonicMs: number;
  readonly audit: object;
  ackPath?: AckPath;
  actualKey?: string;
  handle?: object;
  denied: boolean;
  cancelled: boolean;
}

interface ResumeScopeRecord {
  readonly owner: RegistryState;
  readonly kind: 'resume';
  readonly operationId: string;
  readonly sourceId: string;
  readonly token: string;
  readonly attemptIdHash: string;
  readonly descriptorHash: string;
  readonly identityHash: string;
  readonly beginCallHash: string;
  readonly previousGeneration: number;
  readonly retryCount: number;
  readonly lastRetryCallHash?: string;
  readonly previousRenewedAt?: string;
  readonly previousLastObservedAt: string;
  readonly invocationDeadlineMs: number;
  readonly startedAtMonotonicMs: number;
  readonly deadlineAtMonotonicMs: number;
  readonly audit: object;
  ackPath?: AckPath;
  actualKey?: string;
  handle?: object;
  denied: boolean;
  cancelled: boolean;
}

interface HandleRecord {
  readonly owner: RegistryState;
  readonly scope: BeginScopeRecord | ResumeScopeRecord;
  readonly fence: Fence;
  readonly storeHash: string;
  readonly namespace: string;
  readonly sourceHash: string;
  readonly envelopeHash: string;
  readonly acknowledgedBackendNow: string;
  readonly leaseAcquiredAt: string;
  readonly expiresAt: string;
  readonly issuedAtMonotonicMs: number;
  readonly leaseRemainingMsAtMonotonicAnchor: number;
  consumed: boolean;
}

interface ConsumedRecord {
  readonly owner: RegistryState;
  readonly capability: object;
  readonly lease: HandleRecord;
  readonly completionCallHash: string;
  readonly audit: object;
  completionAckPath?: AckPath;
  proofActualKey?: string;
  proof?: object;
  result?: object;
  sourceVerdictWitness?: object;
  sourceVerdictWitnessInputKey?: string;
  stagedSourceVerdictReceipt?: SourceVerdictTerminalReceipt;
  stagedSourceVerdictReceiptInputKey?: string;
  stagedSourceVerdictReceiptBackendNow?: string;
  denied: boolean;
}

interface SourceVerdictWitnessRecord {
  readonly owner: RegistryState;
  readonly consumed: ConsumedRecord;
  readonly inputKey: string;
  readonly bindingKey: string;
  readonly branch: CompositionalAutomaticCaptureEvidenceReportV3['branch'];
  readonly verdict: 'no_supported_preference_detected' | 'unsupported_preference_meaning';
  readonly interpreterResultHash: string;
  readonly reasons: readonly CompositionalPreferenceV2Reason[];
}

interface ProofRecord {
  readonly owner: RegistryState;
  readonly consumed: ConsumedRecord;
  readonly invocation: 'initial_owner' | 'same_call_ack_recovered';
  readonly terminalReceipt: z.infer<typeof receiptSchema>;
  readonly actualKey: string;
}

interface FirstCommitResultRecord {
  readonly owner: RegistryState;
  readonly proof: ProofRecord;
}

export interface CompositionalAutomaticCaptureHandleRegistryV3 {
  startInitialBegin(
    attemptIdHash: string,
    descriptor: unknown,
    budget?: CompositionalCaptureWorkBudgetV3,
  ): CompositionalCaptureBeginInvocationV3;
  readInitialBeginScope(scope: unknown): CompositionalCaptureInitialBeginScopeSnapshotV3;
  issueInitialAfterAcknowledgedBegin(
    scope: PrivateCompositionalCaptureBeginScopeV3,
    actual: unknown,
  ): PrivateOneUseCompositionalCaptureLeaseHandleV3 | null;
  recoverInitialAfterUnknownAcknowledgement(
    scope: PrivateCompositionalCaptureBeginScopeV3,
    actual: unknown,
  ): PrivateOneUseCompositionalCaptureLeaseHandleV3 | null;
  startResume(
    attemptIdHash: string,
    previousActualOperation: unknown,
  ): CompositionalCaptureResumeInvocationV3;
  issueResumeAfterAcknowledgedWrite(
    scope: PrivateCompositionalCaptureResumeScopeV3,
    actual: unknown,
  ): PrivateOneUseCompositionalCaptureLeaseHandleV3 | null;
  recoverResumeAfterUnknownAcknowledgement(
    scope: PrivateCompositionalCaptureResumeScopeV3,
    actual: unknown,
  ): PrivateOneUseCompositionalCaptureLeaseHandleV3 | null;
  isLiveHandle(value: unknown): value is PrivateOneUseCompositionalCaptureLeaseHandleV3;
  consumeForCompletion(
    handle: PrivateOneUseCompositionalCaptureLeaseHandleV3,
    attemptIdHash: string,
  ): PrivateConsumedCompositionalCaptureInvocationV3;
  readConsumedInvocation(capability: unknown): CompositionalCaptureCompletionInvocationV3;
  readActiveConsumedInvocation(capability: unknown): CompositionalCaptureCompletionInvocationV3;
  prepareBundleStage(
    capability: PrivateConsumedCompositionalCaptureInvocationV3,
    actual: unknown,
    budget: unknown,
  ): CompositionalCompletionPreparedStageResultV3;
  prepareBundleApply(
    capability: PrivateConsumedCompositionalCaptureInvocationV3,
    stage: unknown,
    actual: unknown,
  ): CompositionalCompletionPreparedApplyResultV3;
  prepareSourceVerdictWitness(
    capability: PrivateConsumedCompositionalCaptureInvocationV3,
    actual: unknown,
  ): PrivateCompositionalCaptureSourceVerdictWitnessV3 | null;
  prepareSourceVerdictReceipt(
    capability: PrivateConsumedCompositionalCaptureInvocationV3,
    witness: PrivateCompositionalCaptureSourceVerdictWitnessV3,
    actual: unknown,
  ): SourceVerdictTerminalReceipt | null;
  readAttemptAudit(capability: unknown): CompositionalCaptureAttemptAuditV3;
  confirmInitialCommitAfterAcknowledgement(
    capability: PrivateConsumedCompositionalCaptureInvocationV3,
    actual: unknown,
  ): PrivateCompositionalCaptureFirstCommitProofV3 | null;
  recoverInitialCommitAfterUnknownAcknowledgement(
    capability: PrivateConsumedCompositionalCaptureInvocationV3,
    actual: unknown,
  ): PrivateCompositionalCaptureFirstCommitProofV3 | null;
  createInitialFirstCommitResult(
    proof: PrivateCompositionalCaptureFirstCommitProofV3,
  ): CompositionalCaptureEligibleFirstCommitResultV3 | null;
  markInvocationCancelled(capability: unknown): void;
  resultSchemas(): ReturnType<typeof createCompositionalCaptureInternalResultSchemasV3>;
}

const handles = new WeakMap<object, HandleRecord>();
const audits = new WeakMap<object, AuditRecord>();
const consumedInvocations = new WeakMap<object, ConsumedRecord>();
const sourceVerdictWitnesses = new WeakMap<object, SourceVerdictWitnessRecord>();
const proofs = new WeakMap<object, ProofRecord>();
const firstCommitResults = new WeakMap<object, FirstCommitResultRecord>();

/** Authentication for the exact handle/result pair; stale capabilities are deny-only latched. */
export function isCompositionalFirstCommitResultForHandleV3(
  result: unknown,
  originalHandle: unknown,
): result is CompositionalCaptureEligibleFirstCommitResultV3 {
  if (
    !result ||
    typeof result !== 'object' ||
    !originalHandle ||
    typeof originalHandle !== 'object'
  )
    return false;
  const resultRecord = firstCommitResults.get(result);
  const handleRecord = handles.get(originalHandle);
  if (!resultRecord || !handleRecord) return false;
  const proof = resultRecord.proof;
  const consumed = proof.consumed;
  const matchingChain = Boolean(
    handleRecord.consumed &&
    consumed.lease === handleRecord &&
    resultRecord.owner === handleRecord.owner &&
    proof.owner === handleRecord.owner &&
    consumed.owner === handleRecord.owner &&
    consumed.result === result &&
    consumed.proof &&
    proofs.get(consumed.proof) === proof &&
    handleRecord.fence.claimKind === 'initial' &&
    handleRecord.fence.generation === 1,
  );
  if (!matchingChain) return false;
  if (!proofIsLocallyValid(proof)) {
    consumed.denied = true;
    return false;
  }
  return true;
}

const completedNoneSourceVerdictReasons = new Set<CompositionalPreferenceV2Reason>([
  'quoted_content',
  'reported_statement',
  'third_party',
  'question',
  'hypothetical',
  'instruction',
]);
const unsupportedMeaningSourceVerdictReasons = new Set<CompositionalPreferenceV2Reason>([
  'unsupported_grammar',
  'unsupported_operator',
  'unsupported_topic',
  'unsupported_scope',
  'sensitive_scope',
  'ambiguous_attachment',
  'reported_statement',
  'third_party',
  'hypothetical',
  'instruction',
]);

function opaque<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function hashCallNonce(domain: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([0]))
    .update(randomBytes(32))
    .digest('hex');
}

function invalidHandle(): never {
  throw new Error('Engram compositional capture: invalid_handle');
}

function parseActual(value: unknown): CompositionalCaptureRegistryActualV3 | null {
  const parsed = CompositionalCaptureRegistryActualV3Schema.safeParse(value);
  if (!parsed.success) return null;
  return deepFreeze(parsed.data);
}

function resolveActual(value: unknown, check: () => void = () => {}): ResolvedActual | null {
  check();
  const actual = parseActual(value);
  check();
  if (!actual) return null;
  let checkFailure: unknown;
  let checkFailed = false;
  try {
    assertCompositionalRecordIdentityV3(actual.graph, () => {
      try {
        check();
      } catch (error) {
        checkFailed = true;
        checkFailure = error;
        throw error;
      }
    });
  } catch {
    if (checkFailed) throw checkFailure;
    return null;
  }
  const operation = actual.operation;
  const identity = operation.identity;
  if (
    actual.storeHash !== identity.storeHash ||
    actual.namespace !== identity.namespace ||
    Date.parse(actual.backendNow) < Date.parse(operation.lastObservedAt)
  )
    return null;

  let sourcesFound = 0;
  let source: (typeof actual.graph.episodes)[number] | undefined;
  for (const episode of actual.graph.episodes) {
    check();
    if (episode.uuid === identity.sourceId) {
      sourcesFound += 1;
      source = episode;
      if (sourcesFound > 1) return null;
    }
  }
  if (!source || sourcesFound !== 1 || source.group_id !== identity.namespace) return null;

  try {
    const tuple = validateCompositionalAutomaticSourceTupleV3(source);
    const reconstructed = reconstructCompositionalAutomaticSourceIdentityV3(
      source,
      operation.descriptor,
    );
    if (
      !reconcileCompositionalCaptureOperationIdentityV3(reconstructed.identity, identity) ||
      tuple.owner.namespace !== actual.namespace ||
      tuple.owner.storeHash !== actual.storeHash ||
      tuple.owner.role !== 'human' ||
      tuple.owner.purpose !== 'human_turn_memory'
    )
      return null;

    const subject = assertAutomaticBindingIdentity(
      actual.graph,
      identity.namespace,
      identity.issuer,
      identity.actorReference,
      tuple.owner.binding,
    );
    const authorityActive =
      source.review_status === 'accepted' &&
      source.trust_level === operation.descriptor.requestedTrustLevel &&
      subject.group_id === identity.namespace;
    const descriptorHash = hashCompositionalAutomaticDescriptorV3(operation.descriptor);
    const identityHash = compositionalCaptureOperationIdentityHashV3(identity);
    const sourceHash = identity.sourceHash;
    const envelope = CompositionalAutomaticCaptureSourceEnvelopeV2Schema.parse(tuple.envelope);
    const envelopeHash = hashAutomaticCaptureV2(envelope);
    const authorityKey = hashAutomaticCaptureV2({
      binding: tuple.owner.binding,
      sourceReview: source.review_status,
      sourceTrust: source.trust_level,
      subjectId: subject.uuid,
      subjectGroup: subject.group_id,
    });
    const snapshotKey = hashAutomaticCaptureV2({
      storeHash: actual.storeHash,
      namespace: actual.namespace,
      source: source,
      operation: operation,
    });
    return {
      actual,
      source,
      operation,
      identityHash,
      descriptorHash,
      sourceHash,
      envelopeHash,
      authorityActive,
      authorityKey,
      snapshotKey,
    };
  } catch {
    return null;
  }
}

function fenceFor(actual: ResolvedActual): Fence | null {
  const operation = actual.operation;
  if (operation.state !== 'leased') return null;
  return deepFreeze(
    fenceSchema.parse({
      version: 3,
      purpose: 'human_turn_memory',
      operationId: operation.operationId,
      sourceId: operation.identity.sourceId,
      descriptorHash: actual.descriptorHash,
      identityHash: actual.identityHash,
      sourceHash: operation.identity.sourceHash,
      envelopeHash: actual.envelopeHash,
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
    }),
  );
}

function localTimeIsValid(scope: BeginScopeRecord | ResumeScopeRecord, now = performance.now()) {
  return !scope.cancelled && !scope.denied && now < scope.deadlineAtMonotonicMs;
}

function handleTimeIsValid(record: HandleRecord, now = performance.now()): boolean {
  return (
    !record.consumed &&
    localTimeIsValid(record.scope, now) &&
    now - record.issuedAtMonotonicMs < record.leaseRemainingMsAtMonotonicAnchor
  );
}

function activeConsumedRecord(state: RegistryState, capability: unknown): ConsumedRecord {
  if (capability === null || typeof capability !== 'object') return invalidHandle();
  const consumed = consumedInvocations.get(capability);
  if (!consumed || consumed.owner !== state || consumed.capability !== capability)
    return invalidHandle();
  const scope = consumed.lease.scope;
  if (scope.cancelled) throw new Error('Engram compositional capture: interrupted');
  if (consumed.denied || scope.denied) return invalidHandle();
  const now = performance.now();
  if (
    !Number.isFinite(now) ||
    now >= scope.deadlineAtMonotonicMs ||
    now - consumed.lease.issuedAtMonotonicMs >= consumed.lease.leaseRemainingMsAtMonotonicAnchor
  ) {
    consumed.denied = true;
    throw new Error('Engram compositional capture: budget_exhausted');
  }
  return consumed;
}

function completionInvocationView(
  consumed: ConsumedRecord,
): CompositionalCaptureCompletionInvocationV3 {
  const lease = consumed.lease;
  return deepFreeze(
    parseCompositionalCaptureCompletionInvocationV3({
      boundFence: lease.fence,
      storeHash: lease.storeHash,
      namespace: lease.namespace,
      sourceHash: lease.sourceHash,
      envelopeHash: lease.envelopeHash,
      expiresAt: lease.expiresAt,
      acknowledgedBackendNow: lease.acknowledgedBackendNow,
      leaseRemainingMsAtMonotonicAnchor: lease.leaseRemainingMsAtMonotonicAnchor,
      invocationDeadlineAtMonotonicMs: lease.scope.deadlineAtMonotonicMs,
      claimKind: lease.fence.claimKind,
      completionCallHash: consumed.completionCallHash,
      audit: consumed.audit,
    }),
  );
}

function sourceVerdictForReport(
  report: CompositionalAutomaticCaptureEvidenceReportV3,
): SourceVerdictWitnessRecord['verdict'] | null {
  const result = report.evidence.result;
  if (
    result.bundles.length !== 0 ||
    result.withheld.length !== 0 ||
    result.sourceRequest !== undefined
  )
    return null;
  if (
    report.branch === 'completed_none' &&
    result.coverage === 'none' &&
    result.reasons.every((reason) => completedNoneSourceVerdictReasons.has(reason))
  )
    return 'no_supported_preference_detected';
  if (
    report.branch === 'unsupported_meaning' &&
    result.coverage === 'unknown' &&
    result.reasons.length > 0 &&
    result.reasons.every((reason) => unsupportedMeaningSourceVerdictReasons.has(reason))
  )
    return 'unsupported_preference_meaning';
  return null;
}

function sourceVerdictInputKey(consumed: ConsumedRecord, actual: ResolvedActual): string | null {
  try {
    const observedSourceHash = compositionalCaptureSourceHashV3(actual.source);
    return hashAutomaticCaptureV2({
      domain: 'engram-compositional-source-verdict-witness-input-v3',
      completionCallHash: consumed.completionCallHash,
      operationId: actual.operation.operationId,
      sourceId: actual.operation.identity.sourceId,
      storeHash: actual.actual.storeHash,
      namespace: actual.actual.namespace,
      capturedIdentityHash: consumed.lease.fence.identityHash,
      observedIdentityHash: actual.identityHash,
      capturedSourceHash: consumed.lease.sourceHash,
      observedSourceHash,
      capturedEnvelopeHash: consumed.lease.envelopeHash,
      observedEnvelopeHash: actual.envelopeHash,
      descriptorHash: actual.descriptorHash,
      authorityKey: actual.authorityKey,
      fence: consumed.lease.fence,
    });
  } catch {
    return null;
  }
}

function sourceVerdictWitnessBindingKey(
  inputKey: string,
  interpreterResultHash: string,
  branch: CompositionalAutomaticCaptureEvidenceReportV3['branch'],
  verdict: SourceVerdictWitnessRecord['verdict'],
  reasons: readonly CompositionalPreferenceV2Reason[],
): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-compositional-source-verdict-witness-v3',
    inputKey,
    interpreterResultHash,
    branch,
    verdict,
    reasons,
  });
}

function activeLeasedFieldsMatch(consumed: ConsumedRecord, actual: ResolvedActual): boolean {
  if (!actual.authorityActive || actual.operation.state !== 'leased') return false;
  const operation = actual.operation;
  const expectedFence = consumed.lease.fence;
  const currentFence = fenceFor(actual);
  const backendNow = Date.parse(actual.actual.backendNow);
  const expiresAt = Date.parse(operation.lease.expiresAt);
  return !(
    !currentFence ||
    hashAutomaticCaptureV2(currentFence) !== hashAutomaticCaptureV2(expectedFence) ||
    actual.actual.storeHash !== consumed.lease.storeHash ||
    actual.actual.namespace !== consumed.lease.namespace ||
    actual.identityHash !== expectedFence.identityHash ||
    actual.descriptorHash !== expectedFence.descriptorHash ||
    actual.sourceHash !== consumed.lease.sourceHash ||
    actual.envelopeHash !== consumed.lease.envelopeHash ||
    operation.lease.acquiredAt !== consumed.lease.leaseAcquiredAt ||
    operation.lease.expiresAt !== consumed.lease.expiresAt ||
    !Number.isFinite(backendNow) ||
    !Number.isFinite(expiresAt) ||
    backendNow < Date.parse(consumed.lease.acknowledgedBackendNow) ||
    backendNow >= expiresAt
  );
}

function resolveActiveLeasedActual(
  consumed: ConsumedRecord,
  actualValue: unknown,
): ResolvedActual | null {
  const actual = resolveActual(actualValue, () => {
    activeConsumedRecord(consumed.owner, consumed.capability);
  });
  return actual && activeLeasedFieldsMatch(consumed, actual) ? actual : null;
}

function sourceVerdictReceiptMatchesWitness(
  consumed: ConsumedRecord,
  receipt: SourceVerdictTerminalReceipt,
): boolean {
  const witnessValue = consumed.sourceVerdictWitness;
  if (!witnessValue) return false;
  const witness = sourceVerdictWitnesses.get(witnessValue);
  if (
    !witness ||
    witness.owner !== consumed.owner ||
    witness.consumed !== consumed ||
    consumed.sourceVerdictWitnessInputKey !== witness.inputKey ||
    consumed.stagedSourceVerdictReceiptInputKey !== witness.inputKey ||
    consumed.stagedSourceVerdictReceiptBackendNow !== receipt.terminalAt ||
    !consumed.stagedSourceVerdictReceipt ||
    hashAutomaticCaptureV2(consumed.stagedSourceVerdictReceipt) !== hashAutomaticCaptureV2(receipt)
  )
    return false;

  const expectedCoverage =
    witness.verdict === 'no_supported_preference_detected' ? 'none' : 'unknown';
  return (
    receipt.kind === 'human_compositional_source_verdict_committed' &&
    receipt.operationId === consumed.lease.fence.operationId &&
    receipt.sourceId === consumed.lease.fence.sourceId &&
    receipt.sourceHash === consumed.lease.sourceHash &&
    receipt.descriptorHash === consumed.lease.fence.descriptorHash &&
    receipt.interpretationCoverage === expectedCoverage &&
    receipt.acceptedCoverage === 'none' &&
    receipt.reasons.length === witness.reasons.length &&
    receipt.reasons.every((reason, index) => reason === witness.reasons[index]) &&
    receipt.selection.kind === 'source_verdict' &&
    receipt.selection.verdict === witness.verdict &&
    receipt.selection.interpreterResultHash === witness.interpreterResultHash
  );
}

function makeAudit(
  owner: RegistryState,
  action: AuditRecord['action'],
  attemptIdHash: string,
  operationId: string,
  sourceId: string,
): object {
  const cap = opaque<object>();
  audits.set(cap, { owner, action, attemptIdHash, operationId, sourceId });
  return cap;
}

function actualTerminalKey(actual: ResolvedActual): string {
  const operation = actual.operation;
  if (operation.state !== 'committed') return '';
  return hashAutomaticCaptureV2({
    storeHash: actual.actual.storeHash,
    namespace: actual.actual.namespace,
    sourceHash: compositionalCaptureSourceHashV3(actual.source),
    identityHash: actual.identityHash,
    descriptorHash: actual.descriptorHash,
    operationId: operation.operationId,
    beginCallHash: operation.beginCallHash,
    generation: operation.generation,
    retryCount: operation.retryCount,
    lastRetryCallHash: operation.lastRetryCallHash,
    completionCallHash: operation.completionCallHash,
    terminalReceipt: operation.terminalReceipt,
    authorityKey: actual.authorityKey,
  });
}

function makeHandle(
  state: RegistryState,
  scope: BeginScopeRecord | ResumeScopeRecord,
  actual: ResolvedActual,
  fence: Fence,
): object {
  const handle = opaque<object>();
  const lease = actual.operation.state === 'leased' ? actual.operation.lease : null;
  if (!lease) return invalidHandle();
  const remainingMs = Date.parse(lease.expiresAt) - Date.parse(actual.actual.backendNow);
  if (remainingMs <= 0) return invalidHandle();
  handles.set(handle, {
    owner: state,
    scope,
    fence,
    storeHash: actual.actual.storeHash,
    namespace: actual.actual.namespace,
    sourceHash: actual.sourceHash,
    envelopeHash: actual.envelopeHash,
    acknowledgedBackendNow: actual.actual.backendNow,
    leaseAcquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    issuedAtMonotonicMs: performance.now(),
    leaseRemainingMsAtMonotonicAnchor: remainingMs,
    consumed: false,
  });
  return handle;
}

function issueInitial(
  state: RegistryState,
  scopeValue: unknown,
  actualValue: unknown,
  ackPath: AckPath,
): PrivateOneUseCompositionalCaptureLeaseHandleV3 | null {
  if (scopeValue === null || typeof scopeValue !== 'object') return null;
  const scope = state.scopes.get(scopeValue) as BeginScopeRecord | undefined;
  if (!scope || scope.owner !== state || scope.kind !== 'initial' || scope.denied) return null;
  if (scope.ackPath && scope.ackPath !== ackPath) {
    scope.denied = true;
    return null;
  }
  const resolved = resolveActual(actualValue);
  if (!resolved) return null;
  if (!resolved.authorityActive || !localTimeIsValid(scope)) {
    scope.denied = true;
    return null;
  }
  const operation = resolved.operation;
  const fence = fenceFor(resolved);
  if (
    !fence ||
    operation.state !== 'leased' ||
    operation.operationId !== scope.operationId ||
    operation.identity.sourceId !== scope.sourceId ||
    operation.beginCallHash !== scope.beginCallHash ||
    operation.lease.token !== scope.token ||
    operation.generation !== 1 ||
    operation.lease.claimKind !== 'initial' ||
    operation.retryCount !== 0 ||
    operation.lastRetryCallHash !== undefined ||
    resolved.descriptorHash !== scope.descriptorHash ||
    operation.descriptor.invocationDeadlineMs !== scope.invocationDeadlineMs ||
    Date.parse(resolved.actual.backendNow) >= Date.parse(operation.lease.expiresAt)
  ) {
    scope.denied = true;
    return null;
  }
  if (scope.actualKey !== undefined && scope.actualKey !== resolved.snapshotKey) {
    scope.denied = true;
    return null;
  }
  scope.ackPath = ackPath;
  scope.actualKey = resolved.snapshotKey;
  if (scope.handle) {
    const prior = handles.get(scope.handle);
    return prior && prior.owner === state && handleTimeIsValid(prior)
      ? (scope.handle as PrivateOneUseCompositionalCaptureLeaseHandleV3)
      : null;
  }
  if (!localTimeIsValid(scope)) return null;
  const handle = makeHandle(state, scope, resolved, fence);
  if (!localTimeIsValid(scope)) return null;
  scope.handle = handle;
  return handle as PrivateOneUseCompositionalCaptureLeaseHandleV3;
}

function issueResume(
  state: RegistryState,
  scopeValue: unknown,
  actualValue: unknown,
  ackPath: AckPath,
): PrivateOneUseCompositionalCaptureLeaseHandleV3 | null {
  if (scopeValue === null || typeof scopeValue !== 'object') return null;
  const scope = state.scopes.get(scopeValue) as ResumeScopeRecord | undefined;
  if (!scope || scope.owner !== state || scope.kind !== 'resume' || scope.denied) return null;
  if (scope.ackPath && scope.ackPath !== ackPath) {
    scope.denied = true;
    return null;
  }
  const resolved = resolveActual(actualValue);
  if (!resolved) return null;
  if (!resolved.authorityActive || !localTimeIsValid(scope)) {
    scope.denied = true;
    return null;
  }
  const operation = resolved.operation;
  const fence = fenceFor(resolved);
  if (
    !fence ||
    operation.state !== 'leased' ||
    operation.operationId !== scope.operationId ||
    operation.identity.sourceId !== scope.sourceId ||
    operation.beginCallHash !== scope.beginCallHash ||
    operation.lease.token !== scope.token ||
    operation.generation !== scope.previousGeneration + 1 ||
    operation.lease.claimKind !== 'resume' ||
    operation.retryCount !== scope.retryCount ||
    operation.lastRetryCallHash !== scope.lastRetryCallHash ||
    resolved.identityHash !== scope.identityHash ||
    resolved.descriptorHash !== scope.descriptorHash ||
    operation.descriptor.invocationDeadlineMs !== scope.invocationDeadlineMs ||
    Date.parse(resolved.actual.backendNow) >= Date.parse(operation.lease.expiresAt) ||
    Date.parse(operation.lastObservedAt) < Date.parse(scope.previousLastObservedAt) ||
    (scope.previousRenewedAt !== undefined &&
      Date.parse(operation.lease.renewedAt) < Date.parse(scope.previousRenewedAt))
  ) {
    scope.denied = true;
    return null;
  }
  if (scope.actualKey !== undefined && scope.actualKey !== resolved.snapshotKey) {
    scope.denied = true;
    return null;
  }
  scope.ackPath = ackPath;
  scope.actualKey = resolved.snapshotKey;
  if (scope.handle) {
    const prior = handles.get(scope.handle);
    return prior && prior.owner === state && handleTimeIsValid(prior)
      ? (scope.handle as PrivateOneUseCompositionalCaptureLeaseHandleV3)
      : null;
  }
  const handle = makeHandle(state, scope, resolved, fence);
  if (!localTimeIsValid(scope)) return null;
  scope.handle = handle;
  return handle as PrivateOneUseCompositionalCaptureLeaseHandleV3;
}

function proofIsLocallyValid(proof: ProofRecord, now = performance.now()): boolean {
  return (
    !proof.consumed.denied &&
    !proof.consumed.lease.scope.cancelled &&
    !proof.consumed.lease.scope.denied &&
    now < proof.consumed.lease.scope.deadlineAtMonotonicMs &&
    now - proof.consumed.lease.issuedAtMonotonicMs <
      proof.consumed.lease.leaseRemainingMsAtMonotonicAnchor
  );
}

function resolveCommittedActualBase(
  consumed: ConsumedRecord,
  actualValue: unknown,
): { actual: ResolvedActual; actualKey: string } | null {
  const actual = resolveActual(actualValue, () => {
    activeConsumedRecord(consumed.owner, consumed.capability);
  });
  if (!actual || !actual.authorityActive || actual.operation.state !== 'committed') return null;
  const fence = consumed.lease.fence;
  const operation = actual.operation;
  if (
    actual.actual.storeHash !== consumed.lease.storeHash ||
    actual.actual.namespace !== consumed.lease.namespace ||
    operation.operationId !== fence.operationId ||
    operation.identity.sourceId !== fence.sourceId ||
    actual.descriptorHash !== fence.descriptorHash ||
    actual.identityHash !== fence.identityHash ||
    actual.envelopeHash !== consumed.lease.envelopeHash ||
    operation.beginCallHash !== fence.beginCallHash ||
    operation.generation !== fence.generation ||
    operation.retryCount !== fence.retryCount ||
    operation.lastRetryCallHash !== fence.lastRetryCallHash ||
    operation.completionCallHash !== consumed.completionCallHash ||
    fence.claimKind !== 'initial' ||
    fence.generation !== 1
  )
    return null;
  const receipt = receiptSchema.safeParse(operation.terminalReceipt);
  if (
    !receipt.success ||
    (receipt.data.kind !== 'human_compositional_capture_committed' &&
      receipt.data.kind !== 'human_compositional_source_verdict_committed') ||
    receipt.data.operationId !== operation.operationId ||
    receipt.data.sourceId !== operation.identity.sourceId ||
    receipt.data.sourceHash !== operation.identity.sourceHash ||
    receipt.data.descriptorHash !== actual.descriptorHash ||
    receipt.data.policyFingerprint !== operation.descriptor.policy.fingerprint ||
    Date.parse(receipt.data.terminalAt) >= Date.parse(consumed.lease.expiresAt) ||
    Date.parse(actual.actual.backendNow) < Date.parse(receipt.data.terminalAt)
  )
    return null;
  // A structural source-verdict receipt is never enough for a positive proof.
  if (
    receipt.data.kind === 'human_compositional_source_verdict_committed' &&
    !sourceVerdictReceiptMatchesWitness(consumed, receipt.data)
  )
    return null;
  return { actual, actualKey: actualTerminalKey(actual) };
}

function verifyCommittedActual(
  consumed: ConsumedRecord,
  actualValue: unknown,
): { actual: ResolvedActual; actualKey: string } | null {
  const verified = resolveCommittedActualBase(consumed, actualValue);
  if (!verified) return null;
  if (
    verified.actual.operation.state === 'committed' &&
    verified.actual.operation.terminalReceipt.kind === 'human_compositional_capture_committed' &&
    !consumed.owner.verifyBundles?.(consumed.capability, verified.actual.actual)
  )
    return null;
  activeConsumedRecord(consumed.owner, consumed.capability);
  return verified;
}

/** Private in-process capability registry. It performs no storage work. */
export function createCompositionalAutomaticCaptureHandleRegistryV3(): CompositionalAutomaticCaptureHandleRegistryV3 {
  const state: RegistryState = { scopes: new WeakMap() };
  let schemas: ReturnType<typeof createCompositionalCaptureInternalResultSchemasV3> | undefined;

  const isLiveHandle = (
    value: unknown,
  ): value is PrivateOneUseCompositionalCaptureLeaseHandleV3 => {
    if (value === null || typeof value !== 'object') return false;
    const record = handles.get(value);
    return Boolean(record && record.owner === state && handleTimeIsValid(record));
  };

  const isFirstCommitResult = (
    value: unknown,
  ): value is CompositionalCaptureEligibleFirstCommitResultV3 => {
    if (value === null || typeof value !== 'object') return false;
    const record = firstCommitResults.get(value);
    if (!record || record.owner !== state || !proofIsLocallyValid(record.proof)) {
      if (record) record.proof.consumed.denied = true;
      return false;
    }
    return true;
  };

  const registry: CompositionalAutomaticCaptureHandleRegistryV3 = {
    readInitialBeginScope(scopeValue) {
      if (scopeValue === null || typeof scopeValue !== 'object') return invalidHandle();
      const scope = state.scopes.get(scopeValue);
      if (!scope || scope.owner !== state || scope.kind !== 'initial') return invalidHandle();
      if (scope.cancelled) throw new Error('Engram compositional capture: interrupted');
      if (scope.denied) return invalidHandle();
      if (performance.now() >= scope.deadlineAtMonotonicMs) {
        throw new Error('Engram compositional capture: budget_exhausted');
      }
      return deepFreeze(
        parseCompositionalCaptureInitialBeginScopeSnapshotV3({
          scope: scopeValue,
          sourceId: scope.sourceId,
          operationId: scope.operationId,
          leaseToken: scope.token,
          beginCallHash: scope.beginCallHash,
          descriptorHash: scope.descriptorHash,
          invocationDeadlineMs: scope.invocationDeadlineMs,
          audit: scope.audit,
        }),
      );
    },

    startInitialBegin(attemptIdHashValue, descriptorValue, budgetValue) {
      const startedAtMonotonicMs = performance.now();
      let attemptHash: string;
      let descriptor: z.infer<typeof descriptorSchema>;
      let workAllowanceMs: number;
      try {
        if (typeof attemptIdHashValue !== 'string') throw new Error('invalid');
        attemptHash = attemptHashSchema.parse(attemptIdHashValue);
        descriptor = descriptorSchema.parse(
          cloneBoundedAutomaticCaptureJson(descriptorValue, 'beginRequest'),
        );
        const budget =
          budgetValue === undefined
            ? undefined
            : CompositionalCaptureWorkBudgetV3Schema.parse(
                cloneBoundedAutomaticCaptureJson(budgetValue, 'beginRequest'),
              );
        if (budget && budget.remainingMs > descriptor.invocationDeadlineMs)
          throw new Error('invalid');
        workAllowanceMs = budget?.remainingMs ?? descriptor.invocationDeadlineMs;
      } catch {
        throw new Error('Engram compositional capture: invalid_input');
      }
      const deadlineAtMonotonicMs = startedAtMonotonicMs + workAllowanceMs;
      if (performance.now() >= deadlineAtMonotonicMs)
        throw new Error('Engram compositional capture: budget_exhausted');
      const invocationDeadlineMs = descriptor.invocationDeadlineMs;
      const sourceId = randomUUID();
      const operationId = randomUUID();
      const token = randomUUID();
      const beginCallHash = hashCallNonce('automatic-capture-begin-v3');
      const scope = opaque<PrivateCompositionalCaptureBeginScopeV3>();
      const audit = makeAudit(state, 'initial', attemptHash, operationId, sourceId);
      const record: BeginScopeRecord = {
        owner: state,
        kind: 'initial',
        sourceId,
        operationId,
        token,
        beginCallHash,
        attemptIdHash: attemptHash,
        descriptorHash: hashCompositionalAutomaticDescriptorV3(descriptor),
        invocationDeadlineMs,
        startedAtMonotonicMs,
        deadlineAtMonotonicMs,
        audit,
        denied: false,
        cancelled: false,
      };
      state.scopes.set(scope, record);
      const invocation = deepFreeze(
        parseCompositionalCaptureBeginInvocationV3({
          scope,
          sourceId,
          operationId,
          leaseToken: token,
          beginCallHash,
          audit,
        }),
      );
      if (performance.now() >= deadlineAtMonotonicMs) {
        record.denied = true;
        throw new Error('Engram compositional capture: budget_exhausted');
      }
      return invocation;
    },

    issueInitialAfterAcknowledgedBegin(scope, actual) {
      return issueInitial(state, scope, actual, 'acknowledged');
    },

    recoverInitialAfterUnknownAcknowledgement(scope, actual) {
      return issueInitial(state, scope, actual, 'unknown_ack_recovery');
    },

    startResume(attemptIdHashValue, previousActualOperation) {
      const attemptHash = attemptHashSchema.safeParse(attemptIdHashValue);
      const previous = resolveActual(previousActualOperation);
      if (!attemptHash.success || !previous || !previous.authorityActive)
        throw new Error('Engram compositional capture: invalid_resume_context');
      const operation = previous.operation;
      const now = Date.parse(previous.actual.backendNow);
      const resumable =
        operation.state === 'failed' ||
        operation.state === 'interrupted' ||
        (operation.state === 'leased' && now >= Date.parse(operation.lease.expiresAt));
      if (!resumable || operation.generation >= AUTOMATIC_LEDGER_LIMITS.maxGeneration)
        throw new Error('Engram compositional capture: invalid_resume_context');
      const startedAtMonotonicMs = performance.now();
      const invocationDeadlineMs = operation.descriptor.invocationDeadlineMs;
      const token = randomUUID();
      const scope = opaque<PrivateCompositionalCaptureResumeScopeV3>();
      const audit = makeAudit(
        state,
        'resume',
        attemptHash.data,
        operation.operationId,
        operation.identity.sourceId,
      );
      const previousRenewedAt =
        operation.state === 'leased' ? operation.lease.renewedAt : undefined;
      const record: ResumeScopeRecord = {
        owner: state,
        kind: 'resume',
        operationId: operation.operationId,
        sourceId: operation.identity.sourceId,
        token,
        attemptIdHash: attemptHash.data,
        descriptorHash: previous.descriptorHash,
        identityHash: previous.identityHash,
        beginCallHash: operation.beginCallHash,
        previousGeneration: operation.generation,
        retryCount: operation.retryCount,
        lastRetryCallHash: operation.lastRetryCallHash,
        previousLastObservedAt: operation.lastObservedAt,
        ...(previousRenewedAt === undefined ? {} : { previousRenewedAt }),
        invocationDeadlineMs,
        startedAtMonotonicMs,
        deadlineAtMonotonicMs: startedAtMonotonicMs + invocationDeadlineMs,
        audit,
        denied: false,
        cancelled: false,
      };
      state.scopes.set(scope, record);
      return deepFreeze(
        parseCompositionalCaptureResumeInvocationV3({
          scope,
          operationId: operation.operationId,
          sourceId: operation.identity.sourceId,
          leaseToken: token,
          audit,
        }),
      );
    },

    issueResumeAfterAcknowledgedWrite(scope, actual) {
      return issueResume(state, scope, actual, 'acknowledged');
    },

    recoverResumeAfterUnknownAcknowledgement(scope, actual) {
      return issueResume(state, scope, actual, 'unknown_ack_recovery');
    },

    isLiveHandle,

    consumeForCompletion(handle, attemptIdHashValue) {
      if (handle === null || typeof handle !== 'object') return invalidHandle();
      const record = handles.get(handle);
      if (!record || record.owner !== state || !handleTimeIsValid(record)) return invalidHandle();

      // One-use fencing occurs synchronously before validating optional metadata or doing I/O.
      record.consumed = true;
      const attemptHash = attemptHashSchema.safeParse(attemptIdHashValue);
      if (!attemptHash.success) return invalidHandle();
      const completionCallHash = hashCallNonce('automatic-capture-complete-v3');
      const audit = makeAudit(
        state,
        'completion',
        attemptHash.data,
        record.fence.operationId,
        record.fence.sourceId,
      );
      const capability = opaque<PrivateConsumedCompositionalCaptureInvocationV3>();
      const consumed: ConsumedRecord = {
        owner: state,
        capability,
        lease: record,
        completionCallHash,
        audit,
        denied: false,
      };
      consumedInvocations.set(capability, consumed);
      return capability;
    },

    readConsumedInvocation(capability) {
      if (capability === null || typeof capability !== 'object') return invalidHandle();
      const consumed = consumedInvocations.get(capability);
      if (!consumed || consumed.owner !== state || consumed.capability !== capability)
        return invalidHandle();
      return completionInvocationView(consumed);
    },

    readActiveConsumedInvocation(capability) {
      return completionInvocationView(activeConsumedRecord(state, capability));
    },

    prepareBundleStage(capability, actual, budget) {
      return bundleStages.prepare(capability, actual, budget);
    },

    prepareBundleApply(capability, stage, actual) {
      return bundleStages.prepareApply(capability, stage, actual);
    },

    prepareSourceVerdictWitness(capability, actualValue) {
      // The capability boundary is checked before snapshotActual can inspect input properties.
      const consumed = activeConsumedRecord(state, capability);
      const actual = resolveActiveLeasedActual(consumed, actualValue);
      if (!actual) {
        consumed.denied = true;
        return null;
      }
      activeConsumedRecord(state, capability);
      const inputKey = sourceVerdictInputKey(consumed, actual);
      if (!inputKey) {
        consumed.denied = true;
        return null;
      }
      activeConsumedRecord(state, capability);

      if (consumed.sourceVerdictWitness) {
        const previous = sourceVerdictWitnesses.get(consumed.sourceVerdictWitness);
        if (
          !previous ||
          previous.owner !== state ||
          previous.consumed !== consumed ||
          previous.inputKey !== inputKey ||
          consumed.sourceVerdictWitnessInputKey !== inputKey
        ) {
          consumed.denied = true;
          return null;
        }
        activeConsumedRecord(state, capability);
        return consumed.sourceVerdictWitness as PrivateCompositionalCaptureSourceVerdictWitnessV3;
      }

      const check = () => {
        const active = activeConsumedRecord(state, capability);
        if (active !== consumed) return invalidHandle();
      };
      let report: CompositionalAutomaticCaptureEvidenceReportV3;
      try {
        report = interpretCompositionalHumanSourceV3EvidenceWithExecutionReport(
          actual.source,
          actual.operation.descriptor,
          actual.operation.identity,
          check,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'Engram compositional capture: budget_exhausted' ||
            error.message === 'Engram compositional capture: interrupted')
        )
          throw error;
        consumed.denied = true;
        return null;
      }
      check();
      if (sourceVerdictInputKey(consumed, actual) !== inputKey) {
        consumed.denied = true;
        return null;
      }
      const verdict = sourceVerdictForReport(report);
      if (!verdict) return null;

      const reasons = deepFreeze([...report.evidence.result.reasons]);
      const bindingKey = sourceVerdictWitnessBindingKey(
        inputKey,
        report.evidence.interpreterResultHash,
        report.branch,
        verdict,
        reasons,
      );
      const witness = opaque<PrivateCompositionalCaptureSourceVerdictWitnessV3>();
      sourceVerdictWitnesses.set(witness, {
        owner: state,
        consumed,
        inputKey,
        bindingKey,
        branch: report.branch,
        verdict,
        interpreterResultHash: report.evidence.interpreterResultHash,
        reasons,
      });
      consumed.sourceVerdictWitness = witness;
      consumed.sourceVerdictWitnessInputKey = inputKey;
      check();
      return witness;
    },

    prepareSourceVerdictReceipt(capability, witnessValue, actualValue) {
      // Check the consumed capability and witness before the actual snapshot is inspected.
      const consumed = activeConsumedRecord(state, capability);
      if (witnessValue === null || typeof witnessValue !== 'object') return invalidHandle();
      const witness = sourceVerdictWitnesses.get(witnessValue);
      if (
        !witness ||
        witness.owner !== state ||
        witness.consumed !== consumed ||
        consumed.sourceVerdictWitness !== witnessValue ||
        consumed.sourceVerdictWitnessInputKey !== witness.inputKey ||
        sourceVerdictWitnessBindingKey(
          witness.inputKey,
          witness.interpreterResultHash,
          witness.branch,
          witness.verdict,
          witness.reasons,
        ) !== witness.bindingKey
      ) {
        consumed.denied = true;
        return null;
      }

      const resolved = resolveActual(actualValue, () => {
        activeConsumedRecord(state, capability);
      });
      if (!resolved) {
        consumed.denied = true;
        return null;
      }
      // A committed callback retry belongs on the exact acknowledgement-recovery path.
      // Never rebuild or replace a receipt from a terminal snapshot.
      if (resolved.operation.state === 'committed') {
        if (!verifyCommittedActual(consumed, actualValue)) {
          consumed.denied = true;
          return null;
        }
        activeConsumedRecord(state, capability);
        return null;
      }
      if (!activeLeasedFieldsMatch(consumed, resolved)) {
        consumed.denied = true;
        return null;
      }
      const actual = resolved;
      activeConsumedRecord(state, capability);
      const inputKey = sourceVerdictInputKey(consumed, actual);
      if (!inputKey || inputKey !== witness.inputKey) {
        consumed.denied = true;
        return null;
      }
      const backendNow = Date.parse(actual.actual.backendNow);
      if (!Number.isFinite(backendNow)) {
        consumed.denied = true;
        return null;
      }

      const previousReceipt = consumed.stagedSourceVerdictReceipt;
      if (previousReceipt) {
        const previousBackendNow = Date.parse(consumed.stagedSourceVerdictReceiptBackendNow ?? '');
        if (
          consumed.stagedSourceVerdictReceiptInputKey !== witness.inputKey ||
          !Number.isFinite(previousBackendNow) ||
          previousReceipt.terminalAt !== consumed.stagedSourceVerdictReceiptBackendNow ||
          backendNow < previousBackendNow
        ) {
          consumed.denied = true;
          return null;
        }
        if (backendNow === previousBackendNow) {
          activeConsumedRecord(state, capability);
          return previousReceipt;
        }
      } else if (
        consumed.stagedSourceVerdictReceiptInputKey !== undefined ||
        consumed.stagedSourceVerdictReceiptBackendNow !== undefined
      ) {
        consumed.denied = true;
        return null;
      }

      const receiptResult = receiptSchema.safeParse({
        version: 3,
        kind: 'human_compositional_source_verdict_committed',
        operationId: actual.operation.operationId,
        sourceId: actual.operation.identity.sourceId,
        sourceHash: actual.operation.identity.sourceHash,
        descriptorHash: actual.descriptorHash,
        policyFingerprint: actual.operation.descriptor.policy.fingerprint,
        terminalAt: actual.actual.backendNow,
        reasons: [...witness.reasons],
        interpretationCoverage:
          witness.verdict === 'no_supported_preference_detected' ? 'none' : 'unknown',
        acceptedCoverage: 'none',
        selection: {
          kind: 'source_verdict',
          verdict: witness.verdict,
          interpreterResultHash: witness.interpreterResultHash,
        },
      });
      if (
        !receiptResult.success ||
        receiptResult.data.kind !== 'human_compositional_source_verdict_committed'
      ) {
        consumed.denied = true;
        return null;
      }
      activeConsumedRecord(state, capability);
      const receipt = deepFreeze(receiptResult.data);
      activeConsumedRecord(state, capability);
      consumed.stagedSourceVerdictReceipt = receipt;
      consumed.stagedSourceVerdictReceiptInputKey = witness.inputKey;
      consumed.stagedSourceVerdictReceiptBackendNow = actual.actual.backendNow;
      return receipt;
    },

    readAttemptAudit(capability) {
      if (capability === null || typeof capability !== 'object') return invalidHandle();
      const record = audits.get(capability);
      if (!record || record.owner !== state) return invalidHandle();
      return deepFreeze(
        parseCompositionalCaptureAttemptAuditV3({
          action: record.action,
          attemptIdHash: record.attemptIdHash,
          operationId: record.operationId,
          sourceId: record.sourceId,
        }),
      );
    },

    confirmInitialCommitAfterAcknowledgement(capability, actual) {
      return confirmInitialCommit(state, capability, actual, 'acknowledged');
    },

    recoverInitialCommitAfterUnknownAcknowledgement(capability, actual) {
      return confirmInitialCommit(state, capability, actual, 'unknown_ack_recovery');
    },

    createInitialFirstCommitResult(proof) {
      if (proof === null || typeof proof !== 'object') return null;
      const proofRecord = proofs.get(proof);
      if (!proofRecord || proofRecord.owner !== state || !proofIsLocallyValid(proofRecord)) {
        if (proofRecord) proofRecord.consumed.denied = true;
        return null;
      }
      if (proofRecord.consumed.result) {
        return proofRecord.consumed.result as CompositionalCaptureEligibleFirstCommitResultV3;
      }
      const result = deepFreeze(
        parseCompositionalCaptureEligibleFirstCommitResultBodyV3({
          kind: 'committed',
          invocation: proofRecord.invocation,
          terminalReceipt: proofRecord.terminalReceipt,
          currentAuthority: 'active',
          eligibleFirstCommit: true,
        }),
      );
      const resultRecord: FirstCommitResultRecord = { owner: state, proof: proofRecord };
      firstCommitResults.set(result, resultRecord);
      proofRecord.consumed.result = result;
      return result;
    },

    markInvocationCancelled(capability) {
      if (capability === null || typeof capability !== 'object') return invalidHandle();
      const beginOrResume = state.scopes.get(capability);
      if (beginOrResume && beginOrResume.owner === state) {
        beginOrResume.cancelled = true;
        const handle = beginOrResume.handle ? handles.get(beginOrResume.handle) : undefined;
        if (handle) handle.consumed = true;
        return;
      }
      const handle = handles.get(capability);
      if (handle && handle.owner === state) {
        handle.scope.cancelled = true;
        handle.consumed = true;
        return;
      }
      const consumed = consumedInvocations.get(capability);
      if (consumed && consumed.owner === state) {
        consumed.lease.scope.cancelled = true;
        consumed.denied = true;
        return;
      }
      return invalidHandle();
    },

    resultSchemas() {
      if (!schemas)
        schemas = createCompositionalCaptureInternalResultSchemasV3({
          isLiveHandle,
          isFirstCommitResult,
        });
      return schemas;
    },
  };

  // The verifier is closed over this exact registry. No caller can register a
  // prepared plan, a verification boolean, or a separately created factory.
  const bundleStages = createCompositionalCompletionStageFactoryV3({
    authenticate(capability) {
      try {
        activeConsumedRecord(state, capability);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Engram compositional capture: invalid_handle'
        )
          throw new CompositionalCompletionStageFailureV3('invalid_capability');
        throw error;
      }
    },
    resolve(capability, actualValue, expectedState) {
      const consumed = activeConsumedRecord(state, capability);
      const resolved =
        expectedState === 'leased'
          ? resolveActiveLeasedActual(consumed, actualValue)
          : resolveCommittedActualBase(consumed, actualValue)?.actual;
      if (!resolved) {
        consumed.denied = true;
        return null;
      }
      activeConsumedRecord(state, capability);
      return { actual: resolved.actual, invocation: completionInvocationView(consumed) };
    },
    readCompletionAudit(capability) {
      const consumed = activeConsumedRecord(state, capability);
      return registry.readAttemptAudit(consumed.audit);
    },
  });
  state.verifyBundles = (capability, actual) => bundleStages.verifyAcknowledged(capability, actual);
  return Object.freeze(registry);
}

function confirmInitialCommit(
  state: RegistryState,
  capability: unknown,
  actualValue: unknown,
  ackPath: AckPath,
): PrivateCompositionalCaptureFirstCommitProofV3 | null {
  if (capability === null || typeof capability !== 'object') return null;
  const consumed = consumedInvocations.get(capability);
  if (
    !consumed ||
    consumed.owner !== state ||
    consumed.capability !== capability ||
    consumed.denied
  )
    return null;
  if (consumed.completionAckPath && consumed.completionAckPath !== ackPath) {
    consumed.denied = true;
    return null;
  }
  const verification = verifyCommittedActual(consumed, actualValue);
  if (
    !verification ||
    !proofIsLocallyValid({
      owner: state,
      consumed,
      invocation: 'initial_owner',
      terminalReceipt:
        verification.actual.operation.state === 'committed'
          ? verification.actual.operation.terminalReceipt
          : ({} as z.infer<typeof receiptSchema>),
      actualKey: verification.actualKey,
    })
  ) {
    consumed.denied = true;
    return null;
  }
  consumed.completionAckPath = ackPath;
  const actualKey = verification.actualKey;
  if (consumed.proof) {
    if (consumed.proofActualKey !== actualKey) {
      consumed.denied = true;
      return null;
    }
    return consumed.proof as PrivateCompositionalCaptureFirstCommitProofV3;
  }
  const actualOperation = verification.actual.operation;
  if (actualOperation.state !== 'committed') return null;
  const proof = opaque<PrivateCompositionalCaptureFirstCommitProofV3>();
  const invocation =
    consumed.lease.scope.ackPath === 'unknown_ack_recovery' || ackPath === 'unknown_ack_recovery'
      ? 'same_call_ack_recovered'
      : 'initial_owner';
  const record: ProofRecord = {
    owner: state,
    consumed,
    invocation,
    terminalReceipt: deepFreeze(receiptSchema.parse(actualOperation.terminalReceipt)),
    actualKey,
  };
  proofs.set(proof, record);
  consumed.proof = proof;
  consumed.proofActualKey = actualKey;
  return proof;
}
