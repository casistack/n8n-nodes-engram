import { z } from 'zod';
import { AutonomousPersonalCaptureReceiptSummaryV4Schema } from './AutonomousPersonalCaptureReceiptSummaryV4.schema';

/** Workflow output DATA. This receipt summary never grants continuation authority. */
export const AutonomousPersonalNativeAdminV4OutputSchema = z.union([
  z
    .object({
      version: z.literal(4),
      should_process: z.literal(true),
      status: z.literal('captured'),
      sourceId: z.string().uuid(),
      creationSummary: AutonomousPersonalCaptureReceiptSummaryV4Schema,
    })
    .strict()
    .refine(
      (value) =>
        value.creationSummary.kind === 'committed' &&
        value.sourceId === value.creationSummary.sourceId,
    ),
  z
    .object({
      version: z.literal(4),
      should_process: z.literal(false),
      status: z.literal('replay'),
      sourceId: z.string().uuid(),
      creationSummary: AutonomousPersonalCaptureReceiptSummaryV4Schema,
    })
    .strict()
    .refine((value) => value.sourceId === value.creationSummary.sourceId),
  z
    .object({
      version: z.literal(4),
      should_process: z.literal(false),
      status: z.enum(['stopped', 'unconfirmed']),
      reason: z.enum([
        'unsupported_mode',
        'invalid_input',
        'conflict',
        'authority_changed',
        'budget_exhausted',
        'resource_exhausted',
        'capacity',
        'clock_regression',
        'storage_error',
        'cancelled',
        'in_progress',
        'resume_available',
        'source_only_unconfirmed',
        'acknowledgement_unknown',
        'failed',
        'interrupted',
        'handoff_unavailable',
        'lease_expired',
        'inspection_incomplete',
      ]),
    })
    .strict(),
]);

export type AutonomousPersonalNativeAdminV4Output = z.infer<
  typeof AutonomousPersonalNativeAdminV4OutputSchema
>;
