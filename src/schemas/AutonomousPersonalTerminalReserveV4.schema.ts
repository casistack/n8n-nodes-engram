import { z } from 'zod';
import { AUTOMATIC_LEDGER_LIMITS } from './AutomaticLedgerPrimitives.schema';

/** Size projection DATA only; this is not a reservation or a commit permit. */
export const AutonomousPersonalTerminalReserveV4OwnedDataSchema = z
  .object({
    version: z.literal(1),
    projectedTerminalBytes: z.number().int().positive().safe(),
    withinLimit: z.boolean(),
  })
  .strict()
  .superRefine((projection, context) => {
    if (
      projection.withinLimit !==
      projection.projectedTerminalBytes <= AUTOMATIC_LEDGER_LIMITS.operationBytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Size projection and byte limit do not agree',
      });
    }
  });

export type AutonomousPersonalTerminalReserveV4 = z.infer<
  typeof AutonomousPersonalTerminalReserveV4OwnedDataSchema
>;
