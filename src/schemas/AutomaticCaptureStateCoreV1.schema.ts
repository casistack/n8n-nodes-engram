import { z } from 'zod';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptDispositionSchema,
  AutomaticOperationAttemptSchema,
} from './AutomaticLedgerPrimitives.schema';
import { CompositionalAutomaticCaptureOperationV3Schema } from './CompositionalAutomaticCaptureV3.schema';
import { AutonomousPersonalOperationV4OwnedDataSchema } from './AutonomousPersonalOperationV4.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const canonicalUtcMilliseconds = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  });

export const AutomaticCaptureInitialLeaseFieldsV1InputOwnedDataSchema = z
  .object({
    createdAt: canonicalUtcMilliseconds,
    invocationDeadlineMs: z
      .number()
      .int()
      .min(AUTOMATIC_LEDGER_LIMITS.minInvocationDeadlineMs)
      .max(AUTOMATIC_LEDGER_LIMITS.maxInvocationDeadlineMs),
    beginCallHash: hash64,
    leaseToken: uuid,
    initialAttemptHash: hash64,
  })
  .strict();
export type AutomaticCaptureInitialLeaseFieldsV1Input = z.infer<
  typeof AutomaticCaptureInitialLeaseFieldsV1InputOwnedDataSchema
>;

const initialAttemptV1Schema = z
  .object({
    attemptHash: hash64,
    at: canonicalUtcMilliseconds,
    disposition: z.literal('claim_won'),
  })
  .strict();

export const AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema = z
  .object({
    createdAt: canonicalUtcMilliseconds,
    lastObservedAt: canonicalUtcMilliseconds,
    attempts: z.array(initialAttemptV1Schema).length(1),
    overflowCount: z.literal(0),
    auditTruncated: z.literal(false),
    beginCallHash: hash64,
    retryCount: z.literal(0),
    state: z.literal('leased'),
    generation: z.literal(1),
    lease: z
      .object({
        token: uuid,
        acquiredAt: canonicalUtcMilliseconds,
        renewedAt: canonicalUtcMilliseconds,
        expiresAt: canonicalUtcMilliseconds,
        claimKind: z.literal('initial'),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const createdAt = Date.parse(value.createdAt);
    const attempt = value.attempts[0];
    const duration = Date.parse(value.lease.expiresAt) - createdAt;
    if (
      value.lastObservedAt !== value.createdAt ||
      !attempt ||
      attempt.at !== value.createdAt ||
      value.lease.acquiredAt !== value.createdAt ||
      value.lease.renewedAt !== value.createdAt ||
      duration < AUTOMATIC_LEDGER_LIMITS.minLeaseMs ||
      duration >
        Math.min(
          AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
          Math.max(
            AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
            AUTOMATIC_LEDGER_LIMITS.maxInvocationDeadlineMs +
              AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
          ),
        )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid initial lease field relationships',
      });
    }
  });
export type AutomaticCaptureInitialLeaseFieldsV1 = z.infer<
  typeof AutomaticCaptureInitialLeaseFieldsV1OwnedDataSchema
>;

export const AutomaticCaptureAttemptWrapperV1OwnedDataSchema = z
  .object({
    familyVersion: z.union([z.literal(3), z.literal(4)]),
    operation: z.unknown().refine((value) => value !== undefined),
    observation: z.unknown().refine((value) => value !== undefined),
  })
  .strict();
export type AutomaticCaptureAttemptWrapperV1OwnedData = z.infer<
  typeof AutomaticCaptureAttemptWrapperV1OwnedDataSchema
>;

const canonicalAttemptV4OwnedDataSchema = z
  .object({
    attemptHash: hash64,
    at: canonicalUtcMilliseconds,
    disposition: AutomaticOperationAttemptDispositionSchema,
  })
  .strict()
  .refine(
    (attempt) =>
      Buffer.byteLength(JSON.stringify(attempt), 'utf8') <= AUTOMATIC_LEDGER_LIMITS.attemptBytes,
  );

export const AutomaticCaptureAttemptUpdateV1OwnedDataSchema = z.union([
  z
    .object({ kind: z.literal('same'), familyVersion: z.union([z.literal(3), z.literal(4)]) })
    .strict(),
  z
    .object({
      kind: z.literal('not_updated'),
      familyVersion: z.union([z.literal(3), z.literal(4)]),
    })
    .strict(),
  z.discriminatedUnion('familyVersion', [
    z
      .object({
        kind: z.literal('updated'),
        familyVersion: z.literal(3),
        operation: CompositionalAutomaticCaptureOperationV3Schema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('updated'),
        familyVersion: z.literal(4),
        operation: AutonomousPersonalOperationV4OwnedDataSchema,
      })
      .strict(),
  ]),
]);
export type AutomaticCaptureAttemptUpdateV1 = z.infer<
  typeof AutomaticCaptureAttemptUpdateV1OwnedDataSchema
>;

export const AutomaticOperationAttemptV4StateCoreV1OwnedDataSchema =
  canonicalAttemptV4OwnedDataSchema;
export const AutomaticOperationAttemptV3StateCoreV1OwnedDataSchema =
  AutomaticOperationAttemptSchema;
