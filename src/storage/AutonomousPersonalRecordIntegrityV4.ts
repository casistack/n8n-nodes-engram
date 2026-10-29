import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalRecordIntegrityV4FailureReasonSchema,
  type AutonomousPersonalRecordIntegrityV4FailureReason,
} from '../schemas/AutonomousPersonalRecordIntegrityV4.schema';
import type { AutonomousPersonalOperationV4 } from '../schemas/AutonomousPersonalOperationV4.schema';
import type { GraphData } from '../schemas/GraphData.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import { AutonomousPersonalTypedSyntaxFailureV1 } from '../extraction/AutonomousPersonalTypedSyntaxV1';
import {
  AutonomousPersonalClaimIndexV4Error,
  createAutonomousPersonalClaimIndexV4,
  getAutonomousPersonalClaimIndexGraphV4,
  inspectAutonomousPersonalClaimCreatorV4,
  type AutonomousPersonalClaimIndexV4,
} from '../extraction/AutonomousPersonalQualifiedClaimV4';
import type { AutonomousPersonalQualifiedClaimProofV4 } from '../schemas/AutonomousPersonalQualifiedClaimV4.schema';
import {
  BoundedAutomaticCaptureJsonError,
  isNativePlainAutomaticCaptureObject,
} from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';

const CLAIM_ATTRIBUTE = 'engram_claim_v1';
const VALUE_MARKER_ATTRIBUTE = 'engram_literal_v1';
const PERSONAL_VALUE_TYPE = 'autonomous_personal_value';
const PERSONAL_FAMILY = 'autonomous-personal-v1';

type CommittedOperationV4 = Extract<AutonomousPersonalOperationV4, { state: 'committed' }>;
type OccurrenceReceiptV4 = Extract<
  CommittedOperationV4['terminalReceipt'],
  { selection: { kind: 'occurrences' } }
>;
type OccurrenceItemV4 = OccurrenceReceiptV4['selection']['items'][number];

type PositiveOccurrenceV4 = Readonly<{
  operation: CommittedOperationV4;
  item: OccurrenceItemV4;
}>;

type Footprints = {
  readonly edgeIds: Set<string>;
  readonly valueIds: Set<string>;
  readonly positiveOccurrences: PositiveOccurrenceV4[];
};

type TrustedCheck = {
  readonly check: () => void;
  readonly rethrowFailure: () => void;
};

type WorkContext = Readonly<{ deadline: number; signal: AbortSignal }>;

const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

export class AutonomousPersonalRecordIntegrityV4Error extends Error {
  readonly reason: AutonomousPersonalRecordIntegrityV4FailureReason;

  constructor(reason: AutonomousPersonalRecordIntegrityV4FailureReason) {
    const parsedReason = AutonomousPersonalRecordIntegrityV4FailureReasonSchema.safeParse(reason);
    super('Engram autonomous personal record integrity failed');
    this.name = 'AutonomousPersonalRecordIntegrityV4Error';
    this.reason = parsedReason.success ? parsedReason.data : 'invalid_snapshot';
    Object.freeze(this);
  }
}

function fail(reason: AutonomousPersonalRecordIntegrityV4FailureReason): never {
  throw new AutonomousPersonalRecordIntegrityV4Error(reason);
}

function stickyTrustedCheck(callback: () => void): TrustedCheck {
  let failed = false;
  let failure: unknown;
  const check = () => {
    if (failed) throw failure;
    try {
      callback();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
  return {
    check,
    rethrowFailure: () => {
      if (failed) throw failure;
    },
  };
}

function readWorkContext(value: unknown): WorkContext {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value)
  ) {
    throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  }
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal')
    ) {
      throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
    }
    const deadlineProperty = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signalProperty = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      !deadlineProperty ||
      !deadlineProperty.enumerable ||
      !('value' in deadlineProperty) ||
      !signalProperty ||
      !signalProperty.enumerable ||
      !('value' in signalProperty) ||
      typeof deadlineProperty.value !== 'number' ||
      !Number.isFinite(deadlineProperty.value) ||
      signalProperty.value === null ||
      typeof signalProperty.value !== 'object' ||
      utilTypes.isProxy(signalProperty.value) ||
      nativeAbortSignalAbortedGetter === undefined
    ) {
      throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
    }
    nativeAbortSignalAbortedGetter.call(signalProperty.value);
    return { deadline: deadlineProperty.value, signal: signalProperty.value as AbortSignal };
  } catch (error) {
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  }
}

