import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { z } from 'zod';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalCompletionPlanV4InputOwnedDataSchema,
  AutonomousPersonalCompletionPlanV4OwnedDataSchema,
  type AutonomousPersonalCompletionPlanV4,
  type AutonomousPersonalCompletionPlanV4Input,
  type AutonomousPersonalCompletionPlanV4NoWriteReason,
  type AutonomousPersonalCompletionPlanV4ReferenceGuard,
} from '../schemas/AutonomousPersonalCompletionPlanV4.schema';
import {
  type AutonomousPersonalCompletionGraphCandidateV4Result,
  type AutonomousPersonalCompletionReadbackV4Result,
} from '../schemas/AutonomousPersonalCompletionGraphV4.schema';
import { AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema } from '../schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { EpisodicNode } from '../schemas/EpisodicNode.schema';
import type { GraphData } from '../schemas/GraphData.schema';
import type { StoredAutomaticOperation } from '../schemas/AutomaticLedger.schema';
import { prepareAutonomousPersonalCaptureSnapshotV4 } from './AutonomousPersonalCaptureBeginV4';
import {
  assertAutonomousPersonalRecordIntegrityV4,
  getRegisteredAutonomousPersonalClaimIndexGraphV4,
} from './AutonomousPersonalRecordIntegrityV4';
import { buildCommittedAutonomousPersonalOperationV4 } from './AutonomousPersonalTerminalOperationV4';
import { assertAutomaticLedgerSourceIntegrity } from './AutomaticIdentity';
import { inputAndPlanJoinV4 } from './AutonomousPersonalCompletionJoinsV4';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
  isNativePlainAutomaticCaptureObject,
} from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { getOwnedImmutableGraphData } from './ImmutableGraphSnapshot';

const UUID = z.string().uuid();
const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;

class CompletionGraphFailure extends Error {
  constructor(readonly reason: AutonomousPersonalCompletionPlanV4NoWriteReason) {
    super(reason);
    this.name = 'AutonomousPersonalCompletionGraphV4Failure';
  }
}

function fail(reason: AutonomousPersonalCompletionPlanV4NoWriteReason): never {
  throw new CompletionGraphFailure(reason);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function ownInput(value: unknown): AutonomousPersonalCompletionPlanV4Input {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
    const parsed = AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.parse(owned);
    if (!same(owned, parsed)) fail('invalid_input');
    return parsed;
  } catch (error) {
    if (error instanceof CompletionGraphFailure) throw error;
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
      fail('capacity');
    fail('invalid_input');
  }
}

function ownPlan(value: unknown): AutonomousPersonalCompletionPlanV4 {
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
    const parsed = AutonomousPersonalCompletionPlanV4OwnedDataSchema.parse(owned);
    if (!same(owned, parsed)) fail('invalid_input');
    return parsed;
  } catch (error) {
    if (error instanceof CompletionGraphFailure) throw error;
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
      fail('capacity');
    fail('invalid_input');
  }
}

function readWork(value: unknown): { readonly deadline: number; readonly signal: AbortSignal } {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    !isNativePlainAutomaticCaptureObject(value) ||
    nativeAbortSignalAbortedGetter === undefined
  ) {
    fail('invalid_input');
  }
  try {
    const keys = Reflect.ownKeys(value);
    const deadline = Object.getOwnPropertyDescriptor(value, 'absoluteMonotonicDeadlineMs');
    const signal = Object.getOwnPropertyDescriptor(value, 'signal');
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'absoluteMonotonicDeadlineMs' && key !== 'signal') ||
      !deadline ||
      !deadline.enumerable ||
      !('value' in deadline) ||
      typeof deadline.value !== 'number' ||
      !Number.isFinite(deadline.value) ||
      !signal ||
      !signal.enumerable ||
      !('value' in signal) ||
      signal.value === null ||
      typeof signal.value !== 'object' ||
      utilTypes.isProxy(signal.value)
    ) {
      fail('invalid_input');
    }
    nativeAbortSignalAbortedGetter.call(signal.value);
    return { deadline: deadline.value, signal: signal.value as AbortSignal };
  } catch (error) {
    if (error instanceof CompletionGraphFailure) throw error;
    fail('invalid_input');
  }
}

