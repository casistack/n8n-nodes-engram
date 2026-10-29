import { createHash } from 'crypto';
import { types as utilTypes } from 'util';
import { z } from 'zod';
import {
  AutomaticBindingReferenceSchema,
  AutomaticMappingSchema,
  AutomaticRegionSchema,
} from './AutomaticMemory.schema';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2BundleSchema,
  CompositionalPreferenceV2DescriptorSchema,
  snapshotBoundedCompositionalJson,
} from './CompositionalPreferenceV2.schema';
import { CompositionalPreferenceV2MeaningSchema } from './CompositionalPreferenceV2Meaning.schema';
import { projectCompositionalPreferenceV2Meaning } from '../extraction/CompositionalPreferenceV2Meaning';

// Standalone contracts only. Neither a successful parse nor a compiled policy
// establishes actor authority, source entailment, a commit or a processing permit.
export const COMPOSITIONAL_CLAIM_ATTRIBUTE = 'engram_claim_v1';
export const COMPOSITIONAL_VALUE_ATTRIBUTE = 'engram_literal_v1';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const namespace = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const issuer = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const actor = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
const profile = z.enum(['conservative', 'explicit', 'reviewFirst']);

export const COMPOSITIONAL_AUTOMATIC_LIMITS = Object.freeze({
  sourceBytes: 65536,
  bundles: 32,
  predicates: 32,
  nodes: 128,
  edges: 128,
  depth: 8,
  envelopeBytes: 16384,
  claimMetadataBytes: 32768,
  descriptorBytes: 4096,
  sourceHydrations: 512,
  conflicts: 128,
  conflictRefsPerClaim: 8,
} as const);

const limitsSchema = z
  .object({
    sourceBytes: z.literal(65536),
    bundles: z.literal(32),
    predicates: z.literal(32),
    nodes: z.literal(128),
    edges: z.literal(128),
    depth: z.literal(8),
    envelopeBytes: z.literal(16384),
    claimMetadataBytes: z.literal(32768),
    descriptorBytes: z.literal(4096),
    sourceHydrations: z.literal(512),
    conflicts: z.literal(128),
    conflictRefsPerClaim: z.literal(8),
  })
  .strict();

function bounded(maxBytes: 16384 | 32768) {
  return z.unknown().transform((value, context) => {
    const snapshot = snapshotBoundedCompositionalJson(value, maxBytes);
    if (snapshot === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded plain JSON' });
      return z.NEVER;
    }
    return snapshot;
  });
}

export const CompositionalAutomaticPolicyInputV2Schema = z.object({ profileId: profile }).strict();
export type CompositionalAutomaticPolicyInputV2 = z.input<
  typeof CompositionalAutomaticPolicyInputV2Schema
>;

const policyBodySchema = z
  .object({
    version: z.literal(2),
    profileId: profile,
    profileVersion: z.literal(1),
    policyId: z.literal('compositional-preferences'),
    policyVersion: z.literal(2),
    interpreter: CompositionalPreferenceV2DescriptorSchema,
    materializerVersion: z.literal(1),
    eligibilityVersion: z.literal(1),
    autoAccept: z.boolean(),
    requiresExplicitIntent: z.boolean(),
    limits: limitsSchema,
  })
  .strict();

export const CompositionalAutomaticPolicyV2Schema = bounded(16384).pipe(
  policyBodySchema
    .extend({ fingerprint: hash })
    .strict()
    .superRefine((policy, context) => {
      const { fingerprint, ...body } = policy;
      if (
        policy.autoAccept !== (policy.profileId !== 'reviewFirst') ||
        policy.requiresExplicitIntent !== (policy.profileId === 'explicit') ||
        fingerprint !== hashAutomaticCaptureV2(body) ||
        Buffer.byteLength(JSON.stringify(policy)) > 4096
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Policy must match the exact compiled profile',
        });
      }
    }),
);
export type CompositionalAutomaticPolicyV2 = z.infer<typeof CompositionalAutomaticPolicyV2Schema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function compileCompositionalAutomaticPolicyV2(
  input: CompositionalAutomaticPolicyInputV2,
): CompositionalAutomaticPolicyV2 {
  const { profileId } = CompositionalAutomaticPolicyInputV2Schema.parse(input);
  const body = policyBodySchema.parse({
    version: 2,
    profileId,
    profileVersion: 1,
    policyId: 'compositional-preferences',
    policyVersion: 2,
    interpreter: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    materializerVersion: 1,
    eligibilityVersion: 1,
    autoAccept: profileId !== 'reviewFirst',
    requiresExplicitIntent: profileId === 'explicit',
    limits: COMPOSITIONAL_AUTOMATIC_LIMITS,
  });
  return deepFreeze(
    CompositionalAutomaticPolicyV2Schema.parse({
      ...body,
      fingerprint: hashAutomaticCaptureV2(body),
    }),
  );
}

