import { z } from 'zod';
const duration = z.number().finite().nonnegative();
export const StorageObservationSchema = z.object({
  backend: z.enum(['embedded', 'neo4j']),
  acknowledged: z.boolean(),
  total_ms: duration,
  queue_wait_ms: duration.nullable(),
  lock_wait_ms: duration.nullable(),
  disk_refresh_ms: duration.nullable(),
  snapshot_write_ms: duration.nullable(),
  snapshot_bytes: z.number().int().nonnegative().nullable(),
  transaction_ms: duration.nullable(),
  serialization_ms: duration.nullable(),
});
export type StorageObservation = z.infer<typeof StorageObservationSchema>;
const count = z.number().int().nonnegative();
export const StorageTotalsSchema = z.object({
  operations: count,
  unconfirmed: count,
  invalid_samples: count,
  summed_total_ms: duration,
  queue_wait_ms: duration.nullable(),
  lock_wait_ms: duration.nullable(),
  disk_refresh_ms: duration.nullable(),
  snapshot_write_ms: duration.nullable(),
  snapshot_bytes: z.number().int().nonnegative().nullable(),
  transaction_ms: duration.nullable(),
  serialization_ms: duration.nullable(),
  samples: z.object({
    queue_wait_ms: count,
    lock_wait_ms: count,
    disk_refresh_ms: count,
    snapshot_write_ms: count,
    snapshot_bytes: count,
    transaction_ms: count,
    serialization_ms: count,
  }),
});
export type StorageTotals = z.infer<typeof StorageTotalsSchema>;
