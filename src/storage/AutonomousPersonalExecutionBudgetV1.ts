import { hashAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AUTONOMOUS_PERSONAL_LEGACY_STAGE_ALLOWANCE_MS,
  AutonomousPersonalExecutionBudgetContextV1Schema,
  AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema,
  AutonomousPersonalExecutionBudgetResolutionV1Schema,
  AutonomousPersonalExecutionBudgetV1OwnedDataSchema,
  type AutonomousPersonalExecutionBudgetConfiguredV1OwnedData,
  type AutonomousPersonalExecutionBudgetContextV1,
  type AutonomousPersonalExecutionBudgetResolutionV1,
  type AutonomousPersonalExecutionBudgetV1OwnedData,
} from '../schemas/AutonomousPersonalExecutionBudgetV1.schema';
import { cloneBoundedAutomaticCaptureJson } from './BoundedAutomaticCaptureJson';

/** Domain separator bound into every configured budget fingerprint. */
export const AUTONOMOUS_EXECUTION_BUDGET_V1_HASH_DOMAIN = 'engram-autonomous-execution-budget-v1';

const AUTOMATIC_RESERVE_DIVISOR = 10;
const AUTOMATIC_RESERVE_MIN_MS = 20;
const AUTOMATIC_RESERVE_MAX_MS = 1_000;

