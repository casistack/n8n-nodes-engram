import { z } from 'zod';

/** Inclusive bounds shared by the configured stage limits and the overall allowance. */
export const AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS = Object.freeze({
  overallMs: Object.freeze({ min: 100, max: 120_000 }),
  stageLimitMs: Object.freeze({ min: 100, max: 120_000 }),
  fixedReserveMs: Object.freeze({ min: 20, max: 5_000 }),
});

/** Fixed completion and syntax allowance used by the legacy workflows. */
export const AUTONOMOUS_PERSONAL_LEGACY_STAGE_ALLOWANCE_MS = 5_000;

const safeMs = (min: number, max: number) => z.number().int().safe().min(min).max(max);
const finiteMs = z.number().finite();

const { stageLimitMs, fixedReserveMs, overallMs } = AUTONOMOUS_PERSONAL_EXECUTION_BUDGET_V1_BOUNDS;

export const AutonomousPersonalExecutionStageLimitV1Schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inheritOverall') }).strict(),
  z
    .object({
      mode: z.literal('limited'),
      durationMs: safeMs(stageLimitMs.min, stageLimitMs.max),
    })
    .strict(),
]);
export type AutonomousPersonalExecutionStageLimitV1 = z.infer<
  typeof AutonomousPersonalExecutionStageLimitV1Schema
>;

export const AutonomousPersonalExecutionFinalizationReserveV1Schema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('automatic') }).strict(),
  z
    .object({
      mode: z.literal('fixed'),
      durationMs: safeMs(fixedReserveMs.min, fixedReserveMs.max),
    })
    .strict(),
]);
export type AutonomousPersonalExecutionFinalizationReserveV1 = z.infer<
  typeof AutonomousPersonalExecutionFinalizationReserveV1Schema
>;

/** Distinct tag for workflows that predate configured budgets. Carries no limits. */
export const AutonomousPersonalExecutionBudgetLegacyOwnedDataSchema = z
  .object({ semantics: z.literal('legacy') })
  .strict();
export type AutonomousPersonalExecutionBudgetLegacyOwnedData = z.infer<
  typeof AutonomousPersonalExecutionBudgetLegacyOwnedDataSchema
>;

export const AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema = z
  .object({
    semantics: z.literal('configured'),
    version: z.literal(1),
    completion: AutonomousPersonalExecutionStageLimitV1Schema,
    syntax: AutonomousPersonalExecutionStageLimitV1Schema,
    finalizationReserve: AutonomousPersonalExecutionFinalizationReserveV1Schema,
  })
  .strict();
export type AutonomousPersonalExecutionBudgetConfiguredV1OwnedData = z.infer<
  typeof AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema
>;

export const AutonomousPersonalExecutionBudgetV1OwnedDataSchema = z.discriminatedUnion(
  'semantics',
  [
    AutonomousPersonalExecutionBudgetLegacyOwnedDataSchema,
    AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema,
  ],
);
export type AutonomousPersonalExecutionBudgetV1OwnedData = z.infer<
  typeof AutonomousPersonalExecutionBudgetV1OwnedDataSchema
>;

/**
 * Explicit monotonic anchors. Every value is supplied by the caller; resolution
 * never reads a clock. `completionStartedAt` is omitted while the phase has not begun.
 */
export const AutonomousPersonalExecutionBudgetContextV1Schema = z
  .object({
    originalStartedAt: finiteMs.min(0),
    configuredOverallMs: safeMs(overallMs.min, overallMs.max),
    originalOverallDeadlineAt: finiteMs,
    existingLeaseDeadlineAt: finiteMs.min(0),
    completionStartedAt: finiteMs.min(0).optional(),
  })
  .strict()
  .superRefine((context, ctx) => {
    if (context.originalOverallDeadlineAt <= context.originalStartedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Original overall deadline must be after the original start',
        path: ['originalOverallDeadlineAt'],
      });
    }
    if (
      context.completionStartedAt !== undefined &&
      context.completionStartedAt < context.originalStartedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completion phase cannot start before the original start',
        path: ['completionStartedAt'],
      });
    }
  });
export type AutonomousPersonalExecutionBudgetContextV1 = z.infer<
  typeof AutonomousPersonalExecutionBudgetContextV1Schema
>;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);

/** Resolved deadlines are DATA only; they grant no processing authority. */
export const AutonomousPersonalExecutionBudgetResolutionV1Schema = z
  .object({
    semantics: z.enum(['legacy', 'configured']),
    version: z.literal(1).nullable(),
    originalCeilingAt: finiteMs,
    effectiveOverallDeadlineAt: finiteMs,
    finalizationReserveMs: safeMs(fixedReserveMs.min, fixedReserveMs.max),
    providerDeadlineAt: finiteMs,
    phase: z.enum(['notStarted', 'started']),
    completionDeadlineAt: finiteMs.nullable(),
    /** Original cumulative active-work limit from native entry; null means inherit. */
    syntaxAllowanceMs: safeMs(stageLimitMs.min, stageLimitMs.max).nullable(),
    fingerprint: hash64.nullable(),
    clipped: z
      .object({
        overallByConfiguredAllowance: z.boolean(),
        overallByLease: z.boolean(),
        providerByReserve: z.boolean(),
        completionByOverall: z.boolean(),
      })
      .strict(),
  })
  .strict()
  // Intrinsic DATA consistency only: not proof, authority, or a fingerprint recomputation.
  .superRefine((resolution, ctx) => {
    const invalid = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });

    if (resolution.semantics === 'configured') {
      if (resolution.version !== 1) invalid('version', 'Configured resolution requires version 1');
      if (resolution.fingerprint === null) {
        invalid('fingerprint', 'Configured resolution requires a fingerprint');
      }
    } else {
      if (resolution.version !== null) invalid('version', 'Legacy resolution has no version');
      if (resolution.fingerprint !== null) {
        invalid('fingerprint', 'Legacy resolution has no fingerprint');
      }
      if (resolution.syntaxAllowanceMs !== AUTONOMOUS_PERSONAL_LEGACY_STAGE_ALLOWANCE_MS) {
        invalid('syntaxAllowanceMs', 'Legacy resolution reports the documented allowance');
      }
    }

    if (resolution.phase === 'notStarted') {
      if (resolution.completionDeadlineAt !== null) {
        invalid('completionDeadlineAt', 'Unstarted phase has no completion deadline');
      }
      if (resolution.clipped.completionByOverall) {
        invalid('clipped', 'Unstarted phase cannot be clipped by the overall deadline');
      }
    } else if (resolution.completionDeadlineAt === null) {
      invalid('completionDeadlineAt', 'Started phase requires a completion deadline');
    } else if (resolution.completionDeadlineAt > resolution.effectiveOverallDeadlineAt) {
      invalid('completionDeadlineAt', 'Completion cannot extend past the effective overall');
    }

    if (resolution.effectiveOverallDeadlineAt > resolution.originalCeilingAt) {
      invalid('effectiveOverallDeadlineAt', 'Effective overall cannot extend the original ceiling');
    }
    if (resolution.providerDeadlineAt > resolution.effectiveOverallDeadlineAt) {
      invalid('providerDeadlineAt', 'Provider deadline cannot extend the effective overall');
    }
  });
export type AutonomousPersonalExecutionBudgetResolutionV1 = z.infer<
  typeof AutonomousPersonalExecutionBudgetResolutionV1Schema
>;
