import { z } from 'zod';
import { AutonomousPersonalBeginV4ContextOwnedDataSchema } from './AutonomousPersonalBeginV4.schema';
import { AutonomousPersonalOperationIdentityV4OwnedDataSchema } from './AutonomousPersonalSourceV4.schema';
import { AutonomousPersonalReceiptV4OwnedDataSchema } from './AutonomousPersonalOperationV4.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);

export const AutonomousPersonalNativeOriginV4FailureReasonSchema = z.enum([
  'invalid_input',
  'conflict',
  'capacity',
]);
export type AutonomousPersonalNativeOriginV4FailureReason = z.infer<
  typeof AutonomousPersonalNativeOriginV4FailureReasonSchema
>;

const supportedCommittedReceiptV4Schema = AutonomousPersonalReceiptV4OwnedDataSchema.refine(
  (receipt) =>
    receipt.kind === 'human_autonomous_capture_committed' ||
    receipt.kind === 'human_autonomous_source_deferred_committed' ||
    receipt.kind === 'human_autonomous_source_verdict_committed',
);

/** Strict native-origin DATA projection. It proves no native origin or write authority. */
export const AutonomousPersonalNativeOriginV4OwnedDataSchema = z
  .object({
    version: z.literal(4),
    identity: AutonomousPersonalOperationIdentityV4OwnedDataSchema,
    instance: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.instance,
    workflow: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.workflow,
    execution: AutonomousPersonalBeginV4ContextOwnedDataSchema.shape.execution,
    attemptHash: hash64,
    completionCallHash: hash64,
    terminalReceipt: supportedCommittedReceiptV4Schema,
  })
  .strict();

export type AutonomousPersonalNativeOriginV4 = z.infer<
  typeof AutonomousPersonalNativeOriginV4OwnedDataSchema
>;
