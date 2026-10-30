import { z } from 'zod';
import {
  AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema,
  AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS,
} from './AutonomousPersonalExecutionBudgetV1.schema';
import { AutonomousPersonalExecutionScopeFirstStopV1Schema } from './AutonomousPersonalExecutionScopeV1.schema';

const finiteMs = z.number().finite().min(0);
const overallMs = z
  .number()
  .int()
  .safe()
  .min(AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS.overallMs.min)
  .max(AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS.overallMs.max);

export const AutonomousPersonalExecutionDiagnosticsStageV1Schema = z.enum([
  'initialize',
  'begin',
  'provider_preflight',
  'provider',
  'selection',
  'completion',
  'readback',
  'handoff',
  'final_check',
]);

/** Bounded configured-run observations. This DATA is never execution authority or a receipt. */
export const AutonomousPersonalExecutionDiagnosticsV1Schema = z
  .object({
    version: z.literal(1),
    lastReachedStage: AutonomousPersonalExecutionDiagnosticsStageV1Schema.nullable(),
    /** Null when the final monotonic sample is invalid or regresses. */
    elapsedMs: finiteMs.nullable(),
    cumulativeSynchronousWorkMs: finiteMs,
    configured: z
      .object({
        overallMs,
        completion: AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.shape.completion,
        syntax: AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.shape.syntax,
        finalizationReserve:
          AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.shape.finalizationReserve,
      })
      .strict(),
    effective: z
      .object({
        overallMs: finiteMs,
        /** Remains null until the trusted completion resolver has run. */
        completionMs: finiteMs.nullable(),
        /** Null means syntax inherits the outer wall deadline without its own synchronous-work allowance. */
        syntaxMs: finiteMs.nullable(),
        finalizationReserveMs: finiteMs,
      })
      .strict(),
    firstStop: AutonomousPersonalExecutionScopeFirstStopV1Schema.nullable(),
  })
  .strict();

export type AutonomousPersonalExecutionDiagnosticsV1 = z.infer<
  typeof AutonomousPersonalExecutionDiagnosticsV1Schema
>;
