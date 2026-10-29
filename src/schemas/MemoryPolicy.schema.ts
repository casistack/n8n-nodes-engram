import { z } from 'zod';
import { StorageTotalsSchema } from './StorageObservation.schema';
import { QueueStatsSchema } from './ExtractionQueue.schema';
import { ExtractionOutcomeSchema } from './ExtractionOutcome.schema';
import { ReplaySafeMemoryWriteDiagnosticsSchema } from './ReplaySafeMemory.schema';
import { CompositionalHumanCaptureReceiptSummaryV3Schema } from './CompositionalHumanCapturePublicResultV3.schema';

export const CurrentHumanQuerySchema = z.string();
export const MemoryPolicySchema = z.object({
  historyFilter: z.enum(['off', 'provenance', 'reviewedLegacy']).default('off'),
  maxHistoryScan: z.number().int().min(1).max(10000).default(1000),
  legacyArtifactHashes: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(100)
    .default([]),
  finalTurnWrites: z.boolean().default(false),
  storeToolAudit: z.boolean().default(false),
});
export type MemoryPolicy = z.infer<typeof MemoryPolicySchema>;
export type MemoryPolicyInput = z.input<typeof MemoryPolicySchema>;
export const HistoryReadDiagnosticsSchema = z.object({
  mode: z.enum(['off', 'provenance', 'reviewedLegacy']),
  fetched: z.number().int().nonnegative(),
  examined: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  excluded_provenance: z.number().int().nonnegative(),
  excluded_legacy: z.number().int().nonnegative(),
  legacy_candidates: z.number().int().nonnegative(),
  snapshot_overflow: z.boolean(),
  scan_truncated: z.boolean(),
});
export type HistoryReadDiagnostics = z.infer<typeof HistoryReadDiagnosticsSchema>;
export const MemoryLoadDiagnosticsSchema = z.object({
  capture: z
    .object({
      version: z.literal(3),
      source_id: z.string().uuid(),
      operation_id: z.string().uuid(),
      receipt: CompositionalHumanCaptureReceiptSummaryV3Schema,
    })
    .strict()
    .optional(),
  queue: QueueStatsSchema.extend({ version: z.literal(1) }).optional(),
  history: HistoryReadDiagnosticsSchema,
  retrieval: z.object({
    query_source: z.enum(['input', 'configured', 'none']),
    query_available: z.boolean(),
    fact_messages: z.number().int().nonnegative(),
    selection: z
      .object({
        candidates: z.number().int().nonnegative(),
        returned: z.number().int().nonnegative(),
        duplicate_uuid: z.number().int().nonnegative(),
        irrelevant: z.number().int().nonnegative(),
        uncertain_time: z.number().int().nonnegative(),
        invalid_time: z.number().int().nonnegative(),
        budget: z.number().int().nonnegative(),
        source_reference_deferred: z.number().int().nonnegative(),
        truncated: z.boolean(),
      })
      .optional(),
  }),
});
export type MemoryLoadDiagnostics = z.infer<typeof MemoryLoadDiagnosticsSchema>;
export const MemoryWriteOutcomeSchema = z.object({
  replaySafe: ReplaySafeMemoryWriteDiagnosticsSchema.optional(),
  extraction: ExtractionOutcomeSchema,
  written: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  audit: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type MemoryWriteOutcome = z.infer<typeof MemoryWriteOutcomeSchema>;

export const QueueDeliverySchema = z.object({
  version: z.literal(1),
  status: z.literal('queued'),
  durable: z.literal(true),
  enqueue_ms: z.number().finite().nonnegative(),
  storage_breakdown: StorageTotalsSchema.nullable().optional(),
  jobs: z.array(z.object({ uuid: z.string().uuid(), state: z.string().max(32) })).max(64),
  graph_fresh: z.boolean(),
});
export type QueueDelivery = z.infer<typeof QueueDeliverySchema>;
export const MemoryDeliveryOutcomeSchema = z.union([
  MemoryWriteOutcomeSchema,
  MemoryWriteOutcomeSchema.omit({ extraction: true }).extend({ delivery: QueueDeliverySchema }),
]);
export type MemoryDeliveryOutcome = z.infer<typeof MemoryDeliveryOutcomeSchema>;
