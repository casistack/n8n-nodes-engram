import { types as utilTypes } from 'node:util';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { AutonomousPersonalExecutionDiagnosticsV1 } from '../schemas/AutonomousPersonalExecutionDiagnosticsV1.schema';
import {
  AutonomousPersonalExecutionScopeError,
  bindAutonomousPersonalExecutionScopeV1,
  clipAutonomousPersonalExecutionScopeLeaseV1,
  closeAutonomousPersonalExecutionScopeV1,
  currentAutonomousPersonalExecutionScopeV1,
  currentAutonomousPersonalExecutionScopeWorkV1,
  diagnoseAutonomousPersonalExecutionScopeV1,
  getLatestAutonomousPersonalExecutionDiagnosticsV1,
  openAutonomousPersonalExecutionScopeV1,
  runAutonomousPersonalExecutionScopeV1,
  type AutonomousPersonalExecutionScopeEntryV1,
} from '../storage/AutonomousPersonalExecutionScopeV1';
import {
  AUTOMATIC_EXECUTION_BUDGET_MODE_PARAMETER,
  readNativeAutonomousPersonalExecutionBudgetV1,
} from './autonomousPersonalExecutionBudget';
import type { AutonomousPersonalExecutionBudgetConfiguredV1OwnedData } from '../schemas/AutonomousPersonalExecutionBudgetV1.schema';

const PURPOSE = 'adminCapture';
const DEFAULT_OVERALL_MS = 30_000;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

type EntryControls = Readonly<{
  budget: AutonomousPersonalExecutionBudgetConfiguredV1OwnedData;
  overallMs: unknown;
  signal: AbortSignal | undefined;
}>;

/**
 * Private timing of the ONE original Admin capture entry. The values come from the scope's own
 * registry (original deadline minus the validated overall), never from caller DATA.
 */
export type AutonomousPersonalEntryTimingV1 =
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{
      kind: 'entry';
      entry: AutonomousPersonalExecutionScopeEntryV1;
      startedAtMonotonicMs: number;
      originalDeadlineAtMonotonicMs: number;
      effectiveDeadlineAtMonotonicMs: number;
      overallMs: number;
      fingerprint: string;
    }>;

/**
 * Explicit raw opt-in only: the own data value `configuredV1` on the saved node parameters of
 * the autonomous capture. Anything else (missing, legacy, malformed) is the original path.
 */
