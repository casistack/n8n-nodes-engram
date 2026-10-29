import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import { AutomaticCaptureOperationV2Schema } from './AutomaticCaptureOperation.schema';
import { AutomaticCaptureTerminalReceiptV2Schema } from './AutomaticCaptureReceipt.schema';
import {
  AutomaticCaptureResumeDecisionV2Schema,
  AutomaticCaptureCancelDecisionKindV2Schema,
} from './AutomaticCaptureApi.schema';
import {
  AutomaticCaptureLeaseFenceV2Schema,
  AutomaticCaptureResumeSourceV2Schema,
} from '../storage/AutomaticCaptureHandles';

/** Backend context, never caller-selected administrative authority. */
export const AutomaticHumanCaptureStoreContextV2Schema = z
  .object({ storeHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const AutomaticHumanCaptureControlContextV2Schema =
  AutomaticHumanCaptureStoreContextV2Schema.extend({ backendNow: z.string().datetime() }).strict();
export type AutomaticHumanCaptureControlContextV2 = z.infer<
  typeof AutomaticHumanCaptureControlContextV2Schema
>;
export const AutomaticHumanCaptureResumeContextV2Schema =
  AutomaticHumanCaptureControlContextV2Schema.extend({
    leaseToken: z.string().uuid(),
    previousOperation: AutomaticCaptureOperationV2Schema,
  }).strict();
export type AutomaticHumanCaptureResumeContextV2 = z.infer<
  typeof AutomaticHumanCaptureResumeContextV2Schema
>;
export const AutomaticHumanCaptureResumeSourcePreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('resume_source'),
      operation: AutomaticCaptureOperationV2Schema,
      resumeSource: AutomaticCaptureResumeSourceV2Schema,
    })
    .strict(),
  z
    .object({ kind: z.literal('decision'), decision: AutomaticCaptureResumeDecisionV2Schema })
    .strict(),
]);
export type AutomaticHumanCaptureResumeSourcePreparationV2 = z.infer<
  typeof AutomaticHumanCaptureResumeSourcePreparationV2Schema
>;
export const AutomaticHumanCaptureResumePreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('prepared_resume'),
      graph: GraphDataSchema,
      leaseFence: AutomaticCaptureLeaseFenceV2Schema,
      writeRequired: z.boolean(),
    })
    .strict(),
  z
    .object({ kind: z.literal('decision'), decision: AutomaticCaptureResumeDecisionV2Schema })
    .strict(),
]);
export type AutomaticHumanCaptureResumePreparationV2 = z.infer<
  typeof AutomaticHumanCaptureResumePreparationV2Schema
>;
const cancelledReceipt = AutomaticCaptureTerminalReceiptV2Schema.refine(
  (receipt) => receipt.kind === 'cancelled',
);
export const AutomaticHumanCaptureCancelPreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('prepared_cancel'),
      graph: GraphDataSchema,
      terminalReceipt: cancelledReceipt,
    })
    .strict(),
  z
    .object({
      kind: z.literal('decision'),
      decision: z.object({ kind: AutomaticCaptureCancelDecisionKindV2Schema }).strict(),
    })
    .strict(),
]);
export type AutomaticHumanCaptureCancelPreparationV2 = z.infer<
  typeof AutomaticHumanCaptureCancelPreparationV2Schema
>;
