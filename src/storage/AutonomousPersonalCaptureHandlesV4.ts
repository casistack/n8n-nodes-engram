import { performance } from 'perf_hooks';
import { z } from 'zod';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from './IGraphStorage';
import {
  compileAutonomousPersonalFreshSourceV4,
  parseAutonomousPersonalBeginV4Input,
  hashAutonomousPersonalAttemptV4,
  hashAutonomousPersonalStableRequestV4,
} from './AutonomousPersonalCaptureBeginV4';
import {
  AutonomousPersonalCaptureAttemptScopeV4OwnedDataSchema,
  AutonomousPersonalCaptureBoundScopeV4OwnedDataSchema,
  AutonomousPersonalCapturePreflightV4OwnedDataSchema,
  AutonomousPersonalCaptureStagedFreshV4OwnedDataSchema,
  type AutonomousPersonalCaptureStagedFreshV4,
  type AutonomousPersonalCaptureSameInitialScopeV4,
  type AutonomousPersonalCaptureAttemptScopeV4,
  type AutonomousPersonalCaptureBackendAttemptV4,
  type AutonomousPersonalCaptureBoundBackendAttemptV4,
  type AutonomousPersonalCaptureBoundScopeV4,
  type AutonomousPersonalCaptureBeginV4FalseResult,
} from '../schemas/AutonomousPersonalCaptureBeginV4.schema';
import {
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
  type AutonomousPersonalCaptureBeginV4ResultProjection,
} from '../schemas/AutonomousPersonalCaptureAdmissionV4.schema';
import { AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema } from '../schemas/AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import type { AutonomousPersonalOperationV4 } from '../schemas/AutonomousPersonalOperationV4.schema';
import {
  compileAutonomousPersonalDescriptorV4,
  hashAutonomousPersonalDescriptorV4,
} from '../schemas/AutonomousPersonalDescriptorV4.schema';
import { AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS } from '../schemas/AutonomousPersonalPolicyV3.schema';
import {
  AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE,
  AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE,
  reconstructAutonomousPersonalStoredSourceIdentityV4,
} from '../schemas/AutonomousPersonalSourceV4.schema';
import {
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from '../schemas/AutomaticCapture.schema';
import { AutonomousPersonalCompletionPlanV4OwnedDataSchema } from '../schemas/AutonomousPersonalCompletionPlanV4.schema';
import { AutonomousPersonalNativeOriginV4OwnedDataSchema } from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';
import {
  AutonomousPersonalCaptureAttemptStartV4OwnedDataSchema,
  type AutonomousPersonalCaptureAttemptStartV4,
} from '../schemas/AutonomousPersonalCaptureBeginV4.schema';
import type { AutonomousPersonalCaptureNativeConfigV4 } from '../utils/AutonomousPersonalCaptureNativeConfigV4';
import {
  readNativeAutonomousPersonalCaptureConfigV4,
  readNativeAutonomousPersonalCaptureProviderConfigV4,
} from '../utils/AutonomousPersonalCaptureNativeConfigV4';
import { generateUuid } from '../utils/uuid';
import {
  AutonomousPersonalCaptureProviderObservationV4Schema,
  AutonomousPersonalCaptureProviderPreflightV4Schema,
  AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema,
  type AutonomousPersonalCaptureProviderPreflightV4,
  type AutonomousPersonalCaptureProviderPreflightReadyV4,
  type AutonomousPersonalCaptureProviderObservationV4,
} from '../schemas/AutonomousPersonalCaptureProviderV4.schema';
import {
  AutonomousPersonalProviderResponseV1Schema,
  validateAutonomousPersonalProviderResponseV1,
  type AutonomousPersonalProviderResponseV1,
} from '../schemas/AutonomousPersonalProviderV1.schema';
import {
  AutonomousPersonalEvidenceSelectionFailureV1,
  compileAutonomousPersonalEvidenceSelectionV1,
} from '../extraction/AutonomousPersonalEvidenceSelectionV1';
import {
  AutonomousPersonalEvidenceSelectionV1Schema,
  type AutonomousPersonalEvidenceSelectionV1,
} from '../schemas/AutonomousPersonalEvidenceSelectionV1.schema';
import { AutonomousPersonalProviderResponseV1OwnedDataSchema } from '../schemas/AutonomousPersonalProviderV1.schema';
import { RequestBudget } from '../extraction/RequestBudget';
import { LlmClient } from '../extraction/LlmClient';
import { ExtractionBudgetError, ExtractionError } from '../extraction/ExtractionDiagnostics';
import {
  readNativeAutonomousPersonalCaptureRuntimeProviderV4,
  type AutonomousPersonalCaptureRuntimeProviderV4,
} from '../utils/AutonomousPersonalCaptureNativeConfigV4';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';
import type { SourceHydrationBudget } from '../schemas/ExtractionPolicy.schema';
import {
  canUseAutomaticClaimReadScope,
  getAutomaticClaimReadScope,
  type AutomaticClaimReadScope,
} from './AutomaticClaimReadScope';
import {
  AutonomousPersonalProviderPromptFailureV1,
  prepareAutonomousPersonalProviderPromptV1,
} from '../extraction/AutonomousPersonalProviderRequestV1';

declare const attemptV4Brand: unique symbol;
declare const leaseHandleV4Brand: unique symbol;
declare const providerPreflightAccessV4Brand: unique symbol;
declare const providerStageV4Brand: unique symbol;
declare const providerStageAccessV4Brand: unique symbol;
declare const completionHandleV4Brand: unique symbol;
declare const completionAccessV4Brand: unique symbol;

/** Empty, frozen, one-use key minted only by the fixed native dispatch below. */
export type PrivateAutonomousPersonalCaptureAttemptV4 = object & {
  readonly [attemptV4Brand]: 'native_attempt';
};

/** Empty, frozen initial lease handle, separate from the processing-attempt key. */
export type PrivateOneUseAutonomousPersonalCaptureLeaseHandleV4 = object & {
  readonly [leaseHandleV4Brand]: 'initial';
};

/** Opaque backend-only access key for one actual provider preflight read. */
export type PrivateAutonomousPersonalCaptureProviderPreflightAccessV4 = object & {
  readonly [providerPreflightAccessV4Brand]: 'provider_preflight';
};

/** Empty, one-use provider stage. It is never write or Proceed authority. */
export type PrivateAutonomousPersonalCaptureProviderStageV4 = object & {
  readonly [providerStageV4Brand]: 'provider_stage';
};

/** Opaque one-use view of a consumed provider stage for the fixed completion path. */
export type PrivateAutonomousPersonalCaptureProviderStageAccessV4 = object & {
  readonly [providerStageAccessV4Brand]: 'provider_stage_access';
};

/** Empty, one-use key for a native completion preparation. */
export type PrivateAutonomousPersonalCompletionHandleV4 = object & {
  readonly [completionHandleV4Brand]: 'completion_handle';
};

/** Empty, owner-bound access key for one consumed completion preparation. */
export type PrivateAutonomousPersonalCompletionAccessV4 = object & {
  readonly [completionAccessV4Brand]: 'completion_access';
};

interface NativeCaptureLifetimeV4 {
  readonly controller: AbortController;
  readonly parentSignal?: AbortSignal;
  readonly parentAbort: () => void;
  hostAborted: boolean;
  cleaningUp: boolean;
  disposed: boolean;
  originalDeadlineAtMonotonicMs?: number;
  overallDeadlineAtMonotonicMs?: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  removeParentListener: boolean;
}

interface AttemptRecord {
  readonly owner: object;
  readonly scope: AutonomousPersonalCaptureAttemptScopeV4;
  readonly lifetime?: NativeCaptureLifetimeV4;
  phase: 'issued' | 'in_transaction' | 'acknowledgement_unknown' | 'claimed' | 'closed';
  bound?: AutonomousPersonalCaptureBoundScopeV4;
  stagedFresh?: AutonomousPersonalCaptureStagedFreshV4;
  readbackStarted: boolean;
  readbackKind?: 'acknowledged' | 'unknown';
}

interface LeaseHandleRecord {
  readonly owner: object;
  readonly scope: AutonomousPersonalCaptureBoundScopeV4;
  readonly stagedFresh: AutonomousPersonalCaptureStagedFreshV4;
  readonly lifetime?: NativeCaptureLifetimeV4;
  providerReady?: AutonomousPersonalCaptureProviderPreflightReadyV4;
  providerOverallDeadlineAtMonotonicMs?: number;
  consumed: boolean;
}

interface ProviderPreflightRecordV4 {
  readonly owner: object;
  readonly handle: object;
  readonly lease: LeaseHandleRecord;
  readonly lifetime: NativeCaptureLifetimeV4;
  closed: boolean;
  ready?: AutonomousPersonalCaptureProviderPreflightReadyV4;
  leaseProjectionAtMonotonicMs?: number;
}

const providerStageOutcomeOwnedSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('response'),
      response: AutonomousPersonalProviderResponseV1OwnedDataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('deferred'),
      reason: z.enum([
        'provider_invalid_request',
        'provider_auth',
        'provider_rate_limit',
        'provider_unavailable',
        'provider_network',
        'provider_invalid_response',
        'provider_subdeadline',
        'provider_request_bytes',
        'provider_response_bytes',
        'interpretation_capacity',
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('no_dispatch'),
      reason: z.enum([
        'empty_source',
        'policy_not_selected',
        'source_indeterminate',
        'source_resource',
        'unit_count',
        'typed_metadata',
        'aggregate',
      ]),
    })
    .strict(),
]);

type ProviderStageOutcomeV4 = z.infer<typeof providerStageOutcomeOwnedSchema>;
export type AutonomousPersonalCaptureProviderStageOutcomeV4 = ProviderStageOutcomeV4;

interface ProviderStageRecordV4 {
  readonly owner: object;
  readonly handle: object;
  readonly scope: AutonomousPersonalCaptureBoundScopeV4;
  readonly stagedFresh: AutonomousPersonalCaptureStagedFreshV4;
  readonly lifetime: NativeCaptureLifetimeV4;
  readonly refs: AutonomousPersonalCaptureProviderPreflightReadyV4['refs'];
  readonly outcome: ProviderStageOutcomeV4;
  readonly selection: AutonomousPersonalEvidenceSelectionV1 | null;
  consumed: boolean;
}

interface ProviderStageAccessRecordV4 {
  readonly owner: object;
  readonly stage: object;
  readonly stageRecord: ProviderStageRecordV4;
  closed: boolean;
}

interface AutonomousPersonalCompletionAuditV4 {
  readonly action: 'completion';
  readonly attemptIdHash: string;
  readonly operationId: string;
  readonly sourceId: string;
}

interface AutonomousPersonalCompletionViewV4 {
  readonly scope: AutonomousPersonalCaptureBoundScopeV4;
  readonly stagedFresh: AutonomousPersonalCaptureStagedFreshV4;
  readonly outcome: ProviderStageOutcomeV4;
  readonly selection: AutonomousPersonalEvidenceSelectionV1 | null;
  readonly completionCallHash: string;
  readonly audit: AutonomousPersonalCompletionAuditV4;
}

interface AutonomousPersonalCompletionHandleRecordV4 {
  readonly owner: object;
  readonly originalStageAccess: PrivateAutonomousPersonalCaptureProviderStageAccessV4;
  readonly originalStageCheck: () => void;
  readonly lifetime: NativeCaptureLifetimeV4;
  readonly scope: AutonomousPersonalCaptureBoundScopeV4;
  readonly stagedFresh: AutonomousPersonalCaptureStagedFreshV4;
  readonly outcome: ProviderStageOutcomeV4;
  readonly selection: AutonomousPersonalEvidenceSelectionV1 | null;
  readonly view: AutonomousPersonalCompletionViewV4;
  readonly typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
  readonly legacyReadBudget: SourceHydrationBudget;
  readonly legacyReadScope: AutomaticClaimReadScope;
  readonly completionCallHash: string;
  readonly audit: AutonomousPersonalCompletionAuditV4;
  check: () => void;
  handle?: PrivateAutonomousPersonalCompletionHandleV4;
  access?: PrivateAutonomousPersonalCompletionAccessV4;
  phase: 'issued' | 'consumed' | 'closed';
  stageAccessClosed: boolean;
  firstFailure?: unknown;
}

interface AutonomousPersonalCompletionAccessRecordV4 {
  readonly owner: object;
  readonly handle: PrivateAutonomousPersonalCompletionHandleV4;
  readonly completion: AutonomousPersonalCompletionHandleRecordV4;
}