export function isConfiguredAutonomousPersonalCaptureV1(ctx: IExecuteFunctions): boolean {
  try {
    const parameters: unknown = ctx.getNode()?.parameters;
    if (parameters === null || typeof parameters !== 'object' || utilTypes.isProxy(parameters)) {
      return false;
    }
    const own = (name: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(parameters, name);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    return (
      own(AUTOMATIC_EXECUTION_BUDGET_MODE_PARAMETER) === 'configuredV1' &&
      own('automaticPreferenceInterpreter') === 'autonomousPersonalV1' &&
      own('resource') === 'automaticMemory'
    );
  } catch {
    return false;
  }
}

function readCancelSignal(ctx: IExecuteFunctions): AbortSignal | undefined {
  const getter = ctx.getExecutionCancelSignal;
  if (typeof getter !== 'function') return undefined;
  const signal = getter.call(ctx);
  if (signal === undefined) return undefined;
  if (signal === null || typeof signal !== 'object' || !nativeAborted) throw new Error();
  nativeAborted.call(signal);
  return signal;
}

/** Synchronous reads of the resolved controls: no awaits, no credentials, no storage. */
function readControls(ctx: IExecuteFunctions): EntryControls {
  const parameters = ctx.getNode().parameters;
  const get = (name: string, fallback: unknown) =>
    ctx.getNodeParameter(name, 0, fallback as string);
  const budget = readNativeAutonomousPersonalExecutionBudgetV1(parameters, get);
  if (budget === undefined) throw new Error();
  return {
    budget,
    overallMs: get('extractionDeadlineMs', DEFAULT_OVERALL_MS),
    signal: readCancelSignal(ctx),
  };
}

function bindControls(
  entry: AutonomousPersonalExecutionScopeEntryV1,
  ctx: IExecuteFunctions,
  controls: EntryControls,
): void {
  bindAutonomousPersonalExecutionScopeV1(
    entry,
    ctx,
    controls.budget,
    controls.overallMs,
    controls.signal,
  );
}

/**
 * Fixed Admin/native entry. T0 is opened BEFORE any resolved control, credential or storage
 * work, and the body/overall/native signal are bound synchronously before the first await.
 * A current same-context entry is reused after an identical-configuration assertion and is
 * never restarted. Missing or legacy mode calls the original path unchanged.
 */
export async function runWithAutonomousPersonalExecutionEntryV1<T>(
  ctx: IExecuteFunctions,
  body: () => Promise<T>,
): Promise<T> {
  const current = currentAutonomousPersonalExecutionScopeV1(ctx, PURPOSE);
  if (current !== undefined) {
    if (!isConfiguredAutonomousPersonalCaptureV1(ctx)) {
      throw new AutonomousPersonalExecutionScopeError('configuration_conflict');
    }
    // A conflicting configuration throws `configuration_conflict`; it never restarts T0.
    bindControls(current, ctx, readControls(ctx));
    checkAutonomousPersonalEntryLiveV1();
    let result: T;
    try {
      result = await body();
    } catch (error) {
      try {
        checkAutonomousPersonalEntryLiveV1();
      } catch {
        // A nested body rejection keeps its original error identity.
      }
      throw error;
    }
    checkAutonomousPersonalEntryLiveV1();
    return result;
  }
  if (!isConfiguredAutonomousPersonalCaptureV1(ctx)) return body();

  const entry = openAutonomousPersonalExecutionScopeV1(ctx, PURPOSE);
  try {
    bindControls(entry, ctx, readControls(ctx));
  } catch (error) {
    closeAutonomousPersonalExecutionScopeV1(entry, ctx);
    // A configured binding failure never retries under a new entry or legacy timing.
    throw error;
  }
  return runAutonomousPersonalExecutionScopeV1(entry, ctx, body);
}

/**
 * Query the PRIVATE current-entry state at a fixed call site. The current configuration is
 * re-read and must bind equal to the original body/overall/signal. No caller DATA, snapshot or
 * start time is accepted; diagnostics are read only to derive the original anchors.
 */
export function readCurrentAutonomousPersonalEntryTimingV1(
  ctx: IExecuteFunctions,
): AutonomousPersonalEntryTimingV1 {
  const entry = currentAutonomousPersonalExecutionScopeV1(ctx, PURPOSE);
  if (!isConfiguredAutonomousPersonalCaptureV1(ctx)) {
    if (entry !== undefined) {
      throw new AutonomousPersonalExecutionScopeError('configuration_conflict');
    }
    return Object.freeze({ kind: 'legacy' });
  }
  if (entry === undefined) return Object.freeze({ kind: 'missing' });

  const controls = readControls(ctx);
  bindControls(entry, ctx, controls);
  const diagnostics = diagnoseAutonomousPersonalExecutionScopeV1(entry, ctx);
  const overallMs = controls.overallMs as number;
  if (
    !diagnostics.bound ||
    diagnostics.closed ||
    diagnostics.originalDeadlineMs === null ||
    diagnostics.effectiveDeadlineMs === null ||
    diagnostics.fingerprint === null
  ) {
    throw new AutonomousPersonalExecutionScopeError('scope_not_bound');
  }
  const timing = Object.freeze({
    kind: 'entry' as const,
    entry,
    startedAtMonotonicMs: diagnostics.originalDeadlineMs - overallMs,
    originalDeadlineAtMonotonicMs: diagnostics.originalDeadlineMs,
    effectiveDeadlineAtMonotonicMs: diagnostics.effectiveDeadlineMs,
    overallMs,
    fingerprint: diagnostics.fingerprint,
  });
  checkAutonomousPersonalEntryLiveV1();
  return timing;
}

/** Read only this exact context's latest bound invocation; invalid/unbound entries are omitted. */
export function readLatestAutonomousPersonalExecutionDiagnosticsV1(
  ctx: IExecuteFunctions,
): Readonly<AutonomousPersonalExecutionDiagnosticsV1> | null {
  if (!isConfiguredAutonomousPersonalCaptureV1(ctx)) return null;
  return getLatestAutonomousPersonalExecutionDiagnosticsV1(ctx);
}

/** Clip the original entry to an earlier absolute lease deadline; never extends it. */
export function clipAutonomousPersonalEntryToLeaseV1(
  ctx: IExecuteFunctions,
  entry: AutonomousPersonalExecutionScopeEntryV1,
  leaseDeadlineAtMonotonicMs: number,
): void {
  clipAutonomousPersonalExecutionScopeLeaseV1(entry, ctx, leaseDeadlineAtMonotonicMs);
}

/** Throws the latched or newly detected stop of the ambient entry; no-op without a scope. */
export function checkAutonomousPersonalEntryLiveV1(): void {
  currentAutonomousPersonalExecutionScopeWorkV1();
}
