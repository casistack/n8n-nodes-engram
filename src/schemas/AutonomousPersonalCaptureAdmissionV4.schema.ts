import { z } from 'zod';
import { AUTOMATIC_LEDGER_LIMITS } from './AutomaticLedgerPrimitives.schema';
import {
  AutonomousPersonalOperationV4FailedFailureCodeSchema,
  AutonomousPersonalOperationV4InterruptedFailureCodeSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
} from './AutonomousPersonalOperationV4.schema';
import {
  cloneBoundedAutomaticCaptureJson,
  type AutomaticCaptureJsonBound,
} from '../storage/BoundedAutomaticCaptureJson';

const HASH_64 = /^[a-f0-9]{64}$/u;
const hash64 = z.string().regex(HASH_64);
const uuid = z.string().uuid();
const RESULT_MAX_BYTES = AUTOMATIC_LEDGER_LIMITS.operationBytes;

const canonicalUtcMilliseconds = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

/** Strict fence consistency DATA for an initial generation-one V4 lease. */
export const AutonomousPersonalCaptureFenceV4OwnedDataSchema = z
  .object({
    version: z.literal(4),
    purpose: z.literal('human_turn_memory'),
    operationId: uuid,
    sourceId: uuid,
    descriptorHash: hash64,
    identityHash: hash64,
    sourceHash: hash64,
    envelopeHash: hash64,
    beginCallHash: hash64,
    state: z.literal('leased'),
    generation: z.literal(1),
    token: uuid,
    claimKind: z.literal('initial'),
    retryCount: z.literal(0),
    planTimestamp: canonicalUtcMilliseconds,
  })
  .strict();

export type AutonomousPersonalCaptureFenceV4 = z.infer<
  typeof AutonomousPersonalCaptureFenceV4OwnedDataSchema
>;

const noFirstCommitPermission = { eligibleFirstCommit: z.literal(false) };
const committedReceipt = AutonomousPersonalReceiptV4OwnedDataSchema.refine(
  (receipt) => receipt.kind !== 'cancelled',
);
const cancelledReceipt = AutonomousPersonalReceiptV4OwnedDataSchema.refine(
  (receipt) => receipt.kind === 'cancelled',
);

const claimedProjection = z
  .object({
    kind: z.literal('claimed'),
    purpose: z.literal('human_turn_memory'),
    sourceId: uuid,
    operationId: uuid,
    descriptorHash: hash64,
    sourcePersistence: z.literal('persisted'),
    claimKind: z.literal('initial'),
    ...noFirstCommitPermission,
  })
  .strict();

const committedObservedProjection = z
  .object({
    kind: z.literal('committed_observed'),
    terminalReceipt: committedReceipt,
    ...noFirstCommitPermission,
  })
  .strict();

const cancelledObservedProjection = z
  .object({
    kind: z.literal('cancelled_observed'),
    terminalReceipt: cancelledReceipt,
    ...noFirstCommitPermission,
  })
  .strict();

const failedProjection = z
  .object({
    kind: z.literal('failed'),
    failureCode: AutonomousPersonalOperationV4FailedFailureCodeSchema,
    ...noFirstCommitPermission,
  })
  .strict();

const interruptedProjection = z
  .object({
    kind: z.literal('interrupted'),
    failureCode: AutonomousPersonalOperationV4InterruptedFailureCodeSchema,
    ...noFirstCommitPermission,
  })
  .strict();

const otherFalseOutcome = z
  .object({
    kind: z.enum([
      'in_progress',
      'resume_available',
      'source_only_unconfirmed',
      'unsupported_mode',
      'invalid_handle',
      'invalid_input',
      'conflict',
      'authority_changed',
      'budget_exhausted',
      'resource_exhausted',
      'capacity',
      'clock_regression',
      'acknowledgement_unknown',
      'storage_error',
    ]),
    ...noFirstCommitPermission,
  })
  .strict();

/**
 * Handle-free Begin4 result projection DATA. This is not the runtime result
 * returned by a backend, and cannot carry or recognize a private lease handle.
 */
export const AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    claimedProjection,
    committedObservedProjection,
    cancelledObservedProjection,
    failedProjection,
    interruptedProjection,
    otherFalseOutcome,
  ],
);

export type AutonomousPersonalCaptureBeginV4ResultProjection = z.infer<
  typeof AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function fixedError(code: string): z.ZodError {
  const path: Array<string | number> = [];
  Object.freeze(path);
  const issue = Object.freeze({ code: z.ZodIssueCode.custom, path, message: code }) as z.ZodIssue;
  const error = new z.ZodError([issue]);
  Object.freeze(error.issues);
  return Object.freeze(error);
}

const invalidFenceData = () => fixedError('invalid_autonomous_capture_fence_v4_data');
const invalidResultData = () => fixedError('invalid_autonomous_capture_begin_v4_result_data');

function parseOwned<T>(value: unknown, bound: AutomaticCaptureJsonBound, schema: z.ZodType<T>): T {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, bound);
  return deepFreeze(schema.parse(owned));
}

function parseResultProjection(value: unknown): AutonomousPersonalCaptureBeginV4ResultProjection {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  const serialized = JSON.stringify(owned);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > RESULT_MAX_BYTES) {
    throw invalidResultData();
  }
  return deepFreeze(AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.parse(owned));
}

/** Bounded raw facade for the strict fence consistency schema. */
export const AutonomousPersonalCaptureFenceV4Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalCaptureFenceV4 {
    try {
      return parseOwned(value, 'policyData', AutonomousPersonalCaptureFenceV4OwnedDataSchema);
    } catch {
      throw invalidFenceData();
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalCaptureFenceV4> {
    try {
      return {
        success: true,
        data: parseOwned(value, 'policyData', AutonomousPersonalCaptureFenceV4OwnedDataSchema),
      };
    } catch {
      return { success: false, error: invalidFenceData() };
    }
  },
});

/** Bounded raw facade for the handle-free Begin4 result projection. */
export const AutonomousPersonalCaptureBeginV4ResultProjectionSchema = Object.freeze({
  parse(value: unknown): AutonomousPersonalCaptureBeginV4ResultProjection {
    try {
      return parseResultProjection(value);
    } catch {
      throw invalidResultData();
    }
  },
  safeParse(
    value: unknown,
  ): z.SafeParseReturnType<unknown, AutonomousPersonalCaptureBeginV4ResultProjection> {
    try {
      return { success: true, data: parseResultProjection(value) };
    } catch {
      return { success: false, error: invalidResultData() };
    }
  },
});