type RegistryFailureKindV4 = 'budget_exhausted' | 'invalid_handle' | 'conflict' | 'invalid_input';
type ProviderFailureKindV4 =
  | RegistryFailureKindV4
  | 'cancelled'
  | 'unsupported_mode'
  | 'authority_changed'
  | 'resource_exhausted'
  | 'capacity'
  | 'clock_regression'
  | 'acknowledgement_unknown'
  | 'storage_error'
  | 'in_progress'
  | 'resume_available'
  | 'source_only_unconfirmed'
  | 'committed_observed'
  | 'cancelled_observed'
  | 'failed'
  | 'interrupted';

const providerFailureErrors = new WeakMap<object, ProviderFailureKindV4>();

const attempts = new WeakMap<object, AttemptRecord>();
const leaseHandles = new WeakMap<object, LeaseHandleRecord>();
const registryFailures = new WeakMap<object, RegistryFailureKindV4>();
const provenCommitBudgetFailures = new WeakSet<object>();
const providerPreflightAccesses = new WeakMap<object, ProviderPreflightRecordV4>();
const providerStages = new WeakMap<object, ProviderStageRecordV4>();
const providerStageAccesses = new WeakMap<object, ProviderStageAccessRecordV4>();
const completionHandles = new WeakMap<object, AutonomousPersonalCompletionHandleRecordV4>();
const completionAccesses = new WeakMap<object, AutonomousPersonalCompletionAccessRecordV4>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  return canonicalAutomaticCaptureV2(value);
}

function assertAutonomousPersonalCachedStageBytesV4(data: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw providerFixedError('resource_exhausted');
  }
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes
  ) {
    throw providerFixedError('resource_exhausted');
  }
}

function fixedDecision(
  kind: Exclude<
    AutonomousPersonalCaptureBeginV4ResultProjection['kind'],
    'claimed' | 'committed_observed' | 'cancelled_observed' | 'failed' | 'interrupted'
  >,
): AutonomousPersonalCaptureBeginV4FalseResult {
  return deepFreeze(
    AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.parse({
      kind,
      eligibleFirstCommit: false,
    }) as AutonomousPersonalCaptureBeginV4FalseResult,
  );
}

function fixedError(code: 'invalid_input' | 'conflict' | 'invalid_handle' | 'budget_exhausted') {
  const error = new Error(`Engram autonomous personal capture: ${code}`);
  registryFailures.set(error, code);
  return error;
}

function providerFixedError(code: ProviderFailureKindV4): Error {
  const error = new Error(`Engram autonomous personal provider: ${code}`);
  providerFailureErrors.set(error, code);
  return error;
}

/** Classify only errors minted by this private registry; external errors remain unknown. */
export function getAutonomousPersonalCaptureFailureKindV4(
  error: unknown,
): RegistryFailureKindV4 | null {
  if (!isObject(error)) return null;
  return registryFailures.get(error) ?? null;
}

/** Classify only closed registry failures or fixed Begin4 false outcomes. */
export function getAutonomousPersonalCaptureProviderFailureKindV4(
  error: unknown,
): ProviderFailureKindV4 | null {
  if (!isObject(error)) return null;
  const providerFailure = providerFailureErrors.get(error);
  if (providerFailure) return providerFailure;
  const oldFailure = registryFailures.get(error);
  if (oldFailure) return oldFailure;
  return null;
}

