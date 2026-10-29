import { canonicalAutomaticCaptureV2 } from '../schemas/AutomaticCapture.schema';
import {
  AutonomousPersonalCompletionPlanV4InputOwnedDataSchema,
  AutonomousPersonalCompletionPlanV4OwnedDataSchema,
  type AutonomousPersonalCompletionPlanV4,
  type AutonomousPersonalCompletionPlanV4Input,
} from '../schemas/AutonomousPersonalCompletionPlanV4.schema';
import {
  AutonomousPersonalNativeOriginV4OwnedDataSchema,
  type AutonomousPersonalNativeOriginV4,
  type AutonomousPersonalNativeOriginV4FailureReason,
} from '../schemas/AutonomousPersonalNativeOriginV4.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from './BoundedAutomaticCaptureJson';
import { inputAndPlanJoinV4 } from './AutonomousPersonalCompletionJoinsV4';

export type { AutonomousPersonalNativeOriginV4FailureReason } from '../schemas/AutonomousPersonalNativeOriginV4.schema';

export class AutonomousPersonalNativeOriginV4Error extends Error {
  constructor(readonly reason: AutonomousPersonalNativeOriginV4FailureReason) {
    super(`Engram autonomous personal native origin: ${reason}`);
    this.name = 'AutonomousPersonalNativeOriginV4Error';
  }
}

function fail(reason: AutonomousPersonalNativeOriginV4FailureReason): never {
  throw new AutonomousPersonalNativeOriginV4Error(reason);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalAutomaticCaptureV2(left) === canonicalAutomaticCaptureV2(right);
}

function ownInput(value: unknown, check: () => void): AutonomousPersonalCompletionPlanV4Input {
  let owned: unknown;
  try {
    owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  } catch (error) {
    check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      fail('capacity');
    }
    fail('invalid_input');
  }
  check();

  let parsed;
  try {
    parsed = AutonomousPersonalCompletionPlanV4InputOwnedDataSchema.safeParse(owned);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!parsed.success) fail('invalid_input');

  let exact: boolean;
  try {
    exact = same(owned, parsed.data);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!exact) fail('invalid_input');
  return parsed.data;
}

function ownPlannedPlan(
  value: unknown,
  check: () => void,
): Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }> {
  let owned: unknown;
  try {
    owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  } catch (error) {
    check();
    if (error instanceof BoundedAutomaticCaptureJsonError && error.reason !== 'invalid_json') {
      fail('capacity');
    }
    fail('invalid_input');
  }
  check();

  let parsed;
  try {
    parsed = AutonomousPersonalCompletionPlanV4OwnedDataSchema.safeParse(owned);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!parsed.success || parsed.data.kind !== 'planned') fail('invalid_input');

  let exact: boolean;
  try {
    exact = same(owned, parsed.data);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!exact) fail('invalid_input');
  return parsed.data;
}

function freezeData<T>(value: T, check: () => void): T {
  check();
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child, check);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the strict, bounded native-origin DATA projection for one joined
 * completion input and plan. This DATA is descriptive and grants no authority.
 */
export function projectAutonomousPersonalNativeOriginV4(
  inputValue: AutonomousPersonalCompletionPlanV4Input,
  planValue: Extract<AutonomousPersonalCompletionPlanV4, { kind: 'planned' }>,
  check: () => void,
): AutonomousPersonalNativeOriginV4 {
  check();
  const input = ownInput(inputValue, check);
  const plan = ownPlannedPlan(planValue, check);
  if (!inputAndPlanJoinV4(input, plan, check)) fail('conflict');
  check();

  const candidate = {
    version: 4 as const,
    identity: plan.operation.identity,
    instance: input.scope.context.instance,
    workflow: input.scope.context.workflow,
    execution: input.scope.context.execution,
    attemptHash: input.scope.attemptHash,
    completionCallHash: input.completionCallHash,
    terminalReceipt: plan.operation.terminalReceipt,
  };
  check();

  let parsed;
  try {
    parsed = AutonomousPersonalNativeOriginV4OwnedDataSchema.safeParse(candidate);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!parsed.success) fail('invalid_input');

  let exact: boolean;
  try {
    exact = same(candidate, parsed.data);
  } catch {
    check();
    fail('invalid_input');
  }
  check();
  if (!exact) fail('invalid_input');

  const result = freezeData(parsed.data, check);
  check();
  return result;
}
