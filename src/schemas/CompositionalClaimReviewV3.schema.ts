import { z } from 'zod';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EntityNodeSchema } from './EntityNode.schema';

export const CompositionalClaimReviewRequestV3Schema = z
  .object({
    version: z.literal(3),
    namespace: CompositionalCaptureNamespaceV3Schema,
    edgeId: z.string().uuid(),
    expectedPairHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewStatus: z.enum(['accepted', 'proposed', 'rejected']),
    reviewedBy: z
      .string()
      .min(1)
      .max(512)
      .refine((v) => v.trim() === v),
  })
  .strict();
export type CompositionalClaimReviewRequestV3 = z.infer<
  typeof CompositionalClaimReviewRequestV3Schema
>;

export const CompositionalClaimReviewBackendContextV3Schema = z
  .object({
    storeHash: z.string().regex(/^[a-f0-9]{64}$/),
    backendNow: z.string().datetime(),
  })
  .strict();
export type CompositionalClaimReviewBackendContextV3 = z.infer<
  typeof CompositionalClaimReviewBackendContextV3Schema
>;

export const CompositionalClaimReviewPairV3Schema = z
  .object({
    namespace: CompositionalCaptureNamespaceV3Schema,
    edge: EntityEdgeSchema.strict(),
    value: EntityNodeSchema.strict(),
  })
  .strict()
  .superRefine((pair, ctx) => {
    if (
      pair.edge.group_id !== pair.namespace ||
      pair.value.group_id !== pair.namespace ||
      pair.edge.target_node_uuid !== pair.value.uuid
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid review pair links' });
  });

export const CompositionalClaimReviewPreparationV3Schema = z.union([
  z
    .object({
      kind: z.enum(['prepared_review', 'unchanged']),
      pair: CompositionalClaimReviewPairV3Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('decision'),
      reason: z.enum(['invalid_input', 'invalid_claim', 'conflict', 'backend_clock_invalid']),
    })
    .strict(),
]);
export type CompositionalClaimReviewPreparationV3 = z.infer<
  typeof CompositionalClaimReviewPreparationV3Schema
>;

export const CompositionalClaimReviewResultV3Schema = z.union([
  z
    .object({
      kind: z.enum(['reviewed', 'unchanged']),
      edge: EntityEdgeSchema.strict(),
      valueId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('decision'),
      reason: z.enum([
        'invalid_input',
        'invalid_claim',
        'conflict',
        'backend_clock_invalid',
        'unsupported_mode',
        'capacity',
      ]),
    })
    .strict(),
  z.object({ kind: z.literal('acknowledgement_unknown') }).strict(),
]);
export type CompositionalClaimReviewResultV3 = z.infer<
  typeof CompositionalClaimReviewResultV3Schema
>;
