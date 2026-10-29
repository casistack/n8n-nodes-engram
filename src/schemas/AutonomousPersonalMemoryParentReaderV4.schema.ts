import { z } from 'zod';

export const AutonomousPersonalMemoryParentReaderV4ReasonSchema = z.enum([
  'invalid_lineage',
  'invalid_configuration',
  'unsupported_mode',
  'parent_not_found',
  'parent_mismatch',
  'authority_changed',
  'clock_regression',
  'budget_exhausted',
  'resource_exhausted',
  'invalid_snapshot',
  'storage_unavailable',
]);

export const AutonomousPersonalMemoryParentReaderV4RejectedDataSchema = z
  .object({
    kind: z.literal('rejected'),
    reason: AutonomousPersonalMemoryParentReaderV4ReasonSchema,
  })
  .strict();

export type AutonomousPersonalMemoryParentReaderV4Reason = z.infer<
  typeof AutonomousPersonalMemoryParentReaderV4ReasonSchema
>;
export type AutonomousPersonalMemoryParentReaderV4RejectedData = z.infer<
  typeof AutonomousPersonalMemoryParentReaderV4RejectedDataSchema
>;