/** Only the fixed issuer can mark a budget failure after matching the actual committed rows. */
export function isAutonomousPersonalCaptureProvenCommitBudgetFailureV4(error: unknown): boolean {
  return isObject(error) && provenCommitBudgetFailures.has(error);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function recordFor(owner: object, attempt: unknown): AttemptRecord | undefined {
  if (!isObject(attempt)) return undefined;
  const record = attempts.get(attempt);
  if (!record || record.owner !== owner) return undefined;
  return record;
}

function disposeLifetime(lifetime: NativeCaptureLifetimeV4): void {
  if (lifetime.disposed) return;
  lifetime.cleaningUp = true;
  lifetime.disposed = true;
  if (lifetime.deadlineTimer) clearTimeout(lifetime.deadlineTimer);
  lifetime.deadlineTimer = undefined;
  if (lifetime.parentSignal && lifetime.removeParentListener) {
    lifetime.parentSignal.removeEventListener('abort', lifetime.parentAbort);
    lifetime.removeParentListener = false;
  }
  lifetime.controller.abort();
}

function armLifetimeDeadline(lifetime: NativeCaptureLifetimeV4): void {
  if (lifetime.deadlineTimer) clearTimeout(lifetime.deadlineTimer);
  const deadline = Math.min(
    lifetime.originalDeadlineAtMonotonicMs ?? Number.POSITIVE_INFINITY,
    lifetime.overallDeadlineAtMonotonicMs ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(deadline)) return;
  const remaining = Math.max(0, deadline - performance.now());
  lifetime.deadlineTimer = setTimeout(() => {
    lifetime.controller.abort();
    if (lifetime.parentSignal && lifetime.removeParentListener) {
      lifetime.parentSignal.removeEventListener('abort', lifetime.parentAbort);
      lifetime.removeParentListener = false;
    }
  }, remaining);
}

function checkLifetime(lifetime: NativeCaptureLifetimeV4): void {
  if (lifetime.disposed || lifetime.cleaningUp) throw providerFixedError('invalid_handle');
  if (lifetime.hostAborted) throw providerFixedError('cancelled');
  const deadline = Math.min(
    lifetime.originalDeadlineAtMonotonicMs ?? Number.POSITIVE_INFINITY,
    lifetime.overallDeadlineAtMonotonicMs ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(deadline)) {
    if (lifetime.originalDeadlineAtMonotonicMs === undefined) return;
    throw providerFixedError('budget_exhausted');
  }
  if (performance.now() >= deadline) {
    throw providerFixedError('budget_exhausted');
  }
  if (lifetime.controller.signal.aborted) throw providerFixedError('budget_exhausted');
}

function createNativeLifetimeV4(parentSignal: AbortSignal | undefined): NativeCaptureLifetimeV4 {
  const controller = new AbortController();
  const lifetime: NativeCaptureLifetimeV4 = {
    controller,
    parentSignal,
    hostAborted: parentSignal?.aborted === true,
    cleaningUp: false,
    disposed: false,
    removeParentListener: false,
    parentAbort: () => {
      lifetime.hostAborted = true;
      controller.abort();
    },
  };
  if (parentSignal && !lifetime.hostAborted) {
    parentSignal.addEventListener('abort', lifetime.parentAbort, { once: true });
    lifetime.removeParentListener = true;
  } else if (lifetime.hostAborted) {
    controller.abort();
  }
  return lifetime;
}

function setOriginalDeadlineV4(lifetime: NativeCaptureLifetimeV4, deadline: number): void {
  if (lifetime.hostAborted) throw providerFixedError('cancelled');
  if (!Number.isFinite(deadline) || deadline <= performance.now()) {
    throw providerFixedError('budget_exhausted');
  }
  lifetime.originalDeadlineAtMonotonicMs = deadline;
  lifetime.overallDeadlineAtMonotonicMs = deadline;
  armLifetimeDeadline(lifetime);
  checkLifetime(lifetime);
}

function clipOverallDeadlineV4(lifetime: NativeCaptureLifetimeV4, deadline: number): void {
  if (!Number.isFinite(deadline) || deadline < 0) throw providerFixedError('conflict');
  const original = lifetime.originalDeadlineAtMonotonicMs;
  if (original === undefined) throw providerFixedError('conflict');
  lifetime.overallDeadlineAtMonotonicMs = Math.min(
    lifetime.overallDeadlineAtMonotonicMs ?? original,
    original,
    deadline,
  );
  armLifetimeDeadline(lifetime);
  checkLifetime(lifetime);
}

function checkRecord(record: AttemptRecord): void {
  if (record.phase !== 'in_transaction' && record.phase !== 'acknowledgement_unknown') {
    throw fixedError('invalid_handle');
  }
  if (record.lifetime) checkLifetime(record.lifetime);
  if (performance.now() >= record.scope.deadlineAtMonotonicMs) {
    throw fixedError('budget_exhausted');
  }
}

function checkCallback(record: AttemptRecord): () => void {
  let failed = false;
  let failure: unknown;
  return () => {
    if (failed) throw failure;
    try {
      checkRecord(record);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  };
}

function hasLiveLeaseHandle(
  value: unknown,
): value is PrivateOneUseAutonomousPersonalCaptureLeaseHandleV4 {
  if (!isObject(value)) return false;
  const record = leaseHandles.get(value);
  return (
    record !== undefined &&
    !record.consumed &&
    !record.lifetime?.hostAborted &&
    !record.lifetime?.disposed &&
    performance.now() <
      Math.min(
        record.scope.deadlineAtMonotonicMs,
        record.lifetime?.overallDeadlineAtMonotonicMs ?? Number.POSITIVE_INFINITY,
      )
  );
}

function validateRuntimeLeaseHandle(
  value: unknown,
): value is PrivateOneUseAutonomousPersonalCaptureLeaseHandleV4 {
  if (!isObject(value)) return false;
  const record = leaseHandles.get(value);
  if (!record || record.consumed) return false;
  if (record.lifetime) checkLifetime(record.lifetime);
  if (performance.now() >= record.scope.deadlineAtMonotonicMs) {
    const error = fixedError('budget_exhausted');
    provenCommitBudgetFailures.add(error);
    throw error;
  }
  return true;
}

const falseResultSchema = AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.refine(
  (result): result is AutonomousPersonalCaptureBeginV4FalseResult => result.kind !== 'claimed',
);

function liveProviderStage(
  value: unknown,
): value is PrivateAutonomousPersonalCaptureProviderStageV4 {
  if (!isObject(value)) return false;
  const record = providerStages.get(value);
  if (!record || record.consumed) return false;
  try {
    checkLifetime(record.lifetime);
    return (
      record.owner !== null && performance.now() < record.lifetime.overallDeadlineAtMonotonicMs!
    );
  } catch {
    return false;
  }
}

const preparedProviderResultSchema = z
  .object({
    kind: z.literal('prepared'),
    stage: z.custom<PrivateAutonomousPersonalCaptureProviderStageV4>(liveProviderStage),
    eligibleFirstCommit: z.literal(false),
  })
  .strict();

const providerRuntimeResultSchema = z.union([
  preparedProviderResultSchema,
  AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema,
  falseResultSchema,
]);

export type AutonomousPersonalCaptureProviderV4Result = z.infer<typeof providerRuntimeResultSchema>;

/** Runtime result schema; stage recognition is closed over the private WeakMap. */
export function getAutonomousPersonalCaptureProviderV4ResultSchema() {
  return providerRuntimeResultSchema;
}

function cancelledProviderResultV4(): AutonomousPersonalCaptureProviderV4Result {
  return deepFreeze(
    AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema.parse({
      kind: 'cancelled',
      eligibleFirstCommit: false,
    }),
  );
}

function providerFalseResultV4(
  kind: Exclude<
    ProviderFailureKindV4,
    'cancelled' | 'committed_observed' | 'cancelled_observed' | 'failed' | 'interrupted'
  >,
): AutonomousPersonalCaptureProviderV4Result {
  return deepFreeze(fixedDecision(kind as Parameters<typeof fixedDecision>[0]));
}

const claimedRuntimeResultSchema = z
  .object({
    kind: z.literal('claimed'),
    purpose: z.literal('human_turn_memory'),
    sourceId: z.string().uuid(),
    operationId: z.string().uuid(),
    descriptorHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sourcePersistence: z.literal('persisted'),
    claimKind: z.literal('initial'),
    handle: z.custom<PrivateOneUseAutonomousPersonalCaptureLeaseHandleV4>(
      validateRuntimeLeaseHandle,
    ),
    eligibleFirstCommit: z.literal(false),
  })
  .strict()
  .superRefine((result, context) => {
    const lease = isObject(result.handle) ? leaseHandles.get(result.handle) : undefined;
    if (
      !lease ||
      result.sourceId !== lease.scope.sourceId ||
      result.operationId !== lease.scope.operationId ||
      result.descriptorHash !== lease.stagedFresh.fence.descriptorHash
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid initial lease result' });
    }
  });

const internalBeginResultSchema = z.union([claimedRuntimeResultSchema, falseResultSchema]);
export type AutonomousPersonalCaptureBeginV4InternalResult = z.infer<
  typeof internalBeginResultSchema
>;

/** Runtime result schema with a predicate closed over this module's private handle WeakMap. */
export function getAutonomousPersonalCaptureBeginV4InternalResultSchema() {
  return internalBeginResultSchema;
}

type NativeBeginRunV4 = {
  readonly result: AutonomousPersonalCaptureBeginV4InternalResult;
  readonly config?: Extract<AutonomousPersonalCaptureNativeConfigV4, { kind: 'ready' }>;
};

async function runNativeBeginPrimitiveV4(
  ctx: IExecuteFunctions,
  storageOwner: IGraphStorage,
  startedAtMonotonicMs: number,
  lifetime?: NativeCaptureLifetimeV4,
  allowMissingProviderKey = false,
): Promise<NativeBeginRunV4> {
  const resultSchema = getAutonomousPersonalCaptureBeginV4InternalResultSchema();
  const storageMethod = storageOwner.beginAndClaimAutonomousPersonalCaptureV4;
  if (typeof storageMethod !== 'function') {
    return { result: resultSchema.parse(fixedDecision('unsupported_mode')) };
  }

  let config: AutonomousPersonalCaptureNativeConfigV4;
  try {
    lifetime && checkLifetime(lifetime);
    config = allowMissingProviderKey
      ? await readNativeAutonomousPersonalCaptureProviderConfigV4(ctx)
      : await readNativeAutonomousPersonalCaptureConfigV4(ctx);
    lifetime && checkLifetime(lifetime);
  } catch (error) {
    if (lifetime) checkLifetime(lifetime);
    return { result: resultSchema.parse(fixedDecision('invalid_input')) };
  }
  if (config.kind !== 'ready') {
    return { result: resultSchema.parse(fixedDecision(config.kind)) };
  }

  const deadlineAtMonotonicMs = startedAtMonotonicMs + config.request.settings.invocationDeadlineMs;
  try {
    lifetime && setOriginalDeadlineV4(lifetime, deadlineAtMonotonicMs);
  } catch (error) {
    const failure = getAutonomousPersonalCaptureProviderFailureKindV4(error);
    if (failure === 'cancelled') throw error;
    return { result: resultSchema.parse(fixedDecision('budget_exhausted')) };
  }
  if (performance.now() >= deadlineAtMonotonicMs) {
    return { result: resultSchema.parse(fixedDecision('budget_exhausted')) };
  }

  let attempt: PrivateAutonomousPersonalCaptureAttemptV4;
  try {
    attempt = mintAttemptV4(storageOwner, config, startedAtMonotonicMs, lifetime);
  } catch {
    return { result: resultSchema.parse(fixedDecision('invalid_input')) };
  }
  if (performance.now() >= deadlineAtMonotonicMs) {
    closeAutonomousPersonalCaptureAttemptV4(storageOwner, attempt);
    return { result: resultSchema.parse(fixedDecision('budget_exhausted')) };
  }

  try {
    const value = await storageMethod.call(
      storageOwner,
      { mode: 'existingStore', request: config.request },
      attempt,
    );
    lifetime && checkLifetime(lifetime);
    return { result: resultSchema.parse(value), config };
  } catch (error) {
    if (lifetime) checkLifetime(lifetime);
    const failureKind = getAutonomousPersonalCaptureFailureKindV4(error);
    if (failureKind) return { result: resultSchema.parse(fixedDecision(failureKind)), config };
    const providerFailure = getAutonomousPersonalCaptureProviderFailureKindV4(error);
    if (providerFailure === 'cancelled') throw error;
    if (providerFailure === 'budget_exhausted') {
      return { result: resultSchema.parse(fixedDecision('budget_exhausted')), config };
    }
    return { result: resultSchema.parse(fixedDecision('storage_error')), config };
  } finally {
    closeAutonomousPersonalCaptureAttemptV4(storageOwner, attempt);
  }
}

function mintAttemptV4(
  owner: object,
  config: Extract<AutonomousPersonalCaptureNativeConfigV4, { kind: 'ready' }>,
  startedAtMonotonicMs: number,
  lifetime?: NativeCaptureLifetimeV4,
): PrivateAutonomousPersonalCaptureAttemptV4 {
  if (!Number.isFinite(startedAtMonotonicMs) || startedAtMonotonicMs < 0) {
    throw fixedError('invalid_input');
  }
  const startData: AutonomousPersonalCaptureAttemptStartV4 =
    AutonomousPersonalCaptureAttemptStartV4OwnedDataSchema.parse({
      request: config.request,
      nativeContext: config.nativeContext,
    });
  const descriptor = compileAutonomousPersonalDescriptorV4(startData.request.settings);
  const deadlineAtMonotonicMs = startedAtMonotonicMs + descriptor.invocationDeadlineMs;
  const scope = deepFreeze(
    AutonomousPersonalCaptureAttemptScopeV4OwnedDataSchema.parse({
      ...startData,
      descriptor,
      sourceId: generateUuid(),
      operationId: generateUuid(),
      leaseToken: generateUuid(),
      invocationNonce: generateUuid(),
      startedAtMonotonicMs,
      deadlineAtMonotonicMs,
    }),
  );
  const key = Object.freeze({}) as PrivateAutonomousPersonalCaptureAttemptV4;
  attempts.set(key, {
    owner,
    scope,
    lifetime,
    phase: 'issued',
    readbackStarted: false,
  });
  return key;
}

/**
 * Fixed real-context entry point. It is the only attempt-key mint path and
 * accepts no request/context/callback/hash or capability from a generic caller.
 */
export async function dispatchNativeAutonomousPersonalCaptureV4(
  ctx: IExecuteFunctions,
  storageOwner: IGraphStorage,
): Promise<AutonomousPersonalCaptureBeginV4InternalResult> {
  const startedAtMonotonicMs = performance.now();
  return (await runNativeBeginPrimitiveV4(ctx, storageOwner, startedAtMonotonicMs)).result;
}

function readNativeExecutionCancelSignalV4(ctx: IExecuteFunctions): AbortSignal | undefined {
  const getter = ctx.getExecutionCancelSignal;
  if (typeof getter !== 'function') return undefined;
  const signal = getter.call(ctx);
  if (signal === undefined) return undefined;
  const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  if (!abortedGetter) throw providerFixedError('invalid_input');
  try {
    abortedGetter.call(signal);
  } catch {
    throw providerFixedError('invalid_input');
  }
  return signal;
}

function cancellationResultIfNeededV4(
  lifetime: NativeCaptureLifetimeV4,
): AutonomousPersonalCaptureProviderV4Result | undefined {
  try {
    checkLifetime(lifetime);
    return undefined;
  } catch (error) {
    const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
    if (kind === 'cancelled') return cancelledProviderResultV4();
    if (kind === 'budget_exhausted') return providerFalseResultV4('budget_exhausted');
    return providerFalseResultV4('invalid_handle');
  }
}

function providerDeferredReasonV4(
  error: unknown,
): Extract<ProviderStageOutcomeV4, { kind: 'deferred' }>['reason'] | null {
  if (error instanceof AutonomousPersonalProviderPromptFailureV1) {
    return error.reason === 'request_bytes' ? 'provider_request_bytes' : null;
  }
  if (error instanceof ExtractionBudgetError) {
    switch (error.budgetReason) {
      case 'request_bytes':
        return 'provider_request_bytes';
      case 'response_bytes':
        return 'provider_response_bytes';
      case 'deadline':
      case 'request_count':
        return 'provider_subdeadline';
      case 'cancelled':
        return null;
      default:
        return null;
    }
  }
  if (error instanceof ExtractionError) {
    switch (error.kind) {
      case 'unsupported_parameter':
      case 'invalid_request':
        return 'provider_invalid_request';
      case 'authentication':
        return 'provider_auth';
      case 'rate_limit':
        return 'provider_rate_limit';
      case 'provider_server':
        return 'provider_unavailable';
      case 'network':
        return 'provider_network';
      case 'invalid_response':
        return 'provider_invalid_response';
      case 'timeout':
        return 'provider_subdeadline';
      default:
        return null;
    }
  }
  return null;
}

async function abortableDelayV4(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ExtractionBudgetError('cancelled');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new ExtractionBudgetError('cancelled'));
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fixed native A1 coordinator. This shares the same initial begin primitive as
 * the begin-only adapter and never writes claims or returns Proceed.
 */
export async function prepareNativeAutonomousPersonalCaptureProviderV4(
  ctx: IExecuteFunctions,
  storageOwner: IGraphStorage,
): Promise<AutonomousPersonalCaptureProviderV4Result> {
  const startedAtMonotonicMs = performance.now();
  let lifetime: NativeCaptureLifetimeV4 | undefined;
  let transferred = false;
  try {
    let parentSignal: AbortSignal | undefined;
    try {
      parentSignal = readNativeExecutionCancelSignalV4(ctx);
    } catch (error) {
      if (error instanceof Error) return providerFalseResultV4('invalid_input');
      return providerFalseResultV4('invalid_input');
    }
    lifetime = createNativeLifetimeV4(parentSignal);
    if (lifetime.hostAborted) return cancelledProviderResultV4();

    const begin = await runNativeBeginPrimitiveV4(
      ctx,
      storageOwner,
      startedAtMonotonicMs,
      lifetime,
      true,
    );
    if (begin.result.kind !== 'claimed') {
      return providerRuntimeResultSchema.parse(begin.result);
    }
    const handle = begin.result.handle;
    const live = cancellationResultIfNeededV4(lifetime);
    if (live) return live;

    let expectedProviderReference;
    try {
      expectedProviderReference = getAutonomousPersonalCaptureProviderReferenceForLeaseV4(
        storageOwner,
        handle,
      );
    } catch (error) {
      const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
      if (kind === 'cancelled') return cancelledProviderResultV4();
      return providerFalseResultV4(
        kind === 'budget_exhausted' ? 'budget_exhausted' : 'invalid_handle',
      );
    }

    // This closed native reread happens before backend preflight; no async
    // credential/config lookup occurs after the backend proves current state.
    let runtimeProvider: AutonomousPersonalCaptureRuntimeProviderV4;
    try {
      runtimeProvider = await readNativeAutonomousPersonalCaptureRuntimeProviderV4(
        ctx,
        expectedProviderReference,
      );
    } catch {
      const stopped = cancellationResultIfNeededV4(lifetime);
      return stopped ?? providerFalseResultV4('authority_changed');
    }
    const afterConfig = cancellationResultIfNeededV4(lifetime);
    if (afterConfig) return afterConfig;
    if (runtimeProvider.kind !== 'ready') {
      return providerFalseResultV4('invalid_input');
    }
    if (!runtimeProvider.routeMatches) {
      return providerFalseResultV4('authority_changed');
    }

    const preflightMethod = storageOwner.prepareAutonomousPersonalCaptureProviderV4;
    if (typeof preflightMethod !== 'function') return providerFalseResultV4('unsupported_mode');
    let preflightValue: unknown;
    try {
      preflightValue = await preflightMethod.call(storageOwner, handle);
    } catch (error) {
      const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
      if (kind === 'cancelled') return cancelledProviderResultV4();
      if (kind) {
        return providerFalseResultV4(
          kind as Exclude<
            ProviderFailureKindV4,
            'cancelled' | 'committed_observed' | 'cancelled_observed' | 'failed' | 'interrupted'
          >,
        );
      }
      const stopped = cancellationResultIfNeededV4(lifetime);
      return stopped ?? providerFalseResultV4('storage_error');
    }
    const afterRead = cancellationResultIfNeededV4(lifetime);
    if (afterRead) return afterRead;
    let preflight: AutonomousPersonalCaptureProviderPreflightV4;
    try {
      preflight = AutonomousPersonalCaptureProviderPreflightV4Schema.parse(preflightValue);
    } catch {
      return providerFalseResultV4('conflict');
    }
    if (preflight.kind !== 'ready') return providerRuntimeResultSchema.parse(preflight);

    let overallDeadline: number;
    try {
      overallDeadline = getAutonomousPersonalCaptureProviderOverallDeadlineV4(storageOwner, handle);
    } catch (error) {
      const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
      if (kind === 'cancelled') return cancelledProviderResultV4();
      return providerFalseResultV4(
        kind === 'budget_exhausted' ? 'budget_exhausted' : 'invalid_handle',
      );
    }
    const afterBind = cancellationResultIfNeededV4(lifetime);
    if (afterBind) return afterBind;

    const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
      absoluteMonotonicDeadlineMs: overallDeadline,
      signal: lifetime.controller.signal,
    });
    let promptPreparation;
    try {
      promptPreparation = prepareAutonomousPersonalProviderPromptV1(
        { source: preflight.source, descriptor: preflight.descriptor },
        runtimeProvider.model ?? '',
        work,
      );
    } catch (error) {
      const stopped = cancellationResultIfNeededV4(lifetime);
      if (stopped) return stopped;
      if (error instanceof AutonomousPersonalProviderPromptFailureV1) {
        if (error.reason === 'request_bytes') {
          const stage = sealAutonomousPersonalCaptureProviderStageV4(
            storageOwner,
            handle,
            preflight,
            { kind: 'deferred', reason: 'provider_request_bytes' },
          );
          const prepared = providerRuntimeResultSchema.parse({
            kind: 'prepared',
            stage,
            eligibleFirstCommit: false,
          });
          transferred = true;
          return prepared;
        }
        return providerFalseResultV4('conflict');
      }
      if (error instanceof AutonomousPersonalEvidenceSelectionFailureV1) {
        if (
          error.code === 'cancelled_autonomous_evidence_selection' ||
          error.code === 'deadline_autonomous_evidence_selection'
        ) {
          return providerFalseResultV4('budget_exhausted');
        }
        return providerFalseResultV4('conflict');
      }
      return providerFalseResultV4('conflict');
    }
    const afterPrompt = cancellationResultIfNeededV4(lifetime);
    if (afterPrompt) return afterPrompt;
    if (promptPreparation.kind === 'no_dispatch') {
      const stage = sealAutonomousPersonalCaptureProviderStageV4(storageOwner, handle, preflight, {
        kind: 'no_dispatch',
        reason: promptPreparation.reason,
      });
      const prepared = providerRuntimeResultSchema.parse({
        kind: 'prepared',
        stage,
        eligibleFirstCommit: false,
      });
      transferred = true;
      return prepared;
    }

    if (!runtimeProvider.apiKey || !runtimeProvider.baseUrl || !runtimeProvider.model) {
      const stage = sealAutonomousPersonalCaptureProviderStageV4(storageOwner, handle, preflight, {
        kind: 'deferred',
        reason: 'provider_auth',
      });
      const prepared = providerRuntimeResultSchema.parse({
        kind: 'prepared',
        stage,
        eligibleFirstCommit: false,
      });
      transferred = true;
      return prepared;
    }

    const now = performance.now();
    const providerSubdeadline = overallDeadline - preflight.descriptor.finalizationReserveMs;
    const remaining = providerSubdeadline - now;
    if (remaining <= 0) {
      const stage = sealAutonomousPersonalCaptureProviderStageV4(storageOwner, handle, preflight, {
        kind: 'deferred',
        reason: 'provider_subdeadline',
      });
      const prepared = providerRuntimeResultSchema.parse({
        kind: 'prepared',
        stage,
        eligibleFirstCommit: false,
      });
      transferred = true;
      return prepared;
    }

    const requestTimeoutMs = Math.max(
      1,
      Math.min(30_000, preflight.descriptor.provider.effectiveTimeoutMs, Math.floor(remaining)),
    );
    const maxCalls = Math.min(preflight.descriptor.provider.effectiveRequestLimit, 2);
    const budget = new RequestBudget(
      maxCalls,
      requestTimeoutMs,
      preflight.descriptor.provider.effectiveRequestBytes,
      preflight.descriptor.provider.effectiveResponseBytes,
      lifetime.controller.signal,
      providerSubdeadline,
    );
    let providerResponse: AutonomousPersonalProviderResponseV1 | undefined;
    let deferredReason:
      | 'provider_invalid_request'
      | 'provider_auth'
      | 'provider_rate_limit'
      | 'provider_unavailable'
      | 'provider_network'
      | 'provider_invalid_response'
      | 'provider_subdeadline'
      | 'provider_request_bytes'
      | 'provider_response_bytes'
      | 'interpretation_capacity'
      | undefined;
    try {
      const client = new LlmClient(
        {
          apiKey: runtimeProvider.apiKey,
          baseUrl: runtimeProvider.baseUrl,
          model: runtimeProvider.model,
          timeoutMs: requestTimeoutMs,
          temperature: preflight.descriptor.provider.temperature,
        },
        undefined,
        'entities',
        budget,
      );
      const messages = [...promptPreparation.prompt.messages];
      if (
        promptPreparation.prompt.expectedRequestBytes >
        preflight.descriptor.provider.effectiveRequestBytes
      ) {
        throw new ExtractionBudgetError('request_bytes');
      }

      let rawResponse: unknown;
      let lastError: unknown;
      for (let call = 0; call < maxCalls; call += 1) {
        lifetime && checkLifetime(lifetime);
        try {
          rawResponse = await client.chatJson<unknown>(messages, {
            requireJsonInstruction: true,
          });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          const retryable =
            error instanceof ExtractionError &&
            (error.kind === 'network' ||
              error.kind === 'rate_limit' ||
              error.kind === 'provider_server');
          const canRetry =
            retryable &&
            call === 0 &&
            maxCalls >= 2 &&
            performance.now() + 100 < providerSubdeadline;
          if (!canRetry) break;
          await abortableDelayV4(100, lifetime.controller.signal);
          lifetime && checkLifetime(lifetime);
        }
      }
      if (lastError !== undefined) {
        try {
          lifetime && checkLifetime(lifetime);
        } catch (error) {
          const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
          if (kind === 'cancelled') throw error;
          if (kind === 'budget_exhausted') throw error;
        }
        deferredReason = providerDeferredReasonV4(lastError) ?? 'provider_invalid_response';
      } else {
        try {
          const ownedResponse = AutonomousPersonalProviderResponseV1Schema.parse(rawResponse);
          providerResponse = validateAutonomousPersonalProviderResponseV1({
            response: ownedResponse,
            unitIds: promptPreparation.prompt.unitIds,
          });
        } catch {
          deferredReason = 'provider_invalid_response';
        }
      }
    } catch (error) {
      try {
        checkLifetime(lifetime);
      } catch (lifetimeError) {
        const kind = getAutonomousPersonalCaptureProviderFailureKindV4(lifetimeError);
        if (kind === 'cancelled' || kind === 'budget_exhausted') throw lifetimeError;
      }
      deferredReason = providerDeferredReasonV4(error) ?? 'provider_invalid_response';
    } finally {
      budget.dispose();
    }

    const afterProvider = cancellationResultIfNeededV4(lifetime);
    if (afterProvider) return afterProvider;
    if (deferredReason) {
      const stage = sealAutonomousPersonalCaptureProviderStageV4(storageOwner, handle, preflight, {
        kind: 'deferred',
        reason: deferredReason,
      });
      const prepared = providerRuntimeResultSchema.parse({
        kind: 'prepared',
        stage,
        eligibleFirstCommit: false,
      });
      transferred = true;
      return prepared;
    }
    if (!providerResponse) {
      const stage = sealAutonomousPersonalCaptureProviderStageV4(storageOwner, handle, preflight, {
        kind: 'deferred',
        reason: 'provider_invalid_response',
      });
      const prepared = providerRuntimeResultSchema.parse({
        kind: 'prepared',
        stage,
        eligibleFirstCommit: false,
      });
      transferred = true;
      return prepared;
    }

    let selection;
    try {
      selection = compileAutonomousPersonalEvidenceSelectionV1(
        { source: preflight.source, descriptor: preflight.descriptor },
        providerResponse,
        work,
      );
    } catch (error) {
      const stopped = cancellationResultIfNeededV4(lifetime);
      if (stopped) return stopped;
      if (error instanceof AutonomousPersonalEvidenceSelectionFailureV1) {
        if (error.code === 'deadline_autonomous_evidence_selection') {
          return providerFalseResultV4('budget_exhausted');
        }
        if (error.code === 'cancelled_autonomous_evidence_selection') {
          return cancelledProviderResultV4();
        }
        if (error.code === 'invalid_autonomous_evidence_provider_data') {
          const stage = sealAutonomousPersonalCaptureProviderStageV4(
            storageOwner,
            handle,
            preflight,
            { kind: 'deferred', reason: 'provider_invalid_response' },
          );
          const prepared = providerRuntimeResultSchema.parse({
            kind: 'prepared',
            stage,
            eligibleFirstCommit: false,
          });
          transferred = true;
          return prepared;
        }
      }
      return providerFalseResultV4('conflict');
    }
    const afterSelection = cancellationResultIfNeededV4(lifetime);
    if (afterSelection) return afterSelection;
    if (selection.status === 'not_interpreted') return providerFalseResultV4('conflict');
    if (selection.status === 'capacity') {
      const stage = sealAutonomousPersonalCaptureProviderStageV4(storageOwner, handle, preflight, {
        kind: 'deferred',
        reason: 'interpretation_capacity',
      });
      const prepared = providerRuntimeResultSchema.parse({
        kind: 'prepared',
        stage,
        eligibleFirstCommit: false,
      });
      transferred = true;
      return prepared;
    }

    const stage = sealAutonomousPersonalCaptureProviderStageV4(
      storageOwner,
      handle,
      preflight,
      {
        kind: 'response',
        response: providerResponse,
      },
      selection,
    );
    const prepared = providerRuntimeResultSchema.parse({
      kind: 'prepared',
      stage,
      eligibleFirstCommit: false,
    });
    transferred = true;
    return prepared;
  } catch (error) {
    if (lifetime) {
      const stopped = cancellationResultIfNeededV4(lifetime);
      if (stopped) return stopped;
    }
    const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
    if (kind === 'cancelled') return cancelledProviderResultV4();
    if (kind === 'budget_exhausted') return providerFalseResultV4('budget_exhausted');
    if (kind === 'invalid_handle') return providerFalseResultV4('invalid_handle');
    if (kind === 'conflict') return providerFalseResultV4('conflict');
    if (kind === 'authority_changed') return providerFalseResultV4('authority_changed');
    if (kind === 'invalid_input') return providerFalseResultV4('invalid_input');
    if (kind === 'resource_exhausted') return providerFalseResultV4('resource_exhausted');
    if (error instanceof AutonomousPersonalEvidenceSelectionFailureV1) {
      if (error.code === 'cancelled_autonomous_evidence_selection')
        return cancelledProviderResultV4();
      if (error.code === 'deadline_autonomous_evidence_selection')
        return providerFalseResultV4('budget_exhausted');
    }
    return providerFalseResultV4('storage_error');
  } finally {
    if (!transferred && lifetime) disposeLifetime(lifetime);
  }
}

