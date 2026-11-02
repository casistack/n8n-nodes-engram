import { types as utilTypes } from 'node:util';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { EntityEdge, EntityNode, EpisodicNode, GraphData } from '../schemas';
import { EntityEdgeSchema } from '../schemas/EntityEdge.schema';
import { EntityNodeSchema } from '../schemas/EntityNode.schema';
import {
  AutonomousPersonalClaimV3OwnedDataSchema,
  AutonomousPersonalValueMarkerV3OwnedDataSchema,
  hashAutonomousPersonalClaimMeaningV3,
  hashAutonomousPersonalClaimKeyV3,
} from '../schemas/AutonomousPersonalClaimV3.schema';
import {
  AutonomousPersonalCompletionPlanV4InputOwnedDataSchema,
  AutonomousPersonalCompletionPlanV4OwnedDataSchema,
  type AutonomousPersonalCompletionPlanV4,
  type AutonomousPersonalCompletionPlanV4Input,
  type AutonomousPersonalCompletionPlanV4NoWriteReason,
  type AutonomousPersonalCompletionPlanV4ReferenceGuard,
} from '../schemas/AutonomousPersonalCompletionPlanV4.schema';
import {
  AutonomousPersonalEvidenceSelectionV1Schema,
  type AutonomousPersonalEvidenceSelectionV1,
} from '../schemas/AutonomousPersonalEvidenceSelectionV1.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
  type AutonomousPersonalReceiptV4,
  type AutonomousPersonalSourceCoverageV4,
} from '../schemas/AutonomousPersonalOperationV4.schema';
import { AutonomousPersonalProviderResponseV1Schema } from '../schemas/AutonomousPersonalProviderV1.schema';
import {
  AutonomousPersonalTypedSyntaxV1OwnedDataSchema,
  type AutonomousPersonalTypedSyntaxWorkV1,
} from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { ExtractionMetadataV2Schema } from '../schemas/ExtractionMetadata.schema';
import {
  SourceHydrationBudgetSchema,
  type SourceHydrationBudget,
} from '../schemas/ExtractionPolicy.schema';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
  type AutonomousPersonalStoredSourceIdentityV4,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import {
  compileAutonomousPersonalTypedSyntaxV1,
  AutonomousPersonalTypedSyntaxFailureV1,
} from '../extraction/AutonomousPersonalTypedSyntaxV1';
import { compileAutonomousPersonalEvidenceSelectionV1 } from '../extraction/AutonomousPersonalEvidenceSelectionV1';
import { AutonomousPersonalEvidenceSelectionFailureV1 } from '../extraction/AutonomousPersonalEvidenceSelectionV1';
import { prepareAutonomousPersonalProviderPromptV1 } from '../extraction/AutonomousPersonalProviderRequestV1';
import { AutonomousPersonalProviderPromptFailureV1 } from '../extraction/AutonomousPersonalProviderRequestV1';
import { buildAutonomousPersonalClaimCandidateV1 } from '../extraction/AutonomousPersonalClaimCandidateV1';
import { projectCompositionalPreferenceV2Meaning } from '../extraction/CompositionalPreferenceV2Meaning';
import {
  createAutonomousPersonalClaimIndexV4,
  getRegisteredAutonomousPersonalClaimIndexGraphV4,
  inspectAutonomousPersonalClaimCreatorV4,
  qualifyAutonomousPersonalClaimCreatorV4,
  AutonomousPersonalClaimIndexV4Error,
} from '../extraction/AutonomousPersonalQualifiedClaimV4';
import { compileAutonomousPersonalSourceScanV1 } from '../schemas/AutonomousPersonalSourceScanV1.schema';
import { compileAutonomousSourceGeometryV3 } from '../schemas/AutonomousSourceGeometryV3.schema';
import { AutonomousPersonalSourceCoverageV4OwnedDataSchema } from '../schemas/AutonomousPersonalOperationV4.schema';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../schemas/AutonomousPersonalPolicyV3.schema';
import { deriveAutonomousPersonalRecordIdsV1 } from './AutonomousPersonalRecordIdsV1';
import { buildCommittedAutonomousPersonalOperationV4 } from './AutonomousPersonalTerminalOperationV4';
import { AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema } from '../schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import { prepareAutonomousPersonalCaptureSnapshotV4 } from './AutonomousPersonalCaptureBeginV4';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { getOwnedImmutableGraphData } from './ImmutableGraphSnapshot';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from './BoundedAutomaticCaptureJson';
import {
  beginAutomaticClaimReadAttempt,
  canUseAutomaticClaimReadScope,
  chargeAutomaticClaimContextBytes,
  getAutomaticClaimReadScope,
  isAutomaticClaimReadScopeForBudget,
  type AutomaticClaimReadScope,
  getAutomaticClaimReadScopeRemaining,
} from './AutomaticClaimReadScope';
import {
  createCompositionalSnapshotIndexV3,
  getOwnedCompositionalSnapshotV3,
  CompositionalSnapshotIndexErrorV3,
} from '../extraction/CompositionalSnapshotIndexV3';
import { createCompositionalQualifiedClaimReadPrivateProjectorV3 } from '../extraction/CompositionalQualifiedClaimReadV3';
import {
  compareCompositionalMeaningOverlapDomainV1,
  createLiteralV1SemanticOverlapPrivateProjectorV1,
} from '../extraction/LiteralV1SemanticOverlap';
import { inspectLiteralCompositionalPairCompatibilityV1 } from '../extraction/LiteralCompositionalPairCompatibilityV1';
import type { CompositionalAutomaticClaimMeaningV2 } from '../schemas/CompositionalAutomaticMemory.schema';
import type { LiteralV1SemanticInspection } from '../schemas/LiteralV1SemanticOverlap.schema';
import type { AutonomousPersonalQualifiedClaimProofV4 } from '../schemas/AutonomousPersonalQualifiedClaimV4.schema';
import type { StoredAutomaticOperation } from '../schemas/AutomaticLedger.schema';

const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

type PlanReason = AutonomousPersonalCompletionPlanV4NoWriteReason;
type QualifiedProof = AutonomousPersonalQualifiedClaimProofV4;
type CandidateBuild = ReturnType<typeof buildAutonomousPersonalClaimCandidateV1>;
type Claim = z.infer<typeof AutonomousPersonalClaimV3OwnedDataSchema>;

class PlanStop extends Error {
  constructor(readonly reason: PlanReason) {
    super(reason);
    this.name = 'AutonomousPersonalCompletionPlanV4Stop';
  }
}

function stop(reason: PlanReason): never {
  throw new PlanStop(reason);
}

function freezeData<T>(value: T, check?: () => void): T {
  check?.();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child, check);
    Object.freeze(value);
  }
  return value;
}

function noWrite(reason: PlanReason): AutonomousPersonalCompletionPlanV4 {
  return Object.freeze({ kind: 'no_write', reason });
}

function nativeWorkData(value: unknown): {
  readonly deadline: number;
  readonly signal: AbortSignal;
} | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  )
    return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
    )
      return null;
    const deadlineProperty = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signalProperty = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      !deadlineProperty ||
      !deadlineProperty.enumerable ||
      !('value' in deadlineProperty) ||
      typeof deadlineProperty.value !== 'number' ||
      !Number.isFinite(deadlineProperty.value) ||
      !signalProperty ||
      !signalProperty.enumerable ||
      !('value' in signalProperty) ||
      signalProperty.value === null ||
      typeof signalProperty.value !== 'object' ||
      utilTypes.isProxy(signalProperty.value) ||
      nativeAbortSignalAbortedGetter === undefined
    )
      return null;
    nativeAbortSignalAbortedGetter.call(signalProperty.value);
    return { deadline: deadlineProperty.value, signal: signalProperty.value as AbortSignal };
  } catch {
    return null;
  }
}

function nativeBudget(value: unknown): SourceHydrationBudget | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  )
    return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => key !== 'remaining' && key !== 'deferred'))
      return null;
    const remaining = Object.getOwnPropertyDescriptor(value, 'remaining');
    const deferred = Object.getOwnPropertyDescriptor(value, 'deferred');
    if (
      !remaining ||
      !remaining.enumerable ||
      !('value' in remaining) ||
      !remaining.writable ||
      !deferred ||
      !deferred.enumerable ||
      !('value' in deferred) ||
      !deferred.writable ||
      !Number.isInteger(remaining.value) ||
      remaining.value < 0 ||
      remaining.value > 1024 ||
      !Number.isSafeInteger(deferred.value) ||
      deferred.value < 0
    )
      return null;
    const parsed = SourceHydrationBudgetSchema.safeParse({
      remaining: remaining.value,
      deferred: deferred.value,
    });
    return parsed.success ? (value as SourceHydrationBudget) : null;
  } catch {
    return null;
  }
}

function inputSnapshot(value: unknown): AutonomousPersonalCompletionPlanV4Input {
  return AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse(
    cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest'),
  );
}

function same(a: unknown, b: unknown): boolean {
  return canonicalAutomaticCaptureV2(a) === canonicalAutomaticCaptureV2(b);
}

function actualRecord<T extends { uuid: string }>(
  rows: readonly T[],
  id: string,
  check: () => void,
): T | null {
  let found: T | null = null;
  for (const row of rows) {
    check();
    if (row.uuid !== id) continue;
    if (found) return null;
    found = row;
  }
  return found;
}

function actualOperation(graph: GraphData, id: string, check: () => void) {
  let found: StoredAutomaticOperation | null = null;
  for (const row of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (row.operationId !== id) continue;
    if (found) return null;
    found = row;
  }
  return found;
}

