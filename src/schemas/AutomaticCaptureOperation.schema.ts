import { z } from 'zod';
import {
  AUTOMATIC_LEDGER_LIMITS,
  AutomaticOperationAttemptSchema,
} from './AutomaticLedgerPrimitives.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import {
  AutomaticOperationDescriptorV2Schema,
  AutomaticOperationIdentityV2Schema,
  canonicalAutomaticCaptureV2,
  hashAutomaticCaptureV2,
} from './AutomaticCapture.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const generation = z.number().int().min(1).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration);
const timestamp = z.string().datetime();

const common = {
  version: z.literal(2),
  operationId: uuid,
  identity: AutomaticOperationIdentityV2Schema,
  descriptor: AutomaticOperationDescriptorV2Schema,
  createdAt: timestamp,
  lastObservedAt: timestamp,
  attempts: z
    .array(AutomaticOperationAttemptSchema)
    .max(AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation),
  overflowCount: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.overflowCounterMax),
  auditTruncated: z.boolean().optional(),
  /** Latest successful resume cause; independent of bounded attempt retention. */
  lastResumeCause: z.enum(['lease_expired', 'failed', 'interrupted']).optional(),
  beginCallHash: hash64,
  retryCount: z.number().int().min(0).max(3),
  lastRetryCallHash: hash64.optional(),
};

const captured = z
  .object({ ...common, state: z.literal('captured'), generation: z.literal(0) })
  .strict();

const leased = z
  .object({
    ...common,
    state: z.literal('leased'),
    generation,
    lease: z
      .object({
        token: uuid,
        acquiredAt: timestamp,
        renewedAt: timestamp,
        expiresAt: timestamp,
        claimKind: z.enum(['initial', 'resume']),
      })
      .strict(),
  })
  .strict();

const failed = z
  .object({
    ...common,
    state: z.literal('failed'),
    generation,
    failedAt: timestamp,
    failureCode: z.enum([
      'graph_conflict',
      'invalid_plan',
      'provider_error',
      'storage_error',
      'budget_exhausted',
      'capacity',
      'unknown',
    ]),
  })
  .strict();

const interrupted = z
  .object({
    ...common,
    state: z.literal('interrupted'),
    generation,
    interruptedAt: timestamp,
    failureCode: z.enum(['invocation_interrupted', 'lease_expired', 'storage_error', 'unknown']),
  })
  .strict();

const committed = z
  .object({
    ...common,
    state: z.literal('committed'),
    generation,
    terminalReceipt: AutomaticCaptureTerminalReceiptV2Schema,
    completionCallHash: hash64,
  })
  .strict();

const cancelled = z
  .object({
    ...common,
    state: z.literal('cancelled'),
    generation: z.number().int().min(0).max(AUTOMATIC_LEDGER_LIMITS.maxGeneration),
    terminalReceipt: AutomaticCaptureTerminalReceiptV2Schema,
  })
  .strict();

const operationVariants = z.discriminatedUnion('state', [
  captured,
  leased,
  failed,
  interrupted,
  committed,
  cancelled,
]);

