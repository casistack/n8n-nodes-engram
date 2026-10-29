import { z } from 'zod';
import { EpisodicNodeSchema, type EpisodicNode } from './EpisodicNode.schema';
import {
  AutonomousPersonalDescriptorV4OwnedDataSchema,
  type AutonomousPersonalDescriptorV4,
} from './AutonomousPersonalDescriptorV4.schema';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from './AutonomousPersonalOperationV4.schema';
import {
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema,
  AutonomousPersonalCaptureFenceV4OwnedDataSchema,
} from './AutonomousPersonalCaptureAdmissionV4.schema';
import type { AutonomousPersonalCaptureBeginV4FalseResult } from './AutonomousPersonalCaptureBeginV4.schema';
import { AutonomousPersonalBeginV4ContextOwnedDataSchema } from './AutonomousPersonalBeginV4.schema';
import { reconstructAutonomousPersonalStoredSourceIdentityV4 } from './AutonomousPersonalSourceV4.schema';
import { canonicalAutomaticCaptureV2, hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  });

// Validate without replacing the raw row with a stripping/normalizing parser's output.
// Full Source4 reconstruction below rejects any unexplained field or normalization.
const source: z.ZodType<EpisodicNode> = z.custom<EpisodicNode>(
  (value) => EpisodicNodeSchema.strict().safeParse(value).success,
);
const descriptor: z.ZodType<AutonomousPersonalDescriptorV4> =
  AutonomousPersonalDescriptorV4OwnedDataSchema;
const operation: z.ZodType<
  Extract<AutonomousPersonalOperationV4, { state: 'leased' }>,
  z.ZodTypeDef,
  unknown
> = AutonomousPersonalOperationV4OwnedDataSchema.refine(
  (value): value is Extract<AutonomousPersonalOperationV4, { state: 'leased' }> =>
    value.state === 'leased',
);
const falseResult: z.ZodType<AutonomousPersonalCaptureBeginV4FalseResult, z.ZodTypeDef, unknown> =
  AutonomousPersonalCaptureBeginV4ResultProjectionOwnedDataSchema.refine(
    (value): value is AutonomousPersonalCaptureBeginV4FalseResult => value.kind !== 'claimed',
  );

const readyBody = z
  .object({
    kind: z.literal('ready'),
    source,
    descriptor,
    refs: z
      .object({
        sourceId: z.string().uuid(),
        operationId: z.string().uuid(),
        sourceHash: hash,
        descriptorHash: hash,
        beginCallHash: hash,
        identityHash: hash,
        attemptHash: hash,
        leaseRenewedAt: utc,
      })
      .strict(),
  })
  .strict();

/** Actual-row projection DATA only; its parsing does not establish backend origin. */
export const AutonomousPersonalCaptureProviderPreflightReadyV4OwnedDataSchema =
  readyBody.superRefine((value, context) => {
    try {
      const rebuilt = reconstructAutonomousPersonalStoredSourceIdentityV4({
        source: value.source,
        descriptor: value.descriptor,
      });
      if (
        canonicalAutomaticCaptureV2(rebuilt.source) !== canonicalAutomaticCaptureV2(value.source) ||
        value.refs.sourceId !== value.source.uuid ||
        value.refs.sourceHash !== rebuilt.tuple.identity.sourceHash ||
        value.refs.descriptorHash !== rebuilt.tuple.owner.descriptorHash ||
        value.refs.identityHash !== hashAutomaticCaptureV2(rebuilt.tuple.identity) ||
        value.refs.leaseRenewedAt !== value.source.created_at
      )
        throw new Error('projection_mismatch');
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid source preflight projection',
      });
    }
  });
export type AutonomousPersonalCaptureProviderPreflightReadyV4 = z.infer<
  typeof AutonomousPersonalCaptureProviderPreflightReadyV4OwnedDataSchema
