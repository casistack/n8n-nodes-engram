import { z } from 'zod';

export const AUTOMATIC_LEDGER_LIMITS = Object.freeze({
  operationsPerNamespace: 10_000,
  operationsPerStore: 100_000,
  namespaceBytes: 10 * 1024 * 1024,
  storeBytes: 100 * 1024 * 1024,
  operationBytes: 32 * 1024,
  terminalReceiptBytes: 16 * 1024,
  descriptorBytes: 4 * 1024,
  attemptsPerOperation: 32,
  attemptBytes: 256,
  overflowCounterMax: 2_147_483_647,
  maxGeneration: 2_147_483_647,
  minLeaseMs: 60_000,
  storageGraceMs: 30_000,
  maxLeaseMs: 180_000,
  minInvocationDeadlineMs: 100,
  maxInvocationDeadlineMs: 120_000,
});

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const AutomaticOperationAttemptDispositionSchema = z.enum([
  'captured',
  'claim_won',
  'in_progress',
  'committed_replay',
  'cancelled_replay',
  'legacy_unconfirmed',
  'lease_renewed',
  'committed',
  'failed',
  'interrupted',
  'cancelled',
  'resume_available',
  'resumed',
  'fenced',
  'clock_regression',
  'capacity_reached',
  'conflict',
  'unsupported_mode',
]);

export const AutomaticOperationAttemptSchema = z
  .object({
    attemptHash: hash,
    at: z.string().datetime(),
    disposition: AutomaticOperationAttemptDispositionSchema,
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <= AUTOMATIC_LEDGER_LIMITS.attemptBytes,
    { message: 'Automatic operation attempt must not exceed 256 bytes serialized' },
  );
export type AutomaticOperationAttempt = z.infer<typeof AutomaticOperationAttemptSchema>;