const knownStates = new Set([
  'captured',
  'leased',
  'failed',
  'interrupted',
  'committed',
  'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reject future versions and oversized nested arrays before parsing operation
 * identity, attempts, receipt dependencies, or receipt items.
 */
function preflightOperationInput(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version !== 2) {
    return null;
  }
  if (typeof value.state !== 'string' || !knownStates.has(value.state)) {
    return null;
  }
  if (!isRecord(value.identity) || !isRecord(value.descriptor)) {
    return null;
  }
  if (
    value.identity.lifecycle !== 'replaySafeV2' ||
    value.descriptor.version !== 2 ||
    value.descriptor.lifecycle !== 'replaySafeV2'
  ) {
    return null;
  }
  if (
    (value.identity.purpose !== 'human_turn_memory' &&
      value.identity.purpose !== 'assistant_final_save') ||
    value.descriptor.purpose !== value.identity.purpose ||
    (value.identity.purpose === 'human_turn_memory' && value.identity.role !== 'human') ||
    (value.identity.purpose === 'assistant_final_save' && value.identity.role !== 'assistant')
  ) {
    return null;
  }
  if (!Array.isArray(value.attempts)) {
    return value;
  }
  if (value.attempts.length > AUTOMATIC_LEDGER_LIMITS.attemptsPerOperation) {
    return null;
  }
  if (value.state !== 'committed' && value.state !== 'cancelled') return value;
  if (!isRecord(value.terminalReceipt)) return value;

  if (
    Array.isArray(value.terminalReceipt.dependencies) &&
    value.terminalReceipt.dependencies.length > 32
  ) {
    return null;
  }
  if (!isRecord(value.terminalReceipt.receipt)) return value;
  const receipt = value.terminalReceipt.receipt;
  if (Array.isArray(receipt.items) && receipt.items.length > 32) {
    return null;
  }
  if (Array.isArray(receipt.sourceIds) && receipt.sourceIds.length > 32) {
    return null;
  }
  return value;
}

/** Structural validation only; a valid operation record never grants authority. */
export const AutomaticCaptureOperationV2Schema = z
  .preprocess(preflightOperationInput, operationVariants)
  .superRefine((operation, context) => {
    const invalid = (message: string, path?: Array<string | number>) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message, path });
    const createdAt = Date.parse(operation.createdAt);
    const lastObservedAt = Date.parse(operation.lastObservedAt);

    if (createdAt > lastObservedAt) {
      invalid('Last observed operation time must not precede creation', ['lastObservedAt']);
    }

    if (
      operation.identity.purpose !== operation.descriptor.purpose ||
      (operation.identity.role === 'human' &&
        operation.descriptor.purpose !== 'human_turn_memory') ||
      (operation.identity.role === 'assistant' &&
        operation.descriptor.purpose !== 'assistant_final_save')
    ) {
      invalid('Operation identity and descriptor purpose do not match', ['descriptor', 'purpose']);
    }

    if ((operation.retryCount === 0) !== (operation.lastRetryCallHash === undefined)) {
      invalid('Retry count and last retry-call hash must be present together', ['retryCount']);
    }
    if (operation.lastResumeCause !== undefined && operation.generation < 2) {
      invalid('A resume cause requires a resumed generation', ['lastResumeCause']);
    }
    if (operation.state === 'captured' && operation.retryCount !== 0) {
      invalid('A captured operation cannot already have graph-conflict retries', ['retryCount']);
    }
    if (
      operation.identity.purpose === 'assistant_final_save' &&
      (operation.retryCount !== 0 || operation.lastRetryCallHash !== undefined)
    ) {
      invalid('Assistant final-save operations cannot have graph-conflict retries', ['retryCount']);
    }

    let previousAttemptAt = createdAt;
    for (const [index, attempt] of operation.attempts.entries()) {
      const attemptAt = Date.parse(attempt.at);
      if (attemptAt < previousAttemptAt || attemptAt > lastObservedAt) {
        invalid('Attempt times must be monotonic and within operation observation time', [
          'attempts',
          index,
          'at',
        ]);
      }
      previousAttemptAt = attemptAt;
    }

    if (operation.state === 'leased') {
      const acquiredAt = Date.parse(operation.lease.acquiredAt);
      const renewedAt = Date.parse(operation.lease.renewedAt);
      const expiresAt = Date.parse(operation.lease.expiresAt);
      const leaseDurationMs = Math.min(
        AUTOMATIC_LEDGER_LIMITS.maxLeaseMs,
        Math.max(
          operation.descriptor.invocationDeadlineMs + AUTOMATIC_LEDGER_LIMITS.storageGraceMs,
          AUTOMATIC_LEDGER_LIMITS.minLeaseMs,
        ),
      );
      if (
        acquiredAt < createdAt ||
        renewedAt < acquiredAt ||
        renewedAt > lastObservedAt ||
        expiresAt <= renewedAt ||
        expiresAt - renewedAt !== leaseDurationMs
      ) {
        invalid('Lease times and duration do not match the captured operation', ['lease']);
      }
      if (
        (operation.lease.claimKind === 'initial' && operation.generation !== 1) ||
        (operation.lease.claimKind === 'resume' && operation.generation < 2)
      ) {
        invalid('Lease claim kind does not match its generation', ['lease', 'claimKind']);
      }
    }

    if (
      operation.state === 'failed' &&
      (Date.parse(operation.failedAt) < createdAt ||
        Date.parse(operation.failedAt) > lastObservedAt)
    ) {
      invalid('Failure time must be within operation observation time', ['failedAt']);
    }
    if (
      operation.state === 'interrupted' &&
      (Date.parse(operation.interruptedAt) < createdAt ||
        Date.parse(operation.interruptedAt) > lastObservedAt)
    ) {
      invalid('Interruption time must be within operation observation time', ['interruptedAt']);
    }

    if (operation.state === 'committed' || operation.state === 'cancelled') {
      const terminal = operation.terminalReceipt;
      const descriptorHash = hashAutomaticCaptureV2(operation.descriptor);
      const expectedKind =
        operation.state === 'cancelled'
          ? 'cancelled'
          : operation.identity.purpose === 'human_turn_memory'
            ? 'human_capture_committed'
            : 'assistant_final_saved';
      const terminalAt = Date.parse(terminal.terminalAt);
      if (
        terminal.kind !== expectedKind ||
        terminal.operationId !== operation.operationId ||
        terminal.sourceId !== operation.identity.sourceId ||
        terminal.sourceHash !== operation.identity.sourceHash ||
        terminal.descriptorHash !== descriptorHash
      ) {
        invalid('Terminal receipt does not match the operation identity and purpose', [
          'terminalReceipt',
        ]);
      }
      if (terminalAt < createdAt || terminalAt > lastObservedAt) {
        invalid('Terminal time must be within operation observation time', [
          'terminalReceipt',
          'terminalAt',
        ]);
      }
      if (
        terminal.kind === 'human_capture_committed' &&
        (operation.identity.purpose !== 'human_turn_memory' ||
          operation.descriptor.purpose !== 'human_turn_memory' ||
          canonicalAutomaticCaptureV2(terminal.receipt.policy) !==
            canonicalAutomaticCaptureV2(operation.descriptor.policy))
      ) {
        invalid('Human terminal receipt policy must match the human descriptor', [
          'terminalReceipt',
          'receipt',
          'policy',
        ]);
      }
    }

    if (
      Buffer.byteLength(JSON.stringify(operation), 'utf8') > AUTOMATIC_LEDGER_LIMITS.operationBytes
    ) {
      invalid('Automatic capture operation exceeds 32 KiB serialized');
    }
  });

export type AutomaticCaptureOperationV2 = z.infer<typeof AutomaticCaptureOperationV2Schema>;
