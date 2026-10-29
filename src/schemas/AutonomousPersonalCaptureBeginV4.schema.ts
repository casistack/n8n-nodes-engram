import { z } from 'zod';
import {
  AutonomousPersonalBeginV4ContextOwnedDataSchema,
  AutonomousPersonalBeginV4RequestOwnedDataSchema,
} from './AutonomousPersonalBeginV4.schema';
import { AutonomousPersonalDescriptorV4OwnedDataSchema } from './AutonomousPersonalDescriptorV4.schema';
import type { AutonomousPersonalCaptureBeginV4ResultProjection } from './AutonomousPersonalCaptureAdmissionV4.schema';
import { type AutonomousPersonalCaptureSnapshotPreparationV4 } from './AutonomousPersonalCaptureSnapshotPreparationV4.schema';
import { AutonomousPersonalOperationV4OwnedDataSchema } from './AutonomousPersonalOperationV4.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { AutonomousPersonalCaptureFenceV4OwnedDataSchema } from './AutonomousPersonalCaptureAdmissionV4.schema';

const uuid = z.string().uuid();
const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const monotonicTime = z.number().finite().nonnegative();

/**
 * Native execution identifiers read by the fixed adapter. These values are
 * DATA copied from IExecuteFunctions and are never native-origin proof alone.
 */
export const AutonomousPersonalCaptureNativeContextV4OwnedDataSchema = z
  .object({
    instance: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.instance,
    workflow: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.workflow,
    execution: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.execution,
  })
  .strict();
export type AutonomousPersonalCaptureNativeContextV4 = z.infer<
  typeof AutonomousPersonalCaptureNativeContextV4OwnedDataSchema
>;

/** Request and actual native context held by the private attempt registry. */
export const AutonomousPersonalCaptureAttemptStartV4OwnedDataSchema = z
  .object({
    request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    nativeContext: AutonomousPersonalCaptureNativeContextV4OwnedDataSchema,
  })
  .strict();
export type AutonomousPersonalCaptureAttemptStartV4 = z.infer<
  typeof AutonomousPersonalCaptureAttemptStartV4OwnedDataSchema
>;

export const AutonomousPersonalCapturePreflightV4OwnedDataSchema = z
  .object({
    storeHash: hash64,
    binding: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.binding,
  })
  .strict();
export type AutonomousPersonalCapturePreflightV4 = z.infer<
  typeof AutonomousPersonalCapturePreflightV4OwnedDataSchema
>;

/** Stable per-invocation values allocated once before the backend callback. */
export const AutonomousPersonalCaptureAttemptScopeV4OwnedDataSchema = z
  .object({
    request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    nativeContext: AutonomousPersonalCaptureNativeContextV4OwnedDataSchema,
    descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema,
    sourceId: uuid,
    operationId: uuid,
    leaseToken: uuid,
    invocationNonce: uuid,
    startedAtMonotonicMs: monotonicTime,
    deadlineAtMonotonicMs: monotonicTime,
  })
  .strict()
  .refine((scope) => scope.deadlineAtMonotonicMs > scope.startedAtMonotonicMs);
export type AutonomousPersonalCaptureAttemptScopeV4 = z.infer<
  typeof AutonomousPersonalCaptureAttemptScopeV4OwnedDataSchema
>;

/** Actual preflight binding/store data bound to the same native attempt once. */
export const AutonomousPersonalCaptureBoundScopeV4OwnedDataSchema = z
  .object({
    request: AutonomousPersonalBeginV4RequestOwnedDataSchema,
    context: AutonomousPersonalBeginV4ContextOwnedDataSchema,
    descriptor: AutonomousPersonalDescriptorV4OwnedDataSchema,
    sourceId: uuid,
    operationId: uuid,
    leaseToken: uuid,
    invocationNonce: uuid,
    stableBeginHash: hash64,
    attemptHash: hash64,
    startedAtMonotonicMs: monotonicTime,
    deadlineAtMonotonicMs: monotonicTime,
  })
  .strict()
  .refine((scope) => scope.deadlineAtMonotonicMs > scope.startedAtMonotonicMs);
export type AutonomousPersonalCaptureBoundScopeV4 = z.infer<
  typeof AutonomousPersonalCaptureBoundScopeV4OwnedDataSchema
>;

/** Candidate DATA retained only after the fixed writer proves it is a fresh admission. */
export const AutonomousPersonalCaptureStagedFreshV4OwnedDataSchema = z
  .object({
    kind: z.literal('initial_candidate'),
    episode: EpisodicNodeSchema.strict(),
    operation: AutonomousPersonalOperationV4OwnedDataSchema,
    fence: AutonomousPersonalCaptureFenceV4OwnedDataSchema,
  })
  .strict();
export type AutonomousPersonalCaptureStagedFreshV4 = z.infer<
  typeof AutonomousPersonalCaptureStagedFreshV4OwnedDataSchema
>;

export type AutonomousPersonalCaptureSameInitialScopeV4 = Extract<
  AutonomousPersonalCaptureSnapshotPreparationV4,
  { kind: 'same_initial_scope_candidate' }
>;

export type AutonomousPersonalCaptureBeginV4FalseResult = Exclude<
  AutonomousPersonalCaptureBeginV4ResultProjection,
  { kind: 'claimed' }
>;

/** Attempt setup includes one private sticky work check; it is never serialized. */
export type AutonomousPersonalCaptureBackendAttemptV4 =
  | {
      readonly kind: 'ready';
      readonly scope: AutonomousPersonalCaptureAttemptScopeV4;
      readonly check: () => void;
    }
  | {
      readonly kind: 'decision';
      readonly result: AutonomousPersonalCaptureBeginV4FalseResult;
    };

export type AutonomousPersonalCaptureBoundBackendAttemptV4 =
  AutonomousPersonalCaptureBoundScopeV4 & { readonly check: () => void };
