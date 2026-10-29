import { StagedExtractionSchema, type GraphData, type StagedExtraction } from '../schemas';
import { parseLosslessAutomaticCaptureGraph } from './LosslessAutomaticCaptureGraph';
import {
  AutomaticCaptureOperationV2Schema,
  type AutomaticCaptureOperationV2,
} from '../schemas/AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from '../schemas/AutomaticCaptureReceipt.schema';
import { AutomaticSourceEnvelopeSchema } from '../schemas/AutomaticMemory.schema';
import {
  canonicalAutomaticCaptureV2 as canonical,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import {
  AutomaticHumanCaptureCompletionContextV2Schema,
  type AutomaticHumanCaptureCompletionContextV2,
  type AutomaticHumanCaptureCompletionPreparationV2,
  type AutomaticHumanCaptureCompletionReasonV2,
} from '../schemas/AutomaticCaptureComplete.schema';
import { AUTOMATIC_LEDGER_LIMITS as limits } from '../schemas/AutomaticLedgerPrimitives.schema';
import { committedAutomaticReceipt } from '../extraction/AutomaticClaims';
import { graphFingerprint, sourceFingerprint } from '../extraction/QueueState';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';
import { validateAutomaticCaptureCandidate } from './AutomaticCaptureCapacity';
import { applyHumanLiteralPlanV2 } from './AutomaticCapturePlan';
import {
  assertAutomaticBinding,
  assertAutomaticLedgerSourceIntegrity,
  automaticCaptureOperationIdentityForOwnedSource,
  reconcileAutomaticCaptureOperationIdentity,
  SOURCE_ENVELOPE_ATTRIBUTE,
} from './AutomaticIdentity';
import type {
  AutomaticCaptureHandleRegistry,
  PrivateConsumedAutomaticCaptureInvocation,
  AutomaticCaptureCompletionInvocationFor,
  AutomaticCaptureLeaseFenceV2,
} from './AutomaticCaptureHandles';

declare const preparedPlanBrand: unique symbol;
export type PrivatePreparedHumanCapturePlanV2 = object & { readonly [preparedPlanBrand]: true };
type PlanState = {
  readonly registry: AutomaticCaptureHandleRegistry;
  readonly capability: PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>;
} & (
  | { readonly kind: 'plan'; readonly plan: StagedExtraction }
  | { readonly kind: 'failure'; readonly reason: 'invalid_plan' | 'resource_exhausted' }
);
const plans = new WeakMap<object, PlanState>();
const preparedByCapability = new WeakMap<object, PrivatePreparedHumanCapturePlanV2>();
const isResource = (error: unknown) =>
  error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json';

/** Call synchronously AFTER consuming the handle and BEFORE the backend's first await. */
export function prepareHumanCapturePlanV2(
  planInput: unknown,
  registry: AutomaticCaptureHandleRegistry,
  capability: PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>,
): PrivatePreparedHumanCapturePlanV2 {
  registry.readConsumedInvocation(capability, 'human_turn_memory');
  const existing = preparedByCapability.get(capability);
  if (existing) return existing;
  const token = Object.freeze(Object.create(null)) as PrivatePreparedHumanCapturePlanV2;
  try {
    const owned = cloneBoundedAutomaticCaptureJson<unknown>(planInput, 'plan');
    const plan = StagedExtractionSchema.strict().parse(owned);
    if (canonical(owned) !== canonical(plan))
      throw new Error('Engram automatic memory: invalid_plan');
    plans.set(token, { registry, capability, kind: 'plan', plan });
  } catch (error) {
    plans.set(token, {
      registry,
      capability,
      kind: 'failure',
      reason: isResource(error) ? 'resource_exhausted' : 'invalid_plan',
    });
  }
  preparedByCapability.set(capability, token);
  return token;
}

const no = (
  reason: AutomaticHumanCaptureCompletionReasonV2,
): AutomaticHumanCaptureCompletionPreparationV2 => ({ kind: 'decision', reason });
const knownFailureReasons = new Set([
  'clause_too_long',
  'object_too_long',
  'too_many_claims',
  'capacity',
  'invalid_envelope',
  'content_mismatch',
  'incomplete_mapping',
  'source_changed',
  'binding_changed',
  'missing_binding',
  'interrupted',
]);
const noFactReasons = new Set(['no_preference_clause', 'not_selected']);

function matchesBase(
  operation: AutomaticCaptureOperationV2,
  invocation: AutomaticCaptureCompletionInvocationFor<'human_turn_memory'>,
): boolean {
  const fence = invocation.boundFence;
  return (
    operation.identity.purpose === 'human_turn_memory' &&
    operation.identity.role === 'human' &&
    operation.operationId === fence.operationId &&
    operation.identity.sourceId === fence.sourceId &&
    hashAutomaticCaptureV2(operation.descriptor) === fence.descriptorHash &&
    operation.beginCallHash === fence.beginCallHash &&
    hashAutomaticCaptureV2(operation.identity) === fence.identityHash &&
    operation.generation === fence.generation
  );
}
function fenceFor(
  operation: Extract<AutomaticCaptureOperationV2, { state: 'leased' }>,
): AutomaticCaptureLeaseFenceV2 {
  return {
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
  };
}

/** Pure completion preparation. Only a durable backend acknowledgement may project eligibility. */
export function prepareHumanCaptureCompletionV2(
  graphInput: GraphData,
  preparedToken: PrivatePreparedHumanCapturePlanV2,
  registry: AutomaticCaptureHandleRegistry,
  capability: PrivateConsumedAutomaticCaptureInvocation<'human_turn_memory'>,
  contextInput: AutomaticHumanCaptureCompletionContextV2,
  check: () => void = () => {},
): AutomaticHumanCaptureCompletionPreparationV2 {
  let invocation: AutomaticCaptureCompletionInvocationFor<'human_turn_memory'>;
  try {
    invocation = registry.readConsumedInvocation(capability, 'human_turn_memory');
  } catch {
    return no('invalid_handle');
  }
  const preparation = plans.get(preparedToken);
  if (!preparation || preparation.registry !== registry || preparation.capability !== capability)
    return no('invalid_plan');
  check();
  let graph: GraphData;
  let context: AutomaticHumanCaptureCompletionContextV2;
  try {
    context = AutomaticHumanCaptureCompletionContextV2Schema.parse(
      cloneBoundedAutomaticCaptureJson(contextInput, 'beginRequest'),
    );
    graph = parseLosslessAutomaticCaptureGraph(graphInput);
    assertAutomaticLedgerSourceIntegrity(graph);
  } catch (error) {
    return no(isResource(error) ? 'resource_exhausted' : 'invalid_input');
  }
  check();
  const matching =
    graph.automatic_operations_v1?.operations.filter(
      (operation) => operation.operationId === invocation.boundFence.operationId,
    ) ?? [];
  if (matching.length !== 1 || matching[0].version !== 2) return no('fenced');
  const operation = matching[0];
  if (!matchesBase(operation, invocation) || operation.identity.storeHash !== context.storeHash)
    return no('fenced');
  const sources = graph.episodes.filter((source) => source.uuid === invocation.boundFence.sourceId);
  if (sources.length !== 1) return no('fenced');
  const source = sources[0];
  try {
    const actual = automaticCaptureOperationIdentityForOwnedSource(source, operation.descriptor);
    if (!reconcileAutomaticCaptureOperationIdentity(actual, operation.identity))
      return no('fenced');
  } catch {
    return no('fenced');
  }
  if (Date.parse(context.backendNow) < Date.parse(operation.lastObservedAt))
    return no('clock_regression');
  const authority = () => {
    let workError: { value: unknown } | undefined;
    try {
      assertAutomaticBinding(
        graph,
        AutomaticSourceEnvelopeSchema.parse(source.attributes[SOURCE_ENVELOPE_ATTRIBUTE]),
        () => {
          try {
            check();
          } catch (error) {
            workError = { value: error };
            throw error;
          }
        },
      );
      return source.review_status === 'accepted' &&
        source.trust_level === operation.descriptor.requestedTrustLevel
        ? ('active' as const)
        : ('changed' as const);
    } catch (error) {
      if (workError) throw workError.value;
      return error instanceof Error && error.message.includes('binding_revoked')
        ? ('revoked' as const)
        : ('changed' as const);
    }
  };
  const origin = invocation.boundFence.claimKind;
  if (operation.state === 'committed') {
    if (
      operation.terminalReceipt.kind !== 'human_capture_committed' ||
      operation.completionCallHash !== invocation.completionCallHash ||
      operation.retryCount !== invocation.boundFence.retryCount ||
      operation.lastRetryCallHash !== invocation.boundFence.lastRetryCallHash
    )
      return no('fenced');
    check();
    return {
      kind: 'ack_recovered',
      terminalReceipt: operation.terminalReceipt,
      origin,
      currentAuthority: authority(),
    };
  }
  if (
    operation.state !== 'leased' ||
    operation.lease.token !== invocation.boundFence.token ||
    operation.lease.claimKind !== invocation.boundFence.claimKind ||
    Date.parse(context.backendNow) >= Date.parse(operation.lease.expiresAt)
  )
    return no('fenced');
  if (authority() !== 'active') return no('authority_changed');
  check();
  // Exact retry-issue callback recovery precedes the old timestamp/count fence.
  if (
    operation.retryCount === invocation.boundFence.retryCount + 1 &&
    operation.lastRetryCallHash === invocation.retryIssueCallHash &&
    Date.parse(operation.lease.renewedAt) >= Date.parse(invocation.boundFence.planTimestamp)
  ) {
    return { kind: 'prepared_retry', graph, leaseFence: fenceFor(operation), writeRequired: false };
  }
  if (
    operation.retryCount !== invocation.boundFence.retryCount ||
    operation.lastRetryCallHash !== invocation.boundFence.lastRetryCallHash ||
    operation.lease.renewedAt !== invocation.boundFence.planTimestamp
  )
    return no('fenced');

  const replace = (replacement: AutomaticCaptureOperationV2, candidateGraph = graph) =>
    validateAutomaticCaptureCandidate(
      {
        ...candidateGraph,
        automatic_operations_v1: {
          version: 1,
          operations: graph.automatic_operations_v1!.operations.map((item) =>
            item.operationId === operation.operationId ? replacement : item,
          ),
        },
      },
      check,
    );
  const fail = (
    reason: AutomaticHumanCaptureCompletionReasonV2,
    code?: 'graph_conflict',
  ): AutomaticHumanCaptureCompletionPreparationV2 => {
    const { lease: _lease, ...base } = operation;
    void _lease;
    const candidateOperation = AutomaticCaptureOperationV2Schema.safeParse(
      reason === 'interrupted'
        ? {
            ...base,
            state: 'interrupted',
            interruptedAt: context.backendNow,
            lastObservedAt: context.backendNow,
            failureCode: 'invocation_interrupted',
          }
        : {
            ...base,
            state: 'failed',
            failedAt: context.backendNow,
            lastObservedAt: context.backendNow,
            failureCode:
              code ??
              (reason === 'budget_exhausted'
                ? 'budget_exhausted'
                : reason === 'resource_exhausted' || reason === 'capacity'
                  ? 'capacity'
                  : 'invalid_plan'),
          },
    );
    if (!candidateOperation.success) return no(reason);
    const candidate = replace(candidateOperation.data);
    return candidate ? { kind: 'prepared_failure', graph: candidate, reason } : no(reason);
  };
  if (preparation.kind === 'failure') return fail(preparation.reason);
  // Private state is never returned to callers or passed to an applier by reference.
  const plan = cloneBoundedAutomaticCaptureJson<StagedExtraction>(preparation.plan, 'plan');
  const receipt = plan.outcome.automatic;
  if (
    plan.group_id !== operation.identity.namespace ||
    plan.source_guards.length !== 1 ||
    plan.source_guards[0].uuid !== source.uuid ||
    plan.source_guards[0].hash !== sourceFingerprint(source) ||
    !receipt ||
    canonical(receipt.policy) !== canonical(operation.descriptor.policy) ||
    receipt.sourceIds.length !== 1 ||
    receipt.sourceIds[0] !== source.uuid ||
    receipt.persisted ||
    receipt.commitAt !== null
  )
    return fail('invalid_plan');
  if (plan.outcome.budget)
    return fail(plan.outcome.budget.reason === 'cancelled' ? 'interrupted' : 'budget_exhausted');
  if (
    plan.outcome.error_count ||
    plan.outcome.errors.length ||
    plan.outcome.errors_truncated ||
    plan.outcome.status !== 'succeeded'
  )
    return fail('invalid_plan');
  if (
    plan.outcome.counts.entities_created !== plan.entities.length ||
    plan.outcome.counts.edges_created !== plan.edges.length ||
    plan.outcome.counts.entities_updated ||
    plan.outcome.counts.edges_updated ||
    plan.outcome.counts.edges_expired
  )
    return fail('invalid_plan');
  if (!receipt.coverageComplete || receipt.items.length === 0) return fail('invalid_plan');
  const failedReasons = receipt.items
    .flatMap((item) => item.reasons)
    .filter((reason) => knownFailureReasons.has(reason));
  if (failedReasons.length)
    return fail(
      failedReasons.includes('interrupted')
        ? 'interrupted'
        : failedReasons.some((reason) =>
              ['capacity', 'clause_too_long', 'object_too_long', 'too_many_claims'].includes(
                reason,
              ),
            )
          ? 'resource_exhausted'
          : 'invalid_plan',
    );
  if (receipt.items.some((item) => item.state === 'deferred')) return fail('invalid_plan');
  if (
    receipt.items.some((item) => {
      if (item.state === 'accepted')
        return !item.claimId || item.persisted || item.mutation !== 'pending';
      if (item.state === 'proposed')
        return (
          !item.claimId ||
          !(
            (item.mutation === 'pending' && !item.persisted) ||
            (item.mutation === 'none' && item.persisted)
          )
        );
      if (item.state === 'rejected' || item.state === 'unchanged')
        return !item.claimId || !item.persisted || item.mutation !== 'none';
      return (
        item.persisted ||
        item.mutation !== 'none' ||
        item.claimId !== undefined ||
        item.reasons.length === 0
      );
    })
  )
    return fail('invalid_plan');
  if (plan.graph_hash !== graphFingerprint(graph, plan.group_id)) {
    if (operation.retryCount >= 3) return fail('resource_exhausted', 'graph_conflict');
    const duration = Math.min(
      limits.maxLeaseMs,
      Math.max(
        limits.minLeaseMs,
        operation.descriptor.invocationDeadlineMs + limits.storageGraceMs,
      ),
    );
    const expiry = Date.parse(context.backendNow) + duration;
    if (!Number.isFinite(expiry) || expiry > 8.64e15) return no('clock_regression');
    const retry = AutomaticCaptureOperationV2Schema.safeParse({
      ...operation,
      lastObservedAt: context.backendNow,
      retryCount: operation.retryCount + 1,
      lastRetryCallHash: invocation.retryIssueCallHash,
      lease: {
        ...operation.lease,
        renewedAt: context.backendNow,
        expiresAt: new Date(expiry).toISOString(),
      },
    });
    if (!retry.success || retry.data.state !== 'leased') return fail('resource_exhausted');
    const candidate = replace(retry.data);
    return candidate
      ? {
          kind: 'prepared_retry',
          graph: candidate,
          leaseFence: fenceFor(retry.data),
          writeRequired: true,
        }
      : fail('resource_exhausted');
  }
  let validatedPlan: StagedExtraction;
  const isolated = cloneBoundedAutomaticCaptureJson<GraphData>(graph, 'graph');
  try {
    // Bound proposed growth before the applier's structural/reconstruction checks.
    cloneBoundedAutomaticCaptureJson(
      {
        ...graph,
        entities: [...graph.entities, ...plan.entities],
        edges: [...graph.edges, ...plan.edges],
      },
      'graph',
    );
    validatedPlan = applyHumanLiteralPlanV2(isolated, plan, registry, capability);
  } catch (error) {
    if (error instanceof ExtractionBudgetError)
      return fail(error.budgetReason === 'cancelled' ? 'interrupted' : 'budget_exhausted');
    return fail(isResource(error) ? 'resource_exhausted' : 'invalid_plan');
  }
  check();
  committedAutomaticReceipt(validatedPlan.outcome, context.backendNow);
  const actualReceipt = validatedPlan.outcome.automatic!;
  const persistedClaims = actualReceipt.items.filter(
    (item) =>
      item.persisted && ['accepted', 'unchanged', 'proposed', 'rejected'].includes(item.state),
  );
  const accepted = actualReceipt.items.filter(
    (item) => item.persisted && ['accepted', 'unchanged'].includes(item.state),
  ).length;
  const terminal = AutomaticCaptureTerminalReceiptV2Schema.safeParse({
    version: 2,
    kind: 'human_capture_committed',
    operationId: operation.operationId,
    sourceId: source.uuid,
    sourceHash: operation.identity.sourceHash,
    descriptorHash: hashAutomaticCaptureV2(operation.descriptor),
    terminalAt: context.backendNow,
    receiptInspectionComplete: actualReceipt.coverageComplete,
    interpretationCoverage:
      persistedClaims.length > 0
        ? 'complete'
        : actualReceipt.items.every((item) =>
              item.reasons.every((reason) => noFactReasons.has(reason)),
            )
          ? 'none'
          : 'unknown',
    acceptedCoverage:
      accepted === 0 ? 'none' : accepted === actualReceipt.items.length ? 'all' : 'partial',
    receipt: actualReceipt,
    dependencies: actualReceipt.items.map((item, itemIndex) => ({
      sourceId: source.uuid,
      dependencyHash: hashAutomaticCaptureV2({
        sourceId: source.uuid,
        sourceHash: operation.identity.sourceHash,
        itemIndex,
        item,
      }),
      itemIndex,
      ...(item.claimId ? { claimId: item.claimId } : {}),
      state: item.state,
      persisted: item.persisted,
      reasons: item.reasons,
    })),
  });
  if (!terminal.success || terminal.data.kind !== 'human_capture_committed')
    return fail('invalid_plan');
  const { lease: _lease, ...base } = operation;
  void _lease;
  const committed = AutomaticCaptureOperationV2Schema.safeParse({
    ...base,
    state: 'committed',
    lastObservedAt: context.backendNow,
    completionCallHash: invocation.completionCallHash,
    terminalReceipt: terminal.data,
  });
  if (!committed.success || committed.data.state !== 'committed') return fail('resource_exhausted');
  const candidate = replace(committed.data, isolated);
  return candidate
    ? {
        kind: 'prepared_commit',
        graph: candidate,
        operation: committed.data,
        terminalReceipt: terminal.data,
        origin,
      }
    : fail('resource_exhausted');
}
