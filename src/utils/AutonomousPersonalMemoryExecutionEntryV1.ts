import { types as utilTypes } from 'node:util';
import type { IExecuteFunctions } from 'n8n-workflow';
import type { AutonomousPersonalNativeMemoryConfigV4 } from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import {
  openAutonomousPersonalExecutionScopeV1,
  bindAutonomousPersonalExecutionScopeV1,
  closeAutonomousPersonalExecutionScopeV1,
  currentAutonomousPersonalExecutionScopeV1,
  currentAutonomousPersonalExecutionScopeWorkV1,
  runAutonomousPersonalExecutionScopeV1,
  AutonomousPersonalExecutionScopeError,
} from '../storage/AutonomousPersonalExecutionScopeV1';
import { readNativeAutonomousPersonalExecutionBudgetV1 } from './autonomousPersonalExecutionBudget';

type MemoryPurpose = 'memoryRead' | 'memorySave';
type RegisterFailureCleanup = (cleanup: () => Promise<void>) => void;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

export function readAutonomousPersonalMemoryHostSignalV1(
  ctx: Pick<IExecuteFunctions, 'getExecutionCancelSignal'>,
): AbortSignal | undefined {
  const signal = ctx.getExecutionCancelSignal?.();
  if (signal === undefined) return undefined;
  if (!signal || typeof signal !== 'object' || utilTypes.isProxy(signal) || !nativeAborted)
    throw new AutonomousPersonalExecutionScopeError('invalid_configuration');
  nativeAborted.call(signal);
  return signal;
}

/** One fresh read/save operation. Same-owner nested operations reuse its original clock. */
export async function runAutonomousPersonalMemoryOperationV1<T>(
  owner: object,
  purpose: MemoryPurpose,
  config: AutonomousPersonalNativeMemoryConfigV4,
  hostSignal: AbortSignal | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const current =
    currentAutonomousPersonalExecutionScopeV1(owner, purpose) ??
    (purpose === 'memoryRead'
      ? currentAutonomousPersonalExecutionScopeV1(owner, 'memorySave')
      : undefined);
  if (config.executionBudget === undefined) {
    const anyOwnedOperation =
      current ??
      currentAutonomousPersonalExecutionScopeV1(owner, 'memoryRead') ??
      currentAutonomousPersonalExecutionScopeV1(owner, 'memorySave');
    if (anyOwnedOperation)
      throw new AutonomousPersonalExecutionScopeError('configuration_conflict');
    return body();
  }
  if (current) {
    bindAutonomousPersonalExecutionScopeV1(
      current,
      owner,
      config.executionBudget,
      config.invocationDeadlineMs,
      hostSignal,
    );
    currentAutonomousPersonalExecutionScopeWorkV1();
    const value = await body();
    currentAutonomousPersonalExecutionScopeWorkV1();
    return value;
  }
  const entry = openAutonomousPersonalExecutionScopeV1(owner, purpose);
  try {
    bindAutonomousPersonalExecutionScopeV1(
      entry,
      owner,
      config.executionBudget,
      config.invocationDeadlineMs,
      hostSignal,
    );
  } catch (error) {
    closeAutonomousPersonalExecutionScopeV1(entry, owner);
    throw error;
  }
  try {
    return await runAutonomousPersonalExecutionScopeV1(entry, owner, body);
  } finally {
    // run() rejects illegal nesting before entering its own release block.
    closeAutonomousPersonalExecutionScopeV1(entry, owner);
  }
}

/** Revalidate a resolved native configuration against the original preparation entry. */
export function assertAutonomousPersonalMemoryPreparationConfigV1(
  ctx: Pick<IExecuteFunctions, 'getExecutionCancelSignal'>,
  config: AutonomousPersonalNativeMemoryConfigV4,
): void {
  const entry = currentAutonomousPersonalExecutionScopeV1(ctx, 'memoryPrepare');
  if (!entry) {
    if (config.executionBudget !== undefined)
      throw new AutonomousPersonalExecutionScopeError('scope_not_bound');
    return;
  }
  if (config.executionBudget === undefined)
    throw new AutonomousPersonalExecutionScopeError('configuration_conflict');
  bindAutonomousPersonalExecutionScopeV1(
    entry,
    ctx,
    config.executionBudget,
    config.invocationDeadlineMs,
    readAutonomousPersonalMemoryHostSignalV1(ctx),
  );
  currentAutonomousPersonalExecutionScopeWorkV1();
}

/** Opens before resolved controls, credentials or storage. The temporary signal is never retained. */
export async function runAutonomousPersonalMemoryPreparationV1<T>(
  ctx: Pick<IExecuteFunctions, 'getNode' | 'getNodeParameter' | 'getExecutionCancelSignal'>,
  itemIndex: number,
  body: (registerFailureCleanup: RegisterFailureCleanup) => Promise<T>,
): Promise<T> {
  if (!ctx || typeof ctx !== 'object' || utilTypes.isProxy(ctx)) return body(() => undefined);
  // An already-bound same-owner entry cannot be downgraded through a changed raw gate.
  const existing = currentAutonomousPersonalExecutionScopeV1(ctx, 'memoryPrepare');
  let parameters: unknown;
  try {
    parameters = ctx.getNode().parameters;
  } catch {
    if (existing) throw new AutonomousPersonalExecutionScopeError('configuration_conflict');
    return body(() => undefined);
  }
  const own = (key: string): unknown => {
    if (!parameters || typeof parameters !== 'object' || utilTypes.isProxy(parameters))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  if (
    own('automaticPreferenceInterpreter') !== 'autonomousPersonalV1' ||
    own('automaticExecutionBudgetMode') !== 'configuredV1'
  ) {
    if (existing) throw new AutonomousPersonalExecutionScopeError('configuration_conflict');
    return body(() => undefined);
  }
  const entry = existing ?? openAutonomousPersonalExecutionScopeV1(ctx, 'memoryPrepare');
  const cleanups: Array<() => Promise<void>> = [];
  const register: RegisterFailureCleanup = (cleanup) => {
    cleanups.push(cleanup);
  };
  try {
    const budget = readNativeAutonomousPersonalExecutionBudgetV1(parameters, (name, fallback) =>
      ctx.getNodeParameter(name, itemIndex, fallback as string),
    );
    if (!budget) throw new AutonomousPersonalExecutionScopeError('invalid_configuration');
    bindAutonomousPersonalExecutionScopeV1(
      entry,
      ctx,
      budget,
      ctx.getNodeParameter('extractionDeadlineMs', itemIndex, 30_000),
      readAutonomousPersonalMemoryHostSignalV1(ctx),
    );
    if (existing) {
      currentAutonomousPersonalExecutionScopeWorkV1();
      const value = await body(register);
      currentAutonomousPersonalExecutionScopeWorkV1();
      return value;
    }
    return await runAutonomousPersonalExecutionScopeV1(entry, ctx, () => body(register));
  } catch (error) {
    if (!existing) closeAutonomousPersonalExecutionScopeV1(entry, ctx);
    // Cleanup is mandatory and cannot grant graph authority or replace the original failure.
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        /* Preserve the original preparation failure. */
      }
    }
    throw error;
  }
}
