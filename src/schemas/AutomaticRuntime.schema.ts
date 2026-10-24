import { z } from 'zod';
import { AutomaticProfileIdSchema, AutomaticActorSchema } from './AutomaticMemory.schema';
import { SourceHydrationBudgetSchema } from './ExtractionPolicy.schema';

/** Operator/application configuration, never populated from message additional_kwargs. */
export const AutomaticRuntimeSchema = z
  .object({
    profileId: AutomaticProfileIdSchema.default('existing'),
    actor: AutomaticActorSchema,
    rawHumanContent: z.string().min(1).max(65536).optional(),
    explicitIntent: z.boolean().default(false),
    storeIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    turnId: z.string().min(1).max(512),
    capturedSourceId: z.string().uuid().optional(),
  })
  .strict();
export type AutomaticRuntimeInput = z.input<typeof AutomaticRuntimeSchema>;
export type AutomaticRuntime = z.infer<typeof AutomaticRuntimeSchema>;

export const AutomaticReadBudgetSchema = z.object({ remaining: z.number().int().min(0).max(128) });
export type AutomaticReadBudget = z.infer<typeof AutomaticReadBudgetSchema>;
export const AutomaticReadContextSchema = z.object({
  mode: z.enum(['current', 'historical', 'asOf']).optional(),
  at: z.string().datetime({ offset: true }).optional(),
  conflicts: AutomaticReadBudgetSchema,
  sources: SourceHydrationBudgetSchema,
});
export const AutomaticClaimViewSchema = z.enum(['current', 'historical_record', 'hidden']);
export type AutomaticClaimView = z.infer<typeof AutomaticClaimViewSchema>;
export type AutomaticReadContext = z.infer<typeof AutomaticReadContextSchema>;