type StickyCheck = {
  readonly check: () => void;
  readonly bindScopeDeadline: (deadline: number) => void;
  readonly rethrowCallbackFailure: () => void;
  readonly getStopReason: () => AutonomousPersonalCompletionPlanV4NoWriteReason | null;
};

function createStickyCheck(
  work: { readonly deadline: number; readonly signal: AbortSignal },
  callback: () => void,
): StickyCheck {
  if (
    typeof callback !== 'function' ||
    utilTypes.isProxy(callback) ||
    utilTypes.isAsyncFunction(callback)
  ) {
    fail('invalid_input');
  }
  let scopeDeadline = Number.POSITIVE_INFINITY;
  let scopeDeadlineBound = false;
  let callbackFailed = false;
  let callbackFailure: unknown;
  let stopFailure: CompletionGraphFailure | undefined;
  const runtime = () => {
    if (nativeAbortSignalAbortedGetter?.call(work.signal)) fail('budget_exhausted');
    const now = performance.now();
    if (!Number.isFinite(now)) fail('invalid_input');
    if (now >= Math.min(work.deadline, scopeDeadline)) fail('budget_exhausted');
  };
  const check = () => {
    if (callbackFailed) throw callbackFailure;
    if (stopFailure) throw stopFailure;
    try {
      runtime();
      try {
        callback();
      } catch (error) {
        callbackFailed = true;
        callbackFailure = error;
        throw error;
      }
      runtime();
    } catch (error) {
      if (callbackFailed) throw callbackFailure;
      if (error instanceof CompletionGraphFailure) {
        stopFailure = error;
        throw error;
      }
      stopFailure = new CompletionGraphFailure('invalid_input');
      throw stopFailure;
    }
  };
  return {
    check,
    bindScopeDeadline: (deadline) => {
      if (!Number.isFinite(deadline) || deadline < 0) fail('invalid_input');
      if (scopeDeadlineBound && deadline !== scopeDeadline) fail('invalid_input');
      scopeDeadline = deadline;
      scopeDeadlineBound = true;
    },
    rethrowCallbackFailure: () => {
      if (callbackFailed) throw callbackFailure;
    },
    getStopReason: () => stopFailure?.reason ?? null,
  };
}

function noWrite(
  reason: AutonomousPersonalCompletionPlanV4NoWriteReason,
): Extract<AutonomousPersonalCompletionGraphCandidateV4Result, { kind: 'no_write' }> {
  return Object.freeze({ kind: 'no_write' as const, reason });
}

function unconfirmed(): Extract<
  AutonomousPersonalCompletionReadbackV4Result,
  { kind: 'unconfirmed' }
> {
  return Object.freeze({ kind: 'unconfirmed' as const });
}

function matched(): Extract<AutonomousPersonalCompletionReadbackV4Result, { kind: 'matched' }> {
  return Object.freeze({ kind: 'matched' as const });
}

function closeCandidateFailure(sticky: StickyCheck, error: unknown) {
  sticky.rethrowCallbackFailure();
  let reason = sticky.getStopReason() ?? noWriteReasonForError(error);
  if (sticky.getStopReason() === null) {
    try {
      sticky.check();
    } catch (checkError) {
      sticky.rethrowCallbackFailure();
      reason = sticky.getStopReason() ?? noWriteReasonForError(checkError);
    }
  }
  return noWrite(reason);
}

function closeReadbackFailure(
  sticky: StickyCheck,
): Extract<AutonomousPersonalCompletionReadbackV4Result, { kind: 'unconfirmed' }> {
  sticky.rethrowCallbackFailure();
  if (sticky.getStopReason() === null) {
    try {
      sticky.check();
    } catch {
      sticky.rethrowCallbackFailure();
    }
  }
  return unconfirmed();
}

