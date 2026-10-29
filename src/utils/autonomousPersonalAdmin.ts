import type { IExecuteFunctions } from 'n8n-workflow';
import type { IGraphStorage } from '../storage/IGraphStorage';
import { completeNativeAutonomousPersonalCaptureV4 } from '../storage/AutonomousPersonalNativeCompletionV4';
import { publishAutonomousPersonalMemoryHandoffWithSummaryV4 } from '../storage/AutonomousPersonalNativeMemoryHandoffV4';
import { projectAutonomousPersonalCaptureReceiptSummaryV4 } from '../storage/AutonomousPersonalCaptureReceiptSummaryV4';
import {
  AutonomousPersonalNativeAdminV4OutputSchema,
  type AutonomousPersonalNativeAdminV4Output,
} from '../schemas/AutonomousPersonalNativeAdminV4.schema';

/** Fixed native dispatcher. Only the original confirmed capture publishes a Memory handoff. */
export async function executeAutonomousPersonalAdminV4(
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
  if (completed.kind === 'original_turn') {
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