function allIds(graph: GraphData, check: () => void): Set<string> {
  const ids = new Set<string>();
  for (const row of graph.entities) {
    check();
    ids.add(row.uuid);
  }
  for (const row of graph.edges) {
    check();
    ids.add(row.uuid);
  }
  for (const row of graph.episodes) {
    check();
    ids.add(row.uuid);
  }
  for (const row of graph.automatic_operations_v1?.operations ?? []) {
    check();
    ids.add(row.operationId);
  }
  return ids;
}

function beginProjectionReason(
  projection: ReturnType<typeof prepareAutonomousPersonalCaptureSnapshotV4> extends infer R
    ? R extends { kind: 'no_write'; resultProjection: infer P }
      ? P
      : never
    : never,
): PlanReason {
  switch (projection.kind) {
    case 'invalid_input':
      return 'invalid_input';
    case 'authority_changed':
      return 'authority_changed';
    case 'clock_regression':
      return 'clock_regression';
    case 'resume_available':
      return 'lease_expired';
    case 'budget_exhausted':
    case 'resource_exhausted':
      return 'budget_exhausted';
    case 'capacity':
      return 'capacity';
    default:
      return 'conflict';
  }
}

function omitMutableEpisodeUpdate(source: EpisodicNode) {
  const { updated_at: _updatedAt, ...immutable } = source;
  void _updatedAt;
  return immutable;
}

function omitAppendOnlyAudit(
  operation: Extract<
    z.infer<typeof AutonomousPersonalOperationV4OwnedDataSchema>,
    { state: 'leased' }
  >,
) {
  const {
    attempts: _attempts,
    overflowCount: _overflowCount,
    auditTruncated: _auditTruncated,
    lastObservedAt: _lastObservedAt,
    ...immutable
  } = operation;
  void _attempts;
  void _overflowCount;
  void _auditTruncated;
  void _lastObservedAt;
  return immutable;
}

function sourceGeometryInput(stored: AutonomousPersonalStoredSourceIdentityV4) {
  const geometry = stored.tuple.envelope.geometry;
  if (geometry.mode === 'full_body') {
    return {
      rawContent: stored.source.content,
      mapping: { mode: 'full_body' as const },
      quoteRegions: geometry.quoteRegions,
    };
  }
  if (geometry.humanRegion === null || geometry.applicationWrapper === null) stop('conflict');
  return {
    rawContent: stored.source.content,
    mapping: {
      mode: 'application_region' as const,
      humanRegion: geometry.humanRegion,
      applicationWrapper: geometry.applicationWrapper,
    },
    quoteRegions: geometry.quoteRegions,
  };
}

function providerPreparation(
  source: EpisodicNode,
  descriptor: AutonomousPersonalCompletionPlanV4Input['scope']['descriptor'],
  work: AutonomousPersonalTypedSyntaxWorkV1,
  check: () => void,
) {
  check();
  const preparation = prepareAutonomousPersonalProviderPromptV1({ source, descriptor }, '', work);
  check();
  return preparation;
}

function policyNotSelectedCoverage(
  stored: AutonomousPersonalStoredSourceIdentityV4,
  check: () => void,
): AutonomousPersonalSourceCoverageV4 {
  check();
  const scan = compileAutonomousPersonalSourceScanV1(sourceGeometryInput(stored));
  check();
  if (scan.status !== 'complete' || scan.units.length < 1 || scan.units.length > 32)
    stop('conflict');
  return AutonomousPersonalSourceCoverageV4OwnedDataSchema.parse({
    status: 'unknown',
    scanStatus: 'complete',
    sourceUnitCount: scan.units.length,
    candidateUnitCount: 0,
    neutralUnitCount: 0,
    withheldUnitCount: 0,
    unresolvedUnitCount: scan.units.length,
    unresolvedReason: 'policy_not_selected',
  });
}

function completeSourceUnitCount(
  stored: AutonomousPersonalStoredSourceIdentityV4,
  check: () => void,
): number {
  check();
  const scan = compileAutonomousPersonalSourceScanV1(sourceGeometryInput(stored));
  check();
  if (scan.status !== 'complete' || scan.units.length < 1 || scan.units.length > 32)
    stop('conflict');
  return scan.units.length;
}

function interpretationCapacityCoverage(
  sourceUnitCount: number,
): AutonomousPersonalSourceCoverageV4 {
  return AutonomousPersonalSourceCoverageV4OwnedDataSchema.parse({
    status: 'unknown',
    scanStatus: 'complete',
    sourceUnitCount,
    candidateUnitCount: 0,
    neutralUnitCount: 0,
    withheldUnitCount: 0,
    unresolvedUnitCount: sourceUnitCount,
    unresolvedReason: 'interpretation_capacity',
  });
}

function terminalReceiptBase(input: AutonomousPersonalCompletionPlanV4Input) {
  const { operation } = input.stagedFresh;
  return {
    version: 4 as const,
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: operation.identity.descriptorHash,
    policyFingerprint: operation.descriptor.policy.fingerprint,
    terminalAt: input.backendNow,
  };
}

function buildDeferredReceipt(
  input: AutonomousPersonalCompletionPlanV4Input,
  reason: Extract<
    AutonomousPersonalCompletionPlanV4Input['outcome'],
    { kind: 'deferred' }
  >['reason'],
  sourceCoverage: AutonomousPersonalSourceCoverageV4,
  check: () => void,
): AutonomousPersonalReceiptV4 {
  check();
  return AutonomousPersonalReceiptV4OwnedDataSchema.parse({
    ...terminalReceiptBase(input),
    kind: 'human_autonomous_source_deferred_committed',
    interpretationCoverage: 'unknown',
    acceptedCoverage: 'none',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage,
    selection: { kind: 'source_only_deferred', reason },
  });
}

function buildSourceVerdictReceipt(
  input: AutonomousPersonalCompletionPlanV4Input,
  sourceCoverage: AutonomousPersonalSourceCoverageV4,
  outcome: 'known_no_memory' | 'unsupported_source' | 'unknown_source' | 'policy_not_selected',
  check: () => void,
): AutonomousPersonalReceiptV4 {
  check();
  return AutonomousPersonalReceiptV4OwnedDataSchema.parse({
    ...terminalReceiptBase(input),
    kind: 'human_autonomous_source_verdict_committed',
    interpretationCoverage: sourceCoverage.status as 'complete' | 'partial' | 'unknown',
    acceptedCoverage: 'none',
    acceptanceSemantics: 'per_item_kind_v1',
    sourceCoverage,
    selection: { kind: 'source_verdict', outcome },
  });
}

function terminalOperation(
  input: AutonomousPersonalCompletionPlanV4Input,
  receipt: AutonomousPersonalReceiptV4,
  check: () => void,
  leasedOperation: Extract<AutonomousPersonalOperationV4, { state: 'leased' }>,
) {
  check();
  return buildCommittedAutonomousPersonalOperationV4(
    {
      leasedOperation,
      terminalReceipt: receipt,
      completionCallHash: input.completionCallHash,
      audit: input.audit,
    },
    check,
  );
}

function plannedOutput(
  value: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>,
  check: () => void,
  planCapacityFallback?: () => Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>,
): AutonomousPersonalCompletionPlanV4 {
  check();
  const candidateSerialized = JSON.stringify(value);
  if (typeof candidateSerialized !== 'string') stop('conflict');
  const candidateBytes = Buffer.byteLength(candidateSerialized, 'utf8');
  if (candidateBytes > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes) {
    if (!planCapacityFallback) stop('capacity');
    const candidateValidation = AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(value);
    check();
    const onlySizeIssues =
      !candidateValidation.success &&
      candidateValidation.error.issues.length > 0 &&
      candidateValidation.error.issues.every(
        (issue) =>
          issue.code === 'custom' &&
          (issue.message === 'Plan exceeds the frozen policy planBytes limit' ||
            issue.message === 'Plan exceeds graph ownership bound'),
      );
    if (!candidateValidation.success && !onlySizeIssues) stop('conflict');
    check();
    return plannedOutput(planCapacityFallback(), check);
  }

  let owned: unknown;
  try {
    const graphOwned = cloneBoundedAutomaticCaptureJson<{
      entities: EntityNode[];
      edges: EntityEdge[];
      episodes: unknown[];
      operation: unknown;
      referenceGuards: unknown[];
    }>(
      {
        entities: value.createEntities,
        edges: value.createEdges,
        episodes: [],
        operation: value.operation,
        referenceGuards: value.referenceGuards,
      },
      'graph',
    );
    owned = {
      kind: value.kind,
      createEntities: graphOwned.entities,
      createEdges: graphOwned.edges,
      operation: graphOwned.operation,
      referenceGuards: graphOwned.referenceGuards,
    };
  } catch (error) {
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
      stop('capacity');
    stop('conflict');
  }
  check();
  const serialized = JSON.stringify(owned);
  if (typeof serialized !== 'string') stop('conflict');
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  const parsed = AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(owned);
  check();
  if (!parsed.success) {
    const onlySizeIssues =
      parsed.error.issues.length > 0 &&
      parsed.error.issues.every(
        (issue) =>
          issue.code === 'custom' &&
          (issue.message === 'Plan exceeds the frozen policy planBytes limit' ||
            issue.message === 'Plan exceeds graph ownership bound'),
      );
    if (serializedBytes > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes) {
      if (!onlySizeIssues) stop('conflict');
      if (planCapacityFallback) {
        check();
        return plannedOutput(planCapacityFallback(), check);
      }
      stop('capacity');
    }
    stop('conflict');
  }
  if (serializedBytes > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.planBytes) {
    if (planCapacityFallback) {
      check();
      return plannedOutput(planCapacityFallback(), check);
    }
    stop('capacity');
  }
  const frozen = freezeData(parsed.data, check);
  check();
  return frozen;
}