const descriptorBodySchema = z
  .object({
    version: z.literal(3),
    lifecycle: z.literal('replaySafeV2'),
    executionMode: z.literal('synchronous'),
    purpose: z.literal('human_turn_memory'),
    interpreterId: z.literal('compositional-preferences'),
    semanticVersion: z.literal(2),
    grammarVersion: z.literal(2),
    lexiconVersion: z.literal(2),
    materializerVersion: z.literal(1),
    requestedTrustLevel: z.enum(['trusted', 'standard']),
    intentSetting: z.boolean(),
    invocationDeadlineMs: z.number().int().min(100).max(120000),
    policy: CompositionalAutomaticPolicyV2Schema,
    assistantWriteAuthority: z.null(),
  })
  .strict();
export const CompositionalAutomaticDescriptorV3Schema = bounded(16384).pipe(
  descriptorBodySchema
    .extend({ settingsHash: hash })
    .strict()
    .superRefine((descriptor, context) => {
      const { settingsHash, ...body } = descriptor;
      if (
        settingsHash !== hashAutomaticCaptureV2(body) ||
        Buffer.byteLength(JSON.stringify(descriptor)) > 4096
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Descriptor settings hash or byte limit is invalid',
        });
      }
    }),
);
export type CompositionalAutomaticDescriptorV3 = z.infer<
  typeof CompositionalAutomaticDescriptorV3Schema
>;
export const CompositionalAutomaticDescriptorInputV3Schema = z
  .object({
    profileId: profile,
    requestedTrustLevel: z.enum(['trusted', 'standard']),
    intentSetting: z.boolean(),
    invocationDeadlineMs: z.number().int().min(100).max(120000),
  })
  .strict();
export type CompositionalAutomaticDescriptorInputV3 = z.input<
  typeof CompositionalAutomaticDescriptorInputV3Schema
>;
export function compileCompositionalAutomaticDescriptorV3(
  input: CompositionalAutomaticDescriptorInputV3,
): CompositionalAutomaticDescriptorV3 {
  const checked = CompositionalAutomaticDescriptorInputV3Schema.parse(input);
  const body = descriptorBodySchema.parse({
    version: 3,
    lifecycle: 'replaySafeV2',
    executionMode: 'synchronous',
    purpose: 'human_turn_memory',
    ...COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
    materializerVersion: 1,
    requestedTrustLevel: checked.requestedTrustLevel,
    intentSetting: checked.intentSetting,
    invocationDeadlineMs: checked.invocationDeadlineMs,
    policy: compileCompositionalAutomaticPolicyV2({ profileId: checked.profileId }),
    assistantWriteAuthority: null,
  });
  return deepFreeze(
    CompositionalAutomaticDescriptorV3Schema.parse({
      ...body,
      settingsHash: hashAutomaticCaptureV2(body),
    }),
  );
}
export function hashCompositionalAutomaticDescriptorV3(value: unknown): string {
  return hashAutomaticCaptureV2(CompositionalAutomaticDescriptorV3Schema.parse(value));
}

export const CompositionalAutomaticEnvelopeV2Schema = bounded(16384).pipe(
  z
    .object({
      version: z.literal(2),
      namespace,
      issuer,
      actorReference: actor,
      bindingRef: AutomaticBindingReferenceSchema,
      contentHash: hash,
      rawContentHash: hash,
      mappingAuthority: z.enum(['whole_source', 'application_region']),
      humanRegion: AutomaticRegionSchema,
      mappings: z.array(AutomaticMappingSchema).min(1).max(32),
      quoteRegions: z.array(AutomaticRegionSchema).max(32),
      explicitIntent: z.boolean(),
      policy: CompositionalAutomaticPolicyV2Schema,
    })
    .strict()
    .superRefine((envelope, context) => {
      const first = envelope.mappings[0];
      if (!first) return; // The min(1) issue is already recorded; never index invalid input.
      if (
        envelope.mappings.length + envelope.quoteRegions.length > 32 ||
        envelope.humanRegion.start !== first.rawStart ||
        envelope.humanRegion.end !== envelope.mappings[envelope.mappings.length - 1].rawEnd ||
        first.contentStart !== 0 ||
        (envelope.mappingAuthority === 'whole_source' && first.rawStart !== 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Envelope mapping geometry is invalid',
        });
      }
      for (let i = 1; i < envelope.mappings.length; i++) {
        if (
          envelope.mappings[i].contentStart !== envelope.mappings[i - 1].contentEnd ||
          envelope.mappings[i].rawStart !== envelope.mappings[i - 1].rawEnd
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Envelope mapping must cover one contiguous region',
          });
        }
      }
      for (let i = 1; i < envelope.quoteRegions.length; i++) {
        if (envelope.quoteRegions[i].start < envelope.quoteRegions[i - 1].end) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Quote regions must be ordered and disjoint',
          });
        }
      }
    }),
);
export type CompositionalAutomaticEnvelopeV2 = z.infer<
  typeof CompositionalAutomaticEnvelopeV2Schema
