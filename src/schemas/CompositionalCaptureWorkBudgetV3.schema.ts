import { z } from 'zod';

/** Nonpersisted work allowance; never changes the captured descriptor deadline. */
export const CompositionalCaptureWorkBudgetV3Schema = z
  .object({ remainingMs: z.number().finite().int().min(1).max(120_000) })
  .strict();
export type CompositionalCaptureWorkBudgetV3 = z.infer<
  typeof CompositionalCaptureWorkBudgetV3Schema
>;