function mapPreparationNoWrite(
  value: ReturnType<typeof prepareAutonomousPersonalCaptureSnapshotV4>,
): AutonomousPersonalCompletionPlanV4NoWriteReason {
  if (value.kind !== 'no_write') return 'conflict';
  switch (value.resultProjection.kind) {
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
  operation: Extract<GraphData['automatic_operations_v1'], { version: 1 }>['operations'][number],
) {
  if (operation.version !== 4 || operation.state !== 'leased') fail('conflict');
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

function uniqueRecord<T extends { readonly uuid: string }>(
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

function uniqueOperation(graph: GraphData, id: string, check: () => void) {
  let found: StoredAutomaticOperation | null = null;
  for (const operation of graph.automatic_operations_v1?.operations ?? []) {
    check();
    if (operation.operationId !== id) continue;
    if (found) return null;
    found = operation;
  }
  return found;
}

function existingIds(graph: GraphData, check: () => void): Set<string> {
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

function referenceRowsMatch(
  graph: GraphData,
  guards: readonly AutonomousPersonalCompletionPlanV4ReferenceGuard[],
  check: () => void,
): boolean {
  for (const guard of guards) {
    check();
    const claim = uniqueRecord(graph.edges, guard.claimId, check);
    const value = uniqueRecord(graph.entities, guard.valueId, check);
    const source = uniqueRecord(graph.episodes, guard.sourceId, check);
    const operation = uniqueOperation(graph, guard.operationId, check);
    if (
      !claim ||
      !value ||
      !source ||
      !operation ||
      hashAutomaticCaptureV2(claim) !== guard.claimRowHash ||
      hashAutomaticCaptureV2(value) !== guard.valueRowHash ||
      hashAutomaticCaptureV2(source) !== guard.sourceRowHash ||
      hashAutomaticCaptureV2(operation) !== guard.operationRowHash
    ) {
      return false;
    }
  }
  return true;
}

function freezeData<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child, check);
    Object.freeze(value);
  }
  return value;
}

function noWriteReasonForError(error: unknown): AutonomousPersonalCompletionPlanV4NoWriteReason {
  if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
    return 'capacity';
  }
  return error instanceof CompletionGraphFailure ? error.reason : 'inspection_incomplete';
}

/**
 * Revalidates the exact leased snapshot and constructs a lossless candidate DATA graph.
 * The returned graph is a temporary value; this function has no storage capability.
 */