/** Backend-only raw admission; owns input before direct opaque-key lookup. */
export function consumeAutonomousPersonalCaptureAttemptV4(
  storageOwner: object,
  input: unknown,
  attempt: unknown,
): AutonomousPersonalCaptureBackendAttemptV4 {
  const parsed = parseAutonomousPersonalBeginV4Input(input);
  if (parsed.kind === 'unsupported_mode') {
    return { kind: 'decision', result: fixedDecision('unsupported_mode') };
  }
  if (parsed.kind !== 'ready') {
    return { kind: 'decision', result: fixedDecision('invalid_input') };
  }
  const record = recordFor(storageOwner, attempt);
  if (!record || record.phase !== 'issued') {
    return { kind: 'decision', result: fixedDecision('invalid_handle') };
  }
  record.phase = 'in_transaction';
  if (canonical(parsed.request) !== canonical(record.scope.request)) {
    record.phase = 'closed';
    return { kind: 'decision', result: fixedDecision('conflict') };
  }
  try {
    checkRecord(record);
  } catch (error) {
    record.phase = 'closed';
    const failureKind = getAutonomousPersonalCaptureFailureKindV4(error);
    return {
      kind: 'decision',
      result: fixedDecision(
        failureKind === 'budget_exhausted' ? 'budget_exhausted' : 'invalid_handle',
      ),
    };
  }
  return {
    kind: 'ready',
    scope: record.scope,
    check: checkCallback(record),
  };
}

/** Bind the actual preflight store and binding to this one native attempt. */
export function bindAutonomousPersonalCapturePreflightV4(
  storageOwner: object,
  attempt: unknown,
  preflightValue: unknown,
): AutonomousPersonalCaptureBoundBackendAttemptV4 {
  const record = recordFor(storageOwner, attempt);
  if (!record || record.phase !== 'in_transaction' || record.bound) {
    throw fixedError('conflict');
  }
  checkRecord(record);
  let boundValue: AutonomousPersonalCaptureBoundScopeV4 | undefined;
  try {
    const preflight = AutonomousPersonalCapturePreflightV4OwnedDataSchema.parse(preflightValue);
    const { request, nativeContext } = record.scope;
    const context = {
      storeHash: preflight.storeHash,
      namespace: request.namespace,
      issuer: request.issuer,
      actorReference: request.actorReference,
      turn: request.turn,
      binding: preflight.binding,
      instance: nativeContext.instance,
      workflow: nativeContext.workflow,
      execution: nativeContext.execution,
    };
    const stableBeginHash = hashAutonomousPersonalStableRequestV4({ request, context });
    const attemptHash = hashAutonomousPersonalAttemptV4(context);
    boundValue = deepFreeze(
      AutonomousPersonalCaptureBoundScopeV4OwnedDataSchema.parse({
        request,
        context,
        descriptor: record.scope.descriptor,
        sourceId: record.scope.sourceId,
        operationId: record.scope.operationId,
        leaseToken: record.scope.leaseToken,
        invocationNonce: record.scope.invocationNonce,
        stableBeginHash,
        attemptHash,
        startedAtMonotonicMs: record.scope.startedAtMonotonicMs,
        deadlineAtMonotonicMs: record.scope.deadlineAtMonotonicMs,
      }),
    );
  } catch {
    throw fixedError('invalid_input');
  }
  record.bound = boundValue;
  const bound = record.bound;
  if (!bound) throw fixedError('invalid_input');
  return { ...bound, check: checkCallback(record) };
}

