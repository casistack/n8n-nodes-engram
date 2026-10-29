import { z } from 'zod';
import { isNativePlainAutomaticCaptureObject as isNativePlainObject } from '../storage/BoundedAutomaticCaptureJson';
import { AutomaticCaptureLifecycleV2Schema } from './AutomaticCapture.schema';
import { AUTOMATIC_LEDGER_LIMITS } from './AutomaticLedgerPrimitives.schema';
import {
  CompositionalAutomaticCaptureBeginRequestV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from './CompositionalAutomaticCaptureV3.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const timestamp = z.string().datetime();

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .superRefine((value, context) => {
      if (value.length > max) return;
      if (value.trim() !== value || value.trim().length === 0 || !isWellFormedUnicode(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Locator text must be canonical',
        });
      }
    });

/** Shallow own-data snapshot for fixed, metadata-only request/result records. */
function snapshotFixedRecord(value: unknown, allowedKeys: readonly string[]): unknown {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isNativePlainObject(value)
  )
    return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > allowedKeys.length || keys.some((key) => typeof key !== 'string'))
      return undefined;
    const allowed = new Set(allowedKeys);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      if (!allowed.has(key)) return undefined;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !('value' in property)) return undefined;
      if (typeof property.value === 'string' && property.value.length > 512) return undefined;
      Object.defineProperty(output, key, {
        value: property.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } catch {
    return undefined;
  }
}

const beginMethodKeys = ['request', 'mode'] as const;
const beginMethodBody = z
  .object({
    request: CompositionalAutomaticCaptureBeginRequestV3Schema,
    mode: z.literal('existingStore'),
  })
  .strict();

/** Requires an explicitly existing persistent store; this is not a defaulted mode. */
export const CompositionalCaptureBeginMethodRequestV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, beginMethodKeys),
  beginMethodBody,
);
export type CompositionalCaptureBeginMethodRequestV3 = z.infer<
  typeof CompositionalCaptureBeginMethodRequestV3Schema
>;

const leaseFenceKeys = [
  'version',
  'purpose',
  'operationId',
  'sourceId',
  'descriptorHash',
  'identityHash',
  'sourceHash',
  'envelopeHash',
  'beginCallHash',
  'state',
  'generation',
  'token',
  'claimKind',
  'retryCount',
  'lastRetryCallHash',
  'planTimestamp',
] as const;

const leaseFenceBody = z
  .object({
    version: z.literal(3),
    purpose: z.literal('human_turn_memory'),
    operationId: uuid,
    sourceId: uuid,
    descriptorHash: hash64,
    identityHash: hash64,
    sourceHash: hash64,
    envelopeHash: hash64,
    beginCallHash: hash64,
    state: z.literal('leased'),
    generation: z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    token: uuid,
    claimKind: z.enum(['initial', 'resume']),
    retryCount: z.number().int().min(0).max(3),
    lastRetryCallHash: hash64.optional(),
    planTimestamp: timestamp,
  })
  .strict()
  .superRefine((fence, context) => {
    if ((fence.retryCount === 0) !== (fence.lastRetryCallHash === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryCount'],
        message: 'V3 retry count and retry-call hash must be present together',
      });
    }
    if (
      (fence.claimKind === 'initial' && fence.generation !== 1) ||
      (fence.claimKind === 'resume' && fence.generation < 2)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimKind'],
        message: 'V3 lease claim kind does not match its generation',
      });
    }
  });

/**
 * Structural private-fence data only. It does not prove correspondence to a
 * persisted operation; the backend registry must compare every field to its
 * actual V3 source, descriptor, identity, and operation before mint/consume.
 */
export const CompositionalCaptureLeaseFenceV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, leaseFenceKeys),
  leaseFenceBody,
);
export type CompositionalCaptureLeaseFenceV3 = z.infer<
  typeof CompositionalCaptureLeaseFenceV3Schema
>;

const locatorShape = {
  version: z.literal(3),
  namespace: CompositionalCaptureNamespaceV3Schema,
  issuer: boundedText(256),
  actorReference: boundedText(512),
  turn: boundedText(512),
  role: z.literal('human'),
};
const locatorKeys = ['version', 'namespace', 'issuer', 'actorReference', 'turn', 'role'] as const;

