import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import {
  CompositionalCaptureLeaseFenceV3Schema,
  CompositionalCaptureNonPermitResultV3Schema,
} from './CompositionalAutomaticCaptureLifecycleV3.schema';
import { CompositionalAutomaticCaptureBeginRequestV3Schema } from './CompositionalAutomaticCaptureV3.schema';

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();

const canonicalUtcMillis = z
  .string()
  .datetime({ precision: 3 })
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  }, 'Backend time must be canonical millisecond UTC');

/** Backend-derived inputs only; the caller request is validated separately. */
export const CompositionalAutomaticCaptureBeginContextV3Schema = z
  .object({
    storeHash: hash64,
    backendNow: canonicalUtcMillis,
    previousEpisodeId: uuid.nullable(),
  })
  .strict();
export type CompositionalAutomaticCaptureBeginContextV3 = z.infer<
  typeof CompositionalAutomaticCaptureBeginContextV3Schema
>;

const preparedClaim = z
  .object({
    kind: z.literal('prepared_claim'),
    graph: GraphDataSchema,
    leaseFence: CompositionalCaptureLeaseFenceV3Schema,
    writeRequired: z.boolean(),
  })
  .strict();

const preparedDecision = z
  .object({
    kind: z.literal('prepared_decision'),
    graph: GraphDataSchema,
    decision: CompositionalCaptureNonPermitResultV3Schema,
  })
  .strict();

const decision = z
  .object({
    kind: z.literal('decision'),
    decision: CompositionalCaptureNonPermitResultV3Schema,
  })
  .strict();

/** Candidate data and false-only observations; it contains no storage handle or permit. */
export const CompositionalAutomaticCaptureBeginPreparationV3Schema = z.union([
  preparedClaim,
  preparedDecision,
  decision,
]);
export type CompositionalAutomaticCaptureBeginPreparationV3 = z.infer<
  typeof CompositionalAutomaticCaptureBeginPreparationV3Schema
>;

/** Closed request schema exported here for the pure helper's inferred input type. */
export { CompositionalAutomaticCaptureBeginRequestV3Schema };