/** Sticky per-attempt deadline check used around reads, writes, retries and recovery. */
export function checkAutonomousPersonalCaptureAttemptV4(
  storageOwner: object,
  attempt: unknown,
): void {
  const record = recordFor(storageOwner, attempt);
  if (!record) throw fixedError('invalid_handle');
  checkRecord(record);
}

/** Stage the initial candidate only from the fixed backend's in-writer fresh branch. */
export function stageFreshAutonomousPersonalCaptureV4(
  storageOwner: object,
  attempt: unknown,
  candidateValue: unknown,
): void {
  const record = recordFor(storageOwner, attempt);
  if (!record || record.phase !== 'in_transaction' || !record.bound || record.readbackStarted) {
    throw fixedError('invalid_handle');
  }
  try {
    checkRecord(record);
    const candidateOwned = cloneBoundedAutomaticCaptureJson<unknown>(
      candidateValue,
      'beginRequest',
    );
    const candidate = AutonomousPersonalCaptureStagedFreshV4OwnedDataSchema.parse(candidateOwned);
    const fresh = compileAutonomousPersonalFreshSourceV4({
      request: record.bound.request,
      context: record.bound.context,
      sourceId: record.bound.sourceId,
      previousEpisodeUuid: candidate.episode.previous_episode_uuid,
      createdAt: candidate.episode.created_at,
    });
    const expectedEpisode = {
      uuid: fresh.producer.uuid,
      group_id: fresh.producer.group_id,
      content: fresh.producer.content,
      role: fresh.producer.role,
      source_type: fresh.producer.source_type,
      reference_time: fresh.producer.reference_time,
      previous_episode_uuid: fresh.producer.previous_episode_uuid,
      created_at: fresh.producer.created_at,
      updated_at: null,
      source_message_id: fresh.producer.source_message_id,
      idempotency_key: fresh.producer.idempotency_key,
      conversation_id: fresh.producer.conversation_id,
      sender_id: fresh.producer.sender_id,
      sender_name: null,
      episode_kind: fresh.producer.episode_kind,
      quoted_message_id: fresh.producer.quoted_message_id,
      trust_level: fresh.descriptor.requestedTrustLevel,
      confidence: null,
      review_status: 'accepted',
      source_workflow_id: fresh.producer.source_workflow_id,
      source_execution_id: fresh.producer.source_execution_id,
      attributes: {
        [AUTONOMOUS_CAPTURE_V4_OWNER_ATTRIBUTE]: fresh.tuple.owner,
        [AUTONOMOUS_CAPTURE_V3_ENVELOPE_ATTRIBUTE]: fresh.tuple.envelope,
      },
    };
    if (
      candidate.kind !== 'initial_candidate' ||
      canonical(candidate.episode) !== canonical(expectedEpisode) ||
      candidate.episode.uuid !== record.bound.sourceId ||
      candidate.operation.operationId !== record.bound.operationId ||
      candidate.operation.createdAt !== candidate.episode.created_at ||
      candidate.operation.lastObservedAt !== candidate.operation.createdAt ||
      candidate.operation.attempts.length !== 1 ||
      candidate.operation.identity.sourceId !== record.bound.sourceId ||
      candidate.operation.identity.namespace !== record.bound.context.namespace ||
      candidate.operation.identity.storeHash !== record.bound.context.storeHash ||
      candidate.operation.identity.issuer !== record.bound.context.issuer ||
      candidate.operation.identity.actorReference !== record.bound.context.actorReference ||
      candidate.operation.identity.turn !== record.bound.context.turn ||
      candidate.operation.identity.binding.bindingId !== record.bound.context.binding.bindingId ||
      candidate.operation.identity.binding.revision !== record.bound.context.binding.revision ||
      candidate.operation.identity.binding.subjectId !== record.bound.context.binding.subjectId ||
      candidate.operation.identity.binding.fingerprint !==
        record.bound.context.binding.fingerprint ||
      candidate.operation.identity.descriptorHash !==
        hashAutonomousPersonalDescriptorV4(record.bound.descriptor) ||
      canonical(candidate.operation.descriptor) !== canonical(record.bound.descriptor) ||
      canonical(candidate.operation.identity) !== canonical(fresh.tuple.identity) ||
      candidate.operation.descriptor.settingsHash !== record.bound.descriptor.settingsHash ||
      candidate.operation.beginCallHash !== record.bound.stableBeginHash ||
      candidate.operation.state !== 'leased' ||
      !('lease' in candidate.operation) ||
      candidate.operation.lease.token !== record.bound.leaseToken ||
      candidate.operation.lease.claimKind !== 'initial' ||
      candidate.operation.lease.acquiredAt !== candidate.operation.createdAt ||
      candidate.operation.lease.renewedAt !== candidate.operation.createdAt ||
      candidate.operation.generation !== 1 ||
      candidate.operation.retryCount !== 0 ||
      candidate.operation.attempts[0]?.attemptHash !== record.bound.attemptHash ||
      candidate.operation.attempts[0]?.disposition !== 'claim_won' ||
      candidate.operation.attempts[0]?.at !== candidate.operation.createdAt ||
      candidate.fence.operationId !== record.bound.operationId ||
      candidate.fence.sourceId !== record.bound.sourceId ||
      candidate.fence.token !== record.bound.leaseToken ||
      candidate.fence.beginCallHash !== record.bound.stableBeginHash ||
      candidate.fence.sourceHash !== fresh.tuple.identity.sourceHash ||
      candidate.fence.envelopeHash !== hashAutomaticCaptureV2(fresh.tuple.envelope) ||
      candidate.fence.descriptorHash !== candidate.operation.identity.descriptorHash ||
      candidate.fence.identityHash !== hashAutomaticCaptureV2(candidate.operation.identity) ||
      candidate.fence.planTimestamp !== candidate.operation.createdAt
    ) {
      throw fixedError('conflict');
    }
    record.stagedFresh = deepFreeze(candidate);
  } catch (error) {
    if (getAutonomousPersonalCaptureFailureKindV4(error) === 'budget_exhausted') throw error;
    throw fixedError('conflict');
  }
}

/** Begin the single readback after the fixed writer reports its outcome. */
export function beginAutonomousPersonalCaptureReadbackV4(
  storageOwner: object,
  attempt: unknown,
  acknowledgment: 'acknowledged' | 'unknown',
): void {
  const record = recordFor(storageOwner, attempt);
  if (
    !record ||
    !record.stagedFresh ||
    !record.bound ||
    record.readbackStarted ||
    (record.phase !== 'in_transaction' && record.phase !== 'acknowledgement_unknown')
  ) {
    throw fixedError('conflict');
  }
  checkRecord(record);
  record.readbackStarted = true;
  record.readbackKind = acknowledgment;
  if (acknowledgment === 'unknown') record.phase = 'acknowledgement_unknown';
}

/**
 * Issue the separate initial lease key only when the backend supplies the
 * compiler's exact actual same-scope readback result for this staged writer.
 */
export function issueInitialAutonomousPersonalCaptureHandleV4(
  storageOwner: object,
  attempt: unknown,
  actualValue: unknown,
): PrivateOneUseAutonomousPersonalCaptureLeaseHandleV4 | null {
  const record = recordFor(storageOwner, attempt);
  if (
    !record ||
    !record.bound ||
    !record.stagedFresh ||
    !record.readbackStarted ||
    (record.phase !== 'in_transaction' && record.phase !== 'acknowledgement_unknown')
  ) {
    return null;
  }
  let exactReadbackMatched = false;
  try {
    checkRecord(record);
    const actualOwned = cloneBoundedAutomaticCaptureJson<unknown>(actualValue, 'beginRequest');
    const actual = AutonomousPersonalCaptureSnapshotPreparationV4OwnedDataSchema.parse(actualOwned);
    if (actual.kind !== 'same_initial_scope_candidate') return null;
    const sameScopeActual = actual as AutonomousPersonalCaptureSameInitialScopeV4;
    const staged = record.stagedFresh;
    if (
      canonical(sameScopeActual.episode) !== canonical(staged.episode) ||
      canonical(sameScopeActual.fence) !== canonical(staged.fence) ||
      !matchesStagedOperation(sameScopeActual.operation, staged.operation)
    ) {
      return null;
    }
    exactReadbackMatched = true;
    checkRecord(record);
    const handle = Object.freeze({}) as PrivateOneUseAutonomousPersonalCaptureLeaseHandleV4;
    leaseHandles.set(handle, {
      owner: storageOwner,
      scope: record.bound,
      stagedFresh: record.stagedFresh,
      lifetime: record.lifetime,
      consumed: false,
    });
    record.phase = 'claimed';
    return handle;
  } catch (error) {
    if (getAutonomousPersonalCaptureFailureKindV4(error) === 'budget_exhausted') {
      if (exactReadbackMatched && isObject(error)) provenCommitBudgetFailures.add(error);
      throw error;
    }
    return null;
  }
}

function matchesStagedOperation(
  actual: AutonomousPersonalOperationV4,
  staged: AutonomousPersonalOperationV4,
): boolean {
  if (
    actual.operationId !== staged.operationId ||
    actual.version !== staged.version ||
    actual.state !== 'leased' ||
    actual.createdAt !== staged.createdAt ||
    actual.beginCallHash !== staged.beginCallHash ||
    actual.generation !== 1 ||
    actual.retryCount !== 0 ||
    actual.overflowCount !== staged.overflowCount ||
    typeof actual.auditTruncated !== 'boolean' ||
    actual.descriptor.settingsHash !== staged.descriptor.settingsHash ||
    canonical(actual.identity) !== canonical(staged.identity) ||
    canonical(actual.descriptor) !== canonical(staged.descriptor) ||
    !('lease' in actual) ||
    !('lease' in staged) ||
    canonical(actual.lease) !== canonical(staged.lease) ||
    canonical(actual.attempts[0]) !== canonical(staged.attempts[0]) ||
    actual.attempts.filter((entry) => entry.disposition === 'claim_won').length !== 1
  ) {
    return false;
  }
  return true;
}

/** Close only this attempt; a returned lease handle has an independent WeakMap entry. */
export function closeAutonomousPersonalCaptureAttemptV4(
  storageOwner: object,
  attempt: unknown,
): void {
  const record = recordFor(storageOwner, attempt);
  if (record) record.phase = 'closed';
}

function providerPreflightRecordForV4(
  storageOwner: object,
  access: unknown,
): ProviderPreflightRecordV4 | undefined {
  if (!isObject(access)) return undefined;
  const record = providerPreflightAccesses.get(access);
  if (!record || record.owner !== storageOwner || record.closed) return undefined;
  return record;
}

function providerPreflightCheckV4(record: ProviderPreflightRecordV4): () => void {
  let firstFailure: unknown;
  return () => {
    if (firstFailure) throw firstFailure;
    try {
      checkLifetime(record.lifetime);
      if (record.lease.owner !== record.owner || !record.lease.consumed) {
        throw providerFixedError('invalid_handle');
      }
    } catch (error) {
      firstFailure = error;
      throw firstFailure;
    }
  };
}

/** Non-consuming native guard used before the asynchronous credential reread. */
export function getAutonomousPersonalCaptureProviderReferenceForLeaseV4(
  storageOwner: object,
  initialHandle: unknown,
) {
  if (!isObject(initialHandle)) throw providerFixedError('invalid_handle');
  const lease = leaseHandles.get(initialHandle);
  if (!lease || lease.owner !== storageOwner || lease.consumed || !lease.lifetime) {
    throw providerFixedError('invalid_handle');
  }
  checkLifetime(lease.lifetime);
  return lease.scope.descriptor.provider;
}

/**
 * Backend first action: reserve the exact initial lease handle for one actual
 * provider preflight read. This creates no public/data authority.
 */
