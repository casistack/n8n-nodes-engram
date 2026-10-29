import { z } from 'zod';
import {
  CompositionalAutomaticCaptureOperationV3Schema,
  CompositionalAutomaticCaptureTerminalReceiptV3Schema,
} from './CompositionalAutomaticCaptureV3.schema';
import { CompositionalCompletionStageAuditV3Schema } from './CompositionalCompletionStageV3.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);

/** Bounded input to the pure leased-to-committed operation transform. */
export const CompositionalCaptureTerminalOperationInputV3Schema = z
  .object({
    leasedOperation: CompositionalAutomaticCaptureOperationV3Schema,
    terminalReceipt: CompositionalAutomaticCaptureTerminalReceiptV3Schema,
    completionCallHash: hash64,
    audit: CompositionalCompletionStageAuditV3Schema,
  })
  .strict();
export type CompositionalCaptureTerminalOperationInputV3 = z.infer<
  typeof CompositionalCaptureTerminalOperationInputV3Schema
>;

export const CompositionalCaptureTerminalOperationFailureReasonV3Schema = z.enum([
  'invalid_input',
  'invalid_audit',
  'invalid_receipt',
  'clock_regression',
  'lease_expired',
]);
export type CompositionalCaptureTerminalOperationFailureReasonV3 = z.infer<
  typeof CompositionalCaptureTerminalOperationFailureReasonV3Schema
>;

export type CompositionalCaptureTerminalOperationV3 = Extract<
  z.infer<typeof CompositionalAutomaticCaptureOperationV3Schema>,
  { state: 'committed' }
>;
