import { types } from 'node:util';
import type { AutonomousPersonalStatementContextV1 } from '../schemas/AutonomousPersonalDescriptorV4.schema';

/** Saved static opt-in parameter. Only the literal `contextQualifiedV1` selects the opt-in body. */
export const AUTOMATIC_STATEMENT_CONTEXT_MODE_PARAMETER = 'automaticStatementContextMode';

/** Fixed diagnostic: never echoes parameter names, values or expressions. */
export class AutonomousPersonalStatementContextConfigError extends Error {
  constructor() {
    super('Engram native statement context config: invalid');
    this.name = 'AutonomousPersonalStatementContextConfigError';
  }
}

function fail(): never {
  throw new AutonomousPersonalStatementContextConfigError();
}

/**
 * Read only the own data value of the raw mode. No getters, coercion, proxy traps or cloning of
 * unrelated parameters. A missing key means legacy, so the caller writes no descriptor key.
 */
export function readNativeAutonomousPersonalStatementContextV1(
  rawNodeParameters: unknown,
): AutonomousPersonalStatementContextV1 | undefined {
  if (rawNodeParameters === null || typeof rawNodeParameters !== 'object') return fail();
  // isProxy is checked first: every later reflective call could run a trap.
  if (types.isProxy(rawNodeParameters) || Array.isArray(rawNodeParameters)) return fail();
  const prototype = Object.getPrototypeOf(rawNodeParameters);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(
    rawNodeParameters,
    AUTOMATIC_STATEMENT_CONTEXT_MODE_PARAMETER,
  );
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) return fail();
  if (descriptor.value === 'off') return undefined;
  if (descriptor.value === 'contextQualifiedV1') {
    return Object.freeze({ version: 1 as const, mode: 'literal_context_qualified' as const });
  }
  return fail();
}