export function prepareAutonomousPersonalCompletionGraphCandidateV4(
  graphValue: unknown,
  inputValue: unknown,
  planValue: unknown,
  extractionEpoch: string | null,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  codeOwnedCheck: () => void,
): AutonomousPersonalCompletionGraphCandidateV4Result {
  let work: { readonly deadline: number; readonly signal: AbortSignal };
  let sticky: StickyCheck | undefined;
  try {
    work = readWork(typedSyntaxWork);
    sticky = createStickyCheck(work, codeOwnedCheck);
    sticky.check();
  } catch (error) {
    if (sticky) {
      sticky.rethrowCallbackFailure();
      if (error instanceof CompletionGraphFailure) return noWrite(error.reason);
      throw error;
    }
    return noWrite(noWriteReasonForError(error));
  }

  let input: AutonomousPersonalCompletionPlanV4Input;
  try {
    input = ownInput(inputValue);
    sticky.bindScopeDeadline(input.scope.deadlineAtMonotonicMs);
    sticky.check();
  } catch (error) {
    return closeCandidateFailure(sticky, error);
  }

  let plan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>;
  try {
    const ownedPlan = ownPlan(planValue);
    sticky.check();
    if (ownedPlan.kind === 'no_write') {
      return closeCandidateFailure(sticky, new CompletionGraphFailure(ownedPlan.reason));
    }
    plan = ownedPlan;
    if (extractionEpoch !== null && !UUID.safeParse(extractionEpoch).success) fail('invalid_input');
    if (!inputAndPlanJoinV4(input, plan, sticky.check)) fail('conflict');
  } catch (error) {
    return closeCandidateFailure(sticky, error);
  }
  const { check } = sticky;
  // Known-index guard failures propagate before entering the raw-data error mapping.
  const registered = getRegisteredAutonomousPersonalClaimIndexGraphV4(graphValue);

  try {
    let graph: GraphData;
    try {
      graph =
        registered ??
        getOwnedImmutableGraphData(graphValue) ??
        parseLosslessAutomaticCaptureGraph(graphValue);
    } catch (error) {
      if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json')
        fail('capacity');
      fail('inspection_incomplete');
    }
    check();
    const snapshot: unknown = registered ? graphValue : graph;
    assertAutomaticLedgerSourceIntegrity(graph);
    check();
    assertAutonomousPersonalRecordIntegrityV4(snapshot, typedSyntaxWork, check);
    check();

    const request = AutonomousPersonalCaptureSnapshotPreparationV4InputOwnedDataSchema.safeParse({
      request: input.scope.request,
      context: input.scope.context,
      sourceId: input.scope.sourceId,
      operationId: input.scope.operationId,
      leaseToken: input.scope.leaseToken,
      stableBeginHash: input.scope.stableBeginHash,
      attemptHash: input.scope.attemptHash,
      backendNow: input.backendNow,
      previousEpisodeId: input.stagedFresh.episode.previous_episode_uuid,
    });
    check();
    if (!request.success) fail('invalid_input');
    const prepared = prepareAutonomousPersonalCaptureSnapshotV4(request.data, snapshot, check);
    check();
    if (prepared.kind !== 'same_initial_scope_candidate') {
      if (prepared.kind === 'no_write') fail(mapPreparationNoWrite(prepared));
      fail('conflict');
    }
    if (
      prepared.operation.state !== 'leased' ||
      !same(prepared.fence, input.stagedFresh.fence) ||
      !same(
        omitAppendOnlyAudit(prepared.operation),
        omitAppendOnlyAudit(input.stagedFresh.operation),
      )
    ) {
      fail('conflict');
    }
    if (
      prepared.episode.review_status !== input.stagedFresh.episode.review_status ||
      prepared.episode.trust_level !== input.stagedFresh.episode.trust_level
    ) {
      fail('authority_changed');
    }
    if (
      !same(
        omitMutableEpisodeUpdate(prepared.episode),
        omitMutableEpisodeUpdate(input.stagedFresh.episode),
      )
    ) {
      fail('conflict');
    }
    if (!referenceRowsMatch(graph, plan.referenceGuards, check)) fail('conflict');

    const rebuiltOperation = buildCommittedAutonomousPersonalOperationV4(
      {
        leasedOperation: prepared.operation,
        terminalReceipt: plan.operation.terminalReceipt,
        completionCallHash: input.completionCallHash,
        audit: input.audit,
      },
      check,
    );
    check();
    if (!same(rebuiltOperation, plan.operation)) fail('conflict');

    const creatingFacts = plan.createEntities.length > 0 || plan.createEdges.length > 0;
    if (plan.createEntities.length !== plan.createEdges.length) fail('conflict');
    if (creatingFacts !== (extractionEpoch !== null)) fail('invalid_input');

    const ids = existingIds(graph, check);
    for (const entity of plan.createEntities) {
      check();
      if (ids.has(entity.uuid)) fail('conflict');
      ids.add(entity.uuid);
    }
    for (const edge of plan.createEdges) {
      check();
      if (ids.has(edge.uuid)) fail('conflict');
      ids.add(edge.uuid);
    }

    const ledger = graph.automatic_operations_v1;
    if (!ledger) fail('conflict');
    let operationIndex = -1;
    for (let index = 0; index < ledger.operations.length; index += 1) {
      check();
      if (ledger.operations[index]!.operationId !== prepared.operation.operationId) continue;
      if (operationIndex >= 0) fail('conflict');
      operationIndex = index;
    }
    if (operationIndex < 0) fail('conflict');

    const operations = [...ledger.operations];
    operations[operationIndex] = rebuiltOperation;
    const candidateValue: GraphData = {
      ...graph,
      entities: [...graph.entities, ...plan.createEntities],
      edges: [...graph.edges, ...plan.createEdges],
      episodes: [...graph.episodes],
      automatic_operations_v1: { ...ledger, operations },
      ...(creatingFacts
        ? { metadata: { ...(graph.metadata ?? {}), extraction_epoch: extractionEpoch! } }
        : {}),
    };
    check();
    assertAutomaticLedgerSourceIntegrity(candidateValue);
    check();
    assertAutonomousPersonalRecordIntegrityV4(candidateValue, typedSyntaxWork, check);
    check();
    const serialized = JSON.stringify(candidateValue);
    check();
    if (
      typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > 100 * 1024 * 1024
    ) {
      fail('capacity');
    }
    const frozen = freezeData(candidateValue, check);
    check();
    return Object.freeze({ kind: 'candidate' as const, graph: frozen });
  } catch (error) {
    if (registered) getRegisteredAutonomousPersonalClaimIndexGraphV4(graphValue);
    return closeCandidateFailure(sticky, error);
  }
}

