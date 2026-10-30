import { types } from 'node:util';
import type { AutonomousPersonalExecutionBudgetConfiguredV1OwnedData } from '../schemas/AutonomousPersonalExecutionBudgetV1.schema';
import { compileAutonomousPersonalExecutionBudgetV1 } from '../storage/AutonomousPersonalExecutionBudgetV1';

/** Saved static opt-in parameter. Only the literal `configuredV1` selects the configured body. */
export const AUTOMATIC_EXECUTION_BUDGET_MODE_PARAMETER = 'automaticExecutionBudgetMode';

/** Visible defaults for the later UI; bounds stay in the Zod budget schema. */
export const AUTOMATIC_EXECUTION_BUDGET_NATIVE_DEFAULTS = Object.freeze({
  completionMode: 'inheritOverall',
  completionLimitedMs: 30_000,
  syntaxMode: 'inheritOverall',
  syntaxLimitedMs: 30_000,
  reserveMode: 'automatic',
  reserveFixedMs: 1_000,
});

/** Fixed diagnostic: never echoes parameter names, values or expressions. */
export class AutonomousPersonalExecutionBudgetConfigError extends Error {
  constructor() {
    super('Engram native execution budget config: invalid');
    this.name = 'AutonomousPersonalExecutionBudgetConfigError';
  }
}

type ParameterReader = (name: string, fallback: unknown) => unknown;

function fail(): never {
  throw new AutonomousPersonalExecutionBudgetConfigError();
}

/**
 * Read only the own data value of the raw mode. No getters, coercion, proxy traps or
 * cloning of unrelated parameters. Missing key means legacy (undefined).
 */
function readRawMode(parameters: unknown): 'legacy' | 'configuredV1' {
  if (parameters === null || typeof parameters !== 'object') return fail();
  // isProxy is checked first: every later reflective call could run a trap.
  if (types.isProxy(parameters) || Array.isArray(parameters)) return fail();
  const prototype = Object.getPrototypeOf(parameters);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(
    parameters,
    AUTOMATIC_EXECUTION_BUDGET_MODE_PARAMETER,
  );
  if (descriptor === undefined) return 'legacy';
  if (!('value' in descriptor)) return fail();
  if (descriptor.value === 'legacy' || descriptor.value === 'configuredV1') return descriptor.value;
  return fail();
}

function readStage(get: ParameterReader, modeName: string, msName: string, fallbackMs: number) {
  const mode = get(modeName, 'inheritOverall');
  if (mode === 'inheritOverall') return { mode: 'inheritOverall' as const };
  if (mode === 'limited') return { mode: 'limited' as const, durationMs: get(msName, fallbackMs) };
  return fail();
}

/**
 * Map the static raw opt-in plus per-item resolved values to a frozen configured budget.
 * Returns undefined for legacy so callers never write a legacy key. Malformed values are
 * rejected by the budget compiler; nothing is coerced.
 */
export function readNativeAutonomousPersonalExecutionBudgetV1(
  rawNodeParameters: unknown,
  get: ParameterReader,
): AutonomousPersonalExecutionBudgetConfiguredV1OwnedData | undefined {
  if (readRawMode(rawNodeParameters) === 'legacy') return undefined;
  const defaults = AUTOMATIC_EXECUTION_BUDGET_NATIVE_DEFAULTS;

  try {
    const completion = readStage(
      get,
      'automaticCompletionBudgetMode',
      'automaticCompletionBudgetMs',
      defaults.completionLimitedMs,
    );
    const syntax = readStage(
      get,
      'automaticSyntaxBudgetMode',
      'automaticSyntaxBudgetMs',
      defaults.syntaxLimitedMs,
    );
    const reserveMode = get('automaticFinalizationReserveMode', defaults.reserveMode);
    let finalizationReserve: unknown;
    if (reserveMode === 'automatic') finalizationReserve = { mode: 'automatic' };
    else if (reserveMode === 'fixed') {
      finalizationReserve = {
        mode: 'fixed',
        durationMs: get('automaticFinalizationReserveMs', defaults.reserveFixedMs),
      };
    } else return fail();

    const budget = compileAutonomousPersonalExecutionBudgetV1({
      semantics: 'configured',
      version: 1,
      completion,
      syntax,
      finalizationReserve,
    });
    if (budget.semantics !== 'configured') return fail();
    return budget;
  } catch {
    return fail();
  }
}
