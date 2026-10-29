import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import type { IExecuteFunctions } from 'n8n-workflow';
import { ExtractionBudgetError } from '../extraction/ExtractionDiagnostics';
import { AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema } from '../schemas/AutonomousPersonalNativeMemoryConfigV4.schema';
import type { AutonomousPersonalTypedSyntaxWorkV1 } from '../schemas/AutonomousPersonalTypedSyntaxV1.schema';

const fallbackSignal = new AbortController().signal;
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;

/** Start before the native config await. This cooperative work object creates no timer or worker. */
export function createAutonomousPersonalNativeMemoryWorkV4(
  ctx: Pick<IExecuteFunctions, 'getExecutionCancelSignal'>,
  deadlineValue: unknown,
): Readonly<{
  work: AutonomousPersonalTypedSyntaxWorkV1;
  check: () => void;
  nativeCancellationAvailable: boolean;
}> {
  const started = performance.now();
  let signal: AbortSignal;
  let duration: number;
  let nativeCancellationAvailable: boolean;
  try {
    if (!ctx || typeof ctx !== 'object' || utilTypes.isProxy(ctx) || !nativeAborted)
      throw new Error();
    duration =
      AutonomousPersonalNativeMemoryConfigV4OwnedDataSchema.shape.invocationDeadlineMs.parse(
        deadlineValue,
      );
    const getSignal = ctx.getExecutionCancelSignal;
    if (getSignal !== undefined && typeof getSignal !== 'function') throw new Error();
    const observed: unknown = getSignal?.call(ctx);
    nativeCancellationAvailable = observed !== undefined;
    if (
      observed !== undefined &&
      (observed === null || typeof observed !== 'object' || utilTypes.isProxy(observed))
    )
      throw new Error();
    signal = observed === undefined ? fallbackSignal : (observed as AbortSignal);
    nativeAborted.call(signal);
    if (!Number.isFinite(started)) throw new Error();
  } catch {
    throw new Error('Engram native Memory work: unsupported_configuration');
  }
  const work: AutonomousPersonalTypedSyntaxWorkV1 = Object.freeze({
    absoluteMonotonicDeadlineMs: started + duration,
    signal,
  });
  let failure: ExtractionBudgetError | undefined;
  const check = () => {
    if (failure) throw failure;
    if (nativeAborted!.call(work.signal)) {
      failure = new ExtractionBudgetError('cancelled');
      throw failure;
    }
    const now = performance.now();
    if (!Number.isFinite(now) || now >= work.absoluteMonotonicDeadlineMs) {
      failure = new ExtractionBudgetError('deadline');
      throw failure;
    }
  };
  check();
  return Object.freeze({ work, check, nativeCancellationAvailable });
}