>;

const envelopeSourceBodySchema = z
  .object({
    rawContent: z.string().min(1).max(65536),
    mappedContent: z.string().min(1).max(65536),
    envelope: z.unknown(),
  })
  .strict();
function snapshotEnvelopeSourceWrapper(input: unknown) {
  const invalid = () => undefined;
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      utilTypes.isProxy(input)
    )
      return invalid();
    const prototype = Object.getPrototypeOf(input);
    if (
      prototype !== null &&
      (utilTypes.isProxy(prototype) || Object.getPrototypeOf(prototype) !== null)
    )
      return invalid();
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 3 ||
      !keys.every((key) => key === 'rawContent' || key === 'mappedContent' || key === 'envelope')
    )
      return invalid();
    const raw = Object.getOwnPropertyDescriptor(input, 'rawContent');
    const mapped = Object.getOwnPropertyDescriptor(input, 'mappedContent');
    const envelope = Object.getOwnPropertyDescriptor(input, 'envelope');
    if (
      !raw ||
      !mapped ||
      !envelope ||
      !raw.enumerable ||
      !mapped.enumerable ||
      !envelope.enumerable ||
      !('value' in raw) ||
      !('value' in mapped) ||
      !('value' in envelope)
    )
      return invalid();
    if (
      typeof raw.value !== 'string' ||
      typeof mapped.value !== 'string' ||
      raw.value.length < 1 ||
      mapped.value.length < 1 ||
      raw.value.length > 65536 ||
      mapped.value.length > 65536
    )
      return invalid();
    // Bound metadata separately; raw and mapped strings may EACH occupy 64KiB.
    // Reading data descriptors copies immutable strings without invoking code.
    const snapshot = snapshotBoundedCompositionalJson(envelope.value, 16384);
    if (snapshot === undefined) return invalid();
    return { rawContent: raw.value, mappedContent: mapped.value, envelope: snapshot };
  } catch {
    return invalid();
  }
}
export const CompositionalAutomaticEnvelopeSourceInputV2Schema = z
  .unknown()
  .transform((input, context) => {
    const snapshot = snapshotEnvelopeSourceWrapper(input);
    if (snapshot === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid bounded own-data source wrapper',
      });
      return z.NEVER;
    }
    return snapshot;
  })
  .pipe(envelopeSourceBodySchema);
export type CompositionalAutomaticEnvelopeSourceInputV2 = z.input<typeof envelopeSourceBodySchema>;
export const CompositionalAutomaticEnvelopeSourceResultV2Schema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum([
        'invalid_envelope',
        'source_capacity',
        'content_mismatch',
        'incomplete_mapping',
        'invalid_quote_regions',
        'invalid_unicode',
      ]),
    })
    .strict(),
]);
export type CompositionalAutomaticEnvelopeSourceResultV2 = z.infer<
  typeof CompositionalAutomaticEnvelopeSourceResultV2Schema
>;

/** Byte/mapping integrity only. The application must separately establish the
 * wrapper attestation, actor, binding and current source authority. Quote offsets
 * are mapped-content UTF-16 offsets, matching the persisted envelope contract. */