function rowWithOnlyUpdatedAtOmittedMatches(actual: EpisodicNode, staged: EpisodicNode): boolean {
  return (
    actual.trust_level === staged.trust_level &&
    actual.review_status === staged.review_status &&
    same(omitMutableEpisodeUpdate(actual), omitMutableEpisodeUpdate(staged))
  );
}

/** Confirms exact terminal/created/reference rows from one complete actual graph snapshot. */
export function validateAutonomousPersonalCompletionReadbackV4(
  actualGraphValue: unknown,
  inputValue: unknown,
  planValue: unknown,
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1,
  codeOwnedCheck: () => void,
): AutonomousPersonalCompletionReadbackV4Result {
  let work: { readonly deadline: number; readonly signal: AbortSignal };
  let sticky: StickyCheck | undefined;
  try {
    work = readWork(typedSyntaxWork);
    sticky = createStickyCheck(work, codeOwnedCheck);
    sticky.check();
  } catch {
    if (sticky) {
      sticky.rethrowCallbackFailure();
      return unconfirmed();
    }
    return unconfirmed();
  }

  let input: AutonomousPersonalCompletionPlanV4Input;
  try {
    input = ownInput(inputValue);
    sticky.bindScopeDeadline(input.scope.deadlineAtMonotonicMs);
    sticky.check();
  } catch {
    return closeReadbackFailure(sticky);
  }

  let plan: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>;
  try {
    const ownedPlan = ownPlan(planValue);
    sticky.check();
    if (ownedPlan.kind === 'no_write') return closeReadbackFailure(sticky);
    plan = ownedPlan;
    if (!inputAndPlanJoinV4(input, plan, sticky.check, true)) return closeReadbackFailure(sticky);
  } catch {
    return closeReadbackFailure(sticky);
  }

  try {
    // Read-only comparison: owned immutable DATA skips only the schema parse.
    const graph =
      getOwnedImmutableGraphData(actualGraphValue) ??
      parseLosslessAutomaticCaptureGraph(actualGraphValue);
    sticky.check();
    assertAutomaticLedgerSourceIntegrity(graph);
    sticky.check();
    assertAutonomousPersonalRecordIntegrityV4(graph, typedSyntaxWork, sticky.check);
    sticky.check();

    const operation = uniqueOperation(graph, plan.operation.operationId, sticky.check);
    if (!operation || !same(operation, plan.operation)) return closeReadbackFailure(sticky);
    const source = uniqueRecord(graph.episodes, input.stagedFresh.episode.uuid, sticky.check);
    if (!source || !rowWithOnlyUpdatedAtOmittedMatches(source, input.stagedFresh.episode)) {
      return closeReadbackFailure(sticky);
    }
    for (const entity of plan.createEntities) {
      sticky.check();
      const actual = uniqueRecord(graph.entities, entity.uuid, sticky.check);
      if (!actual || !same(actual, entity)) return closeReadbackFailure(sticky);
    }
    for (const edge of plan.createEdges) {
      sticky.check();
      const actual = uniqueRecord(graph.edges, edge.uuid, sticky.check);
      if (!actual || !same(actual, edge)) return closeReadbackFailure(sticky);
    }
    if (!referenceRowsMatch(graph, plan.referenceGuards, sticky.check)) {
      return closeReadbackFailure(sticky);
    }
    sticky.check();
    return matched();
  } catch {
    return closeReadbackFailure(sticky);
  }
}