type CandidateOccurrence = {
  readonly index: number;
  readonly selection: AutonomousPersonalEvidenceSelectionV1['occurrences'][number];
  readonly result: CandidateBuild | null;
  readonly claim: Claim | null;
  readonly meaning: CompositionalAutomaticClaimMeaningV2 | null;
  readonly logicalIdentity: unknown;
  readonly representation: unknown;
};

type PlanGroup = {
  readonly key: string;
  readonly occurrences: CandidateOccurrence[];
  readonly kind: 'typed_preference' | 'source_statement_record';
  readonly category: CandidateOccurrence['selection']['category'];
  readonly meaningHash: string;
  readonly logicalIdentity: unknown;
  readonly representation: unknown;
  readonly meaning: CompositionalAutomaticClaimMeaningV2 | null;
  readonly namespace: string;
  readonly subjectId: string;
  recordIds?: ReturnType<typeof deriveAutonomousPersonalRecordIdsV1>;
  reference?: ExistingFamily4;
  readonly reasons: Set<
    | 'existing_ineligible'
    | 'legacy_reuse_not_authorized'
    | 'unknown_overlap_domain'
    | 'possible_overlap'
  >;
};

type PlannerRelationAccounting = {
  readonly storedRelations: Set<string>;
  readonly storedIdsByIncomingKey: Map<string, Set<string>>;
  readonly incomingPairs: Set<string>;
};

function createPlannerRelationAccounting(): PlannerRelationAccounting {
  return {
    storedRelations: new Set(),
    storedIdsByIncomingKey: new Map(),
    incomingPairs: new Set(),
  };
}

function enforceConflictLimit(accounting: PlannerRelationAccounting): void {
  if (
    accounting.storedRelations.size + accounting.incomingPairs.size >
    AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.conflicts
  )
    stop('inspection_incomplete');
}

function accountStoredRelation(
  accounting: PlannerRelationAccounting,
  group: PlanGroup,
  storedEdgeId: string,
): void {
  const relationKey = JSON.stringify([storedEdgeId, group.key]);
  if (accounting.storedRelations.has(relationKey)) return;
  accounting.storedRelations.add(relationKey);
  const storedIds = accounting.storedIdsByIncomingKey.get(group.key) ?? new Set<string>();
  storedIds.add(storedEdgeId);
  accounting.storedIdsByIncomingKey.set(group.key, storedIds);
  if (storedIds.size > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.conflictRefsPerClaim)
    stop('inspection_incomplete');
  enforceConflictLimit(accounting);
}

function accountIncomingPair(
  accounting: PlannerRelationAccounting,
  left: PlanGroup,
  right: PlanGroup,
): void {
  const keys = [left.key, right.key].sort();
  accounting.incomingPairs.add(JSON.stringify(keys));
  enforceConflictLimit(accounting);
}

type ExistingFamily4 = {
  readonly edge: EntityEdge;
  readonly claim: Claim;
  readonly proof: QualifiedProof;
  readonly eligibility: 'qualified' | 'inactive';
  readonly reason?: string;
};

function evidenceIdentity(occurrence: CandidateOccurrence): {
  kind: 'typed_preference' | 'source_statement_record';
  category: CandidateOccurrence['selection']['category'];
  meaningHash: string;
  logicalIdentity: unknown;
  representation: unknown;
} {
  return {
    kind: occurrence.selection.kind,
    category: occurrence.selection.category,
    meaningHash: occurrence.selection.meaningHash,
    logicalIdentity: occurrence.logicalIdentity,
    representation: occurrence.representation,
  };
}

function sourceCandidateOccurrences(
  source: EpisodicNode,
  stored: AutonomousPersonalStoredSourceIdentityV4,
  selection: AutonomousPersonalEvidenceSelectionV1,
  work: AutonomousPersonalTypedSyntaxWorkV1,
  check: () => void,
): CandidateOccurrence[] {
  check();
  const geometryInput = sourceGeometryInput(stored);
  const geometry = compileAutonomousSourceGeometryV3(geometryInput);
  check();
  const syntaxValue = compileAutonomousPersonalTypedSyntaxV1(
    {
      ...geometryInput,
      syntaxScope: {
        namespace: stored.tuple.owner.namespace,
        issuer: stored.tuple.owner.issuer,
        actorReference: stored.tuple.owner.actorReference,
        binding: stored.tuple.owner.binding,
      },
    },
    work,
  );
  check();
  const syntax = AutonomousPersonalTypedSyntaxV1OwnedDataSchema.parse(syntaxValue);
  if (syntax.status !== 'complete') stop('capacity');
  const sourceTime = new Date(Date.parse(source.reference_time)).toISOString();
  const output: CandidateOccurrence[] = [];

  for (const occurrence of selection.occurrences) {
    check();
    const unit = selection.units[occurrence.unitIndex];
    const syntaxUnit = syntax.units[occurrence.unitIndex];
    if (!unit || unit.outcome !== 'candidate' || !syntaxUnit) stop('conflict');
    const literal = source.content.slice(occurrence.rawSpan.start, occurrence.rawSpan.end);
    const mapped = geometry.mappedHumanBody.slice(
      occurrence.mappedSpan.start,
      occurrence.mappedSpan.end,
    );
    if (!literal || literal !== mapped) stop('conflict');

    let bundle = null;
    let meaning: CompositionalAutomaticClaimMeaningV2 | null = null;
    let logicalIdentity: unknown;
    let representation: unknown;
    if (occurrence.kind === 'typed_preference') {
      if (syntaxUnit.kind !== 'typed') stop('conflict');
      const matches = syntaxUnit.preference.bundles.filter((candidate) => {
        const span = candidate.evidence.spans[0];
        return (
          candidate.coverage === 'complete' &&
          candidate.evidence.lexicalForm === literal &&
          span?.raw.start === occurrence.rawSpan.start &&
          span?.raw.end === occurrence.rawSpan.end &&
          span?.content.start === occurrence.mappedSpan.start &&
          span?.content.end === occurrence.mappedSpan.end
        );
      });
      if (matches.length !== 1) stop('conflict');
      bundle = matches[0]!;
      const projected = projectCompositionalPreferenceV2Meaning({
        preference: {
          version: 2,
          descriptor: syntaxUnit.preference.descriptor,
          coverage: 'complete',
          bundles: [bundle],
          withheld: [],
          reasons: [],
        },
        namespace: stored.tuple.owner.namespace,
        subjectId: stored.tuple.owner.binding.subjectId,
        check,
      });
      if (!projected.ok) stop('conflict');
      meaning = projected.meaning;
      logicalIdentity = {
        kind: 'typed_preference',
        namespace: stored.tuple.owner.namespace,
        subjectId: stored.tuple.owner.binding.subjectId,
        meaning,
      };
      // The exact complete logical meaning is hashed independently of source
      // spans. Lexical form and category remain part of representation identity.
      representation = {
        category: occurrence.category,
        lexicalForm: bundle.evidence.lexicalForm,
        descriptor: bundle.evidence.descriptor,
      };
    } else {
      logicalIdentity = {
        kind: 'source_statement_record',
        namespace: stored.tuple.owner.namespace,
        subjectId: stored.tuple.owner.binding.subjectId,
        sourceEventTime: sourceTime,
        completeLiteral: literal,
        semantics: 'source_attributed_statement',
        ...(occurrence.qualification === undefined
          ? {}
          : { qualification: occurrence.qualification }),
      };
      representation = {
        category: occurrence.category,
        framingVersion: 1,
        headForm: 'first_person_i_main_clause',
        semantics: 'source_attributed_statement',
        typedProjection: null,
        ...(occurrence.qualification === undefined
          ? {}
          : { qualification: occurrence.qualification }),
      };
    }

    const expectedMeaningHash = hashAutonomousPersonalClaimMeaningV3(logicalIdentity);
    const expectedKey = hashAutonomousPersonalClaimKeyV3(logicalIdentity);
    if (expectedMeaningHash !== occurrence.meaningHash || expectedKey !== occurrence.key)
      stop('conflict');

    const result = buildAutonomousPersonalClaimCandidateV1({
      sourceId: stored.tuple.owner.sourceId,
      contentHash: stored.tuple.owner.contentHash,
      descriptorHash: stored.tuple.owner.descriptorHash,
      namespace: stored.tuple.owner.namespace,
      subjectId: stored.tuple.owner.binding.subjectId,
      sourceHash: stored.tuple.identity.sourceHash,
      policy: stored.descriptor.policy,
      sourceEventTime: sourceTime,
      unitId: unit.unitId,
      unitIndex: occurrence.unitIndex,
      kind: occurrence.kind,
      category: occurrence.category,
      literal,
      rawSpan: occurrence.rawSpan,
      mappedSpan: occurrence.mappedSpan,
      bundle,
      ...(occurrence.qualification === undefined
        ? {}
        : { qualification: occurrence.qualification }),
    });
    check();
    if (result.kind === 'candidate') {
      if (
        (result.claim.kind === 'source_statement_record'
          ? result.claim.qualification
          : undefined) !== occurrence.qualification ||
        result.reference.key !== occurrence.key ||
        result.reference.kind !== occurrence.kind ||
        result.reference.category !== occurrence.category ||
        result.reference.evidenceHash !== occurrence.evidenceHash ||
        result.reference.meaningHash !== occurrence.meaningHash ||
        !same(result.reference.dependencies, occurrence.dependencies) ||
        !same(result.reference.rawSpan, occurrence.rawSpan) ||
        !same(result.reference.mappedSpan, occurrence.mappedSpan)
      )
        stop('conflict');
      logicalIdentity =
        result.claim.kind === 'typed_preference'
          ? {
              kind: 'typed_preference',
              namespace: result.claim.namespace,
              subjectId: result.claim.subjectId,
              meaning: result.claim.meaning,
            }
          : {
              kind: 'source_statement_record',
              namespace: result.claim.namespace,
              subjectId: result.claim.subjectId,
              sourceEventTime: result.claim.sourceEventTime,
              completeLiteral: result.claim.evidence.literal,
              semantics: 'source_attributed_statement',
              ...(result.claim.qualification === undefined
                ? {}
                : { qualification: result.claim.qualification }),
            };
    } else {
      output.push({
        index: occurrence.candidateIndex,
        selection: occurrence,
        result,
        claim: null,
        meaning,
        logicalIdentity,
        representation,
      });
      continue;
    }

    output.push({
      index: occurrence.candidateIndex,
      selection: occurrence,
      result,
      claim: result.claim,
      meaning: result.claim.kind === 'typed_preference' ? result.claim.meaning : null,
      logicalIdentity,
      representation,
    });
  }
  return output;
}

