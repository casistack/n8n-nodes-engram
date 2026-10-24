import { z } from 'zod';
export const ExtractionBudgetReasonSchema = z.enum([
  'deadline',
  'request_count',
  'comparison_count',
  'source_count',
  'source_bytes',
  'request_bytes',
  'response_bytes',
  'cancelled',
  'snapshot_limit',
  'conflict_limit',
  'metadata_bytes',
]);
export type ExtractionBudgetReason = z.infer<typeof ExtractionBudgetReasonSchema>;
export const ExtractionBudgetOutcomeSchema = z
  .object({
    version: z.literal(1),
    reason: ExtractionBudgetReasonSchema,
  })
  .strict();
