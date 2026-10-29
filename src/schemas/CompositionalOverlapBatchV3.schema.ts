import { z } from 'zod';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import { CompositionalAutomaticClaimMeaningV2Schema } from './CompositionalAutomaticMemory.schema';
import { LiteralCompositionalPairCompatibilityRuleV1Schema } from './LiteralCompositionalPairCompatibilityV1.schema';
import { snapshotBoundedCompositionalJson } from './CompositionalPreferenceV2.schema';
const requestBody = z
  .object({
    namespace: CompositionalCaptureNamespaceV3Schema,
    subjectId: z.string().uuid(),
    meanings: z.array(CompositionalAutomaticClaimMeaningV2Schema).min(1).max(32),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.meanings.some((m) => m.namespace !== r.namespace || m.subjectId !== r.subjectId) ||
      r.meanings.reduce((sum, m) => sum + m.bundles[0].nodes.length, 0) > 128 ||
      r.meanings.reduce((sum, m) => sum + m.bundles[0].edges.length, 0) > 128 ||
      r.meanings.reduce((sum, m) => sum + m.bundles[0].rootPaths.length, 0) > 32
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Whole-source meaning domain/capacity mismatch',
      });
  });
export const CompositionalOverlapBatchRequestV3Schema = requestBody;
export type CompositionalOverlapBatchRequestV3 = z.infer<typeof requestBody>;
export const CompositionalOverlapBatchFailureReasonV3Schema = z.enum([
  'invalid_input',
  'invalid_resources',
  'invalid_snapshot',
  'invalid_batch',
  'inspection_capacity',
  'budget_exhausted',
  'diagnostic_capacity',
]);
export const CompositionalOverlapBatchFailureV3Schema = z
  .object({
    status: z.literal('incomplete'),
    reason: CompositionalOverlapBatchFailureReasonV3Schema,
  })
  .strict();
export type CompositionalOverlapBatchFailureV3 = z.infer<
  typeof CompositionalOverlapBatchFailureV3Schema
>;
const detail = z
  .object({
    candidateId: z.string().uuid(),
    family: z.enum(['literal_v1', 'compositional_v2', 'unknown']),
    projection: z.enum(['exact', 'unknown', 'uncommitted']),
    currentReview: z.enum(['accepted', 'proposed', 'rejected', 'unknown']),
    currentEligibility: z.enum(['eligible', 'ineligible', 'unknown']),
    domain: z.enum(['proven_disjoint', 'possible_overlap', 'unknown_domain']),
    equivalent: z.boolean().nullable(),
    disposition: z.enum([
      'proven_disjoint',
      'conditional_compatible',
      'legacy_reuse_not_authorized',
      'same_family_reference_data',
      'possible_overlap',
      'unknown',
      'uncommitted',
    ]),
    conditionalRuleId: LiteralCompositionalPairCompatibilityRuleV1Schema.optional(),
    referenceGuardHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const bundleBody = z
  .object({
    version: z.literal(3),
    status: z.literal('complete_data'),
    bundleIndex: z.number().int().min(0).max(31),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    inspectedCandidateCount: z.number().int().min(0).max(128),
    provenDisjointCount: z.number().int().min(0).max(128),
    relevantCandidateCount: z.number().int().min(0).max(8),
    details: z.array(detail).max(8),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.inspectedCandidateCount !== r.provenDisjointCount + r.relevantCandidateCount ||
      r.details.filter((d) => d.domain !== 'proven_disjoint').length !== r.relevantCandidateCount ||
      new Set(r.details.map((d) => d.candidateId)).size !== r.details.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Honest complete candidate accounting required',
      });
  });
export const CompositionalOverlapBundleDataV3Schema = z
  .unknown()
  .transform((value, ctx) => {
    const snapshot = snapshotBoundedCompositionalJson(value, 32768);
    if (snapshot === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded diagnostic data' });
      return z.NEVER;
    }
    return snapshot;
  })
  .pipe(bundleBody);
export type CompositionalOverlapBundleDataV3 = z.infer<
  typeof CompositionalOverlapBundleDataV3Schema
>;

export const CompositionalPlanningDataExpectationV3Schema = z
  .object({
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    namespace: CompositionalCaptureNamespaceV3Schema,
    subjectId: z.string().uuid(),
  })
  .strict();
