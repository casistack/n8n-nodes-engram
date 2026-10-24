import { z } from 'zod';

export const ExtractionTemperatureSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('legacy') }),
  z.object({ mode: z.literal('providerDefault') }),
  z.object({ mode: z.literal('custom'), value: z.number().finite() }),
]);
export type ExtractionTemperature = z.infer<typeof ExtractionTemperatureSchema>;
export const ExtractionErrorKindSchema = z.enum([
  'unsupported_parameter',
  'authentication',
  'rate_limit',
  'timeout',
  'network',
  'provider_server',
  'invalid_request',
  'invalid_response',
  'storage',
  'unknown',
]);
export type ExtractionErrorKind = z.infer<typeof ExtractionErrorKindSchema>;
export const ExtractionStageSchema = z.enum([
  'entities',
  'entity_dedup',
  'relationships',
  'edge_dedup',
  'cross_edge_dedup',
  'contradictions',
  'embeddings',
  'persistence',
]);
export type ExtractionStage = z.infer<typeof ExtractionStageSchema>;
export const ExtractionCountsSchema = z.object({
  entities_created: z.number().int().nonnegative(),
  entities_updated: z.number().int().nonnegative(),
  edges_created: z.number().int().nonnegative(),
  edges_updated: z.number().int().nonnegative(),
  edges_expired: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  malformed: z.number().int().nonnegative(),
  filtered: z.number().int().nonnegative(),
});
export const ExtractionOutcomeSchema = z.object({
  status: z.enum(['disabled', 'skipped', 'succeeded', 'partial', 'failed']),
  reason: z.enum(['disabled', 'no_sources', 'missing_configuration']).optional(),
  duration_ms: z.number().nonnegative(),
  counts: ExtractionCountsSchema,
  stages: z
    .array(
      z.object({
        stage: ExtractionStageSchema,
        status: z.enum(['skipped', 'succeeded', 'partial', 'failed']),
        reason: z.enum(['not_reached', 'not_eligible']).optional(),
      }),
    )
    .max(8),
  errors: z
    .array(
      z.object({
        stage: ExtractionStageSchema,
        kind: ExtractionErrorKindSchema,
        http_status: z.number().int().min(100).max(599).optional(),
      }),
    )
    .max(20),
  error_count: z.number().int().nonnegative(),
  errors_truncated: z.boolean(),
});
export type ExtractionOutcome = z.infer<typeof ExtractionOutcomeSchema>;
