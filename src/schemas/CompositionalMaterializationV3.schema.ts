import { z } from 'zod';
import { CompositionalPreferenceV2ReasonSchema } from './CompositionalPreferenceV2.schema';
import { CompositionalOperationSnapshotIndexRequestV3Schema } from './CompositionalOperationSnapshotIndexV3.schema';
import {
  CompositionalMaterializationPreparedV3Schema,
  type CompositionalMaterializationPreparedV3,
} from './CompositionalMaterializationPreparedV3.schema';

/** Selects one persisted operation; it carries no source or subject authority. */
export const CompositionalMaterializationSelectorV3Schema =
  CompositionalOperationSnapshotIndexRequestV3Schema;
export type CompositionalMaterializationSelectorV3 = z.infer<
  typeof CompositionalMaterializationSelectorV3Schema
>;

export const CompositionalMaterializationDeferredReasonV3Schema = z.enum([
  'invalid_input',
  'invalid_resources',
  'invalid_snapshot',
  'missing_operation',
  'ambiguous_operation',
  'unsupported_mode',
  'operation_not_leased',
  'clock_regression',
  'lease_expired',
  'invalid_source',
  'authority_changed',
  'source_verdict_required',
  'identity_collision',
  'inspection_incomplete',
  'budget_exhausted',
  'plan_too_large',
  'invalid_plan',
]);
export type CompositionalMaterializationDeferredReasonV3 = z.infer<
  typeof CompositionalMaterializationDeferredReasonV3Schema
>;

/** Exact interpretation diagnostics; these data do not establish source authority. */
export const CompositionalMaterializationInterpretationV3Schema = z
  .object({
    interpreterResultHash: z.string().regex(/^[a-f0-9]{64}$/u),
    reasons: z.array(CompositionalPreferenceV2ReasonSchema).max(16),
  })
  .strict();
export type CompositionalMaterializationInterpretationV3 = z.infer<
  typeof CompositionalMaterializationInterpretationV3Schema
>;

const materializationResultBody = z.union([
  z
    .object({
      status: z.literal('prepared_data'),
      plan: CompositionalMaterializationPreparedV3Schema,
      interpretation: CompositionalMaterializationInterpretationV3Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal('deferred'),
      reason: CompositionalMaterializationDeferredReasonV3Schema,
    })
    .strict(),
]);

export const CompositionalMaterializationResultV3Schema = materializationResultBody;
export type CompositionalMaterializationResultV3 = z.infer<
  typeof CompositionalMaterializationResultV3Schema
>;

export type PreparedCompositionalMaterializationV3 = CompositionalMaterializationPreparedV3;
