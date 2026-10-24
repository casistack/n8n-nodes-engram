import { z } from 'zod';
export const ExtractionPolicySchema = z
  .object({
    mode: z.enum(['legacy', 'bounded']).default('legacy'),
    quality: z.enum(['legacy', 'durableTemporal']).default('legacy'),
    shortlist: z.number().int().min(1).max(64).default(8),
    fuzzy_calls: z.number().int().min(0).max(128).default(16),
    max_calls: z.number().int().min(1).max(256).default(32),
    deadline_ms: z.number().int().min(100).max(120000).default(30000),
    timezone: z
      .string()
      .max(128)
      .refine(
        (value) => {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'Source timezone must be a valid IANA timezone' },
      )
      .optional(),
  })
  .default({});
export type ExtractionPolicy = z.infer<typeof ExtractionPolicySchema>;
export type ExtractionPolicyInput = z.input<typeof ExtractionPolicySchema>;
export const EvidenceSpanSchema = z.object({
  source_id: z.string().max(512),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export const KnowledgeCategorySchema = z.enum([
  'durable_fact',
  'preference',
  'commitment',
  'event_plan',
  'conversational_request',
  'processing_artifact',
  'uncertain',
]);
export const BoundedCandidatesSchema = z.object({
  entities: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(512),
        entity_type: z.string().min(1).max(128),
        summary: z.string().max(4096).default(''),
        confidence: z.number().min(0).max(1).nullable().default(null),
        category: KnowledgeCategorySchema.default('uncertain'),
        evidence: z.array(EvidenceSpanSchema).max(4).default([]),
      }),
    )
    .max(32),
  relationships: z
    .array(
      z.object({
        source_id: z.string().min(1).max(64),
        target_id: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        fact: z.string().min(1).max(4096),
        confidence: z.number().min(0).max(1).nullable().default(null),
        category: KnowledgeCategorySchema.default('uncertain'),
        evidence: z.array(EvidenceSpanSchema).max(4).default([]),
      }),
    )
    .max(64),
});
export type BoundedCandidates = z.infer<typeof BoundedCandidatesSchema>;

export const MemoryQualitySchema = z.object({
  version: z.literal(1),
  category: KnowledgeCategorySchema,
  policy: z.enum(['legacy', 'durableTemporal']),
  evidence: z.array(EvidenceSpanSchema).max(4),
  temporal: z.object({
    status: z.enum(['none', 'uncertain', 'resolved']),
    source_times: z.array(z.string().datetime().nullable()).max(4),
    timezone: z.string().nullable(),
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
    precision: z.enum(['day']).optional(),
  }),
});
export const RetrievalModeSchema = z
  .enum(['legacy', 'current', 'historical', 'asOf'])
  .default('legacy');

export const ExplicitTimestampSchema = z.string().datetime({ offset: true });

export const ResolvedDaySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('resolved'),
    start: z.string().datetime(),
    end: z.string().datetime(),
    precision: z.literal('day'),
  }),
  z.object({ status: z.literal('uncertain') }),
]);
export type ResolvedDay = z.infer<typeof ResolvedDaySchema>;

export const GraphEvidenceBudgetsSchema = z
  .object({
    durable: z.number().int().min(0).max(100000).default(4096),
    historical: z.number().int().min(0).max(100000).default(2048),
  })
  .default({});
export type GraphEvidenceBudgetsInput = z.input<typeof GraphEvidenceBudgetsSchema>;

export const SourceHydrationBudgetSchema = z.object({
  remaining: z.number().int().min(0).max(1024),
  deferred: z.number().int().nonnegative(),
});
export type SourceHydrationBudget = z.infer<typeof SourceHydrationBudgetSchema>;