export function consumeAutonomousPersonalCaptureProviderPreflightV4(
  storageOwner: object,
  initialHandle: unknown,
): PrivateAutonomousPersonalCaptureProviderPreflightAccessV4 {
  if (!isObject(initialHandle)) throw providerFixedError('invalid_handle');
  const lease = leaseHandles.get(initialHandle);
  if (!lease || lease.owner !== storageOwner || lease.consumed || !lease.lifetime) {
    throw providerFixedError('invalid_handle');
  }
  checkLifetime(lease.lifetime);
  lease.consumed = true;
  const access = Object.freeze({}) as PrivateAutonomousPersonalCaptureProviderPreflightAccessV4;
  providerPreflightAccesses.set(access, {
    owner: storageOwner,
    handle: initialHandle,
    lease,
    lifetime: lease.lifetime,
    closed: false,
  });
  return access;
}

/** Backend-only accessor for the consumed key's immutable scope and sticky work check. */
export function getAutonomousPersonalCaptureProviderPreflightAccessV4(
  storageOwner: object,
  access: unknown,
) {
  const record = providerPreflightRecordForV4(storageOwner, access);
  if (!record) throw providerFixedError('invalid_handle');
  const check = providerPreflightCheckV4(record);
  check();
  return {
    scope: record.lease.scope,
    stagedFresh: record.lease.stagedFresh,
    check,
  } as const;
}

function matchesProviderPreflightOperationV4(
  actual: Extract<AutonomousPersonalOperationV4, { state: 'leased' }>,
  staged: AutonomousPersonalOperationV4,
  scope: AutonomousPersonalCaptureBoundScopeV4,
): boolean {
  if (
    actual.operationId !== staged.operationId ||
    actual.state !== 'leased' ||
    actual.createdAt !== staged.createdAt ||
    actual.beginCallHash !== scope.stableBeginHash ||
    actual.generation !== 1 ||
    actual.retryCount !== 0 ||
    canonical(actual.identity) !== canonical(staged.identity) ||
    canonical(actual.descriptor) !== canonical(staged.descriptor) ||
    !('lease' in staged) ||
    canonical(actual.lease) !== canonical(staged.lease) ||
    actual.attempts.length < staged.attempts.length ||
    actual.attempts.some((attempt, index) =>
      index < staged.attempts.length
        ? canonical(attempt) !== canonical(staged.attempts[index])
        : attempt.disposition === 'claim_won',
    ) ||
    actual.attempts[0]?.disposition !== 'claim_won' ||
    actual.attempts[0]?.at !== actual.createdAt ||
    actual.attempts[0]?.attemptHash !== scope.attemptHash ||
    actual.attempts.filter((attempt) => attempt.disposition === 'claim_won').length !== 1 ||
    actual.overflowCount < staged.overflowCount ||
    Date.parse(actual.lastObservedAt) < Date.parse(staged.lastObservedAt)
  ) {
    return false;
  }
  return true;
}

/**
 * Bind backend observation DATA to the consumed private access key. The
 * backend still owns the actual read/lock and this helper grants no write
 * capability; it only returns a frozen preflight projection.
 */
export function bindAutonomousPersonalCaptureProviderPreflightV4(
  storageOwner: object,
  access: unknown,
  observationValue: unknown,
): AutonomousPersonalCaptureProviderPreflightV4 {
  const record = providerPreflightRecordForV4(storageOwner, access);
  if (!record) throw providerFixedError('invalid_handle');
  const check = providerPreflightCheckV4(record);
  check();

  let observation: AutonomousPersonalCaptureProviderObservationV4;
  try {
    observation = AutonomousPersonalCaptureProviderObservationV4Schema.parse(observationValue);
  } catch {
    check();
    return fixedDecision('conflict');
  }
  check();

  const { lease, lifetime } = record;
  const scope = lease.scope;
  const staged = lease.stagedFresh;
  if (canonical(observation.binding) !== canonical(scope.context.binding)) {
    return fixedDecision('authority_changed');
  }
  if (
    canonical(observation.source) !== canonical(staged.episode) ||
    canonical(observation.descriptor) !== canonical(scope.descriptor) ||
    canonical(observation.descriptor) !== canonical(staged.operation.descriptor) ||
    canonical(observation.fence) !== canonical(staged.fence) ||
    !matchesProviderPreflightOperationV4(observation.operation, staged.operation, scope) ||
    observation.operation.operationId !== scope.operationId ||
    observation.operation.identity.storeHash !== scope.context.storeHash ||
    observation.operation.identity.namespace !== scope.context.namespace ||
    observation.operation.identity.issuer !== scope.context.issuer ||
    observation.operation.identity.actorReference !== scope.context.actorReference ||
    observation.operation.identity.turn !== scope.context.turn ||
    observation.operation.identity.sourceId !== scope.sourceId ||
    observation.operation.lease.token !== scope.leaseToken ||
    observation.operation.beginCallHash !== scope.stableBeginHash ||
    observation.operation.attempts[0]?.attemptHash !== scope.attemptHash ||
    observation.source.uuid !== scope.sourceId ||
    observation.source.group_id !== scope.context.namespace ||
    observation.operation.createdAt !== observation.source.created_at ||
    observation.operation.lease.renewedAt !== observation.source.created_at ||
    observation.readStartedAtMonotonicMs < scope.startedAtMonotonicMs ||
    observation.readStartedAtMonotonicMs > performance.now()
  ) {
    return fixedDecision('conflict');
  }

  const expiresAtEpochMs = Date.parse(observation.operation.lease.expiresAt);
  const backendNowEpochMs = Date.parse(observation.backendNow);
  if (!Number.isFinite(expiresAtEpochMs) || !Number.isFinite(backendNowEpochMs)) {
    return fixedDecision('conflict');
  }
  if (backendNowEpochMs >= expiresAtEpochMs) return fixedDecision('budget_exhausted');
  const leaseProjection =
    observation.readStartedAtMonotonicMs + Math.max(0, expiresAtEpochMs - backendNowEpochMs);
  const overallDeadline = Math.min(scope.deadlineAtMonotonicMs, leaseProjection);
  if (performance.now() >= overallDeadline) return fixedDecision('budget_exhausted');

  try {
    clipOverallDeadlineV4(lifetime, overallDeadline);
  } catch (error) {
    if (getAutonomousPersonalCaptureProviderFailureKindV4(error) === 'cancelled') throw error;
    return fixedDecision('budget_exhausted');
  }

  let ready: AutonomousPersonalCaptureProviderPreflightV4;
  try {
    const rebuilt = reconstructAutonomousPersonalStoredSourceIdentityV4({
      source: observation.source,
      descriptor: observation.descriptor,
    });
    ready = AutonomousPersonalCaptureProviderPreflightV4Schema.parse({
      kind: 'ready',
      source: observation.source,
      descriptor: observation.descriptor,
      refs: {
        sourceId: observation.source.uuid,
        operationId: observation.operation.operationId,
        sourceHash: rebuilt.tuple.identity.sourceHash,
        descriptorHash: rebuilt.tuple.owner.descriptorHash,
        beginCallHash: observation.operation.beginCallHash,
        identityHash: hashAutomaticCaptureV2(observation.operation.identity),
        attemptHash: observation.operation.attempts[0]!.attemptHash,
        leaseRenewedAt: observation.operation.lease.renewedAt,
      },
    });
  } catch {
    check();
    return fixedDecision('conflict');
  }
  if (ready.kind !== 'ready') return fixedDecision('conflict');
  lease.providerReady = ready;
  lease.providerOverallDeadlineAtMonotonicMs = overallDeadline;
  record.ready = ready;
  record.leaseProjectionAtMonotonicMs = leaseProjection;
  check();
  return ready;
}

/** Closing backend access does not close the verified parent lifetime. */
export function closeAutonomousPersonalCaptureProviderPreflightV4(
  storageOwner: object,
  access: unknown,
): void {
  const record = providerPreflightRecordForV4(storageOwner, access);
  if (!record) return;
  record.closed = true;
  providerPreflightAccesses.delete(access as object);
}

export function getAutonomousPersonalCaptureProviderOverallDeadlineV4(
  storageOwner: object,
  initialHandle: unknown,
): number {
  if (!isObject(initialHandle)) throw providerFixedError('invalid_handle');
  const lease = leaseHandles.get(initialHandle);
  if (
    !lease ||
    lease.owner !== storageOwner ||
    !lease.consumed ||
    !lease.lifetime ||
    lease.providerReady === undefined ||
    lease.providerOverallDeadlineAtMonotonicMs === undefined
  ) {
    throw providerFixedError('invalid_handle');
  }
  checkLifetime(lease.lifetime);
  return lease.providerOverallDeadlineAtMonotonicMs;
}

function sealAutonomousPersonalCaptureProviderStageV4(
  storageOwner: object,
  initialHandle: unknown,
  ready: AutonomousPersonalCaptureProviderPreflightReadyV4,
  outcomeValue: ProviderStageOutcomeV4,
  selectionValue?: unknown,
): PrivateAutonomousPersonalCaptureProviderStageV4 {
  if (!isObject(initialHandle)) throw providerFixedError('invalid_handle');
  const lease = leaseHandles.get(initialHandle);
  if (
    !lease ||
    lease.owner !== storageOwner ||
    !lease.consumed ||
    !lease.lifetime ||
    lease.providerReady === undefined ||
    canonical(lease.providerReady.refs) !== canonical(ready.refs)
  ) {
    throw providerFixedError('invalid_handle');
  }
  checkLifetime(lease.lifetime);
  let selection: AutonomousPersonalEvidenceSelectionV1 | null = null;
  if (outcomeValue.kind === 'response') {
    if (selectionValue === undefined) throw providerFixedError('invalid_input');
    let ownedSelection: AutonomousPersonalEvidenceSelectionV1;
    try {
      ownedSelection = AutonomousPersonalEvidenceSelectionV1Schema.parse(selectionValue);
    } catch {
      checkLifetime(lease.lifetime);
      throw providerFixedError('conflict');
    }
    checkLifetime(lease.lifetime);
    if (
      ownedSelection.status !== 'complete' ||
      ownedSelection.sourceId !== ready.refs.sourceId ||
      ownedSelection.sourceHash !== ready.refs.sourceHash ||
      ownedSelection.descriptorHash !== ready.refs.descriptorHash ||
      ownedSelection.policyFingerprint !== ready.descriptor.policy.fingerprint
    ) {
      throw providerFixedError('conflict');
    }
    selection = ownedSelection;
  } else if (selectionValue !== undefined) {
    throw providerFixedError('invalid_input');
  }
  checkLifetime(lease.lifetime);
  const outcome = deepFreeze(providerStageOutcomeOwnedSchema.parse(outcomeValue));
  checkLifetime(lease.lifetime);
  assertAutonomousPersonalCachedStageBytesV4({
    scope: lease.scope,
    stagedFresh: lease.stagedFresh,
    refs: ready.refs,
    outcome,
    selection,
  });
  checkLifetime(lease.lifetime);
  const token = Object.freeze({}) as PrivateAutonomousPersonalCaptureProviderStageV4;
  checkLifetime(lease.lifetime);
  providerStages.set(token, {
    owner: storageOwner,
    handle: initialHandle,
    scope: lease.scope,
    stagedFresh: lease.stagedFresh,
    lifetime: lease.lifetime,
    refs: ready.refs,
    outcome,
    selection,
    consumed: false,
  });
  checkLifetime(lease.lifetime);
  return token;
}

/** The native config reader is re-exported only from this private adapter surface. */
export { readNativeAutonomousPersonalCaptureConfigV4 };

export function isLiveAutonomousPersonalCaptureLeaseHandleV4(value: unknown): boolean {
  return hasLiveLeaseHandle(value);
}

export type AutonomousPersonalCaptureProviderStageViewV4 = Readonly<{
  scope: AutonomousPersonalCaptureBoundScopeV4;
  stagedFresh: AutonomousPersonalCaptureStagedFreshV4;
  refs: AutonomousPersonalCaptureProviderPreflightReadyV4['refs'];
  outcome: AutonomousPersonalCaptureProviderStageOutcomeV4;
  selection: AutonomousPersonalEvidenceSelectionV1 | null;
  overallDeadlineAtMonotonicMs: number;
}>;

export type AutonomousPersonalCaptureProviderStageAccessViewV4 = Readonly<{
  view: AutonomousPersonalCaptureProviderStageViewV4;
  signal: AbortSignal;
  check: () => void;
}>;

/** Consume a sealed A1 stage once for the fixed completion adapter. */
export function consumeAutonomousPersonalCaptureProviderStageV4(
  storageOwner: object,
  stage: unknown,
): PrivateAutonomousPersonalCaptureProviderStageAccessV4 {
  if (!isObject(stage)) throw providerFixedError('invalid_handle');
  const record = providerStages.get(stage);
  if (!record || record.owner !== storageOwner || record.consumed) {
    throw providerFixedError('invalid_handle');
  }
  checkLifetime(record.lifetime);
  if (performance.now() >= record.lifetime.overallDeadlineAtMonotonicMs!) {
    throw providerFixedError('budget_exhausted');
  }
  record.consumed = true;
  const access = Object.freeze({}) as PrivateAutonomousPersonalCaptureProviderStageAccessV4;
  providerStageAccesses.set(access, {
    owner: storageOwner,
    stage,
    stageRecord: record,
    closed: false,
  });
  return access;
}

