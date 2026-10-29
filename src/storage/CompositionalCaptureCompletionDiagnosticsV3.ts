import {
  CompositionalCompletionStageDeferredReasonV3Schema,
  type CompositionalCompletionStageDeferredReasonV3,
} from '../schemas/CompositionalCompletionStageV3.schema';
import {
  CompositionalCaptureNonPermitDecisionV3Schema,
  type CompositionalCaptureNonPermitDecisionV3,
} from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';

type Kind = CompositionalCaptureNonPermitDecisionV3['kind'];
const stageKinds: Readonly<Record<CompositionalCompletionStageDeferredReasonV3, Kind>> =
  Object.freeze({
    invalid_capability: 'invalid_handle',
    invalid_input: 'invalid_input',
    invalid_resources: 'resource_exhausted',
    invalid_snapshot: 'conflict',
    missing_operation: 'not_found',
    ambiguous_operation: 'conflict',
    unsupported_mode: 'unsupported_mode',
    operation_not_leased: 'fenced',
    clock_regression: 'clock_regression',
    lease_expired: 'fenced',
    invalid_source: 'conflict',
    authority_changed: 'authority_changed',
    source_verdict_required: 'invalid_plan',
    identity_collision: 'conflict',
    inspection_incomplete: 'resource_exhausted',
    budget_exhausted: 'budget_exhausted',
    plan_too_large: 'resource_exhausted',
    invalid_plan: 'invalid_plan',
    invalid_stage: 'invalid_plan',
    invalid_receipt: 'invalid_plan',
    invalid_audit: 'invalid_plan',
    capacity: 'capacity',
    acknowledgement_mismatch: 'acknowledgement_unknown',
    deadline_exceeded: 'budget_exhausted',
  });

/** Same fixed diagnostics on both backends; this never grants processing permission. */
export function compositionalCaptureCompletionDecisionKindV3(reason: unknown): Kind {
  if (typeof reason !== 'string') return 'invalid_plan';
  const stage = CompositionalCompletionStageDeferredReasonV3Schema.safeParse(reason);
  if (stage.success) return stageKinds[stage.data];
  const publicDecision = CompositionalCaptureNonPermitDecisionV3Schema.safeParse({
    kind: reason,
    eligibleFirstCommit: false,
  });
  return publicDecision.success ? publicDecision.data.kind : 'invalid_plan';
}
