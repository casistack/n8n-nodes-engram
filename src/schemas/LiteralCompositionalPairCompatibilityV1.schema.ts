import { z } from 'zod';
import { CompositionalAutomaticClaimMeaningV2Schema } from './CompositionalAutomaticMemory.schema';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import { CompositionalAutomaticPredicateDependencyV3Schema } from './CompositionalAutomaticCaptureV3.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';

const body = z
  .object({
    oldMeaning: CompositionalAutomaticClaimMeaningV2Schema,
    newMeaning: CompositionalAutomaticClaimMeaningV2Schema,
  })
  .strict();
export const LiteralCompositionalPairCompatibilityRequestV1Schema = z
  .unknown()
  .transform((value, ctx) => {
    try {
      const cloned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
      if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > 96 * 1024)
        throw new Error('capacity');
      return cloned;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded pair data' });
      return z.NEVER;
    }
  })
  .pipe(body)
  .superRefine((request, ctx) => {
    if (
      !CompositionalCaptureNamespaceV3Schema.safeParse(request.oldMeaning.namespace).success ||
      !CompositionalCaptureNamespaceV3Schema.safeParse(request.newMeaning.namespace).success
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid exact namespace' });
  });
export type LiteralCompositionalPairCompatibilityRequestV1 = z.infer<
  typeof LiteralCompositionalPairCompatibilityRequestV1Schema
>;
export const LiteralCompositionalPairCompatibilityRuleV1Schema = z.enum([
  'O_SHORT:N_LANGUAGE',
  'O_SHORT:N_ORDER',
  'O_SHORT:N_RICH',
  'O_NOT_LONG:N_LANGUAGE',
  'O_NOT_LONG:N_ORDER',
  'O_NOT_LONG:N_RICH',
  'O_SHORT_EXAMPLES:N_ORDER',
  'O_SHORT_EXAMPLES:N_RICH',
]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const coverage = z
  .object({
    nodePaths: z.array(z.string().min(1).max(128)).min(1).max(128),
    edgeKeys: z.array(z.string().min(1).max(512)).min(1).max(128),
    predicateDependencies: z
      .array(CompositionalAutomaticPredicateDependencyV3Schema)
      .min(1)
      .max(32),
  })
  .strict();
const common = {
  version: z.literal(1),
  checker: z.literal('accepted_literal_compositional_compatibility_v1'),
};
// Conditional semantic data only. Caller-supplied accepted/trusted flags are not
// inputs; actual current old eligibility and new-source authority are external.
export const LiteralCompositionalPairCompatibilityResultV1Schema = z.discriminatedUnion('status', [
  z
    .object({
      ...common,
      status: z.literal('compatible_constraints'),
      ruleId: LiteralCompositionalPairCompatibilityRuleV1Schema,
      oldMeaningHash: hash,
      newMeaningHash: hash,
      oldCoverage: coverage,
      newCoverage: coverage,
    })
    .strict(),
  z
    .object({
      ...common,
      status: z.literal('unknown_constraints'),
      reason: z.enum([
        'invalid_input',
        'identity_mismatch',
        'unsupported_old_shape',
        'unsupported_new_shape',
        'unsupported_pair',
        'incomplete_coverage',
      ]),
    })
    .strict(),
]);
export type LiteralCompositionalPairCompatibilityResultV1 = z.infer<
  typeof LiteralCompositionalPairCompatibilityResultV1Schema
>;