function makeGroups(occurrences: CandidateOccurrence[]): PlanGroup[] {
  const byKey = new Map<string, PlanGroup>();
  for (const occurrence of occurrences) {
    const identity = evidenceIdentity(occurrence);
    const prior = byKey.get(
      identity.kind === occurrence.selection.kind ? occurrence.selection.key : '',
    );
    if (!prior) {
      byKey.set(occurrence.selection.key, {
        key: occurrence.selection.key,
        occurrences: [occurrence],
        kind: occurrence.selection.kind,
        category: occurrence.selection.category,
        meaningHash: occurrence.selection.meaningHash,
        logicalIdentity: identity.logicalIdentity,
        representation: identity.representation,
        meaning: occurrence.meaning,
        namespace:
          occurrence.claim?.namespace ??
          (occurrence.logicalIdentity as { namespace: string }).namespace,
        subjectId:
          occurrence.claim?.subjectId ??
          (occurrence.logicalIdentity as { subjectId: string }).subjectId,
        reasons: new Set(),
      });
      continue;
    }
    if (
      prior.kind !== occurrence.selection.kind ||
      prior.category !== occurrence.selection.category ||
      prior.meaningHash !== occurrence.selection.meaningHash ||
      !same(prior.logicalIdentity, identity.logicalIdentity) ||
      !same(prior.representation, identity.representation) ||
      !same(prior.occurrences[0]!.selection.dependencies, occurrence.selection.dependencies)
    )
      stop('conflict');
    prior.occurrences.push(occurrence);
  }
  return [...byKey.values()].sort((a, b) => a.occurrences[0]!.index - b.occurrences[0]!.index);
}

function graphDomainCandidates(
  graph: GraphData,
  namespace: string,
  subjectId: string,
  check: () => void,
): EntityEdge[] {
  const candidates: EntityEdge[] = [];
  for (const edge of graph.edges) {
    check();
    if (
      edge.group_id === namespace &&
      edge.source_node_uuid === subjectId &&
      (edge.name === 'PREFERS' ||
        Object.prototype.hasOwnProperty.call(edge.attributes, 'engram_claim_v1'))
    ) {
      candidates.push(edge);
    }
  }
  return candidates;
}

function rawClaimKey(edge: EntityEdge): string | null {
  const raw = edge.attributes.engram_claim_v1;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const key = Object.getOwnPropertyDescriptor(raw, 'key');
  return key && 'value' in key && typeof key.value === 'string' ? key.value : null;
}

function inspectExistingFamily4(
  graph: GraphData,
  snapshot: unknown,
  namespace: string,
  subjectId: string,
  storeHash: string,
  backendNow: string,
  typedWork: AutonomousPersonalTypedSyntaxWorkV1,
  check: () => void,
  legacyScope: ReturnType<typeof getAutomaticClaimReadScope>,
): {
  readonly rows: ExistingFamily4[];
  readonly rowsByKey: ReadonlyMap<string, readonly ExistingFamily4[]>;
  readonly legacyIds: Set<string>;
  readonly candidateEdgesByKey: ReadonlyMap<string, readonly EntityEdge[]>;
  readonly legacyIndex: ReturnType<typeof createCompositionalSnapshotIndexV3>;
} {
  const candidateEdges = graphDomainCandidates(graph, namespace, subjectId, check);
  const candidateIds = new Set<string>();
  for (const edge of candidateEdges) {
    check();
    candidateIds.add(edge.uuid);
  }
  if (candidateIds.size > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.candidateProjections)
    stop('inspection_incomplete');
  // Complete B1b structural classification first. Only actual structural
  // family4 proofs leave the legacy universe; raw tags and IDs never do.
  const claimIndex = createAutonomousPersonalClaimIndexV4(snapshot, typedWork, check);
  check();
  const rows: ExistingFamily4[] = [];
  const rowsByKey = new Map<string, ExistingFamily4[]>();
  const candidateEdgesByKey = new Map<string, EntityEdge[]>();
  const legacyIds = new Set<string>();
  for (const edge of candidateEdges) {
    check();
    const rawKey = rawClaimKey(edge);
    if (rawKey !== null) {
      const keyedEdges = candidateEdgesByKey.get(rawKey) ?? [];
      keyedEdges.push(edge);
      candidateEdgesByKey.set(rawKey, keyedEdges);
    }
    const inspected = inspectAutonomousPersonalClaimCreatorV4(claimIndex, edge.uuid);
    check();
    if (inspected.status === 'capacity') stop('inspection_incomplete');
    if (inspected.status !== 'structural') {
      legacyIds.add(edge.uuid);
      continue;
    }
    const qualified = qualifyAutonomousPersonalClaimCreatorV4(claimIndex, {
      storeHash,
      namespace,
      edgeId: edge.uuid,
      backendNow,
    });
    check();
    if (qualified.status === 'capacity') stop('inspection_incomplete');
    const claimResult = AutonomousPersonalClaimV3OwnedDataSchema.safeParse(
      edge.attributes.engram_claim_v1,
    );
    if (!claimResult.success || claimResult.data.key !== inspected.proof.key)
      stop('inspection_incomplete');
    const row = {
      edge,
      claim: claimResult.data,
      proof: inspected.proof,
      eligibility: qualified.status === 'qualified' ? 'qualified' : 'inactive',
      ...(qualified.status === 'inactive' ? { reason: qualified.reason } : {}),
    } satisfies ExistingFamily4;
    rows.push(row);
    const keyedRows = rowsByKey.get(row.claim.key) ?? [];
    keyedRows.push(row);
    rowsByKey.set(row.claim.key, keyedRows);
  }

  // Own one old snapshot index for both its candidate universe check and the
  // legacy-only projectors. Keep its complete root; the candidate loop below
  // projects only rows whose B1b classification did not prove family4.
  const legacyIndex = createCompositionalSnapshotIndexV3(
    graph,
    { namespace, subjectId },
    check,
    legacyScope,
  );
  check();
  const legacyView = getOwnedCompositionalSnapshotV3(legacyIndex);
  if (!legacyView) stop('inspection_incomplete');
  if (legacyView.candidates.length !== candidateEdges.length) stop('inspection_incomplete');
  for (const edge of legacyView.candidates) {
    check();
    if (!candidateIds.has(edge.uuid)) stop('inspection_incomplete');
  }
  return { rows, rowsByKey, legacyIds, candidateEdgesByKey, legacyIndex };
}

function groupExistingReference(
  group: PlanGroup,
  existingByKey: ReadonlyMap<string, readonly ExistingFamily4[]>,
  candidateEdgesByKey: ReadonlyMap<string, readonly EntityEdge[]>,
): ExistingFamily4 | undefined {
  const sameKeyEdges = candidateEdgesByKey.get(group.key) ?? [];
  if (sameKeyEdges.length > 1) stop('conflict');
  const structural = existingByKey.get(group.key) ?? [];
  if (sameKeyEdges.length === 0) {
    if (structural.length > 0) stop('conflict');
    return undefined;
  }
  if (structural.length !== 1 || structural[0]!.edge.uuid !== sameKeyEdges[0]!.uuid)
    stop('conflict');
  const match = structural[0]!;
  const first = group.occurrences[0]!;
  if (
    match.eligibility !== 'qualified' ||
    match.proof.kind !== group.kind ||
    match.proof.key !== group.key ||
    match.proof.meaningHash !== group.meaningHash ||
    match.claim.interpretation.category !== group.category ||
    !same(
      match.claim.kind === 'typed_preference'
        ? {
            kind: 'typed_preference',
            namespace: match.claim.namespace,
            subjectId: match.claim.subjectId,
            meaning: match.claim.meaning,
          }
        : {
            kind: 'source_statement_record',
            namespace: match.claim.namespace,
            subjectId: match.claim.subjectId,
            sourceEventTime: match.claim.sourceEventTime,
            completeLiteral: match.claim.evidence.literal,
            semantics: 'source_attributed_statement',
            ...(match.claim.qualification === undefined
              ? {}
              : { qualification: match.claim.qualification }),
          },
      first.logicalIdentity,
    )
  )
    stop('conflict');
  return match;
}

