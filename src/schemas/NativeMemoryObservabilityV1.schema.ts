import { z } from 'zod';
import { ExtractionStageMetricsSchema } from './ExtractionOutcome.schema';
import { StorageTotalsSchema } from './StorageObservation.schema';

export const NativeDiagnosticsOptionSchema = z.enum(['disabled', 'enabled']);
const requests = ExtractionStageMetricsSchema.shape.requests.omit({ retries: true }).strict();
/** Diagnostic DATA only: never a receipt, authority token, or provider billing estimate. */
export const NativeMemoryObservabilityV1Schema = z
  .object({
    version: z.literal(1),
    operation_id: z.string().uuid(),
    purpose: z.enum(['capture', 'load', 'save']),
    elapsed_ms: z.number().finite().nonnegative(),
    observer_errors: z.number().int().min(0).max(100),
    native_requests: requests.nullable(),
    storage: StorageTotalsSchema.nullable(),
  })
  .strict();
export type NativeMemoryObservabilityV1 = z.infer<typeof NativeMemoryObservabilityV1Schema>;