const captureReadRequestBody = z.object(locatorShape).strict();

/** Exact event locator only; callers cannot select source IDs, hashes, or authority. */
export const CompositionalCaptureReadRequestV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, locatorKeys),
  captureReadRequestBody,
);
export type CompositionalCaptureReadRequestV3 = z.infer<
  typeof CompositionalCaptureReadRequestV3Schema
>;

const adminRequestKeys = [...locatorKeys, 'expectedGeneration', 'attemptIdHash'] as const;
const captureAdminFenceRequestBody = z
  .object({
    ...locatorShape,
    expectedGeneration: z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    attemptIdHash: hash64,
  })
  .strict();

/** Operator-control locator and optimistic generation fence; no caller identity hashes. */
export const CompositionalCaptureAdminFenceRequestV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, adminRequestKeys),
  captureAdminFenceRequestBody,
);
export type CompositionalCaptureAdminFenceRequestV3 = z.infer<
  typeof CompositionalCaptureAdminFenceRequestV3Schema
>;

const noEligibility = { eligibleFirstCommit: z.literal(false) };
const currentAuthority = z.enum(['active', 'changed', 'revoked', 'unknown']);
const terminalReceipt = CompositionalAutomaticCaptureTerminalReceiptV3Schema;
const committedReceipt = terminalReceipt.refine(
  (receipt) =>
    receipt.kind === 'human_compositional_capture_committed' ||
    receipt.kind === 'human_compositional_source_verdict_committed',
);
const cancelledReceipt = terminalReceipt.refine((receipt) => receipt.kind === 'cancelled');

const fixedDecisionKinds = [
  'in_progress',
  'committed_replay',
  'cancelled_replay',
  'legacy_unconfirmed',
  'source_only_unconfirmed',
  'conflict',
  'authority_changed',
  'invalid_input',
  'unsupported_mode',
  'clock_regression',
  'capacity',
  'resource_exhausted',
  'budget_exhausted',
  'interrupted',
  'acknowledgement_unknown',
  'not_found',
  'fenced',
  'invalid_handle',
  'invalid_plan',
  'storage_error',
  'resume_available',
] as const;

const decisionBody = z
  .object({
    kind: z.enum(fixedDecisionKinds),
    ...noEligibility,
  })
  .strict();

const decisionKeys = ['kind', 'eligibleFirstCommit'] as const;

/** Structural outcomes only. This schema intentionally has no claimed/handle branch. */
export const CompositionalCaptureNonPermitDecisionV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, decisionKeys),
  decisionBody,
);
export type CompositionalCaptureNonPermitDecisionV3 = z.infer<
  typeof CompositionalCaptureNonPermitDecisionV3Schema
>;

const committedObservationKeys = [
  'kind',
  'invocation',
  'terminalReceipt',
  'currentAuthority',
  'eligibleFirstCommit',
] as const;
const committedObservationBody = z
  .object({
    kind: z.literal('committed'),
    invocation: z.enum([
      'initial_owner',
      'same_call_ack_recovered',
      'committed_replay',
      'explicit_resume',
    ]),
    terminalReceipt: committedReceipt,
    currentAuthority,
    ...noEligibility,
  })
  .strict();

/** A persisted receipt observation is always false; this is not a first-commit factory. */
export const CompositionalCaptureCommittedObservationV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, committedObservationKeys),
  committedObservationBody,
);
export type CompositionalCaptureCommittedObservationV3 = z.infer<
  typeof CompositionalCaptureCommittedObservationV3Schema
>;

const cancelledObservationBody = z
  .object({
    kind: z.literal('cancelled'),
    terminalReceipt: cancelledReceipt,
    ...noEligibility,
  })
  .strict();
const cancelledObservationKeys = ['kind', 'terminalReceipt', 'eligibleFirstCommit'] as const;

export const CompositionalCaptureCancelledObservationV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, cancelledObservationKeys),
  cancelledObservationBody,
);
export type CompositionalCaptureCancelledObservationV3 = z.infer<
  typeof CompositionalCaptureCancelledObservationV3Schema