function directLegacyDisposition(
  inspection: LiteralV1SemanticInspection,
  meaning: CompositionalAutomaticClaimMeaningV2,
  check: () => void,
): { readonly reason: LegacyRelationReason | null; readonly relevant: boolean } {
  if (inspection.projection !== 'exact' || !inspection.canonicalMeaning)
    return { reason: 'unknown_overlap_domain', relevant: true };
  if (inspection.domain === 'proven_disjoint') return { reason: null, relevant: false };
  if (inspection.domain === 'unknown_domain')
    return { reason: 'unknown_overlap_domain', relevant: true };
  if (inspection.equivalent === true) {
    return {
      reason:
        inspection.currentReview === 'accepted' && inspection.oldCurrentEligibility === 'eligible'
          ? 'legacy_reuse_not_authorized'
          : 'existing_ineligible',
      relevant: true,
    };
  }
  if (inspection.oldCurrentEligibility === 'eligible' && inspection.currentReview === 'accepted') {
    const compatibility = inspectLiteralCompositionalPairCompatibilityV1(
      { oldMeaning: inspection.canonicalMeaning, newMeaning: meaning },
      check,
    );
    check();
    if (compatibility.status === 'compatible_constraints') return { reason: null, relevant: true };
  }
  return { reason: 'possible_overlap', relevant: true };
}

type LegacyRelationReason =
  | 'existing_ineligible'
  | 'legacy_reuse_not_authorized'
  | 'unknown_overlap_domain'
  | 'possible_overlap';

function claimV2Disposition(
  candidateResult: ReturnType<
    ReturnType<typeof createCompositionalQualifiedClaimReadPrivateProjectorV3>['projectCandidate']
  >,
  meaning: CompositionalAutomaticClaimMeaningV2,
  check: () => void,
): { readonly reason: LegacyRelationReason | null; readonly relevant: boolean } {
  if (candidateResult.result.status !== 'valid_data')
    return { reason: 'unknown_overlap_domain', relevant: true };
  const claim = candidateResult.result.context.edge.attributes.engram_claim_v1 as {
    meaning: CompositionalAutomaticClaimMeaningV2;
  };
  const comparison = compareCompositionalMeaningOverlapDomainV1(claim.meaning, meaning, check);
  check();
  if (comparison.domain === 'proven_disjoint') return { reason: null, relevant: false };
  if (comparison.domain === 'unknown_domain')
    return { reason: 'unknown_overlap_domain', relevant: true };
  if (comparison.equivalent) {
    return {
      reason:
        candidateResult.result.currentReview === 'accepted'
          ? 'legacy_reuse_not_authorized'
          : 'existing_ineligible',
      relevant: true,
    };
  }
  return { reason: 'possible_overlap', relevant: true };
}

function compareLegacyCandidates(
  legacyIndex: ReturnType<typeof createCompositionalSnapshotIndexV3>,
  backendNow: string,
  legacyIds: ReadonlySet<string>,
  groups: readonly PlanGroup[],
  check: () => void,
  scope: ReturnType<typeof getAutomaticClaimReadScope>,
  accounting: PlannerRelationAccounting,
): void {
  const view = getOwnedCompositionalSnapshotV3(legacyIndex);
  if (!view) stop('inspection_incomplete');
  const legacyEdges: EntityEdge[] = [];
  for (const edge of view.candidates) {
    check();
    if (!legacyIds.has(edge.uuid)) continue;
    legacyEdges.push(edge);
    if (legacyEdges.length > 128) stop('inspection_incomplete');
  }
  check();
  const literal = createLiteralV1SemanticOverlapPrivateProjectorV1(legacyIndex, {
    now: Date.parse(backendNow),
    check,
  });
  if (!literal) stop('inspection_incomplete');
  check();
  const compositional = createCompositionalQualifiedClaimReadPrivateProjectorV3(
    legacyIndex,
    backendNow,
    check,
  );
  check();

  const typedGroups = groups.filter((group) => group.kind === 'typed_preference');
  for (const group of groups) {
    check();
    if (group.kind === 'typed_preference' && group.meaning) literal.prepareMeaning(group.meaning);
  }

  const relevantCounts = new Map(typedGroups.map((group) => [group.key, 0]));
  let capExceeded = false;
  for (const edge of legacyEdges) {
    check();
    if (!beginAutomaticClaimReadAttempt(scope)) stop('budget_exhausted');
    const remaining = getAutomaticClaimReadScopeRemaining(scope)?.contextBytesRemaining;
    if (remaining === undefined) stop('budget_exhausted');
    const limit = Math.min(512 * 1024, remaining);
    const rawClaim = edge.attributes.engram_claim_v1;
    const rawVersion =
      rawClaim !== null && typeof rawClaim === 'object' && !Array.isArray(rawClaim)
        ? Object.getOwnPropertyDescriptor(rawClaim, 'version')?.value
        : undefined;
    if (rawVersion === 2) {
      const inspected = compositional.projectCandidate(edge.uuid, limit);
      check();
      const spent = Math.min(inspected.inspectedBytes, remaining);
      if (
        !chargeAutomaticClaimContextBytes(scope, spent) ||
        inspected.inspectedBytes > limit ||
        (inspected.result.status === 'invalid' &&
          ['context_too_large', 'proof_too_large'].includes(inspected.result.reason))
      )
        stop('budget_exhausted');
      for (const group of typedGroups) {
        if (!group.meaning) stop('inspection_incomplete');
        const relation = claimV2Disposition(inspected, group.meaning, check);
        if (relation.relevant) {
          accountStoredRelation(accounting, group, edge.uuid);
          const next = (relevantCounts.get(group.key) ?? 0) + 1;
          relevantCounts.set(group.key, next);
          if (next > 8) capExceeded = true;
        }
        if (relation.reason) {
          if (!group.reference) group.reasons.add(relation.reason);
        }
      }
    } else {
      const inspected = literal.projectCandidate(edge.uuid, limit);
      check();
      if (!inspected) stop('inspection_incomplete');
      const spent = Math.min(inspected.inspectedBytes, remaining);
      if (
        !chargeAutomaticClaimContextBytes(scope, spent) ||
        inspected.inspectedBytes > limit ||
        inspected.capacityExceeded
      )
        stop('budget_exhausted');
      for (const group of typedGroups) {
        if (!group.meaning) stop('inspection_incomplete');
        const relation = inspected.compare(group.meaning);
        check();
        const disposition = directLegacyDisposition(relation, group.meaning, check);
        if (disposition.relevant) {
          accountStoredRelation(accounting, group, edge.uuid);
          const next = (relevantCounts.get(group.key) ?? 0) + 1;
          relevantCounts.set(group.key, next);
          if (next > 8) capExceeded = true;
        }
        if (disposition.reason) {
          if (!group.reference) group.reasons.add(disposition.reason);
        }
      }
    }
  }
  if (capExceeded) stop('inspection_incomplete');
}

function reasonPriority(
  group: PlanGroup,
):
  | 'existing_ineligible'
  | 'legacy_reuse_not_authorized'
  | 'unknown_overlap_domain'
  | 'possible_overlap'
  | null {
  for (const reason of [
    'existing_ineligible',
    'legacy_reuse_not_authorized',
    'unknown_overlap_domain',
    'possible_overlap',
  ] as const) {
    if (group.reasons.has(reason)) return reason;
  }
  return null;
}

function addTypedConstraint(
  group: PlanGroup,
  oldMeaning: CompositionalAutomaticClaimMeaningV2,
  oldKey: string,
  check: () => void,
  accounting: PlannerRelationAccounting,
  storedEdgeId: string,
): void {
  if (!group.meaning) stop('inspection_incomplete');
  const compared = compareCompositionalMeaningOverlapDomainV1(oldMeaning, group.meaning, check);
  check();
  if (compared.domain !== 'proven_disjoint') accountStoredRelation(accounting, group, storedEdgeId);
  if (compared.equivalent && group.key !== oldKey) {
    // Semantic equality under a different durable key is an integrity conflict.
    stop('conflict');
  }
  if (compared.domain === 'proven_disjoint') return;
  if (!group.reference) {
    group.reasons.add(
      compared.domain === 'unknown_domain' ? 'unknown_overlap_domain' : 'possible_overlap',
    );
  }
}

