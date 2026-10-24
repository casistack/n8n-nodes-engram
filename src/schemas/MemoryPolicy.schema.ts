import { z } from 'zod';
import { ExtractionOutcomeSchema } from './ExtractionOutcome.schema';

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
  history: HistoryReadDiagnosticsSchema,
  retrieval: z.object({
    query_source: z.enum(['input', 'configured', 'none']),
    query_available: z.boolean(),
    fact_messages: z.number().int().nonnegative(),
  }),
});
export type MemoryLoadDiagnostics = z.infer<typeof MemoryLoadDiagnosticsSchema>;
export const MemoryWriteOutcomeSchema = z.object({
  extraction: ExtractionOutcomeSchema,
  written: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  audit: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type MemoryWriteOutcome = z.infer<typeof MemoryWriteOutcomeSchema>;