>;

/**
 * Safe structural result surface for this checkpoint. True eligibility and
 * any handle-bearing success are intentionally absent until a reviewed V3
 * backend registry can bind those branches to private capabilities.
 */
export const CompositionalCaptureNonPermitResultV3Schema = z.union([
  CompositionalCaptureNonPermitDecisionV3Schema,
  CompositionalCaptureCommittedObservationV3Schema,
  CompositionalCaptureCancelledObservationV3Schema,
]);
export type CompositionalCaptureNonPermitResultV3 = z.infer<
  typeof CompositionalCaptureNonPermitResultV3Schema
>;

const falseReadDecisionKinds = [
  'not_found',
  'in_progress',
  'source_only_unconfirmed',
  'legacy_unconfirmed',
  'failed',
  'interrupted',
  'resume_available',
  'conflict',
  'authority_changed',
  'capacity',
  'unsupported_mode',
  'invalid_input',
  'clock_regression',
  'resource_exhausted',
  'recovery_required',
] as const;
const readDecisionKeys = ['kind', 'eligibleFirstCommit'] as const;
const readDecisionBody = z
  .object({ kind: z.enum(falseReadDecisionKinds), ...noEligibility })
  .strict();

export const CompositionalCaptureReadDecisionV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, readDecisionKeys),
  readDecisionBody,
);
export type CompositionalCaptureReadDecisionV3 = z.infer<
  typeof CompositionalCaptureReadDecisionV3Schema
>;

/** Read-only history never yields eligibility, including exact terminal receipt reads. */
export const CompositionalCaptureReadResultV3Schema = z.union([
  CompositionalCaptureReadDecisionV3Schema,
  z.preprocess(
    (value) => snapshotFixedRecord(value, committedObservationKeys),
    committedObservationBody.extend({
      invocation: z.literal('committed_replay'),
    }),
  ),
  CompositionalCaptureCancelledObservationV3Schema,
]);
export type CompositionalCaptureReadResultV3 = z.infer<
  typeof CompositionalCaptureReadResultV3Schema
>;

/** Structural public projections in this checkpoint are deliberately false-only. */
export const CompositionalCapturePublicResultV3Schema = z.union([
  CompositionalCaptureNonPermitResultV3Schema,
  CompositionalCaptureReadResultV3Schema,
]);
export type CompositionalCapturePublicResultV3 = z.infer<
  typeof CompositionalCapturePublicResultV3Schema
>;

const adminDecisionKinds = [
  'not_found',
  'in_progress',
  'committed_replay',
  'cancelled_replay',
  'legacy_unconfirmed',
  'source_only_unconfirmed',
  'conflict',
  'authority_changed',
  'capacity',
  'invalid_input',
  'fenced',
  'clock_regression',
  'unsupported_mode',
] as const;
const adminDecisionBody = z.object({ kind: z.enum(adminDecisionKinds), ...noEligibility }).strict();
const adminDecisionKeys = ['kind', 'eligibleFirstCommit'] as const;

/** False-only decision component for registry-bound resume/cancel result factories. */
export const CompositionalCaptureAdminDecisionV3Schema = z.preprocess(
  (value) => snapshotFixedRecord(value, adminDecisionKeys),
  adminDecisionBody,
);
export type CompositionalCaptureAdminDecisionV3 = z.infer<
  typeof CompositionalCaptureAdminDecisionV3Schema
>;

/** Cancellation may return its actual immutable receipt, but never a lease or permit. */
export const CompositionalCaptureCancelResultV3Schema = z.union([
  CompositionalCaptureAdminDecisionV3Schema,
  CompositionalCaptureCancelledObservationV3Schema,
]);
export type CompositionalCaptureCancelResultV3 = z.infer<
  typeof CompositionalCaptureCancelResultV3Schema
>;

/** Explicitly pin the saved lifecycle enum without creating a new lifecycle value. */
export const CompositionalCaptureLifecycleV3Schema = AutomaticCaptureLifecycleV2Schema;