function currentFamily4Consistency(
  groups: readonly PlanGroup[],
  existing: readonly ExistingFamily4[],
  currentSourceEventTime: string,
  check: () => void,
  accounting: PlannerRelationAccounting,
): void {
  const typedGroups = groups.filter((group) => group.kind === 'typed_preference');
  const qualifiedReferenceTargetIds = new Set(
    typedGroups.flatMap((group) =>
      group.reference?.eligibility === 'qualified' ? [group.reference.edge.uuid] : [],
    ),
  );
  for (const group of groups) {
    check();
    if (group.reference) accountStoredRelation(accounting, group, group.reference.edge.uuid);
  }

  for (const row of existing) {
    check();
    if (row.claim.kind !== 'typed_preference') continue;
    if (row.eligibility !== 'qualified') {
      for (const group of typedGroups) {
        accountStoredRelation(accounting, group, row.edge.uuid);
        if (!group.reference) group.reasons.add('unknown_overlap_domain');
      }
      continue;
    }
    for (const group of typedGroups) {
      if (
        group.reference &&
        row.edge.uuid !== group.reference.edge.uuid &&
        qualifiedReferenceTargetIds.has(row.edge.uuid)
      )
        continue;
      addTypedConstraint(group, row.claim.meaning, row.claim.key, check, accounting, row.edge.uuid);
    }
  }

  const createTyped = typedGroups.filter((group) => !group.reference);
  for (let leftIndex = 0; leftIndex < createTyped.length; leftIndex += 1) {
    const left = createTyped[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < createTyped.length; rightIndex += 1) {
      check();
      const right = createTyped[rightIndex]!;
      if (!left.meaning || !right.meaning) stop('inspection_incomplete');
      const compared = compareCompositionalMeaningOverlapDomainV1(
        left.meaning,
        right.meaning,
        check,
      );
      check();
      if (compared.domain !== 'proven_disjoint') accountIncomingPair(accounting, left, right);
      if (compared.equivalent) stop('conflict');
      if (compared.domain === 'possible_overlap') {
        left.reasons.add('possible_overlap');
        right.reasons.add('possible_overlap');
      } else if (compared.domain === 'unknown_domain') {
        left.reasons.add('unknown_overlap_domain');
        right.reasons.add('unknown_overlap_domain');
      }
    }
  }

  for (const group of groups) {
    check();
    if (group.kind !== 'source_statement_record' || group.reference || !group.occurrences[0]?.claim)
      continue;
    const claim = group.occurrences[0]!.claim!;
    if (claim.kind !== 'source_statement_record') continue;
    const literal = claim.evidence.literal;
    const acceptedCreate = claim.policy.autoAccept;
    for (const prior of existing) {
      check();
      if (
        prior.claim.evidence.literal === literal &&
        prior.proof.sourceEventTime !== currentSourceEventTime
      ) {
        accountStoredRelation(accounting, group, prior.edge.uuid);
        if (
          acceptedCreate &&
          (prior.proof.reviewState !== 'accepted' || prior.eligibility !== 'qualified')
        ) {
          group.reasons.add('existing_ineligible');
        }
      }
    }
  }
}

function assertNoDeterministicIdCollision(
  graph: GraphData,
  groups: readonly PlanGroup[],
  check: () => void,
): void {
  const occupied = allIds(graph, check);
  const newClaimIds = new Map<string, string>();
  const newValueIds = new Map<string, string>();
  for (const group of groups) {
    check();
    group.recordIds = deriveAutonomousPersonalRecordIdsV1({
      namespace: group.namespace,
      subjectId: group.subjectId,
      key: group.key,
    });
    for (const [map, id] of [
      [newClaimIds, group.recordIds.claimId] as const,
      [newValueIds, group.recordIds.valueId] as const,
    ]) {
      const prior = map.get(id);
      if (prior !== undefined && prior !== group.key) stop('conflict');
      map.set(id, group.key);
    }
    if (group.reference) {
      if (group.reference.edge.uuid !== group.recordIds.claimId) stop('conflict');
      continue;
    }
    if (occupied.has(group.recordIds.claimId) || occupied.has(group.recordIds.valueId))
      stop('conflict');
  }
}

function referenceGuard(
  graph: GraphData,
  group: PlanGroup,
  indexes: number[],
  check: () => void,
): AutonomousPersonalCompletionPlanV4ReferenceGuard {
  const existing = group.reference;
  if (!existing) stop('conflict');
  const proof = existing.proof;
  const value = actualRecord(graph.entities, proof.valueId, check);
  const source = actualRecord(graph.episodes, proof.sourceId, check);
  const operation = actualOperation(graph, proof.operationId, check);
  if (!value || !source || !operation) stop('conflict');
  check();
  return {
    claimId: proof.claimId,
    valueId: proof.valueId,
    sourceId: proof.sourceId,
    operationId: proof.operationId,
    key: proof.key,
    meaningHash: proof.meaningHash,
    reviewState: proof.reviewState,
    occurrenceIndexes: [...indexes].sort((a, b) => a - b),
    claimRowHash: hashAutomaticCaptureV2(existing.edge),
    valueRowHash: hashAutomaticCaptureV2(value),
    sourceRowHash: hashAutomaticCaptureV2(source),
    operationRowHash: hashAutomaticCaptureV2(operation),
  };
}

function createdPair(
  group: PlanGroup,
  sourceId: string,
  namespace: string,
  subjectId: string,
  createdAt: string,
  state: 'accepted' | 'proposed',
): { entity: EntityNode; edge: EntityEdge } {
  const first = group.occurrences[0];
  const claim = first?.claim;
  const ids = group.recordIds;
  if (!first || !claim || !ids) stop('capacity');
  const metadata = ExtractionMetadataV2Schema.parse({
    version: 2,
    source: 'policy',
    confidence: null,
    review_status: state,
    threshold_decision: state === 'accepted' ? 'auto_accepted' : 'pending_review',
    extracted_at: createdAt,
    episode_uuids: [sourceId],
    reviewed_at: null,
    reviewed_by: null,
  });
  const marker = AutonomousPersonalValueMarkerV3OwnedDataSchema.parse({
    version: 3,
    family: 'autonomous-personal-v1',
    kind: claim.kind,
    key: claim.key,
    namespace,
    subjectId,
  });
  const entity = EntityNodeSchema.parse({
    uuid: ids.valueId,
    group_id: namespace,
    name: claim.evidence.literal,
    summary: '',
    entity_type: 'autonomous_personal_value',
    name_embedding: null,
    attributes: { engram_literal_v1: marker, engram_extraction: metadata },
    created_at: createdAt,
    updated_at: createdAt,
  });
  const edge = EntityEdgeSchema.parse({
    uuid: ids.claimId,
    group_id: namespace,
    source_node_uuid: subjectId,
    target_node_uuid: entity.uuid,
    name: claim.kind === 'typed_preference' ? 'PREFERS' : 'STATED',
    fact: claim.evidence.literal,
    fact_embedding: null,
    episodes: [sourceId],
    valid_at: null,
    invalid_at: null,
    expired_at: null,
    attributes: { engram_claim_v1: claim, engram_extraction: metadata },
    created_at: createdAt,
    updated_at: createdAt,
  });
  return { entity, edge };
}

function occurrenceItems(
  groups: readonly PlanGroup[],
  selection: AutonomousPersonalEvidenceSelectionV1,
  profileState: 'accepted' | 'proposed',
): Array<{
  occurrenceIndex: number;
  kind: 'typed_preference' | 'source_statement_record';
  evidenceHash: string;
  meaningHash: string;
  dependencies: Array<{ index: number; dependencyHash: string }>;
  state: 'accepted' | 'proposed' | 'rejected' | 'not_selected';
  effect: 'created' | 'reference' | 'none';
  claimId: string | null;
  reason:
    | 'eligible_create'
    | 'existing_accepted'
    | 'profile_review_required'
    | 'existing_proposed'
    | 'existing_rejected'
    | 'explicit_intent_required'
    | 'existing_ineligible'
    | 'legacy_reuse_not_authorized'
    | 'possible_overlap'
    | 'unknown_overlap_domain';
}> {
  const byOccurrence = new Map<number, PlanGroup>();
  for (const group of groups)
    for (const occurrence of group.occurrences) byOccurrence.set(occurrence.index, group);
  return selection.occurrences.map((occurrence, index) => {
    const group = byOccurrence.get(index);
    if (!group) stop('conflict');
    const shared = {
      occurrenceIndex: index,
      kind: occurrence.kind,
      evidenceHash: occurrence.evidenceHash,
      meaningHash: occurrence.meaningHash,
      dependencies: occurrence.dependencies,
    };
    if (group.reference) {
      const state = group.reference.proof.reviewState;
      return {
        ...shared,
        state,
        effect: 'reference' as const,
        claimId: group.reference.proof.claimId,
        reason:
          state === 'accepted'
            ? ('existing_accepted' as const)
            : state === 'proposed'
              ? ('existing_proposed' as const)
              : ('existing_rejected' as const),
      };
    }
    const reason = reasonPriority(group);
    if (reason) {
      return {
        ...shared,
        state: 'not_selected' as const,
        effect: 'none' as const,
        claimId: null,
        reason,
      };
    }
    const firstIndex = group.occurrences[0]!.index;
    return {
      ...shared,
      state: profileState,
      effect: index === firstIndex ? ('created' as const) : ('reference' as const),
      claimId: group.recordIds!.claimId,
      reason:
        index === firstIndex
          ? profileState === 'accepted'
            ? ('eligible_create' as const)
            : ('profile_review_required' as const)
          : profileState === 'accepted'
            ? ('existing_accepted' as const)
            : ('existing_proposed' as const),
    };
  });
}

function responseReceipt(
  input: AutonomousPersonalCompletionPlanV4Input,
  selection: AutonomousPersonalEvidenceSelectionV1,
  groups: readonly PlanGroup[],
  profileState: 'accepted' | 'proposed',
  check: () => void,
): { receipt: AutonomousPersonalReceiptV4; items: ReturnType<typeof occurrenceItems> } {
  const items = occurrenceItems(groups, selection, profileState);
  if (items.length === 0) {
    const coverage = selection.sourceCoverage;
    const outcome =
      coverage.status === 'complete'
        ? coverage.withheldUnitCount > 0
          ? 'unsupported_source'
          : 'known_no_memory'
        : 'unknown_source';
    return {
      receipt: buildSourceVerdictReceipt(input, coverage, outcome, check),
      items,
    };
  }
  const acceptedCount = items.filter((item) => item.state === 'accepted').length;
  const acceptedCoverage =
    acceptedCount === 0 ? 'none' : acceptedCount === items.length ? 'all' : 'partial';
  const value = {
    ...terminalReceiptBase(input),
    kind: 'human_autonomous_capture_committed' as const,
    interpretationCoverage: selection.sourceCoverage.status as 'complete' | 'partial',
    acceptedCoverage,
    acceptanceSemantics: 'per_item_kind_v1' as const,
    sourceCoverage: selection.sourceCoverage,
    selection: { kind: 'occurrences' as const, items },
  };
  check();
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16 * 1024) {
    return {
      receipt: buildDeferredReceipt(
        input,
        'interpretation_capacity',
        interpretationCapacityCoverage(selection.sourceCoverage.sourceUnitCount ?? 1),
        check,
      ),
      items,
    };
  }
  const parsed = AutonomousPersonalReceiptV4OwnedDataSchema.safeParse(value);
  check();
  if (!parsed.success) stop('conflict');
  return { receipt: parsed.data, items };
}