function stickyWorkCheck(work: unknown, trusted: TrustedCheck): TrustedCheck {
  const supplied = readWorkContext(work);
  const abortedGetter = nativeAbortSignalAbortedGetter;
  if (abortedGetter === undefined) throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
  let failed = false;
  let failure: unknown;
  const latch = (error: unknown): never => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    throw failure;
  };
  const checkWork = () => {
    try {
      if (abortedGetter.call(supplied.signal)) {
        throw new AutonomousPersonalTypedSyntaxFailureV1('cancelled');
      }
      const now = performance.now();
      if (!Number.isFinite(now)) throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
      if (now >= supplied.deadline) throw new AutonomousPersonalTypedSyntaxFailureV1('deadline');
    } catch (error) {
      if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
      throw new AutonomousPersonalTypedSyntaxFailureV1('internal');
    }
  };
  const check = () => {
    if (failed) throw failure;
    try {
      checkWork();
      trusted.check();
      checkWork();
    } catch (error) {
      latch(error);
    }
  };
  return {
    check,
    rethrowFailure: () => {
      if (failed) throw failure;
      trusted.rethrowFailure();
    },
  };
}

function isFamilyFourTag(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.version === 'number' && record.version >= 3) || record.family === PERSONAL_FAMILY
  );
}

function collectFootprints(graph: GraphData, check: () => void): Footprints {
  const edgeIds = new Set<string>();
  const valueIds = new Set<string>();
  const positiveOccurrences: PositiveOccurrenceV4[] = [];

  check();
  for (const edge of graph.edges) {
    check();
    if (isFamilyFourTag(edge.attributes[CLAIM_ATTRIBUTE])) edgeIds.add(edge.uuid);
  }
  check();

  for (const entity of graph.entities) {
    check();
    if (
      isFamilyFourTag(entity.attributes[VALUE_MARKER_ATTRIBUTE]) ||
      entity.entity_type === PERSONAL_VALUE_TYPE
    ) {
      valueIds.add(entity.uuid);
    }
  }
  check();

  for (const storedOperation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (storedOperation.version !== 4 || storedOperation.state !== 'committed') continue;
    const operation = storedOperation;
    const receipt = operation.terminalReceipt;
    if (receipt.kind !== 'human_autonomous_capture_committed') continue;
    if (receipt.selection.kind !== 'occurrences') continue;
    for (const item of receipt.selection.items) {
      check();
      if (item.effect === 'created' || item.effect === 'reference') {
        positiveOccurrences.push({ operation, item });
      }
    }
  }
  check();

  return { edgeIds, valueIds, positiveOccurrences };
}

function mapOwnershipFailure(error: unknown): never {
  if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
    fail('snapshot_capacity');
  }
  fail('invalid_snapshot');
}

function mapIndexFailure(error: unknown): never {
  if (error instanceof AutonomousPersonalClaimIndexV4Error) {
    fail(error.reason === 'snapshot_capacity' ? 'snapshot_capacity' : 'invalid_snapshot');
  }
  if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
    fail('snapshot_capacity');
  }
  if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
  fail('inspection_incomplete');
}

