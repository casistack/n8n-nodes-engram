import { z } from 'zod';

export const AutomaticProfileIdSchema = z.enum([
  'existing',
  'conservative',
  'explicit',
  'reviewFirst',
]);
export type AutomaticProfileId = z.infer<typeof AutomaticProfileIdSchema>;

export const AutomaticPolicySchema = z
  .object({
    version: z.literal(1),
    profileId: AutomaticProfileIdSchema,
    profileVersion: z.literal(1),
    policyId: z.enum(['legacy', 'literal-preferences']),
    policyVersion: z.literal(1),
    autoAccept: z.boolean(),
    requiresExplicitIntent: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticPolicy = z.infer<typeof AutomaticPolicySchema>;

export const AutomaticPolicyInputSchema = z
  .object({ profileId: AutomaticProfileIdSchema.optional() })
  .strict();
export type AutomaticPolicyInput = z.input<typeof AutomaticPolicyInputSchema>;

export const AutomaticBindingReferenceSchema = z
  .object({
    bindingId: z.string().uuid(),
    revision: z.number().int().min(1).max(2147483647),
    subjectId: z.string().uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AutomaticBindingReference = z.infer<typeof AutomaticBindingReferenceSchema>;

export const AutomaticActorSchema = z
  .object({
    namespace: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0),
    issuer: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    actorReference: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0),
    applicationOwnedWrapper: z.literal(true).optional(),
    humanRegion: z
      .object({
        start: z.number().int().min(0).max(65536),
        end: z.number().int().min(1).max(65536),
      })
      .strict()
      .refine((region) => region.start < region.end)
      .optional(),
    // Quote-region offsets are in the supplied `content` string.
    quoteRegions: z
      .array(
        z
          .object({
            start: z.number().int().min(0).max(65536),
            end: z.number().int().min(1).max(65536),
          })
          .strict()
          .refine((region) => region.start < region.end),
      )
      .max(32)
      .default([]),
  })
  .strict();
export type AutomaticActor = z.input<typeof AutomaticActorSchema>;
export type ParsedAutomaticActor = z.infer<typeof AutomaticActorSchema>;

export const AutomaticRegionSchema = z
  .object({
    start: z.number().int().min(0).max(65536),
    end: z.number().int().min(1).max(65536),
  })
  .strict()
  .refine((region) => region.start < region.end, 'Region must be non-empty');
export type AutomaticRegion = z.infer<typeof AutomaticRegionSchema>;

export const AutomaticMappingSchema = z
  .object({
    contentStart: z.number().int().min(0).max(65536),
    contentEnd: z.number().int().min(1).max(65536),
    rawStart: z.number().int().min(0).max(65536),
    rawEnd: z.number().int().min(1).max(65536),
  })
  .strict()
  .refine(
    (mapping) =>
      mapping.contentStart < mapping.contentEnd &&
      mapping.rawStart < mapping.rawEnd &&
      mapping.contentEnd - mapping.contentStart === mapping.rawEnd - mapping.rawStart,
    'Mapping must be a non-empty one-to-one span',
  );
export type AutomaticMapping = z.infer<typeof AutomaticMappingSchema>;

export const AutomaticSourceEnvelopeSchema = z
  .object({
    version: z.literal(1),
    namespace: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0),
    issuer: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    actorReference: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim().length > 0),
    bindingRef: AutomaticBindingReferenceSchema,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    rawContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    mappingAuthority: z.enum(['whole_source', 'application_region']),
    humanRegion: AutomaticRegionSchema,
    mappings: z.array(AutomaticMappingSchema).min(1).max(32),
    quoteRegions: z.array(AutomaticRegionSchema).max(32),
    explicitIntent: z.boolean(),
    policy: AutomaticPolicySchema.optional(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.mappings.length + envelope.quoteRegions.length > 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Mapping and quote regions combined must not exceed 32',
        path: ['mappings'],
      });
    }
    const mappings = envelope.mappings;
    const firstMapping = mappings[0];
    if (
      firstMapping &&
      envelope.mappingAuthority === 'whole_source' &&
      (envelope.humanRegion.start !== 0 || firstMapping.rawStart !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Whole-source mappings must begin at source offset zero',
        path: ['mappingAuthority'],
      });
    }
    if (
      firstMapping &&
      envelope.mappingAuthority === 'application_region' &&
      (envelope.humanRegion.start !== firstMapping.rawStart ||
        envelope.humanRegion.end !== firstMapping.rawEnd)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Application-region mapping must match the attested region',
        path: ['humanRegion'],
      });
    }
    for (let index = 1; index < mappings.length; index += 1) {
      if (
        mappings[index].contentStart < mappings[index - 1].contentEnd ||
        mappings[index].rawStart < mappings[index - 1].rawEnd
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Mappings must be ordered and non-overlapping',
          path: ['mappings', index],
        });
      }
    }
    for (let index = 1; index < envelope.quoteRegions.length; index += 1) {
      if (envelope.quoteRegions[index].start < envelope.quoteRegions[index - 1].end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Quote regions must be ordered and non-overlapping',
          path: ['quoteRegions', index],
        });
      }
    }
    if (
      envelope.policy?.profileId !== undefined &&
      envelope.policy.profileId !== 'existing' &&
      envelope.policy.policyId !== 'literal-preferences'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automatic profiles require the literal preference policy',
        path: ['policy', 'policyId'],
      });
    }
  })
  .refine((envelope) => Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= 16 * 1024, {
    message: 'Source envelope metadata must not exceed 16 KiB serialized',
  });
export type AutomaticSourceEnvelope = z.infer<typeof AutomaticSourceEnvelopeSchema>;

export const AutomaticReasonCodeSchema = z.enum([
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
]);
export type AutomaticReasonCode = z.infer<typeof AutomaticReasonCodeSchema>;

export const AutomaticCaptureFailureReasonSchema = z.enum([
  'invalid_input',
  'invalid_binding',
  'invalid_policy',
  'invalid_region',
  'ambiguous_mapping',
  'content_not_mapped',
  'invalid_quote_regions',
  'invalid_unicode',
  'metadata_too_large',
]);
export type AutomaticCaptureFailureReason = z.infer<typeof AutomaticCaptureFailureReasonSchema>;

export const AutomaticPreferenceClaimSchema = z
  .object({
    predicate: z.literal('PREFERS'),
    polarity: z.enum(['positive', 'negative']),
    literal: z.string().min(1).max(2048),
    clause: z.string().min(1).max(4096),
    clauseSpan: AutomaticRegionSchema,
    objectSpan: AutomaticRegionSchema,
    rawClauseSpan: AutomaticRegionSchema,
    rawObjectSpan: AutomaticRegionSchema,
    languageTag: z.literal('und'),
  })
  .strict();
export type AutomaticPreferenceClaim = z.infer<typeof AutomaticPreferenceClaimSchema>;

export const AutomaticPreferenceParseResultSchema = z
  .object({
    claims: z.array(AutomaticPreferenceClaimSchema).max(32),
    reasons: z.array(AutomaticReasonCodeSchema).max(8),
  })
  .strict();
export type AutomaticPreferenceParseResult = z.infer<typeof AutomaticPreferenceParseResultSchema>;