export function validateCompositionalAutomaticEnvelopeSourceV2(
  input: CompositionalAutomaticEnvelopeSourceInputV2,
): CompositionalAutomaticEnvelopeSourceResultV2 {
  // Zod's own type detection can access `then` or proxy prototypes. Inspect
  // original own data BEFORE invoking any Zod parser, including z.unknown().
  const snapshot = snapshotEnvelopeSourceWrapper(input);
  if (snapshot === undefined) return { ok: false, reason: 'invalid_envelope' };
  const shape = envelopeSourceBodySchema.safeParse(snapshot);
  if (!shape.success) return { ok: false, reason: 'invalid_envelope' };
  const { rawContent, mappedContent } = shape.data;
  if (Buffer.byteLength(rawContent) > 65536 || Buffer.byteLength(mappedContent) > 65536)
    return { ok: false, reason: 'source_capacity' };
  const boundary = (text: string, offset: number) =>
    !(
      offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/u.test(text[offset - 1]) &&
      /[\uDC00-\uDFFF]/u.test(text[offset])
    );
  const wellFormed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  };
  if (!wellFormed(rawContent) || !wellFormed(mappedContent))
    return { ok: false, reason: 'invalid_unicode' };
  const parsed = CompositionalAutomaticEnvelopeV2Schema.safeParse(shape.data.envelope);
  if (!parsed.success) return { ok: false, reason: 'invalid_envelope' };
  const envelope = parsed.data;
  if (
    envelope.mappings.some(
      (map) =>
        !boundary(mappedContent, map.contentStart) ||
        !boundary(mappedContent, map.contentEnd) ||
        !boundary(rawContent, map.rawStart) ||
        !boundary(rawContent, map.rawEnd),
    )
  )
    return { ok: false, reason: 'invalid_unicode' };
  const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  if (sha(rawContent) !== envelope.rawContentHash || sha(mappedContent) !== envelope.contentHash)
    return { ok: false, reason: 'content_mismatch' };
  if (
    envelope.mappings[envelope.mappings.length - 1].contentEnd !== mappedContent.length ||
    envelope.humanRegion.end > rawContent.length ||
    (envelope.mappingAuthority === 'whole_source' &&
      (envelope.humanRegion.end !== rawContent.length || rawContent !== mappedContent)) ||
    envelope.mappings.some(
      (map) =>
        mappedContent.slice(map.contentStart, map.contentEnd) !==
        rawContent.slice(map.rawStart, map.rawEnd),
    )
  )
    return { ok: false, reason: 'incomplete_mapping' };
  if (
    envelope.quoteRegions.some(
      (region) =>
        region.end > mappedContent.length ||
        !boundary(mappedContent, region.start) ||
        !boundary(mappedContent, region.end),
    )
  )
    return { ok: false, reason: 'invalid_quote_regions' };
  return { ok: true };
}

export const CompositionalAutomaticClaimMeaningV2Schema = bounded(32768).pipe(
  CompositionalPreferenceV2MeaningSchema.refine(
    (meaning) => meaning.bundles.length === 1,
    'A claim has exactly one complete meaning bundle',
  ),
);
export type CompositionalAutomaticClaimMeaningV2 = z.infer<
  typeof CompositionalAutomaticClaimMeaningV2Schema
>;

const claimBaseSchema = z
  .object({
    version: z.literal(2),
    generation: z.literal('compositional-preferences-v2'),
    namespace,
    subjectId: z.string().uuid(),
    binding: AutomaticBindingReferenceSchema,
    issuer,
    actorReference: actor,
    policy: CompositionalAutomaticPolicyV2Schema,
    sourceId: z.string().uuid(),
    bundle: CompositionalPreferenceV2BundleSchema,
    meaning: CompositionalAutomaticClaimMeaningV2Schema,
    key: hash,
  })
  .strict();

export function compositionalAutomaticClaimKeyV2(
  meaning: CompositionalAutomaticClaimMeaningV2,
): string {
  const parsed = CompositionalAutomaticClaimMeaningV2Schema.parse(meaning);
  return hashAutomaticCaptureV2({
    domain: 'engram-compositional-claim-v2',
    namespace: parsed.namespace,
    subjectId: parsed.subjectId,
    meaning: parsed,
  });
}

export const CompositionalAutomaticClaimMetadataV2Schema = bounded(32768).pipe(
  claimBaseSchema.superRefine((claim, context) => {
    if (
      claim.subjectId !== claim.binding.subjectId ||
      claim.namespace !== claim.meaning.namespace ||
      claim.subjectId !== claim.meaning.subjectId ||
      claim.meaning.bundles.length !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Claim identity and one-bundle meaning must agree',
      });
      return;
    }
    // This local synthetic container validates structural projection only. It is
    // NOT a coverage assertion about the actual linked source. Commit/read must
    // reinterpret the whole actual source and match this exact complete bundle.
    const projected = projectCompositionalPreferenceV2Meaning({
      preference: {
        version: 2,
        descriptor: COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
        coverage: 'complete',
        bundles: [claim.bundle],
        withheld: [],
        reasons: [],
      },
      namespace: claim.namespace,
      subjectId: claim.subjectId,
    });
    if (
      !projected.ok ||
      hashAutomaticCaptureV2(projected.meaning) !== hashAutomaticCaptureV2(claim.meaning) ||
      claim.key !== compositionalAutomaticClaimKeyV2(claim.meaning)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Claim bundle, meaning and semantic key must agree',
      });
    }
  }),
);
export type CompositionalAutomaticClaimMetadataV2 = z.infer<
  typeof CompositionalAutomaticClaimMetadataV2Schema
>;

// Reuses the existing presence-hidden key, with a distinct payload generation.
// This is an attributed compound value, never a literal-v1 preference value.
export const CompositionalAutomaticValueMarkerV2Schema = bounded(16384).pipe(
  z
    .object({
      version: z.literal(2),
      generation: z.literal('compositional-preferences-v2'),
      key: hash,
    })
    .strict(),
);
export type CompositionalAutomaticValueMarkerV2 = z.infer<
  typeof CompositionalAutomaticValueMarkerV2Schema
>;
