import { z } from 'zod';

/** Four invocation purposes; each later read and final save opens its own fresh scope. */
export const AutonomousPersonalExecutionScopePurposeV1Schema = z.enum([
  'adminCapture',
  'memoryPrepare',
  'memoryRead',
  'memorySave',
]);
export type AutonomousPersonalExecutionScopePurposeV1 = z.infer<
  typeof AutonomousPersonalExecutionScopePurposeV1Schema
>;

/** Closed reasons for genuine time exhaustion or cancellation (budget errors). */
export const AutonomousPersonalExecutionScopeBudgetStopReasonV1Schema = z.enum([
  'invocation_deadline',
  'stage_deadline',
  'syntax_allowance',
  'parent_cancelled',
  'stage_cancelled',
]);
export type AutonomousPersonalExecutionScopeBudgetStopReasonV1 = z.infer<
  typeof AutonomousPersonalExecutionScopeBudgetStopReasonV1Schema
>;

/** Clock failures are not budget stops; they stay distinct from deadline/cancellation. */
export const AutonomousPersonalExecutionScopeClockFailureV1Schema = z.enum([
  'clock_invalid',
  'clock_regression',
]);

export const AutonomousPersonalExecutionScopeFirstStopV1Schema = z.union([
  AutonomousPersonalExecutionScopeBudgetStopReasonV1Schema,
  AutonomousPersonalExecutionScopeClockFailureV1Schema,
]);
export type AutonomousPersonalExecutionScopeFirstStopV1 = z.infer<
  typeof AutonomousPersonalExecutionScopeFirstStopV1Schema
>;

/** Fixed non-budget error reasons. Never classified as a harmless post-ACK timeout. */
export const AutonomousPersonalExecutionScopeErrorReasonV1Schema = z.enum([
  'invalid_scope',
  'invalid_configuration',
  'configuration_conflict',
  'scope_not_bound',
  'scope_closed',
  'scope_already_running',
  'nested_scope',
  'foreign_scope',
  'async_span_misuse',
  'clock_invalid',
  'clock_regression',
]);
export type AutonomousPersonalExecutionScopeErrorReasonV1 = z.infer<
  typeof AutonomousPersonalExecutionScopeErrorReasonV1Schema
>;

const finiteMs = z.number().finite();

/**
 * Bounded diagnostic DATA only. No context, signals, callbacks, timers, prompts or raw
 * errors; it is not proof or authority and cannot be fed back as a scope.
 */
export const AutonomousPersonalExecutionScopeDiagnosticsV1Schema = z
  .object({
    version: z.literal(1),
    purpose: AutonomousPersonalExecutionScopePurposeV1Schema,
    bound: z.boolean(),
    closed: z.boolean(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    originalDeadlineMs: finiteMs.nullable(),
    effectiveDeadlineMs: finiteMs.nullable(),
    syntaxAllowanceMs: z.number().int().safe().min(0).nullable(),
    chargedSyntaxMs: finiteMs.min(0),
    activeDepth: z.number().int().min(0),
    firstStop: AutonomousPersonalExecutionScopeFirstStopV1Schema.nullable(),
  })
  .strict();
export type AutonomousPersonalExecutionScopeDiagnosticsV1 = z.infer<
  typeof AutonomousPersonalExecutionScopeDiagnosticsV1Schema
>;