type VerifiedInitialCandidate = Extract<
  ReturnType<typeof prepareAutonomousPersonalCaptureSnapshotV4>,
  { kind: 'same_initial_scope_candidate' }
> & {
  operation: Extract<AutonomousPersonalOperationV4, { state: 'leased' }>;
};

function verifyInputSource(
  input: AutonomousPersonalCompletionPlanV4Input,
  graph: GraphData,
  snapshot: unknown,
  check: () => void,
): VerifiedInitialCandidate {
  const { scope, stagedFresh } = input;
  const stagedOperation = stagedFresh.operation;
  if (
    stagedOperation.state !== 'leased' ||
    stagedOperation.generation !== 1 ||
    stagedOperation.lease.claimKind !== 'initial' ||
    scope.sourceId !== stagedFresh.episode.uuid ||
    scope.operationId !== stagedOperation.operationId ||
    scope.leaseToken !== stagedOperation.lease.token ||
    !same(scope.descriptor, stagedOperation.descriptor) ||
    input.audit.action !== 'completion' ||
    input.audit.operationId !== stagedOperation.operationId ||
    input.audit.sourceId !== stagedFresh.episode.uuid
  )
    stop('conflict');

  if (Date.parse(input.backendNow) < Date.parse(stagedOperation.lastObservedAt))
    stop('clock_regression');
  if (Date.parse(input.backendNow) >= Date.parse(stagedOperation.lease.expiresAt))
    stop('lease_expired');

  const request = AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema.safeParse({
    request: scope.request,
    context: scope.context,
    sourceId: scope.sourceId,
    operationId: scope.operationId,
    leaseToken: scope.leaseToken,
    stableBeginHash: scope.stableBeginHash,
    attemptHash: scope.attemptHash,
    backendNow: input.backendNow,
    previousEpisodeId: stagedFresh.episode.previous_episode_uuid,
  });
  if (!request.success) stop('invalid_input');
  check();
  const prepared = prepareAutonomousPersonalCaptureSnapshotV4(request.data, snapshot, check);
  check();
  if (prepared.kind === 'no_write') stop(beginProjectionReason(prepared.resultProjection));
  if (prepared.kind !== 'same_initial_scope_candidate') stop('conflict');

  const actualOperation = prepared.operation;
  if (
    actualOperation.state !== 'leased' ||
    prepared.fence.version !== stagedFresh.fence.version ||
    !same(prepared.fence, stagedFresh.fence) ||
    !same(omitAppendOnlyAudit(actualOperation), omitAppendOnlyAudit(stagedOperation))
  )
    stop('conflict');
  if (
    prepared.episode.review_status !== stagedFresh.episode.review_status ||
    prepared.episode.trust_level !== stagedFresh.episode.trust_level
  )
    stop('authority_changed');
  if (
    !same(omitMutableEpisodeUpdate(prepared.episode), omitMutableEpisodeUpdate(stagedFresh.episode))
  )
    stop('conflict');
  return prepared as VerifiedInitialCandidate;
}

/**
 * Builds a complete candidate DATA diff from the same staged initial lease and
 * actual complete graph snapshot. This function has no backend write capability.
 */
