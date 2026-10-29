import { z } from 'zod';
import {
  AutonomousPersonalOperationV4OwnedDataSchema,
  AutonomousPersonalReceiptV4OwnedDataSchema,
  type AutonomousPersonalOperationV4,
} from './AutonomousPersonalOperationV4.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();

export const AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema = z
  .object({
    action: z.literal('completion'),
    attemptIdHash: hash64,
    operationId: uuid,
    sourceId: uuid,
  })
  .strict();

export type AutonomousPersonalTerminalOperationAuditV4 = z.infer<
  typeof AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema
>;

/** Strict input DATA for the pure leased-to-committed Operation4 transform. */
export const AutonomousPersonalTerminalOperationV4InputOwnedDataSchema = z
  .object({
    leasedOperation: AutonomousPersonalOperationV4OwnedDataSchema,
    terminalReceipt: AutonomousPersonalReceiptV4OwnedDataSchema,
    completionCallHash: hash64,
    audit: AutonomousPersonalTerminalOperationAuditV4OwnedDataSchema,
  })
  .strict();

export type AutonomousPersonalTerminalOperationV4Input = z.infer<
  typeof AutonomousPersonalTerminalOperationV4InputOwnedDataSchema
>;

export const AutonomousPersonalTerminalOperationV4FailureReasonSchema = z.enum([
  'invalid_input',
  'unsupported_generation',
  'invalid_audit',
  'invalid_receipt',
  'clock_regression',
  'lease_expired',
  'capacity',
]);

export type AutonomousPersonalTerminalOperationV4FailureReason = z.infer<
  typeof AutonomousPersonalTerminalOperationV4FailureReasonSchema
>;

export type AutonomousPersonalTerminalOperationV4 = Extract<
  AutonomousPersonalOperationV4,
  { state: 'committed' }
>;
