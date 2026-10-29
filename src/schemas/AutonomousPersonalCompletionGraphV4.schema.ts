import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import { AutonomousPersonalCompletionPlanV4NoWriteReasonSchema } from './AutonomousPersonalCompletionPlanV4.schema';

export const AutonomousPersonalCompletionGraphCandidateV4ResultOwnedDataSchema =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('candidate'), graph: GraphDataSchema }).strict(),
    z
      .object({
        kind: z.literal('no_write'),
        reason: AutonomousPersonalCompletionPlanV4NoWriteReasonSchema,
      })
      .strict(),
  ]);

export type AutonomousPersonalCompletionGraphCandidateV4Result = z.infer<
  typeof AutonomousPersonalCompletionGraphCandidateV4ResultOwnedDataSchema
>;

export const AutonomousPersonalCompletionReadbackV4ResultOwnedDataSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('matched') }).strict(),
    z.object({ kind: z.literal('unconfirmed') }).strict(),
  ],
);

export type AutonomousPersonalCompletionReadbackV4Result = z.infer<
  typeof AutonomousPersonalCompletionReadbackV4ResultOwnedDataSchema
>;
