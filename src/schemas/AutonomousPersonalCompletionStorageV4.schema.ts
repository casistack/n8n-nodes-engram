import { z } from 'zod';
import { AutonomousPersonalCompletionPlanV4NoWriteReasonSchema } from './AutonomousPersonalCompletionPlanV4.schema';

/** Private backend observation only; this DATA grants no continuation authority. */
export const AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('matched') }).strict(),
    z.object({ kind: z.literal('unconfirmed') }).strict(),
    z
      .object({
        kind: z.literal('no_write'),
        reason: AutonomousPersonalCompletionPlanV4NoWriteReasonSchema,
      })
      .strict(),
  ],
);

export type AutonomousPersonalCompletionStorageV4Result = z.infer<
  typeof AutonomousPersonalCompletionStorageV4ResultOwnedDataSchema
>;
