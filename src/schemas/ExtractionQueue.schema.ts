import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { ExtractionOutcomeSchema } from './ExtractionOutcome.schema';

export const QueueBindingSchema = z.object({
  route_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/),
  config_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type QueueBinding = z.infer<typeof QueueBindingSchema>;
export const QueueLimitsSchema = z.object({
  max_jobs: z.number().int().min(1).max(10000).default(1000),
  max_namespace_bytes: z
    .number()
    .int()
    .min(1024)
    .max(100 * 1024 * 1024)
    .default(10 * 1024 * 1024),
  max_store_bytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024 * 1024)
    .default(100 * 1024 * 1024),
});
export type QueueLimits = z.infer<typeof QueueLimitsSchema>;
export const StagedExtractionSchema = z.object({
  version: z.literal(1),
  group_id: z.string().min(1),
  source_guards: z
    .array(z.object({ uuid: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }))
    .max(32)
    .default([]),
  graph_hash: z.string().regex(/^[a-f0-9]{64}$/),
  entities: z.array(EntityNodeSchema).max(64),
  edges: z.array(EntityEdgeSchema).max(128),
  outcome: ExtractionOutcomeSchema,
});
export type StagedExtraction = z.infer<typeof StagedExtractionSchema>;
export const ExtractionJobSchema = z.object({
  version: z.literal(1),
  uuid: z.string().uuid(),
  group_id: z.string().min(1),
  binding: QueueBindingSchema,
  limits: QueueLimitsSchema.default({}),
  sources: z
    .array(z.object({ uuid: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1)
    .max(32),
  state: z.enum([
    'pending',
    'leased',
    'staged',
    'retry_wait',
    'completed',
    'failed',
    'cancelled',
    'paused',
  ]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  available_at: z.string().datetime(),
  lease_token: z.string().uuid().nullable().default(null),
  generation: z.number().int().nonnegative().default(0),
  lease_expires_at: z.string().datetime().nullable().default(null),
  manual_retries: z.number().int().min(0).max(3).default(0),
  reviews: z
    .array(
      z.object({
        at: z.string().datetime(),
        actor: z.string().min(1).max(128),
        reason: z.string().min(1).max(512),
        previous_config_hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        action: z.enum(['pause', 'resume', 'retry', 'cancel', 'compact', 'rebind']),
      }),
    )
    .max(20)
    .default([]),
  claims: z.number().int().nonnegative().default(0),
  processing_attempts: z.number().int().nonnegative().default(0),
  recoveries: z.number().int().nonnegative().default(0),
  commit_attempts: z.number().int().nonnegative().default(0),
  last_error: z
    .enum([
      'provider',
      'configuration',
      'source_changed',
      'graph_changed',
      'capacity',
      'storage',
      'budget',
    ])
    .nullable()
    .default(null),
  plan: StagedExtractionSchema.nullable().default(null),
  outcome: ExtractionOutcomeSchema.nullable().default(null),
  reserved_bytes: z
    .number()
    .int()
    .min(1024)
    .max(2 * 1024 * 1024)
    .default(512 * 1024),
});
export type ExtractionJob = z.infer<typeof ExtractionJobSchema>;
export const SourceOwnershipSchema = z.object({
  version: z.literal(1),
  owner_job_uuid: z.string().uuid(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  job: ExtractionJobSchema.optional(),
});
export const QueueCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('claim'),
    group_id: z.string().min(1),
    binding: QueueBindingSchema,
    lease_ms: z.number().int().min(1000).max(300000).default(120000),
  }),
  z.object({
    action: z.literal('status'),
    group_id: z.string().min(1),
    binding: QueueBindingSchema,
  }),
  z.object({
    action: z.literal('control'),
    group_id: z.string().min(1),
    job_uuid: z.string().uuid(),
    operation: z.enum(['pause', 'resume', 'retry', 'cancel', 'compact', 'rebind']),
    binding: QueueBindingSchema.optional(),
    actor: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(512),
  }),
  ...(['renew', 'stage', 'commit', 'fail', 'cancel'] as const).map((action) =>
    z.object({
      action: z.literal(action),
      group_id: z.string().min(1),
      job_uuid: z.string().uuid(),
      token: z.string().uuid(),
      generation: z.number().int().min(1),
      lease_ms: z.number().int().min(1000).max(300000).default(120000),
      plan: StagedExtractionSchema.optional(),
      error: z
        .enum([
          'provider',
          'configuration',
          'source_changed',
          'graph_changed',
          'capacity',
          'storage',
          'budget',
        ])
        .optional(),
      retry: z.boolean().default(false),
      outcome: ExtractionOutcomeSchema.optional(),
    }),
  ),
]);
export type QueueCommand = z.input<typeof QueueCommandSchema>;
export const QueueStatsSchema = z.object({
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldest_pending_at: z.string().datetime().nullable(),
  graph_fresh: z.boolean(),
});
export type QueueStats = z.infer<typeof QueueStatsSchema>;
export const QueueResultSchema = z.object({
  job: ExtractionJobSchema.nullable(),
  pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldest_pending_at: z.string().datetime().nullable(),
});
export type QueueResult = z.infer<typeof QueueResultSchema>;

export const QueueBackupSchema = z.object({
  format: z.literal('engram-extraction-backup'),
  version: z.literal(1),
  graph: GraphDataSchema,
  warnings: z
    .object({
      missing_fact_source_references: z.number().int().nonnegative(),
      missing_chain_predecessors: z.number().int().nonnegative(),
    })
    .optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type QueueBackup = z.infer<typeof QueueBackupSchema>;

export const WorkerTimingSchema = z
  .object({
    lease_ms: z.number().int().min(1000).max(300000).default(120000),
    heartbeat_ms: z.number().int().min(10).max(60000).default(30000),
  })
  .refine((value) => value.heartbeat_ms < value.lease_ms / 2, {
    message: 'Heartbeat must be less than half the lease',
  });
export type WorkerTimingInput = z.input<typeof WorkerTimingSchema>;
export const QueueClearOptionsSchema = z
  .object({ allowQueued: z.boolean().default(false) })
  .default({});
export type QueueClearOptions = z.input<typeof QueueClearOptionsSchema>;
export const QueueClearImpactSchema = z.object({
  sources: z.number().int().nonnegative(),
  jobs: z.number().int().nonnegative(),
});
export type QueueClearImpact = z.infer<typeof QueueClearImpactSchema>;