export function planAutonomousPersonalCaptureCompletionV4(
  inputValue: unknown,
  graphValue: unknown,
  responseValue: unknown | null,
  selectionValue: unknown | null,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  trustedCheck: () => void,
  legacyReadBudgetValue: SourceHydrationBudget,
  existingReadScope?: AutomaticClaimReadScope,
): AutonomousPersonalCompletionPlanV4 {
  if (
    typeof trustedCheck !== 'function' ||
    utilTypes.isProxy(trustedCheck) ||
    utilTypes.isAsyncFunction(trustedCheck)
  )
    return noWrite('invalid_input');
  const work = nativeWorkData(typedSyntaxWork);
  const legacyReadBudget = nativeBudget(legacyReadBudgetValue);
  if (!work || !legacyReadBudget || nativeAbortSignalAbortedGetter === undefined)
    return noWrite('invalid_input');

  let input: AutonomousPersonalCompletionPlanV4Input;
  try {
    input = inputSnapshot(inputValue);
  } catch (error) {
    return noWrite(
      error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json'
        ? 'capacity'
        : 'invalid_input',
    );
  }

  if (
    existingReadScope !== undefined &&
    !isAutomaticClaimReadScopeForBudget(existingReadScope, legacyReadBudget)
  )
    return noWrite('invalid_input');
  const scope = existingReadScope ?? getAutomaticClaimReadScope(legacyReadBudget);
  let trustedFailure: unknown;
  let trustedFailed = false;
  let latchedStop: PlanStop | undefined;
  let snapshotIndexed = false;
  const workDeadline = Math.min(work.deadline, input.scope.deadlineAtMonotonicMs);
  const check = () => {
    if (trustedFailed) throw trustedFailure;
    if (latchedStop) throw latchedStop;
    try {
      const checkRuntimeBounds = () => {
        if (nativeAbortSignalAbortedGetter.call(work.signal)) {
          latchedStop = new PlanStop('budget_exhausted');
          throw latchedStop;
        }
        const now = performance.now();
        if (!Number.isFinite(now)) {
          latchedStop = new PlanStop('invalid_input');
          throw latchedStop;
        }
        if (now >= workDeadline || !canUseAutomaticClaimReadScope(scope)) {
          latchedStop = new PlanStop('budget_exhausted');
          throw latchedStop;
        }
      };
      checkRuntimeBounds();
      try {
        trustedCheck();
      } catch (error) {
        trustedFailed = true;
        trustedFailure = error;
        throw error;
      }
      checkRuntimeBounds();
    } catch (error) {
      if (trustedFailed) throw trustedFailure;
      if (latchedStop) throw latchedStop;
      latchedStop = error instanceof PlanStop ? error : new PlanStop('invalid_input');
      throw latchedStop;
    }
  };

  try {
    check();
    if (nativeBudget(legacyReadBudgetValue) !== legacyReadBudget) stop('invalid_input');

    // A module-registered claim index shares its frozen graph DATA; raw input parses as before.
    let registered: GraphData | undefined;
    try {
      registered = getRegisteredAutonomousPersonalClaimIndexGraphV4(graphValue);
    } catch (error) {
      // Only a known index throws here; keep its guard failure out of the raw mapping.
      snapshotIndexed = true;
      throw error;
    }
    snapshotIndexed = registered !== undefined;
    let graph: GraphData;
    try {
      graph =
        registered ??
        getOwnedImmutableGraphData(graphValue) ??
        parseLosslessAutomaticCaptureGraph(graphValue);
    } catch (error) {
      if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
        stop('capacity');
      stop('conflict');
    }
    check();
    const snapshot: unknown = registered ? graphValue : graph;

    const prepared = verifyInputSource(input, graph, snapshot, check);
    const source = prepared.episode;
    const stored = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source,
      descriptor: prepared.operation.descriptor,
    });
    check();
    if (
      !AutonomousPersonalStoredSourceIdentityV4OwnedDataSchema.safeParse(stored).success ||
      stored.descriptorValidation !== 'compiled_descriptor' ||
      stored.tuple.identity.storeHash !== input.scope.context.storeHash ||
      stored.tuple.owner.namespace !== input.scope.context.namespace ||
      stored.tuple.owner.binding.subjectId !== input.scope.context.binding.subjectId
    )
      stop('authority_changed');

    let selection: AutonomousPersonalEvidenceSelectionV1 | null = null;
    let noResponsePreparation: ReturnType<typeof providerPreparation> | null = null;
    let providerPromptFailure: AutonomousPersonalProviderPromptFailureV1 | null = null;
    if (input.outcome.kind === 'response') {
      if (responseValue === null || selectionValue === null) stop('invalid_input');
      const providerParsed = AutonomousPersonalProviderResponseV1Schema.safeParse(responseValue);
      check();
      if (!providerParsed.success) stop('invalid_input');
      const retainedSelection =
        AutonomousPersonalEvidenceSelectionV1Schema.safeParse(selectionValue);
      check();
      if (!retainedSelection.success || retainedSelection.data.status !== 'complete')
        stop('invalid_input');
      const recompiled = compileAutonomousPersonalEvidenceSelectionV1(
        { source, descriptor: prepared.operation.descriptor },
        providerParsed.data,
        typedSyntaxWork,
      );
      check();
      if (recompiled.status !== 'complete' || !same(recompiled, retainedSelection.data))
        stop('conflict');
      selection = recompiled;
    } else {
      if (responseValue !== null || selectionValue !== null) stop('invalid_input');
      try {
        const preparation = providerPreparation(
          source,
          prepared.operation.descriptor,
          typedSyntaxWork,
          check,
        );
        noResponsePreparation = preparation;
      } catch (error) {
        if (!(error instanceof AutonomousPersonalProviderPromptFailureV1)) throw error;
        providerPromptFailure = error;
      }
      if (input.outcome.kind === 'no_dispatch') {
        if (
          providerPromptFailure ||
          noResponsePreparation?.kind !== 'no_dispatch' ||
          noResponsePreparation.reason !== input.outcome.reason
        )
          stop('conflict');
      } else if (
        providerPromptFailure &&
        (providerPromptFailure.reason !== 'request_bytes' ||
          input.outcome.reason !== 'provider_request_bytes')
      ) {
        stop('conflict');
      }
    }

    if (input.outcome.kind === 'deferred') {
      if (
        noResponsePreparation?.kind === 'no_dispatch' ||
        (!providerPromptFailure && noResponsePreparation?.kind !== 'dispatch')
      )
        stop('conflict');
      if (
        providerPromptFailure &&
        (providerPromptFailure.reason !== 'request_bytes' ||
          input.outcome.reason !== 'provider_request_bytes')
      )
        stop('conflict');
      const unitCount =
        noResponsePreparation?.kind === 'dispatch'
          ? noResponsePreparation.prompt.unitIds.length
          : completeSourceUnitCount(stored, check);
      if (unitCount < 1 || unitCount > 32) stop('conflict');
      const coverage =
        input.outcome.reason === 'interpretation_capacity'
          ? interpretationCapacityCoverage(unitCount)
          : AutonomousPersonalSourceCoverageV4OwnedDataSchema.parse({
              status: 'unknown',
              scanStatus: 'complete',
              sourceUnitCount: unitCount,
              candidateUnitCount: 0,
              neutralUnitCount: 0,
              withheldUnitCount: 0,
              unresolvedUnitCount: unitCount,
              unresolvedReason: 'provider_failure',
            });
      const receipt = buildDeferredReceipt(input, input.outcome.reason, coverage, check);
      const operation = terminalOperation(input, receipt, check, prepared.operation);
      return plannedOutput(
        { kind: 'planned', createEntities: [], createEdges: [], operation, referenceGuards: [] },
        check,
      );
    }

    if (input.outcome.kind === 'no_dispatch') {
      let coverage: AutonomousPersonalSourceCoverageV4;
      let verdict:
        | 'known_no_memory'
        | 'unsupported_source'
        | 'unknown_source'
        | 'policy_not_selected';
      if (input.outcome.reason === 'policy_not_selected') {
        if (
          prepared.operation.descriptor.policy.profileId !== 'explicit' ||
          prepared.operation.descriptor.intentSetting !== false
        )
          stop('conflict');
        coverage = policyNotSelectedCoverage(stored, check);
        verdict = 'policy_not_selected';
      } else {
        const sourceOnly = compileAutonomousPersonalEvidenceSelectionV1(
          { source, descriptor: prepared.operation.descriptor },
          null,
          typedSyntaxWork,
        );
        check();
        if (input.outcome.reason === 'empty_source') {
          if (sourceOnly.status !== 'complete' || sourceOnly.units.length !== 0) stop('conflict');
          coverage = sourceOnly.sourceCoverage;
          verdict = 'known_no_memory';
        } else if (input.outcome.reason === 'source_indeterminate') {
          if (sourceOnly.status !== 'not_interpreted') stop('conflict');
          coverage = sourceOnly.sourceCoverage;
          verdict = 'unknown_source';
        } else {
          if (sourceOnly.status !== 'capacity') stop('conflict');
          const expected =
            sourceOnly.reason === 'source_resource'
              ? 'source_resource'
              : sourceOnly.reason === 'unit_count'
                ? 'unit_count'
                : sourceOnly.reason === 'typed_metadata'
                  ? 'typed_metadata'
                  : 'aggregate';
          if (expected !== input.outcome.reason) stop('conflict');
          coverage = sourceOnly.sourceCoverage;
          verdict = 'unknown_source';
        }
      }
      if (
        input.outcome.reason === 'source_resource' ||
        input.outcome.reason === 'unit_count' ||
        input.outcome.reason === 'typed_metadata' ||
        input.outcome.reason === 'aggregate'
      ) {
        const receipt = buildDeferredReceipt(input, 'interpretation_capacity', coverage, check);
        const operation = terminalOperation(input, receipt, check, prepared.operation);
        return plannedOutput(
          { kind: 'planned', createEntities: [], createEdges: [], operation, referenceGuards: [] },
          check,
        );
      }
      const receipt = buildSourceVerdictReceipt(input, coverage, verdict, check);
      const operation = terminalOperation(input, receipt, check, prepared.operation);
      return plannedOutput(
        { kind: 'planned', createEntities: [], createEdges: [], operation, referenceGuards: [] },
        check,
      );
    }

    if (!selection) stop('conflict');
    const occurrences = sourceCandidateOccurrences(
      source,
      stored,
      selection,
      typedSyntaxWork,
      check,
    );
    const groups = makeGroups(occurrences);
    const index = inspectExistingFamily4(
      graph,
      snapshot,
      input.scope.context.namespace,
      input.scope.context.binding.subjectId,
      input.scope.context.storeHash,
      input.backendNow,
      typedSyntaxWork,
      check,
      scope,
    );
    check();

    for (const group of groups) {
      check();
      group.reference = groupExistingReference(group, index.rowsByKey, index.candidateEdgesByKey);
    }
    assertNoDeterministicIdCollision(graph, groups, check);
    const relationAccounting = createPlannerRelationAccounting();
    currentFamily4Consistency(
      groups,
      index.rows,
      new Date(Date.parse(source.reference_time)).toISOString(),
      check,
      relationAccounting,
    );

    // The old projector path remains a low-level legacy-only projection. B1b
    // structural family4 rows were already removed from this legacy universe.
    compareLegacyCandidates(
      index.legacyIndex,
      input.backendNow,
      index.legacyIds,
      groups,
      check,
      scope,
      relationAccounting,
    );

    if (occurrences.some((occurrence) => occurrence.result?.kind !== 'candidate')) {
      const coverage = interpretationCapacityCoverage(
        selection.sourceCoverage.sourceUnitCount ?? 1,
      );
      const receipt = buildDeferredReceipt(input, 'interpretation_capacity', coverage, check);
      const operation = terminalOperation(input, receipt, check, prepared.operation);
      return plannedOutput(
        { kind: 'planned', createEntities: [], createEdges: [], operation, referenceGuards: [] },
        check,
      );
    }

    const profileState = prepared.operation.descriptor.policy.autoAccept ? 'accepted' : 'proposed';
    const { receipt, items } = responseReceipt(input, selection, groups, profileState, check);
    const operation = terminalOperation(input, receipt, check, prepared.operation);
    if (receipt.kind !== 'human_autonomous_capture_committed') {
      return plannedOutput(
        { kind: 'planned', createEntities: [], createEdges: [], operation, referenceGuards: [] },
        check,
      );
    }

    const createEntities: EntityNode[] = [];
    const createEdges: EntityEdge[] = [];
    const referenceGuards: AutonomousPersonalCompletionPlanV4ReferenceGuard[] = [];
    for (const group of groups) {
      check();
      if (group.reference) {
        const indexes = group.occurrences.map((occurrence) => occurrence.index);
        referenceGuards.push(referenceGuard(graph, group, indexes, check));
        continue;
      }
      if (reasonPriority(group)) continue;
      const pair = createdPair(
        group,
        source.uuid,
        input.scope.context.namespace,
        input.scope.context.binding.subjectId,
        prepared.operation.lease.renewedAt,
        profileState,
      );
      createEntities.push(pair.entity);
      createEdges.push(pair.edge);
    }
    if (createEntities.length + createEdges.length + referenceGuards.length > items.length * 2)
      stop('conflict');
    return plannedOutput(
      { kind: 'planned', createEntities, createEdges, operation, referenceGuards },
      check,
      () => {
        const coverage = interpretationCapacityCoverage(
          selection.sourceCoverage.sourceUnitCount ?? 1,
        );
        const receipt = buildDeferredReceipt(input, 'interpretation_capacity', coverage, check);
        const fallbackOperation = terminalOperation(input, receipt, check, prepared.operation);
        return {
          kind: 'planned',
          createEntities: [],
          createEdges: [],
          operation: fallbackOperation,
          referenceGuards: [],
        };
      },
    );
  } catch (error) {
    // A known DATA index retains its own sticky guard failure, without raw-error mapping.
    if (snapshotIndexed) getRegisteredAutonomousPersonalClaimIndexGraphV4(graphValue);
    if (trustedFailed) throw trustedFailure;
    if (latchedStop) return noWrite(latchedStop.reason);
    if (error instanceof PlanStop) return noWrite(error.reason);
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) {
      return noWrite(
        error.reason === 'deadline' || error.reason === 'cancelled'
          ? 'budget_exhausted'
          : 'invalid_input',
      );
    }
    if (error instanceof AutonomousPersonalEvidenceSelectionFailureV1) {
      return noWrite(
        error.code === 'deadline_autonomous_evidence_selection' ||
          error.code === 'cancelled_autonomous_evidence_selection'
          ? 'budget_exhausted'
          : 'conflict',
      );
    }
    if (error instanceof AutonomousPersonalClaimIndexV4Error) {
      return noWrite(
        error.reason === 'snapshot_capacity' ? 'inspection_incomplete' : 'inspection_incomplete',
      );
    }
    if (error instanceof CompositionalSnapshotIndexErrorV3) {
      return noWrite(
        error.reason === 'budget_exhausted' ? 'budget_exhausted' : 'inspection_incomplete',
      );
    }
    if (error instanceof BoundedAutomaticCaptureJsonError) {
      return noWrite(error.reason === 'invalid_json' ? 'conflict' : 'capacity');
    }
    return noWrite('conflict');
  }
}
