import { z } from 'zod';
import {
  AutomaticBindingReferenceSchema,
  AutomaticPolicySchema,
  AutomaticPreferenceClaimSchema,
} from './AutomaticMemory.schema';

export const AutomaticClaimMetadataSchema = z
  .object({
    version: z.literal(1),
    generation: z.literal('literal-parser-v1'),
    subjectId: z.string().uuid(),
    binding: AutomaticBindingReferenceSchema,
    issuer: z.string().min(1).max(256),
    actorReference: z.string().min(1).max(512),
    policy: AutomaticPolicySchema,
    claim: AutomaticPreferenceClaimSchema,
    sourceId: z.string().uuid(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticClaimMetadata = z.infer<typeof AutomaticClaimMetadataSchema>;

export const AutomaticReceiptReasonSchema = z.enum([
  'selected',
  'review_required',
  'conflicting_claim',
  'existing_claim',
  'missing_binding',
  'binding_changed',
  'source_changed',
  'interrupted',
  'not_selected',
  'invalid_envelope',
  'content_mismatch',
  'incomplete_mapping',
  'quoted_content',
  'no_preference_clause',
  'unsupported_grammar',
  'unsupported_topic',
  'sensitive_topic',
  'mixed_clauses',
  'question',
  'hypothetical',
  'instruction',
  'third_party',
  'explicit_intent_required',
  'too_many_claims',
  'object_too_long',
  'clause_too_long',
  'capacity',
]);
export const AutomaticReceiptSchema = z
  .object({
    version: z.literal(1),
    policy: AutomaticPolicySchema,
    sourceIds: z.array(z.string().uuid()).max(32),
    persisted: z.boolean(),
    commitAt: z.string().datetime().nullable(),
    items: z
      .array(
        z
          .object({
            claimId: z.string().uuid().optional(),
            state: z.enum([
              'accepted',
              'proposed',
              'rejected',
              'deferred',
              'not_selected',
              'unchanged',
            ]),
            persisted: z.boolean(),
            mutation: z.enum(['created', 'none', 'pending']),
            reasons: z.array(AutomaticReceiptReasonSchema).max(8),
          })
          .strict(),
      )
      .max(32),
    coverageComplete: z.boolean(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024);
export type AutomaticReceipt = z.infer<typeof AutomaticReceiptSchema>;

export const AutomaticWriteOwnerSchema = z
  .object({
    version: z.literal(1),
    store: z.string().regex(/^[a-f0-9]{64}$/),
    namespace: z.string().min(1).max(128),
    turn: z.string().min(1).max(512),
    role: z.enum(['human', 'assistant']),
    actor: z.string().min(1).max(512),
    issuer: z.string().min(1).max(256),
    binding: AutomaticBindingReferenceSchema.nullable(),
    policy: AutomaticPolicySchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticWriteOwner = z.infer<typeof AutomaticWriteOwnerSchema>;
