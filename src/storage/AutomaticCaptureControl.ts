import { z } from 'zod';
import { COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  AutonomousPersonalSourceOwnerV4OwnedDataSchema,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import type { GraphData, EpisodicNode } from '../schemas';
import {
  AutomaticCaptureAdminFenceRequestV2Schema,
  AutomaticCaptureReadRequestV2Schema,
  AutomaticCaptureReadResultV2Schema,
  type AutomaticCaptureAdminFenceRequestV2,
  type AutomaticCaptureReadRequestV2,
  type AutomaticCaptureReadResultV2,
  type AutomaticCaptureResumeDecisionV2,
} from '../schemas/AutomaticCaptureApi.schema';
import {
  AutomaticHumanCaptureStoreContextV2Schema,
  AutomaticHumanCaptureControlContextV2Schema,
  AutomaticHumanCaptureResumeContextV2Schema,
  type AutomaticHumanCaptureControlContextV2,
  type AutomaticHumanCaptureResumeContextV2,
  type AutomaticHumanCaptureResumePreparationV2,
  type AutomaticHumanCaptureResumeSourcePreparationV2,
  type AutomaticHumanCaptureCancelPreparationV2,
} from '../schemas/AutomaticCaptureControl.schema';
import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from '../schemas/AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../schemas/AutomaticCaptureReceipt.schema';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import {
  AutomaticCaptureSourceOwnerV2Schema,
  hashAutomaticCaptureV2,
  canonicalAutomaticCaptureV2 as canonical,
} from '../schemas/AutomaticCapture.schema';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import { AUTOMATIC_LEDGER_LIMITS as limits } from '../schemas/AutomaticLedgerPrimitives.schema';
import {
  AutomaticCaptureResumeSourceV2Schema,
  type AutomaticCaptureLeaseFenceV2,
} from './AutomaticCaptureHandles';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import { validateAutomaticCaptureCandidate } from './AutomaticCaptureCapacity';
import { withAutomaticCaptureAttemptV2 } from './AutomaticCaptureAudit';
import {
  automaticWriteOwnerIdempotencyKey,
  prepareAutomaticEpisodeInput,
  assertAutomaticLedgerSourceIntegrity,
  assertAutomaticBinding,
  automaticCaptureOperationIdentityForOwnedSource,
  reconcileAutomaticCaptureOperationIdentity,
  SOURCE_ENVELOPE_ATTRIBUTE,
  WRITE_OWNER_ATTRIBUTE,
  WRITE_OWNER_V2_ATTRIBUTE,
} from './AutomaticIdentity';

type Locator = AutomaticCaptureReadRequestV2;
type Resolution =
  | {
      kind: 'owned';
      graph: GraphData;
      source: EpisodicNode;
      operation: AutomaticCaptureOperationV2 | null;
      legacy: boolean;
    }
  | {
      kind: 'decision';
      status: 'conflict' | 'not_found' | 'invalid_input' | 'capacity' | 'unsupported_mode';
    };
function owned(
  graphValue: GraphData,
  request: Locator,
  storeHash: string,
  check: () => void,
): Resolution {
  let graph: GraphData;
  try {
    graph = parseLosslessAutomaticCaptureGraph(graphValue);
    assertAutomaticLedgerSourceIntegrity(graph);
  } catch (error) {
    return {
      kind: 'decision',
      status:
        error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json'
          ? 'capacity'
          : 'invalid_input',
    };
  }
  check();
  const key = automaticWriteOwnerIdempotencyKey({ turn: request.turn, role: 'human' });
  const operations = (graph.automatic_operations_v1?.operations ?? []).filter((operation) => {
    check();
    return (
      operation.identity.namespace === request.namespace &&
      operation.identity.turn === request.turn &&
      operation.identity.role === 'human'
    );
  });
  const sources = graph.episodes.filter((source) => {
    check();
    if (source.group_id !== request.namespace) return false;
    if (source.idempotency_key === key) return true;
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
  });
  if (operations.length > 1 || sources.length > 1) return { kind: 'decision', status: 'conflict' };
  const operation = operations[0];
  const source = sources[0];
  if (!operation && !source) return { kind: 'decision', status: 'not_found' };
  if (!source || (operation && operation.identity.sourceId !== source.uuid))
    return { kind: 'decision', status: 'conflict' };
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
    return { kind: 'decision', status: 'unsupported_mode' };
  try {
    prepareAutomaticEpisodeInput(source);
    const owner = AutomaticWriteOwnerSchema.parse(source.attributes[WRITE_OWNER_ATTRIBUTE]);
    if (
      owner.store !== storeHash ||
      owner.namespace !== request.namespace ||
      owner.turn !== request.turn ||
      owner.role !== 'human' ||
      owner.issuer !== request.issuer ||
      owner.actor !== request.actorReference ||
      source.role !== 'human'
    )
      return { kind: 'decision', status: 'conflict' };
    const hasV2 = source.attributes[WRITE_OWNER_V2_ATTRIBUTE] !== undefined;
    if (!hasV2 || operation?.version === 1)
      return { kind: 'owned', graph, source, operation: null, legacy: true };
    if (!operation) return { kind: 'owned', graph, source, operation: null, legacy: false };
    if (
      operation.version !== 2 ||
      operation.identity.storeHash !== storeHash ||
      operation.identity.issuer !== request.issuer ||
      operation.identity.actorReference !== request.actorReference ||
      !reconcileAutomaticCaptureOperationIdentity(
        automaticCaptureOperationIdentityForOwnedSource(source, operation.descriptor),
        operation.identity,
      )
    )
      return { kind: 'decision', status: 'conflict' };
    return { kind: 'owned', graph, source, operation, legacy: false };
  } catch {
    return { kind: 'decision', status: 'conflict' };
  }
}

function authority(
  resolution: Extract<Resolution, { kind: 'owned' }>,
  check: () => void,
): 'active' | 'changed' | 'revoked' | 'unknown' | 'not_evaluated' {
  let aborted: { value: unknown } | undefined;
  try {
    const envelope = AutomaticSourceEnvelopeSchema.safeParse(
      resolution.source.attributes[SOURCE_ENVELOPE_ATTRIBUTE],
    );
    if (!envelope.success) return 'not_evaluated';
    assertAutomaticBinding(resolution.graph, envelope.data, () => {
      try {
        check();
      } catch (error) {
        aborted = { value: error };
        throw error;
      }
    });
    const owner = AutomaticCaptureSourceOwnerV2Schema.safeParse(
      resolution.source.attributes[WRITE_OWNER_V2_ATTRIBUTE],
    );
    if (!owner.success || owner.data.purpose !== 'human_turn_memory') return 'not_evaluated';
    return resolution.source.review_status === 'accepted' &&
      resolution.source.trust_level === owner.data.requestedTrustLevel
      ? 'active'
      : 'changed';
  } catch (error) {
    if (aborted) throw aborted.value;
    return error instanceof Error && error.message.includes('binding_revoked')
      ? 'revoked'
      : 'changed';
  }
}
function readRequest<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> | null {
  try {
    return schema.parse(cloneBoundedAutomaticCaptureJson(value, 'beginRequest'));
  } catch {
    return null;
  }
}
const resumeDecision = (
  kind: AutomaticCaptureResumeDecisionV2['kind'],
): Extract<AutomaticHumanCaptureResumePreparationV2, { kind: 'decision' }> => ({
  kind: 'decision',
  decision: { kind },
});
const fence = (
  operation: Extract<AutomaticCaptureOperationV2, { state: 'leased' }>,
): AutomaticCaptureLeaseFenceV2 => ({
  purpose: 'human_turn_memory',
  state: 'leased',
  operationId: operation.operationId,
  sourceId: operation.identity.sourceId,
  descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
  identityHash: hashAutomaticCaptureV2(operation.identity),
  beginCallHash: operation.beginCallHash,
  generation: operation.generation,
  token: operation.lease.token,
  claimKind: operation.lease.claimKind,
  planTimestamp: operation.lease.renewedAt,
  retryCount: operation.retryCount,
  ...(operation.lastRetryCallHash === undefined
    ? {}
    : { lastRetryCallHash: operation.lastRetryCallHash }),
});
function sameIdentity(
  actual: AutomaticCaptureOperationV2,
  previous: AutomaticCaptureOperationV2,
): boolean {
  return (
    actual.operationId === previous.operationId &&
    canonical(actual.identity) === canonical(previous.identity) &&
    canonical(actual.descriptor) === canonical(previous.descriptor) &&
    actual.beginCallHash === previous.beginCallHash &&
    actual.retryCount === previous.retryCount &&
    actual.lastRetryCallHash === previous.lastRetryCallHash
  );
}
function replace(
  resolution: Extract<Resolution, { kind: 'owned' }>,
  operation: AutomaticCaptureOperationV2,
  attemptHash: string,
  at: string,
  disposition: 'resumed' | 'cancelled',
  check: () => void,
): GraphData | null {
  const observed =
    withAutomaticCaptureAttemptV2(operation, { attemptHash, at, disposition }) ?? operation;
  return validateAutomaticCaptureCandidate(
    {
      ...resolution.graph,
      automatic_operations_v1: {
        version: 1,
        operations: resolution.graph.automatic_operations_v1!.operations.map((item) =>
          item.operationId === operation.operationId ? observed : item,
        ),
      },
    },
    check,
  );
}

/** Private pre-read metadata only. It grants no authority and is rechecked under the fresh write transaction. */
export function prepareHumanCaptureResumeSourceV2(
  graph: GraphData,
  requestValue: AutomaticCaptureAdminFenceRequestV2,
  contextValue: z.infer<typeof AutomaticHumanCaptureStoreContextV2Schema>,
  check: () => void = () => {},
): AutomaticHumanCaptureResumeSourcePreparationV2 {
  check();
  const request = readRequest(AutomaticCaptureAdminFenceRequestV2Schema, requestValue);
  if (!request) return resumeDecision('invalid_input');
  if (request.role !== 'human') return resumeDecision('unsupported_mode');
  const context = readRequest(AutomaticHumanCaptureStoreContextV2Schema, contextValue);
  if (!context) return resumeDecision('invalid_input');
  const resolution = owned(graph, request, context.storeHash, check);
  if (resolution.kind === 'decision') return resumeDecision(resolution.status);
  if (resolution.legacy) return resumeDecision('legacy_unconfirmed');
  if (!resolution.operation) return resumeDecision('source_only_unconfirmed');
  const operation = resolution.operation;
  if (operation.generation !== request.expectedGeneration) return resumeDecision('fenced');
  if (operation.state === 'committed') return resumeDecision('committed_replay');
  if (operation.state === 'cancelled') return resumeDecision('cancelled');
  if (operation.state === 'captured') return resumeDecision('fenced');
  if (operation.generation >= limits.maxGeneration) return resumeDecision('capacity');
  const resumeSource = AutomaticCaptureResumeSourceV2Schema.parse({
    purpose: 'human_turn_memory',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
    identityHash: hashAutomaticCaptureV2(operation.identity),
    beginCallHash: operation.beginCallHash,
    retryCount: operation.retryCount,
    ...(operation.lastRetryCallHash === undefined
      ? {}
      : { lastRetryCallHash: operation.lastRetryCallHash }),
    generation: operation.generation,
    // A leased snapshot describes a PLANNED interruption only. The fresh write
    // must independently prove expiry before its atomic interrupted->resume step.
    state: operation.state === 'failed' ? 'failed' : 'interrupted',
  });
  return { kind: 'resume_source', operation, resumeSource };
}

/** Operator authentication is an external Admin prerequisite; this helper accepts no authority boolean. */
export function prepareHumanCaptureResumeV2(
  graph: GraphData,
  requestValue: AutomaticCaptureAdminFenceRequestV2,
  contextValue: AutomaticHumanCaptureResumeContextV2,
  check: () => void = () => {},
): AutomaticHumanCaptureResumePreparationV2 {
  check();
  const request = readRequest(AutomaticCaptureAdminFenceRequestV2Schema, requestValue);
  if (!request) return resumeDecision('invalid_input');
  if (request.role !== 'human') return resumeDecision('unsupported_mode');
  const context = readRequest(AutomaticHumanCaptureResumeContextV2Schema, contextValue);
  if (!context) return resumeDecision('invalid_input');
  const resolution = owned(graph, request, context.storeHash, check);
  if (resolution.kind === 'decision') return resumeDecision(resolution.status);
  if (resolution.legacy) return resumeDecision('legacy_unconfirmed');
  if (!resolution.operation) return resumeDecision('source_only_unconfirmed');
  const operation = resolution.operation;
  const previous = context.previousOperation;
  if (Date.parse(context.backendNow) < Date.parse(operation.lastObservedAt))
    return resumeDecision('clock_regression');
  // Only this invocation's unique new token and exact old capture can recover the resumed lease.
  if (
    operation.state === 'leased' &&
    operation.generation === previous.generation + 1 &&
    previous.generation === request.expectedGeneration &&
    sameIdentity(operation, previous) &&
    ['failed', 'interrupted', 'leased'].includes(previous.state) &&
    operation.lastResumeCause ===
      (previous.state === 'leased' ? 'lease_expired' : previous.state) &&
    operation.lease.token === context.leaseToken &&
    operation.lease.claimKind === 'resume' &&
    operation.lease.acquiredAt === operation.lease.renewedAt &&
    Date.parse(operation.lease.acquiredAt) >= Date.parse(previous.lastObservedAt) &&
    (previous.state !== 'leased' ||
      Date.parse(operation.lease.acquiredAt) >= Date.parse(previous.lease.expiresAt))
  ) {
    if (Date.parse(context.backendNow) >= Date.parse(operation.lease.expiresAt))
      return resumeDecision('fenced');
    if (authority(resolution, check) !== 'active') return resumeDecision('authority_changed');
    return {
      kind: 'prepared_resume',
      graph: resolution.graph,
      leaseFence: fence(operation),
      writeRequired: false,
    };
  }
  if (operation.generation !== request.expectedGeneration) return resumeDecision('fenced');
  if (operation.state === 'committed') return resumeDecision('committed_replay');
  if (operation.state === 'cancelled') return resumeDecision('cancelled');
  if (operation.state === 'captured') return resumeDecision('fenced');
  if (
    !sameIdentity(operation, previous) ||
    operation.generation !== previous.generation ||
    operation.state !== previous.state ||
    operation.lastResumeCause !== previous.lastResumeCause ||
    (operation.state === 'leased' &&
      (previous.state !== 'leased' || canonical(operation.lease) !== canonical(previous.lease)))
  )
    return resumeDecision('fenced');
  if (
    operation.state === 'leased' &&
    Date.parse(context.backendNow) < Date.parse(operation.lease.expiresAt)
  )
    return resumeDecision('in_progress');
  if (authority(resolution, check) !== 'active') return resumeDecision('authority_changed');
  if (operation.generation >= limits.maxGeneration) return resumeDecision('capacity');
  if (operation.state === 'leased' && operation.lease.token === context.leaseToken)
    return resumeDecision('fenced');
  const duration = Math.min(
    limits.maxLeaseMs,
    Math.max(limits.minLeaseMs, operation.descriptor.invocationDeadlineMs + limits.storageGraceMs),
  );
  const expires = Date.parse(context.backendNow) + duration;
  if (!Number.isFinite(expires) || expires > 8.64e15) return resumeDecision('clock_regression');
  const base = { ...operation } as Record<string, unknown>;
  for (const field of ['lease', 'failedAt', 'interruptedAt', 'failureCode']) delete base[field];
  const resumed = AutomaticCaptureOperationV2Schema.safeParse({
    ...base,
    state: 'leased',
    generation: operation.generation + 1,
    lastResumeCause: operation.state === 'leased' ? 'lease_expired' : operation.state,
    lastObservedAt: context.backendNow,
    lease: {
      token: context.leaseToken,
      acquiredAt: context.backendNow,
      renewedAt: context.backendNow,
      expiresAt: new Date(expires).toISOString(),
      claimKind: 'resume',
    },
  });
  if (!resumed.success || resumed.data.state !== 'leased') return resumeDecision('capacity');
  const candidate = replace(
    resolution,
    resumed.data,
    request.attemptIdHash,
    context.backendNow,
    'resumed',
    check,
  );
  return candidate
    ? {
        kind: 'prepared_resume',
        graph: candidate,
        leaseFence: fence(resumed.data),
        writeRequired: true,
      }
    : resumeDecision('capacity');
}

export function prepareHumanCaptureCancelV2(
  graph: GraphData,
  requestValue: AutomaticCaptureAdminFenceRequestV2,
  contextValue: AutomaticHumanCaptureControlContextV2,
  check: () => void = () => {},
): AutomaticHumanCaptureCancelPreparationV2 {
  const no = (
    kind: Exclude<
      AutomaticHumanCaptureCancelPreparationV2,
      { kind: 'prepared_cancel' }
    >['decision']['kind'],
  ): AutomaticHumanCaptureCancelPreparationV2 => ({ kind: 'decision', decision: { kind } });
  check();
  const request = readRequest(AutomaticCaptureAdminFenceRequestV2Schema, requestValue);
  if (!request) return no('invalid_input');
  if (request.role !== 'human') return no('unsupported_mode');
  const context = readRequest(AutomaticHumanCaptureControlContextV2Schema, contextValue);
  if (!context) return no('invalid_input');
  const resolution = owned(graph, request, context.storeHash, check);
  if (resolution.kind === 'decision') return no(resolution.status);
  if (resolution.legacy) return no('legacy_unconfirmed');
  if (!resolution.operation) return no('source_only_unconfirmed');
  const operation = resolution.operation;
  if (operation.generation !== request.expectedGeneration) return no('fenced');
  if (Date.parse(context.backendNow) < Date.parse(operation.lastObservedAt))
    return no('clock_regression');
  if (operation.state === 'committed' || operation.state === 'cancelled')
    return no('already_terminal');
  const terminal = AutomaticCaptureTerminalReceiptV2Schema.safeParse({
    version: 2,
    kind: 'cancelled',
    operationId: operation.operationId,
    sourceId: operation.identity.sourceId,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
    terminalAt: context.backendNow,
    acceptedCoverage: 'none',
  });
  if (!terminal.success || terminal.data.kind !== 'cancelled') return no('capacity');
  const base = { ...operation } as Record<string, unknown>;
  for (const field of ['lease', 'failedAt', 'interruptedAt', 'failureCode']) delete base[field];
  const cancelled = AutomaticCaptureOperationV2Schema.safeParse({
    ...base,
    state: 'cancelled',
    lastObservedAt: context.backendNow,
    terminalReceipt: terminal.data,
  });
  if (!cancelled.success) return no('capacity');
  // Explicit authenticated operator cancellation may abort revoked/rejected work;
  // it grants no processing permission and deletes no source or accepted fact.
  const candidate = replace(
    resolution,
    cancelled.data,
    request.attemptIdHash,
    context.backendNow,
    'cancelled',
    check,
  );
  return candidate
    ? { kind: 'prepared_cancel', graph: candidate, terminalReceipt: terminal.data }
    : no('capacity');
}

/** Read-only public projection; original accepted counts are explicitly tied to commitAt. */
export function projectHumanCaptureOutcomeV2(
  graph: GraphData,
  requestValue: AutomaticCaptureReadRequestV2,
  contextValue: AutomaticHumanCaptureControlContextV2,
  check: () => void = () => {},
): AutomaticCaptureReadResultV2 {
  const empty = (
    status: AutomaticCaptureReadResultV2['status'],
    sourcePersistence: AutomaticCaptureReadResultV2['sourcePersistence'],
  ): AutomaticCaptureReadResultV2 => ({
    version: 2,
    purpose: null,
    status,
    sourceId: null,
    sourcePersistence,
    should_process: false,
    currentAuthority: 'not_evaluated',
    receiptSummary: null,
  });
  check();
  const request = readRequest(AutomaticCaptureReadRequestV2Schema, requestValue);
  if (!request) return empty('invalid_input', 'not_persisted');
  if (request.role !== 'human') return empty('unsupported_mode', 'unknown');
  const context = readRequest(AutomaticHumanCaptureControlContextV2Schema, contextValue);
  if (!context) return empty('failed', 'unknown');
  const resolution = owned(graph, request, context.storeHash, check);
  if (resolution.kind === 'decision')
    return empty(
      resolution.status === 'invalid_input' ? 'failed' : resolution.status,
      resolution.status === 'not_found' ? 'not_persisted' : 'unknown',
    );
  const base = {
    version: 2 as const,
    purpose: 'human_turn_memory' as const,
    sourceId: resolution.source.uuid,
    sourcePersistence: 'persisted' as const,
    should_process: false as const,
    currentAuthority: authority(resolution, check),
    receiptSummary: null,
  };
  if (resolution.legacy)
    return AutomaticCaptureReadResultV2Schema.parse({ ...base, status: 'legacy_unconfirmed' });
  if (!resolution.operation)
    return AutomaticCaptureReadResultV2Schema.parse({ ...base, status: 'source_only_unconfirmed' });
  const operation = resolution.operation;
  if (
    operation.state === 'committed' &&
    operation.terminalReceipt.kind === 'human_capture_committed'
  ) {
    const terminal = operation.terminalReceipt;
    const itemCounts = {
      accepted: 0,
      proposed: 0,
      rejected: 0,
      deferred: 0,
      not_selected: 0,
      unchanged: 0,
    };
    for (const item of terminal.receipt.items) itemCounts[item.state]++;
    return AutomaticCaptureReadResultV2Schema.parse({
      ...base,
      status: 'committed_replay',
      receiptSummary: {
        persisted: terminal.receipt.persisted,
        commitAt: terminal.receipt.commitAt,
        receiptInspectionComplete: terminal.receiptInspectionComplete,
        interpretationCoverage: terminal.interpretationCoverage,
        acceptedCoverage: terminal.acceptedCoverage,
        itemCounts,
      },
    });
  }
  if (operation.state === 'cancelled')
    return AutomaticCaptureReadResultV2Schema.parse({ ...base, status: 'cancelled' });
  if (Date.parse(context.backendNow) < Date.parse(operation.lastObservedAt))
    return AutomaticCaptureReadResultV2Schema.parse({
      ...base,
      currentAuthority: 'unknown',
      status: 'clock_regression',
    });
  const resumable =
    operation.state === 'failed' ||
    operation.state === 'interrupted' ||
    (operation.state === 'leased' &&
      Date.parse(context.backendNow) >= Date.parse(operation.lease.expiresAt));
  if (resumable && operation.generation >= limits.maxGeneration)
    return AutomaticCaptureReadResultV2Schema.parse({
      ...base,
      status: 'capacity',
      sourceId: null,
    });
  return AutomaticCaptureReadResultV2Schema.parse({
    ...base,
    status:
      base.currentAuthority !== 'active'
        ? 'authority_changed'
        : resumable
          ? 'resume_available'
          : 'in_progress',
  });
}
