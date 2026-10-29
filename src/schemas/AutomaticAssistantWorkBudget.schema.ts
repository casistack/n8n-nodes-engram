import { z } from 'zod';

/** Per-call cooperative work limit only. Never part of the persisted intent or identity. */
export const AutomaticAssistantWorkBudgetV2Schema = z
  .object({
    remainingMs: z.number().int().min(1).max(120000),
  })
  .strict();
export type AutomaticAssistantWorkBudgetV2 = z.infer<typeof AutomaticAssistantWorkBudgetV2Schema>;