/** Read only the bounded frozen stage data for the fixed family4 writer. */
export function getAutonomousPersonalCaptureProviderStageAccessV4(
  storageOwner: object,
  access: unknown,
): AutonomousPersonalCaptureProviderStageAccessViewV4 {
  if (!isObject(access)) throw providerFixedError('invalid_handle');
  const accessRecord = providerStageAccesses.get(access);
  if (!accessRecord || accessRecord.owner !== storageOwner || accessRecord.closed) {
    throw providerFixedError('invalid_handle');
  }
  const stage = accessRecord.stageRecord;
  let firstFailure: unknown;
  const check = () => {
    if (firstFailure) throw firstFailure;
    try {
      if (
        accessRecord.closed ||
        providerStageAccesses.get(access) !== accessRecord ||
        !stage.consumed
      ) {
        throw providerFixedError('invalid_handle');
      }
      checkLifetime(stage.lifetime);
      if (performance.now() >= stage.lifetime.overallDeadlineAtMonotonicMs!) {
        throw providerFixedError('budget_exhausted');
      }
    } catch (error) {
      firstFailure = error;
      throw error;
    }
  };
  check();
  const view = Object.freeze({
    scope: stage.scope,
    stagedFresh: stage.stagedFresh,
    refs: stage.refs,
    outcome: stage.outcome,
    selection: stage.selection,
    overallDeadlineAtMonotonicMs: stage.lifetime.overallDeadlineAtMonotonicMs!,
  });
  check();
  return Object.freeze({ view, signal: stage.lifetime.controller.signal, check });
}

/** Close a consumed stage access and release its transferred invocation lifetime. */
export function closeAutonomousPersonalCaptureProviderStageAccessV4(
  storageOwner: object,
  access: unknown,
): void {
  if (!isObject(access)) return;
  const accessRecord = providerStageAccesses.get(access);
  if (!accessRecord) return;
  if (accessRecord.owner !== storageOwner) throw providerFixedError('invalid_handle');
  if (accessRecord.closed) return;
  accessRecord.closed = true;
  providerStageAccesses.delete(access);
  disposeLifetime(accessRecord.stageRecord.lifetime);
}

export type AutonomousPersonalCompletionDecisionV4Result =
  | AutonomousPersonalCaptureBeginV4FalseResult
  | z.infer<typeof AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema>;

export type AutonomousPersonalCompletionPreparationV4Result =
  | {
      readonly kind: 'completion_prepared';
      readonly handle: PrivateAutonomousPersonalCompletionHandleV4;
      readonly eligibleFirstCommit: false;
    }
  | AutonomousPersonalCompletionDecisionV4Result;

export type AutonomousPersonalCompletionAccessViewV4 = Readonly<{
  view: Readonly<AutonomousPersonalCompletionViewV4>;
  typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1;
  legacyReadBudget: SourceHydrationBudget;
  check: () => void;
}>;

function abandonUnconsumedAutonomousPersonalCaptureProviderStageV4(
  storageOwner: object,
  stage: unknown,
): void {
  if (!isObject(stage)) return;
  const record = providerStages.get(stage);
  if (!record || record.owner !== storageOwner || record.consumed) return;
  record.consumed = true;
  providerStages.delete(stage);
  disposeLifetime(record.lifetime);
}

function completionCancelledResultV4(): z.infer<
  typeof AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema
> {
  return deepFreeze(
    AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema.parse({
      kind: 'cancelled',
      eligibleFirstCommit: false,
    }),
  );
}

export function completionFalseResultV4(
  kind: Parameters<typeof providerFalseResultV4>[0],
): AutonomousPersonalCaptureBeginV4FalseResult {
  return fixedDecision(kind as Parameters<typeof fixedDecision>[0]);
}

export function completionFailureResultV4(
  error: unknown,
): AutonomousPersonalCompletionDecisionV4Result {
  const kind = getAutonomousPersonalCaptureProviderFailureKindV4(error);
  if (kind === 'cancelled') return completionCancelledResultV4();
  if (
    kind &&
    kind !== 'committed_observed' &&
    kind !== 'cancelled_observed' &&
    kind !== 'failed' &&
    kind !== 'interrupted'
  ) {
    return completionFalseResultV4(kind as Parameters<typeof providerFalseResultV4>[0]);
  }
  return completionFalseResultV4('storage_error');
}

type NativeContextComparisonV4 =
  | { readonly kind: 'match' }
  | { readonly kind: 'decision'; readonly result: AutonomousPersonalCompletionDecisionV4Result };

async function compareAutonomousPersonalNativeContextV4(
  ctx: IExecuteFunctions,
  scope: AutonomousPersonalCaptureBoundScopeV4,
  check: () => void,
): Promise<NativeContextComparisonV4> {
  check();
  let currentConfig;
  try {
    currentConfig = await readNativeAutonomousPersonalCaptureProviderConfigV4(ctx);
  } catch {
    check();
    return { kind: 'decision', result: completionFalseResultV4('invalid_input') };
  }
  check();
  if (currentConfig.kind !== 'ready') {
    return {
      kind: 'decision',
      result: completionFalseResultV4(
        currentConfig.kind === 'unsupported_mode' ? 'unsupported_mode' : 'invalid_input',
      ),
    };
  }

  const expectedNativeContext = {
    instance: scope.context.instance,
    workflow: scope.context.workflow,
    execution: scope.context.execution,
  };
  const currentNativeContext = {
    instance: currentConfig.nativeContext.instance,
    workflow: currentConfig.nativeContext.workflow,
    execution: currentConfig.nativeContext.execution,
  };
  const expectedProviderReference = scope.request.settings.providerReference;
  const currentProviderReference = currentConfig.request.settings.providerReference;
  if (
    canonical(currentConfig.request) !== canonical(scope.request) ||
    canonical(currentNativeContext) !== canonical(expectedNativeContext) ||
    canonical(currentProviderReference) !== canonical(expectedProviderReference) ||
    currentProviderReference.configurationFingerprint !==
      scope.descriptor.provider.configurationFingerprint
  ) {
    return { kind: 'decision', result: completionFalseResultV4('authority_changed') };
  }

  check();
  return { kind: 'match' };
}

function makeCompletionCheckV4(
  storageOwner: object,
  originalStageCheck: () => void,
  work: AutonomousPersonalTypedSyntaxWorkV1,
  readScope: AutomaticClaimReadScope,
): {
  readonly check: () => void;
  bind: (record: AutonomousPersonalCompletionHandleRecordV4) => void;
} {
  let record: AutonomousPersonalCompletionHandleRecordV4 | undefined;
  let firstFailure: unknown;
  const check = () => {
    if (firstFailure !== undefined) throw firstFailure;
    try {
      originalStageCheck();
      if (
        !Number.isFinite(work.absoluteMonotonicDeadlineMs) ||
        performance.now() >= work.absoluteMonotonicDeadlineMs ||
        work.signal.aborted ||
        !canUseAutomaticClaimReadScope(readScope)
      ) {
        throw providerFixedError('budget_exhausted');
      }
      if (
        record &&
        (record.owner !== storageOwner ||
          record.phase === 'closed' ||
          !record.handle ||
          completionHandles.get(record.handle) !== record)
      ) {
        throw providerFixedError('invalid_handle');
      }
    } catch (error) {
      firstFailure = error;
      if (record) record.firstFailure = error;
      throw error;
    }
  };
  return {
    check,
    bind: (value) => {
      record = value;
    },
  };
}

/**
 * Fixed native preparation. A1 owns the only provider dispatch; this adapter
 * binds its stage to a clipped, one-use completion handle after a fresh native
 * configuration reread. It does not write graph data or mint write authority.
 */
export async function prepareNativeAutonomousPersonalCompletionV4(
  ctx: IExecuteFunctions,
  storageOwner: IGraphStorage,
): Promise<AutonomousPersonalCompletionPreparationV4Result> {
  const completionNonce = generateUuid();
  let a1Result: AutonomousPersonalCaptureProviderV4Result;
  try {
    a1Result = await prepareNativeAutonomousPersonalCaptureProviderV4(ctx, storageOwner);
  } catch (error) {
    return completionFailureResultV4(error);
  }
  if (a1Result.kind !== 'prepared') {
    // A1 already owns and validates these false projections. Terminal
    // observations carry mandatory receipts; reducing them to a kind would
    // discard that evidence and cannot satisfy the existing result schema.
    return a1Result;
  }

  let stageAccess: PrivateAutonomousPersonalCaptureProviderStageAccessV4 | undefined;
  let completionRecord: AutonomousPersonalCompletionHandleRecordV4 | undefined;
  let transferred = false;
  try {
    stageAccess = consumeAutonomousPersonalCaptureProviderStageV4(storageOwner, a1Result.stage);
    const stageAccessView = getAutonomousPersonalCaptureProviderStageAccessV4(
      storageOwner,
      stageAccess,
    );
    const postProviderStartedAtMonotonicMs = performance.now();
    const legacyReadBudget: SourceHydrationBudget = { remaining: 512, deferred: 0 };
    const legacyReadScope = getAutomaticClaimReadScope(legacyReadBudget);
    const typedSyntaxWork: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
      absoluteMonotonicDeadlineMs: Math.min(
        stageAccessView.view.overallDeadlineAtMonotonicMs,
        postProviderStartedAtMonotonicMs + 5_000,
      ),
      signal: stageAccessView.signal,
    });
    const workCheck = makeCompletionCheckV4(
      storageOwner,
      stageAccessView.check,
      typedSyntaxWork,
      legacyReadScope,
    );
    workCheck.check();

    const { scope, stagedFresh, outcome, selection } = stageAccessView.view;
    const nativeContextComparison = await compareAutonomousPersonalNativeContextV4(
      ctx,
      scope,
      workCheck.check,
    );
    if (nativeContextComparison.kind === 'decision') return nativeContextComparison.result;
    workCheck.check();
    const audit: AutonomousPersonalCompletionAuditV4 = deepFreeze({
      action: 'completion',
      attemptIdHash: hashAutomaticCaptureV2({
        domain: 'engram-autonomous-personal-completion-attempt-v4',
        originalAttemptHash: scope.attemptHash,
        invocationNonce: scope.invocationNonce,
        completionNonce,
        operationId: scope.operationId,
      }),
      operationId: scope.operationId,
      sourceId: scope.sourceId,
    });
    const completionCallHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-personal-completion-call-v4',
      originalAttemptHash: scope.attemptHash,
      invocationNonce: scope.invocationNonce,
      completionNonce,
      sourceId: scope.sourceId,
      operationId: scope.operationId,
      sourceHash: stagedFresh.fence.sourceHash,
      descriptorHash: stagedFresh.fence.descriptorHash,
      providerFingerprint: scope.descriptor.provider.configurationFingerprint,
      outcome,
      selection,
    });
    assertAutonomousPersonalCachedStageBytesV4({
      scope,
      stagedFresh,
      refs: stageAccessView.view.refs,
      outcome,
      selection,
      completionCallHash,
      audit,
    });
    workCheck.check();
    const view = deepFreeze({
      scope,
      stagedFresh,
      outcome,
      selection,
      completionCallHash,
      audit,
    });
    const handle = Object.freeze({}) as PrivateAutonomousPersonalCompletionHandleV4;
    const record: AutonomousPersonalCompletionHandleRecordV4 = {
      owner: storageOwner,
      originalStageAccess: stageAccess,
      originalStageCheck: stageAccessView.check,
      lifetime: providerStageAccesses.get(stageAccess)!.stageRecord.lifetime,
      scope,
      stagedFresh,
      outcome,
      selection,
      view,
      typedSyntaxWork,
      legacyReadBudget,
      legacyReadScope,
      completionCallHash,
      audit,
      check: workCheck.check,
      handle,
      phase: 'issued',
      stageAccessClosed: false,
    };
    completionRecord = record;
    completionHandles.set(handle, record);
    workCheck.bind(record);
    workCheck.check();
    const result = Object.freeze({
      kind: 'completion_prepared' as const,
      handle,
      eligibleFirstCommit: false as const,
    });
    workCheck.check();
    transferred = true;
    return result;
  } catch (error) {
    return completionFailureResultV4(error);
  } finally {
    if (!transferred) {
      if (completionRecord) {
        closeAutonomousPersonalCompletionRecordV4(storageOwner, completionRecord);
      } else if (stageAccess) {
        closeAutonomousPersonalCaptureProviderStageAccessV4(storageOwner, stageAccess);
      } else {
        abandonUnconsumedAutonomousPersonalCaptureProviderStageV4(storageOwner, a1Result.stage);
      }
    }
  }
}

