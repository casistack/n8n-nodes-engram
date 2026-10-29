import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import { AutomaticCaptureOperationV2Schema } from './AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import { AutomaticCaptureLeaseFenceV2Schema } from '../storage/AutomaticCaptureHandles';

export const AutomaticHumanCaptureCompletionContextV2Schema = z
  .object({
    backendNow: z.string().datetime(),
    storeHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticHumanCaptureCompletionContextV2 = z.infer<
  typeof AutomaticHumanCaptureCompletionContextV2Schema
>;
const origin = z.enum(['initial', 'resume']);
const humanReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'human_capture_committed',
);
const committed = AutomaticCaptureOperationV2Schema.refine(
  (
    operation,
  ): operation is Extract<
    z.infer<typeof AutomaticCaptureOperationV2Schema>,
    { state: 'committed' }
  > => operation.state === 'committed',
);
export const AutomaticHumanCaptureCompletionReasonV2Schema = z.enum([
  'invalid_handle',
  'invalid_input',
  'invalid_plan',
  'fenced',
  'authority_changed',
  'clock_regression',
  'resource_exhausted',
  'budget_exhausted',
  'interrupted',
  'capacity',
]);
export type AutomaticHumanCaptureCompletionReasonV2 = z.infer<
  typeof AutomaticHumanCaptureCompletionReasonV2Schema
>;
/** Prepared data is not durable acknowledgement or processing eligibility. */
export const AutomaticHumanCaptureCompletionPreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('prepared_commit'),
      graph: GraphDataSchema,
      operation: committed,
      terminalReceipt: humanReceipt,
      origin,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ack_recovered'),
      terminalReceipt: humanReceipt,
      origin,
      currentAuthority: z.enum(['active', 'changed', 'revoked', 'unknown']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prepared_retry'),
      graph: GraphDataSchema,
      leaseFence: AutomaticCaptureLeaseFenceV2Schema,
      writeRequired: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prepared_failure'),
      graph: GraphDataSchema,
      reason: AutomaticHumanCaptureCompletionReasonV2Schema,
    })
    .strict(),
  z
    .object({ kind: z.literal('decision'), reason: AutomaticHumanCaptureCompletionReasonV2Schema })
    .strict(),
]);
export type AutomaticHumanCaptureCompletionPreparationV2 = z.infer<
  typeof AutomaticHumanCaptureCompletionPreparationV2Schema
>;
