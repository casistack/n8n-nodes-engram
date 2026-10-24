import { z } from 'zod';
import { StorageTotalsSchema } from './StorageObservation.schema';

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
  'budget_exhausted',
  'cancelled',
]);
export type ExtractionErrorKind = z.infer<typeof ExtractionErrorKindSchema>;
export const ExtractionErrorDetailsSchema = z.object({
  reason: z.literal('json_mode_instruction_missing'),
  parameter: z.literal('messages'),
});
export type ExtractionErrorDetails = z.infer<typeof ExtractionErrorDetailsSchema>;
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
const metricCount = z.number().int().nonnegative();
const metricDuration = z.number().finite().nonnegative();
export const ExtractionStageMetricsSchema = z.object({
  stage: ExtractionStageSchema,
  operations: metricCount,
  operation_failures: metricCount,
  elapsed_ms: metricDuration,
  summed_operation_ms: metricDuration,
  requests: z.object({
    attempted: metricCount,
    completed: metricCount,
    failed: metricCount,
    cancelled: metricCount,
    in_flight: metricCount,
    retries: metricCount,
    summed_ms: metricDuration,
    headers_ms: metricDuration.nullable(),
    body_ms: metricDuration.nullable(),
    timing_samples: metricCount,
    usage_valid: metricCount,
    usage_missing: metricCount,
    usage_invalid: metricCount,
    input_tokens: metricCount.nullable(),
    output_tokens: metricCount.nullable(),
    total_tokens: metricCount.nullable(),
  }),
  candidates: metricCount,
  exact_hits: metricCount,
  shortlisted: metricCount,
  pruned: metricCount,
  unresolved: metricCount,
  deferrals: z.object({ budget: metricCount, ambiguity: metricCount, unknown: metricCount }),
});
export const ExtractionMetricContextSchema = z.object({
  backend: z.enum(['embedded', 'neo4j', 'unknown']).default('unknown'),
  resolution: z.enum(['legacy', 'bounded']).default('legacy'),
  quality: z.enum(['legacy', 'durableTemporal']).default('legacy'),
  execution: z.enum(['synchronous', 'durable', 'unknown']).default('unknown'),
});
export type ExtractionMetricContext = z.input<typeof ExtractionMetricContextSchema>;
export const ExtractionMetricsSchema = z.object({
  version: z.literal(1),
  operation_id: z.string().uuid(),
  package_version: z.string().max(64),
  context: ExtractionMetricContextSchema,
  stages: z.array(ExtractionStageMetricsSchema).length(8),
  // Storage method timing is observed; backend lock/provider compute timings are not inferred.
  storage_breakdown: StorageTotalsSchema.nullable(),
});
export type ExtractionStageMetrics = z.infer<typeof ExtractionStageMetricsSchema>;
export type ExtractionMetrics = z.infer<typeof ExtractionMetricsSchema>;
export const ExtractionOutcomeSchema = z.object({
  status: z.enum(['disabled', 'skipped', 'succeeded', 'partial', 'failed']),
  reason: z.enum(['disabled', 'no_sources', 'missing_configuration']).optional(),
  duration_ms: z.number().nonnegative(),
  duration_scope: z.enum(['end_to_end', 'preparation']).optional(),
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
        reason: z.literal('json_mode_instruction_missing').optional(),
        parameter: z.literal('messages').optional(),
      }),
    )
    .max(20),
  error_count: z.number().int().nonnegative(),
  errors_truncated: z.boolean(),
  metrics: ExtractionMetricsSchema.optional(),
});
export type ExtractionOutcome = z.infer<typeof ExtractionOutcomeSchema>;