>;
export const AutonomousPersonalCaptureProviderPreflightV4OwnedDataSchema = z.union([
  AutonomousPersonalCaptureProviderPreflightReadyV4OwnedDataSchema,
  falseResult,
]);
export type AutonomousPersonalCaptureProviderPreflightV4 = z.infer<
  typeof AutonomousPersonalCaptureProviderPreflightV4OwnedDataSchema
>;

/** Backend-owned observation DATA, never a caller-created authorization token. */
export const AutonomousPersonalCaptureProviderObservationV4OwnedDataSchema = z
  .object({
    source,
    descriptor,
    operation,
    fence: AutonomousPersonalCaptureFenceV4OwnedDataSchema,
    binding: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.binding,
    backendNow: utc,
    readStartedAtMonotonicMs: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const rebuilt = reconstructAutonomousPersonalStoredSourceIdentityV4({
        source: value.source,
        descriptor: value.descriptor,
      });
      const op = value.operation;
      const fence = value.fence;
      if (
        canonicalAutomaticCaptureV2(rebuilt.source) !== canonicalAutomaticCaptureV2(value.source) ||
        canonicalAutomaticCaptureV2(op.identity) !==
          canonicalAutomaticCaptureV2(rebuilt.tuple.identity) ||
        canonicalAutomaticCaptureV2(op.descriptor) !==
          canonicalAutomaticCaptureV2(value.descriptor) ||
        canonicalAutomaticCaptureV2(value.binding) !==
          canonicalAutomaticCaptureV2(rebuilt.tuple.owner.binding) ||
        op.createdAt !== value.source.created_at ||
        op.lease.acquiredAt !== op.createdAt ||
        op.lease.renewedAt !== value.source.created_at ||
        Date.parse(value.backendNow) < Date.parse(op.lastObservedAt) ||
        Date.parse(value.backendNow) >= Date.parse(op.lease.expiresAt) ||
        op.lease.claimKind !== 'initial' ||
        op.generation !== 1 ||
        op.retryCount !== 0 ||
        op.attempts[0]?.disposition !== 'claim_won' ||
        op.attempts[0]?.at !== op.createdAt ||
        fence.operationId !== op.operationId ||
        fence.sourceId !== value.source.uuid ||
        fence.descriptorHash !== rebuilt.tuple.owner.descriptorHash ||
        fence.identityHash !== hashAutomaticCaptureV2(op.identity) ||
        fence.sourceHash !== rebuilt.tuple.identity.sourceHash ||
        fence.envelopeHash !== hashAutomaticCaptureV2(rebuilt.tuple.envelope) ||
        fence.beginCallHash !== op.beginCallHash ||
        fence.token !== op.lease.token ||
        fence.planTimestamp !== op.lease.renewedAt
      )
        throw new Error('observation_mismatch');
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid source preflight observation',
      });
    }
  });
export type AutonomousPersonalCaptureProviderObservationV4 = z.infer<
  typeof AutonomousPersonalCaptureProviderObservationV4OwnedDataSchema
>;

/** Host cancellation is not a persisted cancellation receipt. */
export const AutonomousPersonalCaptureProviderCancelledV4OwnedDataSchema = z
  .object({ kind: z.literal('cancelled'), eligibleFirstCommit: z.literal(false) })
  .strict();

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function invalid(): z.ZodError {
  const error = new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'invalid_autonomous_provider_preflight_data',
    },
  ]);
  freeze(error.issues);
  return Object.freeze(error) as z.ZodError;
}
function facade<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  const parse = (value: unknown): T => {
    try {
      return freeze(schema.parse(cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest')));
    } catch {
      throw invalid();
    }
  };
  return Object.freeze({
    parse,
    safeParse(value: unknown) {
      try {
        return { success: true as const, data: parse(value) };
      } catch {
        return { success: false as const, error: invalid() };
      }
    },
  });
}
export const AutonomousPersonalCaptureProviderPreflightV4Schema = facade(
  AutonomousPersonalCaptureProviderPreflightV4OwnedDataSchema,
);
export const AutonomousPersonalCaptureProviderObservationV4Schema = facade(
  AutonomousPersonalCaptureProviderObservationV4OwnedDataSchema,
);
