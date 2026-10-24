import { StorageObservationSchema, type StorageTotals } from '../schemas/StorageObservation.schema';
/** Fixed-size numeric aggregation; never retains a storage operation's arguments. */
export class StorageAccumulator {
  private totals: StorageTotals = {
    operations: 0,
    unconfirmed: 0,
    invalid_samples: 0,
    summed_total_ms: 0,
    queue_wait_ms: null,
    lock_wait_ms: null,
    disk_refresh_ms: null,
    snapshot_write_ms: null,
    snapshot_bytes: null,
    transaction_ms: null,
    serialization_ms: null,
    samples: {
      queue_wait_ms: 0,
      lock_wait_ms: 0,
      disk_refresh_ms: 0,
      snapshot_write_ms: 0,
      snapshot_bytes: 0,
      transaction_ms: 0,
      serialization_ms: 0,
    },
  };
  observe(input: unknown): void {
    const parsed = StorageObservationSchema.safeParse(input);
    if (!parsed.success) {
      this.totals.invalid_samples++;
      return;
    }
    const value = parsed.data;
    this.totals.operations++;
    if (!value.acknowledged) this.totals.unconfirmed++;
    this.totals.summed_total_ms += value.total_ms;
    for (const key of [
      'queue_wait_ms',
      'lock_wait_ms',
      'disk_refresh_ms',
      'snapshot_write_ms',
      'snapshot_bytes',
      'transaction_ms',
      'serialization_ms',
    ] as const) {
      if (value[key] !== null) {
        this.totals[key] = (this.totals[key] ?? 0) + value[key]!;
        this.totals.samples[key]++;
      }
    }
  }
  snapshot(): StorageTotals | null {
    return this.totals.operations || this.totals.invalid_samples
      ? (JSON.parse(JSON.stringify(this.totals)) as StorageTotals)
      : null;
  }
}
