import { z } from 'zod';
import { AutomaticCaptureBeginRequestV2Schema } from './AutomaticCapture.schema';
import { AutomaticCaptureOperationV2Schema } from './AutomaticCaptureOperation.schema';
import { AutomaticCaptureBeginDecisionV2Schema } from './AutomaticCaptureApi.schema';
import { GraphDataSchema } from './GraphData.schema';
import { AutomaticCaptureLeaseFenceV2Schema } from '../storage/AutomaticCaptureHandles';

/** Inputs derived inside/outside the backend transaction as specified by its adapter. Not authority. */
export const AutomaticHumanCaptureBeginInputV2Schema = z
  .object({
    request: AutomaticCaptureBeginRequestV2Schema.refine(
      (request) => request.purpose === 'human_turn_memory',
    ),
    storeHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceId: z.string().uuid(),
    operationId: z.string().uuid(),
    previousEpisodeId: z.string().uuid().nullable(),
    backendNow: z.string().datetime(),
    beginCallHash: z.string().regex(/^[a-f0-9]{64}$/),
    leaseToken: z.string().uuid(),
  })
  .strict();
export type AutomaticHumanCaptureBeginInputV2 = z.input<
  typeof AutomaticHumanCaptureBeginInputV2Schema
>;
const leased = AutomaticCaptureOperationV2Schema.refine(
  (
    operation,
  ): operation is Extract<z.infer<typeof AutomaticCaptureOperationV2Schema>, { state: 'leased' }> =>
    operation.state === 'leased',
);
/** Prepared candidates are not durable results. No handles or processing eligibility are returned. */
export const AutomaticHumanCaptureBeginPreparationV2Schema = z.union([
  z
    .object({
      kind: z.literal('prepared_claim'),
      graph: GraphDataSchema,
      operation: leased,
      leaseFence: AutomaticCaptureLeaseFenceV2Schema,
      writeRequired: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('prepared_source_only'), graph: GraphDataSchema }).strict(),
  z
    .object({
      kind: z.literal('prepared_decision'),
      graph: GraphDataSchema,
      decision: AutomaticCaptureBeginDecisionV2Schema,
    })
    .strict(),
  z
    .object({ kind: z.literal('decision'), decision: AutomaticCaptureBeginDecisionV2Schema })
    .strict(),
]);
export type AutomaticHumanCaptureBeginPreparationV2 = z.infer<
  typeof AutomaticHumanCaptureBeginPreparationV2Schema
>;
