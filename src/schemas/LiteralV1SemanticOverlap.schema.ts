import { z } from 'zod';
import {
  CompositionalPreferenceV2DescriptorSchema,
  snapshotBoundedCompositionalJson,
} from './CompositionalPreferenceV2.schema';
import { CompositionalAutomaticClaimMeaningV2Schema } from './CompositionalAutomaticMemory.schema';

export const LiteralV1OverlapReasonSchema = z.enum([
  'exact_meaning',
  'not_equivalent',
  'rejected_overlap',
  'proposed_overlap',
  'manual_overlap_unresolved',
  'source_unavailable',
  'binding_not_current',
  'invalid_v1_provenance',
  'current_review_not_accepted',
  'ambiguous_existing_ids',
  'inspection_capacity',
  'new_source_not_eligible',
  'proven_disjoint',
  'unknown_overlap_domain',
]);
export type LiteralV1OverlapReason = z.infer<typeof LiteralV1OverlapReasonSchema>;

const namespace = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const requestBody = z
  .object({
    descriptor: CompositionalPreferenceV2DescriptorSchema,
    namespace,
    subjectId: z.string().uuid(),
    newMeaning: CompositionalAutomaticClaimMeaningV2Schema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.newMeaning.namespace !== request.namespace ||
      request.newMeaning.subjectId !== request.subjectId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Inspection domain and typed meaning must agree',
      });
    }
  });
const bounded = z.unknown().transform((value, context) => {
  const snapshot = snapshotBoundedCompositionalJson(value, 32768);
  if (snapshot === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded inspection data' });
    return z.NEVER;
  }
  return snapshot;
});
export const LiteralV1SemanticOverlapRequestSchema = bounded.pipe(requestBody);
export type LiteralV1SemanticOverlapRequest = z.infer<typeof LiteralV1SemanticOverlapRequestSchema>;

const common = {
  oldEdgeId: z.string().uuid(),
  provenance: z.enum(['automatic_literal_v1', 'manual_or_generic', 'unknown_protected']),
  currentReview: z.enum(['accepted', 'proposed', 'rejected', 'unknown']),
  currentAuthority: z.enum(['current', 'binding_not_current', 'source_unavailable', 'invalid']),
  oldCurrentEligibility: z.enum(['eligible', 'ineligible', 'unavailable']),
  blocksNewAcceptance: z.boolean(),
  reasons: z.array(LiteralV1OverlapReasonSchema).max(8),
};
export const LiteralV1SemanticInspectionSchema = z.discriminatedUnion('projection', [
  z
    .object({
      ...common,
      projection: z.literal('exact'),
      canonicalMeaning: CompositionalAutomaticClaimMeaningV2Schema,
      domain: z.enum(['proven_disjoint', 'possible_overlap', 'unknown_domain']),
      equivalent: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...common,
      projection: z.literal('unresolved'),
      domain: z.literal('unknown_domain'),
      equivalent: z.null(),
    })
    .strict(),
  z
    .object({
      ...common,
      projection: z.literal('unavailable'),
      domain: z.literal('unknown_domain'),
      equivalent: z.null(),
    })
    .strict(),
]);
export type LiteralV1SemanticInspection = z.infer<typeof LiteralV1SemanticInspectionSchema>;

const resultBody = z
  .object({
    version: z.literal(1),
    descriptor: CompositionalPreferenceV2DescriptorSchema,
    namespace,
    subjectId: z.string().uuid(),
    status: z.enum(['complete', 'incomplete']),
    inspectedCandidateCount: z.number().int().min(0).max(128),
    provenDisjointCount: z.number().int().min(0).max(128),
    relevantCandidateCount: z.number().int().min(0).max(128),
    inspections: z.array(LiteralV1SemanticInspectionSchema).max(8),
    reasons: z.array(LiteralV1OverlapReasonSchema).max(8),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.inspectedCandidateCount !==
        result.provenDisjointCount + result.relevantCandidateCount ||
      new Set(result.inspections.map((item) => item.oldEdgeId)).size !==
        result.inspections.length ||
      (result.status === 'complete' &&
        result.inspections.filter((item) => item.domain !== 'proven_disjoint').length !==
          result.relevantCandidateCount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Inspection counts and complete relevant detail must agree',
      });
    }
    for (const item of result.inspections) {
      if (
        (item.projection !== 'exact' &&
          (!item.blocksNewAcceptance || item.oldCurrentEligibility === 'eligible')) ||
        (item.domain === 'proven_disjoint' &&
          (item.projection !== 'exact' || item.equivalent || item.blocksNewAcceptance)) ||
        (item.domain === 'unknown_domain' && !item.blocksNewAcceptance) ||
        (item.oldCurrentEligibility === 'eligible' &&
          (item.provenance !== 'automatic_literal_v1' ||
            item.currentReview !== 'accepted' ||
            item.currentAuthority !== 'current'))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Inspection projection/eligibility is internally inconsistent',
        });
      }
    }
  });
/** Diagnostic evidence only; a parsed result never authorizes reuse or writes. */
export const LiteralV1SemanticOverlapResultSchema = bounded.pipe(resultBody);
export type LiteralV1SemanticOverlapResult = z.infer<typeof LiteralV1SemanticOverlapResultSchema>;