export class AutonomousPersonalExecutionBudgetError extends Error {
  constructor(readonly reason: 'fixed_reserve_not_below_overall' | 'non_finite_deadline') {
    super(`Engram autonomous execution budget: ${reason}`);
    this.name = 'AutonomousPersonalExecutionBudgetError';
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Immutable default: inherit completion, inherit syntax, automatic reserve. */
export const DEFAULT_CONFIGURED_EXECUTION_BUDGET_V1: AutonomousPersonalExecutionBudgetConfiguredV1OwnedData =
  deepFreeze(
    AutonomousPersonalExecutionBudgetConfiguredV1OwnedDataSchema.parse({
      semantics: 'configured',
      version: 1,
      completion: { mode: 'inheritOverall' },
      syntax: { mode: 'inheritOverall' },
      finalizationReserve: { mode: 'automatic' },
    }),
  );

/** Clone through the bounded plain-data boundary before any schema property access. */
function ownBudget(input: unknown): AutonomousPersonalExecutionBudgetV1OwnedData {
  const cloned = cloneBoundedAutomaticCaptureJson<unknown>(input, 'policyData');
  return deepFreeze(AutonomousPersonalExecutionBudgetV1OwnedDataSchema.parse(cloned));
}

/**
 * Compile untrusted compiler input into frozen, tagged budget DATA.
 * Only a missing (`undefined`) input maps to legacy; null, unknown keys/modes/versions,
 * coercible strings and invalid numbers are errors. Omit optional keys rather than
 * passing `undefined` values: the bounded clone rejects them.
 */
export function compileAutonomousPersonalExecutionBudgetV1(
  input: unknown,
): AutonomousPersonalExecutionBudgetV1OwnedData {
  if (input === undefined) return deepFreeze({ semantics: 'legacy' as const });
  return ownBudget(input);
}

/**
 * Canonical fingerprint of a configured budget, binding every field and mode.
 * Legacy returns null; callers must not write that null into an old descriptor.
 */
export function hashAutonomousPersonalExecutionBudgetV1(input: unknown): string | null {
  const budget = ownBudget(input);
  if (budget.semantics === 'legacy') return null;
  return hashAutomaticCaptureV2({
    domain: AUTONOMOUS_EXECUTION_BUDGET_V1_HASH_DOMAIN,
    budget,
  });
}

/**
 * clamp(ceil(overall / 10), 20, 1000), matching the existing reserve recipe. Private:
 * it trusts its argument, so callers go through the validating resolver.
 */
function automaticFinalizationReserveMsV1(configuredOverallMs: number): number {
  return Math.min(
    AUTOMATIC_RESERVE_MAX_MS,
    Math.max(AUTOMATIC_RESERVE_MIN_MS, Math.ceil(configuredOverallMs / AUTOMATIC_RESERVE_DIVISOR)),
  );
}

function requireFinite(value: number): number {
  if (!Number.isFinite(value))
    throw new AutonomousPersonalExecutionBudgetError('non_finite_deadline');
  return value;
}

/**
 * Resolve a budget against explicit monotonic anchors. Pure DATA: no clock reads, no I/O,
 * no authority. A past deadline from an expired lease is reported, never extended.
 * The syntax allowance is the ORIGINAL cumulative limit from native entry and is never
 * rebased at completion. `legacy` reports its documented allowance but no meter exists.
 */
export function resolveAutonomousPersonalExecutionBudgetV1(
  budgetInput: unknown,
  contextInput: unknown,
): AutonomousPersonalExecutionBudgetResolutionV1 {
  const budget = ownBudget(budgetInput);
  const context: AutonomousPersonalExecutionBudgetContextV1 =
    AutonomousPersonalExecutionBudgetContextV1Schema.parse(
      cloneBoundedAutomaticCaptureJson<unknown>(contextInput, 'policyData'),
    );

  const overallMs = context.configuredOverallMs;
  let reserveMs = automaticFinalizationReserveMsV1(overallMs);
  if (budget.semantics === 'configured' && budget.finalizationReserve.mode === 'fixed') {
    reserveMs = budget.finalizationReserve.durationMs;
    if (reserveMs >= overallMs) {
      throw new AutonomousPersonalExecutionBudgetError('fixed_reserve_not_below_overall');
    }
  }

  const configuredAllowanceAt = requireFinite(context.originalStartedAt + overallMs);
  const originalCeilingAt = Math.min(context.originalOverallDeadlineAt, configuredAllowanceAt);
  const effectiveOverallDeadlineAt = Math.min(originalCeilingAt, context.existingLeaseDeadlineAt);
  // The reserve stays inside an earlier lease ceiling. A result at or before the
  // current time is honest expired DATA, never processing permission.
  const providerDeadlineAt = requireFinite(effectiveOverallDeadlineAt - reserveMs);

  let stageDurationMs: number | null;
  let syntaxAllowanceMs: number | null;
  if (budget.semantics === 'legacy') {
    stageDurationMs = AUTONOMOUS_PERSONAL_LEGACY_STAGE_ALLOWANCE_MS;
    syntaxAllowanceMs = AUTONOMOUS_PERSONAL_LEGACY_STAGE_ALLOWANCE_MS;
  } else {
    stageDurationMs = budget.completion.mode === 'limited' ? budget.completion.durationMs : null;
    syntaxAllowanceMs = budget.syntax.mode === 'limited' ? budget.syntax.durationMs : null;
  }

  let completionDeadlineAt: number | null = null;
  let completionByOverall = false;
  if (context.completionStartedAt !== undefined) {
    if (stageDurationMs === null) {
      completionDeadlineAt = effectiveOverallDeadlineAt;
    } else {
      const stageEndAt = requireFinite(context.completionStartedAt + stageDurationMs);
      completionDeadlineAt = Math.min(effectiveOverallDeadlineAt, stageEndAt);
      completionByOverall = stageEndAt > effectiveOverallDeadlineAt;
    }
  }

  return deepFreeze(
    AutonomousPersonalExecutionBudgetResolutionV1Schema.parse({
      semantics: budget.semantics,
      version: budget.semantics === 'configured' ? budget.version : null,
      originalCeilingAt,
      effectiveOverallDeadlineAt,
      finalizationReserveMs: reserveMs,
      providerDeadlineAt,
      phase: context.completionStartedAt === undefined ? 'notStarted' : 'started',
      completionDeadlineAt,
      syntaxAllowanceMs,
      fingerprint:
        budget.semantics === 'configured'
          ? hashAutomaticCaptureV2({
              domain: AUTONOMOUS_EXECUTION_BUDGET_V1_HASH_DOMAIN,
              budget,
            })
          : null,
      clipped: {
        overallByConfiguredAllowance: configuredAllowanceAt < context.originalOverallDeadlineAt,
        overallByLease: context.existingLeaseDeadlineAt < originalCeilingAt,
        providerByReserve: providerDeadlineAt < effectiveOverallDeadlineAt,
        completionByOverall,
      },
    }),
  );
}