function equalData(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function required<T>(
  value: T | null | undefined,
  reason: AutonomousPersonalRecordIntegrityV4FailureReason,
  check: () => void,
): T {
  if (value === null || value === undefined) {
    check();
    fail(reason);
  }
  return value;
}

function inspectFailureReason(
  result: Exclude<
    ReturnType<typeof inspectAutonomousPersonalClaimCreatorV4>,
    { status: 'structural' }
  >,
): AutonomousPersonalRecordIntegrityV4FailureReason {
  if (result.status === 'capacity') {
    return result.reason === 'snapshot_capacity' ? 'snapshot_capacity' : 'inspection_incomplete';
  }
  if (result.status === 'uncommitted') return 'orphan_record';
  if (result.status !== 'invalid') return 'inspection_incomplete';
  if (result.reason === 'missing_record') return 'orphan_record';
  if (
    result.reason === 'invalid_operation' ||
    result.reason === 'invalid_creator' ||
    result.reason === 'unsupported_generation' ||
    result.reason === 'ambiguous_record'
  ) {
    return 'invalid_creator';
  }
  return 'invalid_pair';
}

function validatePositiveOccurrences(
  occurrences: readonly PositiveOccurrenceV4[],
  proofs: ReadonlyMap<string, AutonomousPersonalQualifiedClaimProofV4>,
  check: () => void,
): void {
  const creatorsByClaim = new Map<string, PositiveOccurrenceV4[]>();
  for (const occurrence of occurrences) {
    check();
    const claimId = required(occurrence.item.claimId, 'invalid_creator', check);
    if (occurrence.item.effect !== 'created') continue;
    const rows = creatorsByClaim.get(claimId) ?? [];
    rows.push(occurrence);
    creatorsByClaim.set(claimId, rows);
  }
  check();

  for (const [claimId, creators] of creatorsByClaim) {
    check();
    if (creators.length !== 1) {
      check();
      fail('invalid_creator');
    }
    const proof = required(proofs.get(claimId), 'orphan_record', check);
    const creator = creators[0]!;
    const receipt = creator.operation.terminalReceipt;
    const item = creator.item;
    if (
      proof.operationId !== creator.operation.operationId ||
      proof.operationId !== receipt.operationId ||
      proof.sourceId !== creator.operation.identity.sourceId ||
      proof.sourceId !== receipt.sourceId ||
      proof.claimId !== claimId ||
      proof.kind !== item.kind ||
      proof.evidenceHash !== item.evidenceHash ||
      proof.meaningHash !== item.meaningHash ||
      !equalData(proof.dependencies, item.dependencies)
    ) {
      check();
      fail('invalid_creator');
    }
  }
  check();

  for (const occurrence of occurrences) {
    check();
    const item = occurrence.item;
    const claimId = required(item.claimId, 'invalid_creator', check);
    const proof = required(proofs.get(claimId), 'orphan_record', check);
    const identityMatches =
      proof.storeHash === occurrence.operation.identity.storeHash &&
      proof.namespace === occurrence.operation.identity.namespace &&
      proof.subjectId === occurrence.operation.identity.binding.subjectId;
    if (!identityMatches) {
      check();
      fail(item.effect === 'reference' ? 'invalid_pair' : 'invalid_creator');
    }
    if (
      proof.claimId !== claimId ||
      proof.kind !== item.kind ||
      proof.meaningHash !== item.meaningHash
    ) {
      check();
      fail(item.effect === 'created' ? 'invalid_creator' : 'invalid_pair');
    }
  }
  check();
}

function validateFootprints(
  graph: GraphData,
  footprints: Footprints,
  index: AutonomousPersonalClaimIndexV4,
  check: () => void,
): void {
  const edgeRowsById = new Map<string, (typeof graph.edges)[number]>();
  check();
  for (const edge of graph.edges) {
    check();
    edgeRowsById.set(edge.uuid, edge);
  }
  check();
  const candidateEdgeIds = new Set<string>(footprints.edgeIds);
  const creatorCounts = new Map<string, number>();
  for (const occurrence of footprints.positiveOccurrences) {
    check();
    const claimId = required(occurrence.item.claimId, 'invalid_creator', check);
    candidateEdgeIds.add(claimId);
    if (occurrence.item.effect === 'created') {
      creatorCounts.set(claimId, (creatorCounts.get(claimId) ?? 0) + 1);
    }
  }
  check();

  for (const count of creatorCounts.values()) {
    check();
    if (count !== 1) {
      check();
      fail('invalid_creator');
    }
  }
  check();

  const proofs = new Map<string, AutonomousPersonalQualifiedClaimProofV4>();
  for (const claimId of candidateEdgeIds) {
    check();
    if (!edgeRowsById.has(claimId)) {
      check();
      fail('orphan_record');
    }
    let result: ReturnType<typeof inspectAutonomousPersonalClaimCreatorV4>;
    try {
      result = inspectAutonomousPersonalClaimCreatorV4(index, claimId);
    } catch (error) {
      if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
      check();
      fail('inspection_incomplete');
    }
    check();
    if (result.status !== 'structural') {
      check();
      fail(inspectFailureReason(result));
    }
    proofs.set(claimId, result.proof);
  }
  check();

  for (const edgeId of footprints.edgeIds) {
    check();
    const proof = proofs.get(edgeId);
    if (!proof || proof.claimId !== edgeId) {
      check();
      fail('orphan_record');
    }
  }
  check();

  for (const valueId of footprints.valueIds) {
    check();
    let matchingProofCount = 0;
    for (const proof of proofs.values()) {
      check();
      if (proof.valueId === valueId) matchingProofCount += 1;
    }
    if (matchingProofCount === 0) {
      check();
      fail('orphan_record');
    }
    if (matchingProofCount !== 1) {
      check();
      fail('invalid_pair');
    }
  }
  check();

  validatePositiveOccurrences(footprints.positiveOccurrences, proofs, check);
  check();
}

function checkAutonomousPersonalRecordIntegrityV4(
  graphValue: unknown,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  codeOwnedCheck: () => void,
  requireIndex: boolean,
): AutonomousPersonalClaimIndexV4 | undefined {
  const trusted = stickyTrustedCheck(codeOwnedCheck);
  trusted.check();

  let graph: GraphData | undefined;
  let ownershipFailure: unknown;
  try {
    graph = parseLosslessAutomaticCaptureGraph(graphValue);
  } catch (error) {
    ownershipFailure = error;
  }
  trusted.check();
  if (ownershipFailure !== undefined) {
    trusted.rethrowFailure();
    mapOwnershipFailure(ownershipFailure);
  }
  if (!graph) fail('invalid_snapshot');

  const footprints = collectFootprints(graph, trusted.check);
  trusted.check();
  if (
    footprints.edgeIds.size === 0 &&
    footprints.valueIds.size === 0 &&
    footprints.positiveOccurrences.length === 0
  ) {
    trusted.check();
    if (!requireIndex) return undefined;
  }

  const workCheck = stickyWorkCheck(typedSyntaxWork, trusted);
  let index: AutonomousPersonalClaimIndexV4;
  let indexedGraph = graph;
  try {
    workCheck.check();
    index = createAutonomousPersonalClaimIndexV4(graph, typedSyntaxWork, workCheck.check);
    workCheck.check();
    if (requireIndex) {
      indexedGraph = getAutonomousPersonalClaimIndexGraphV4(index);
      workCheck.check();
    }
  } catch (error) {
    workCheck.rethrowFailure();
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    mapIndexFailure(error);
  }

  try {
    validateFootprints(requireIndex ? indexedGraph : graph, footprints, index!, workCheck.check);
    workCheck.check();
  } catch (error) {
    workCheck.rethrowFailure();
    if (error instanceof AutonomousPersonalTypedSyntaxFailureV1) throw error;
    if (error instanceof AutonomousPersonalRecordIntegrityV4Error) throw error;
    mapIndexFailure(error);
  }
  workCheck.check();
  return requireIndex ? index! : undefined;
}

/**
 * Validates historical Autonomous Personal Claim3/Marker3 pairs in one complete
 * lossless DATA snapshot. This is structural DATA validation only; it does not
 * establish native origin, current authority, or write permission.
 */
export function assertAutonomousPersonalRecordIntegrityV4(
  graphValue: unknown,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  codeOwnedCheck: () => void,
): void {
  checkAutonomousPersonalRecordIntegrityV4(graphValue, typedSyntaxWork, codeOwnedCheck, false);
}

/** Builds the one fully checked full-root index for internal reader DATA access. */
export function createIntegrityCheckedAutonomousPersonalClaimIndexV4(
  graphValue: unknown,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  codeOwnedCheck: () => void,
): AutonomousPersonalClaimIndexV4 {
  const index = checkAutonomousPersonalRecordIntegrityV4(
    graphValue,
    typedSyntaxWork,
    codeOwnedCheck,
    true,
  );
  if (!index) fail('invalid_snapshot');
  return index;
}