/** Reserve the opaque completion handle synchronously before backend I/O. */
export function consumeAutonomousPersonalCompletionHandleV4(
  storageOwner: object,
  handle: unknown,
): PrivateAutonomousPersonalCompletionAccessV4 {
  if (!isObject(handle)) throw providerFixedError('invalid_handle');
  const record = completionHandles.get(handle);
  const ownedHandle = record?.handle;
  if (
    !record ||
    record.owner !== storageOwner ||
    record.phase !== 'issued' ||
    !ownedHandle ||
    ownedHandle !== handle
  ) {
    throw providerFixedError('invalid_handle');
  }
  record.check();
  record.phase = 'consumed';
  const access = Object.freeze({}) as PrivateAutonomousPersonalCompletionAccessV4;
  record.access = access;
  completionAccesses.set(access, { owner: storageOwner, handle: ownedHandle, completion: record });
  record.check();
  return access;
}

/** Read the frozen DATA and shared runtime work for a consumed completion key. */
export function getAutonomousPersonalCompletionAccessV4(
  storageOwner: object,
  access: unknown,
): AutonomousPersonalCompletionAccessViewV4 {
  if (!isObject(access)) throw providerFixedError('invalid_handle');
  const accessRecord = completionAccesses.get(access);
  if (
    !accessRecord ||
    accessRecord.owner !== storageOwner ||
    accessRecord.completion.phase !== 'consumed' ||
    accessRecord.completion.access !== access
  ) {
    throw providerFixedError('invalid_handle');
  }
  const record = accessRecord.completion;
  record.check();
  const result = Object.freeze({
    view: record.view,
    typedSyntaxWork: record.typedSyntaxWork,
    legacyReadBudget: record.legacyReadBudget,
    check: record.check,
  });
  record.check();
  return result;
}

function completionRecordForNativeCheckV4(
  storageOwner: object,
  handle: unknown,
): AutonomousPersonalCompletionHandleRecordV4 | undefined {
  if (!isObject(handle)) return undefined;
  const record = completionHandles.get(handle);
  if (
    !record ||
    record.owner !== storageOwner ||
    record.handle !== handle ||
    completionHandles.get(handle) !== record
  ) {
    return undefined;
  }
  if (record.phase === 'issued') return record.access === undefined ? record : undefined;
  if (record.phase !== 'consumed' || !record.access) return undefined;
  const accessRecord = completionAccesses.get(record.access);
  if (
    !accessRecord ||
    accessRecord.owner !== storageOwner ||
    accessRecord.handle !== handle ||
    accessRecord.completion !== record ||
    completionAccesses.get(record.access) !== accessRecord
  ) {
    return undefined;
  }
  return record;
}

/** Check one exact private completion record without consuming its handle. */
export function checkAutonomousPersonalCompletionV4(storageOwner: object, handle: unknown): void {
  const record = completionRecordForNativeCheckV4(storageOwner, handle);
  if (!record) throw providerFixedError('invalid_handle');
  record.check();
}

/** Recheck the live native config against the exact owner-held completion scope. */
export async function recheckAutonomousPersonalNativeContextV4(
  ctx: IExecuteFunctions,
  storageOwner: object,
  handle: unknown,
): Promise<NativeContextComparisonV4> {
  const record = completionRecordForNativeCheckV4(storageOwner, handle);
  if (!record) {
    return { kind: 'decision', result: completionFalseResultV4('invalid_handle') };
  }
  try {
    record.check();
    const result = await compareAutonomousPersonalNativeContextV4(ctx, record.scope, record.check);
    if (result.kind === 'decision') return result;
    record.check();
    return { kind: 'match' };
  } catch (error) {
    return { kind: 'decision', result: completionFailureResultV4(error) };
  }
}

/** Read-only consumed-record membership, independent of work expiry. */
export function isAutonomousPersonalCompletionHandleOpenV4(
  storageOwner: object,
  handle: unknown,
): boolean {
  if (!isObject(handle)) return false;
  const record = completionHandles.get(handle);
  if (
    !record ||
    record.owner !== storageOwner ||
    record.handle !== handle ||
    completionHandles.get(handle) !== record
  ) {
    return false;
  }
  if (record.phase !== 'consumed' || !record.access) return false;
  const accessRecord = completionAccesses.get(record.access);
  return (
    accessRecord !== undefined &&
    accessRecord.owner === storageOwner &&
    accessRecord.handle === handle &&
    accessRecord.completion === record
  );
}

/** Read-only identity/work predicate for the consumed access of its exact handle. */
export function isAutonomousPersonalCompletionAccessForHandleV4(
  storageOwner: object,
  handle: unknown,
  access: unknown,
): boolean {
  if (!isObject(handle) || !isObject(access)) return false;
  const record = completionHandles.get(handle);
  if (
    !record ||
    record.owner !== storageOwner ||
    record.handle !== handle ||
    record.phase !== 'consumed' ||
    record.access !== access ||
    completionHandles.get(handle) !== record
  ) {
    return false;
  }
  const accessRecord = completionAccesses.get(access);
  if (
    !accessRecord ||
    accessRecord.owner !== storageOwner ||
    accessRecord.handle !== handle ||
    accessRecord.completion !== record ||
    completionAccesses.get(access) !== accessRecord
  ) {
    return false;
  }
  try {
    record.check();
    return true;
  } catch {
    return false;
  }
}

/**
 * Enforce the existing aggregate retained-DATA ceiling for one valid native
 * completion access and one strict, bounded planner result. This grants no
 * write authority and retains neither the plan nor an aggregate copy.
 */
export function assertAutonomousPersonalCompletionPlanAggregateBytesV4(
  storageOwner: object,
  access: unknown,
  planValue: unknown,
): void {
  if (!isObject(access)) throw providerFixedError('invalid_handle');
  const accessRecord = completionAccesses.get(access);
  if (
    !accessRecord ||
    accessRecord.owner !== storageOwner ||
    accessRecord.completion.owner !== storageOwner ||
    accessRecord.completion.phase !== 'consumed' ||
    accessRecord.completion.access !== access ||
    !accessRecord.completion.handle ||
    completionHandles.get(accessRecord.completion.handle) !== accessRecord.completion
  ) {
    throw providerFixedError('invalid_handle');
  }
  const record = accessRecord.completion;
  record.check();

  const stageAccessRecord = providerStageAccesses.get(record.originalStageAccess);
  if (
    !stageAccessRecord ||
    stageAccessRecord.owner !== storageOwner ||
    stageAccessRecord.closed ||
    stageAccessRecord.stageRecord.consumed !== true
  ) {
    throw providerFixedError('invalid_handle');
  }

  let clonedPlan: unknown;
  try {
    // The begin-request facade provides the established 512 KiB bounded JSON
    // clone without invoking accessors; the strict plan schema then owns shape.
    clonedPlan = cloneBoundedAutomaticCaptureJson<unknown>(planValue, 'beginRequest');
  } catch (error) {
    record.check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      throw providerFixedError('resource_exhausted');
    }
    throw providerFixedError('invalid_input');
  }
  record.check();

  let parsedPlan;
  try {
    parsedPlan = AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(clonedPlan);
  } catch {
    record.check();
    throw providerFixedError('invalid_input');
  }
  record.check();
  if (!parsedPlan.success || parsedPlan.data.kind !== 'planned') {
    throw providerFixedError('invalid_input');
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify({
      scope: record.scope,
      stagedFresh: record.stagedFresh,
      refs: stageAccessRecord.stageRecord.refs,
      outcome: record.outcome,
      selection: record.selection,
      completionCallHash: record.completionCallHash,
      audit: record.audit,
      plan: parsedPlan.data,
    });
  } catch {
    record.check();
    throw providerFixedError('invalid_input');
  }
  record.check();
  if (typeof serialized !== 'string') throw providerFixedError('invalid_input');
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  record.check();
  if (serializedBytes > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes) {
    throw providerFixedError('resource_exhausted');
  }
  record.check();
}

/**
 * Enforce the existing retained-DATA ceiling with a strict native-origin
 * projection included. This validates bounded DATA only and grants no proof
 * or write authority.
 */
export function assertAutonomousPersonalCompletionNativeAggregateBytesV4(
  storageOwner: object,
  access: unknown,
  planValue: unknown,
  nativeOriginValue: unknown,
): void {
  if (!isObject(access)) throw providerFixedError('invalid_handle');
  const accessRecord = completionAccesses.get(access);
  if (
    !accessRecord ||
    accessRecord.owner !== storageOwner ||
    accessRecord.completion.owner !== storageOwner ||
    accessRecord.completion.phase !== 'consumed' ||
    accessRecord.completion.access !== access ||
    !accessRecord.completion.handle ||
    completionHandles.get(accessRecord.completion.handle) !== accessRecord.completion
  ) {
    throw providerFixedError('invalid_handle');
  }
  const record = accessRecord.completion;
  record.check();

  const stageAccessRecord = providerStageAccesses.get(record.originalStageAccess);
  if (
    !stageAccessRecord ||
    stageAccessRecord.owner !== storageOwner ||
    stageAccessRecord.closed ||
    stageAccessRecord.stageRecord.consumed !== true
  ) {
    throw providerFixedError('invalid_handle');
  }
  record.check();

  let clonedPlan: unknown;
  try {
    clonedPlan = cloneBoundedAutomaticCaptureJson<unknown>(planValue, 'beginRequest');
  } catch (error) {
    record.check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      throw providerFixedError('resource_exhausted');
    }
    throw providerFixedError('invalid_input');
  }
  record.check();

  let parsedPlan;
  try {
    parsedPlan = AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(clonedPlan);
  } catch {
    record.check();
    throw providerFixedError('invalid_input');
  }
  record.check();
  if (!parsedPlan.success || parsedPlan.data.kind !== 'planned') {
    throw providerFixedError('invalid_input');
  }

  let clonedNativeOrigin: unknown;
  try {
    clonedNativeOrigin = cloneBoundedAutomaticCaptureJson<unknown>(
      nativeOriginValue,
      'beginRequest',
    );
  } catch (error) {
    record.check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      throw providerFixedError('resource_exhausted');
    }
    throw providerFixedError('invalid_input');
  }
  record.check();

  let parsedNativeOrigin;
  try {
    parsedNativeOrigin =
      AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse(clonedNativeOrigin);
  } catch {
    record.check();
    throw providerFixedError('invalid_input');
  }
  record.check();
  if (!parsedNativeOrigin.success) throw providerFixedError('invalid_input');

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify({
      scope: record.scope,
      stagedFresh: record.stagedFresh,
      refs: stageAccessRecord.stageRecord.refs,
      outcome: record.outcome,
      selection: record.selection,
      completionCallHash: record.completionCallHash,
      audit: record.audit,
      plan: parsedPlan.data,
      nativeOrigin: parsedNativeOrigin.data,
    });
  } catch {
    record.check();
    throw providerFixedError('invalid_input');
  }
  record.check();
  if (typeof serialized !== 'string') throw providerFixedError('invalid_input');
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  record.check();
  if (serializedBytes > AUTONOMOUS_PERSONAL_POLICY_V3_LIMITS.cachedStageBytes) {
    throw providerFixedError('resource_exhausted');
  }
  record.check();
}

function closeAutonomousPersonalCompletionRecordV4(
  storageOwner: object,
  record: AutonomousPersonalCompletionHandleRecordV4,
): void {
  if (record.owner !== storageOwner) throw providerFixedError('invalid_handle');
  if (record.phase === 'closed') return;
  record.phase = 'closed';
  if (record.handle) completionHandles.delete(record.handle);
  if (record.access) completionAccesses.delete(record.access);
  if (!record.stageAccessClosed) {
    record.stageAccessClosed = true;
    closeAutonomousPersonalCaptureProviderStageAccessV4(storageOwner, record.originalStageAccess);
  }
}

/** Cleanup-only close. It remains usable after the original work deadline. */
export function closeAutonomousPersonalCompletionV4(
  storageOwner: object,
  handleOrAccess: unknown,
): void {
  if (!isObject(handleOrAccess)) return;
  const handleRecord = completionHandles.get(handleOrAccess);
  if (handleRecord) {
    closeAutonomousPersonalCompletionRecordV4(storageOwner, handleRecord);
    return;
  }
  const accessRecord = completionAccesses.get(handleOrAccess);
  if (accessRecord) {
    closeAutonomousPersonalCompletionRecordV4(storageOwner, accessRecord.completion);
  }
}
