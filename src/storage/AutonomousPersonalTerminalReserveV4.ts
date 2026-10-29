import { z } from 'zod';
import { AUTOMATIC_LEDGER_LIMITS } from '../schemas/AutomaticLedgerPrimitives.schema';
import { AutonomousPersonalOperationV4Schema } from '../schemas/AutonomousPersonalOperationV4.schema';
import {
  AutonomousPersonalTerminalReserveV4OwnedDataSchema,
  type AutonomousPersonalTerminalReserveV4,
} from '../schemas/AutonomousPersonalTerminalReserveV4.schema';

const PLACEHOLDER_HASH = '0'.repeat(64);

function invalid(): z.ZodError {
  const path = Object.freeze([]) as unknown as Array<string | number>;
  const issue = Object.freeze({
    code: z.ZodIssueCode.custom,
    path,
    message: 'invalid_autonomous_terminal_reserve_data',
  }) as z.ZodIssue;
  const error = new z.ZodError([issue]);
  Object.freeze(error.issues);
  return Object.freeze(error);
}

/**
 * Project the maximum terminal byte footprint of one current audit prefix.
 * The operation facade owns unknown input before any property reads. This
 * function does not append, truncate, reserve space, authenticate or persist.
 */
export function projectAutonomousPersonalTerminalReserveV4(
  input: unknown,
): AutonomousPersonalTerminalReserveV4 {
  try {
    const operation = AutonomousPersonalOperationV4Schema.parse(input);
    if (operation.state === 'committed' || operation.state === 'cancelled') throw invalid();

    // Measuring object only: null is replaced by the FULL receipt byte ceiling.
    // Never parse or persist this object as an operation or terminal receipt.
    const measuringEnvelope = {
      version: operation.version,
      operationId: operation.operationId,
      identity: operation.identity,
      descriptor: operation.descriptor,
      createdAt: operation.createdAt,
      lastObservedAt: operation.lastObservedAt,
      attempts: operation.attempts,
      overflowCount: AUTOMATIC_LEDGER_LIMITS.overflowCounterMax,
      auditTruncated: false,
      lastResumeCause: 'lease_expired',
      beginCallHash: operation.beginCallHash,
      retryCount: 3,
      lastRetryCallHash: PLACEHOLDER_HASH,
      state: 'committed',
      generation: AUTOMATIC_LEDGER_LIMITS.maxGeneration,
      terminalReceipt: null,
      completionCallHash: PLACEHOLDER_HASH,
    };
    const projectedTerminalBytes =
      Buffer.byteLength(JSON.stringify(measuringEnvelope), 'utf8') -
      Buffer.byteLength('null', 'utf8') +
      AUTOMATIC_LEDGER_LIMITS.terminalReceiptBytes;
    return Object.freeze(
      AutonomousPersonalTerminalReserveV4OwnedDataSchema.parse({
        version: 1,
        projectedTerminalBytes,
        withinLimit: projectedTerminalBytes <= AUTOMATIC_LEDGER_LIMITS.operationBytes,
      }),
    );
  } catch {
    throw invalid();
  }
}
