import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from '../storage/IGraphStorage';
import { completeNativeAutonomousPersonalCaptureV4 } from '../storage/AutonomousPersonalNativeCompletionV4';
import { publishAutonomousPersonalMemoryHandoffWithSummaryV4 } from '../storage/AutonomousPersonalNativeMemoryHandoffV4';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 } from '../storage/AutonomousPersonalCaptureReceiptSummaryV4';
import {
  AutonomousPersonalNativeAdminV4OutputSchema,
  type AutonomousPersonalNativeAdminV4Output,
} from '../schemas/AutonomousPersonalNativeAdminV4.schema';
import {
  checkAutonomousPersonalEntryLiveV1,
  runWithAutonomousPersonalExecutionEntryV1,
} from './AutonomousPersonalExecutionEntryV1';
import { markCurrentAutonomousPersonalExecutionStageV1 } from '../storage/AutonomousPersonalExecutionScopeV1';

/**
 * Fixed native dispatcher. Only the original confirmed capture publishes a Memory handoff.
 * A configured capture keeps ONE entry scope through completion, handoff and output projection;
 * a direct supported call opens it here, while the Admin node entry is reused unchanged.
 */
export async function executeAutonomousPersonalAdminV4(
  ctx: IExecuteFunctions,
  storage: IGraphStorage,
): Promise<AutonomousPersonalNativeAdminV4Output> {
  return runWithAutonomousPersonalExecutionEntryV1(ctx, () => dispatchWithinEntryV4(ctx, storage));
}

async function dispatchWithinEntryV4(
  ctx: IExecuteFunctions,
  storage: IGraphStorage,
): Promise<AutonomousPersonalNativeAdminV4Output> {
  const stopped = (
    reason:
      | Extract<
          AutonomousPersonalNativeAdminV4Output,
          { status: 'stopped' | 'unconfirmed' }
        >['reason']
      | 'invalid_handle',
    status: 'stopped' | 'unconfirmed' = 'stopped',
  ): AutonomousPersonalNativeAdminV4Output =>
    AutonomousPersonalNativeAdminV4OutputSchema.parse({
      version: 4,
      should_process: false,
      status,
      reason: reason === 'invalid_handle' ? 'unsupported_mode' : reason,
    });

  if (ctx.getNodeParameter('automaticMemoryProfile', 0, 'existing') === 'reviewFirst')
    return stopped('unsupported_mode');

  const completed = await completeNativeAutonomousPersonalCaptureV4(ctx, storage);
  if (
    completed.kind === 'original_turn' ||
    (completed.kind === 'no_origin' && completed.observation.kind === 'unconfirmed') ||
    (completed.kind === 'decision' &&
      (completed.result.kind === 'committed_observed' ||
        completed.result.kind === 'cancelled_observed'))
  ) {
    markCurrentAutonomousPersonalExecutionStageV1('readback');
  }
  if (completed.kind === 'original_turn') {
    // Publication and Proceed require a live scope: after a stop there is no new handoff or
    // reply. The already durable write is untouched and is never repeated or rolled back.
    markCurrentAutonomousPersonalExecutionStageV1('handoff');
    try {
      checkAutonomousPersonalEntryLiveV1();
    } catch {
      return stopped('handoff_unavailable', 'unconfirmed');
    }
    const published = publishAutonomousPersonalMemoryHandoffWithSummaryV4(
      ctx,
      storage,
      completed.origin,
    );
    if (published.kind !== 'published') return stopped('handoff_unavailable', 'unconfirmed');
    return AutonomousPersonalNativeAdminV4OutputSchema.parse({
      version: 4,
      should_process: true,
      status: 'captured',
      sourceId: published.sourceId,
      creationSummary: published.summary,
    });
  }
  if (completed.kind === 'no_origin') {
    if (completed.observation.kind === 'no_write') return stopped(completed.observation.reason);
    return stopped('acknowledgement_unknown', 'unconfirmed');
  }
  if (
    completed.result.kind === 'committed_observed' ||
    completed.result.kind === 'cancelled_observed'
  ) {
    const summary = projectAutonomousPersonalCaptureReceiptSummaryV4(
      completed.result.terminalReceipt,
      () => undefined,
    );
    return AutonomousPersonalNativeAdminV4OutputSchema.parse({
      version: 4,
      should_process: false,
      status: 'replay',
      sourceId: summary.sourceId,
      creationSummary: summary,
    });
  }
  return stopped(completed.result.kind);
}
