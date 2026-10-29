import { createHash } from 'crypto';
import { z } from 'zod';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { hashAutomaticCaptureV2 } from './AutomaticCapture.schema';
import { AutonomousPersonalPolicyV3OwnedDataSchema } from './AutonomousPersonalPolicyV3.schema';
import {
  COMPOSITIONAL_PREFERENCE_V2_DESCRIPTOR,
  CompositionalPreferenceV2BundleSchema,
} from './CompositionalPreferenceV2.schema';
import {
  CompositionalAutomaticClaimMeaningV2Schema,
  type CompositionalAutomaticClaimMeaningV2,
} from './CompositionalAutomaticMemory.schema';
import { projectCompositionalPreferenceV2Meaning } from '../extraction/CompositionalPreferenceV2Meaning';

const HASH_64 = /^[a-f0-9]{64}$/u;
const UUID = z.string().uuid();
const HASH = z.string().regex(HASH_64);
const CLAIM_MAX_BYTES = 32 * 1024;
const MARKER_MAX_BYTES = 16 * 1024;
const HELPER_MAX_BYTES = 32 * 1024;
const SOURCE_MAX_UTF16 = 65_536;
const SOURCE_UNIT_MAX = 128;
const DEPENDENCY_ROOT_MAX = 32;
const STATEMENT_MAX_CODE_POINTS = 2048;
const STATEMENT_MAX_BYTES = 4096;

const INVALID_CLAIM = 'invalid_autonomous_claim_data';
const INVALID_KEY = 'invalid_autonomous_claim_key_data';
const INVALID_EVIDENCE = 'invalid_autonomous_claim_evidence_data';
const INVALID_UNIT = 'invalid_autonomous_claim_unit_data';
const INVALID_MEANING = 'invalid_autonomous_claim_meaning_data';
const INVALID_DEPENDENCY = 'invalid_autonomous_claim_dependency_data';
const INVALID_MARKER = 'invalid_autonomous_marker_data';

const knownProviderCategorySchema = z.enum([
  'preference',
  'work_role',
  'work_affiliation',
  'project',
  'skill',
  'interest',
  'broad_location',
  'self_description',
  'personal_assertion',
]);

const downgradeSchema = z.array(z.never()).length(0);

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const namespaceSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0 && isWellFormedUnicode(value));

const sourceEventTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

const literalSchema = z
  .string()
  .min(1)
  .max(STATEMENT_MAX_BYTES)
  .refine(isWellFormedUnicode)
  .refine((value) => Array.from(value).length <= STATEMENT_MAX_CODE_POINTS)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= STATEMENT_MAX_BYTES);

const utf16OffsetSchema = z.number().int().safe().min(0).max(SOURCE_MAX_UTF16);
const nonEmptySpanSchema = z
  .object({ start: utf16OffsetSchema, end: utf16OffsetSchema })
  .strict()
  .refine((span) => span.start < span.end);

const claimEvidenceSchema = z
  .object({
    unitId: HASH,
    rawSpan: nonEmptySpanSchema,
    mappedSpan: nonEmptySpanSchema,
    literal: literalSchema,
    rawContentHash: HASH,
    literalHash: HASH,
    evidenceHash: HASH,
  })
  .strict();

const interpretationSchema = z
  .object({
    category: knownProviderCategorySchema,
    usefulness: z.literal('personal_memory'),
    risk: z.literal('ordinary'),
    downgrade: downgradeSchema,
  })
  .strict();

// The legacy bounded schema has unknown raw input. After outer ownership, this
// private shim keeps its output type while delegating to its unchanged strict validation.
const completeClaimMeaningSchema = z.custom<CompositionalAutomaticClaimMeaningV2>(
  (value) => CompositionalAutomaticClaimMeaningV2Schema.safeParse(value).success,
);

const commonClaimSchema = z
  .object({
    version: z.literal(3),
    family: z.literal('autonomous-personal-v1'),
    key: HASH,
    namespace: namespaceSchema,
    subjectId: UUID,
    sourceId: UUID,
    sourceHash: HASH,
    descriptorHash: HASH,
    policy: AutonomousPersonalPolicyV3OwnedDataSchema,
    evidence: claimEvidenceSchema,
    interpretation: interpretationSchema,
  })
  .strict();

const typedClaimBranchSchema = commonClaimSchema
  .extend({
    kind: z.literal('typed_preference'),
    bundle: CompositionalPreferenceV2BundleSchema,
    meaning: CompositionalAutomaticClaimMeaningV2Schema,
  })
  .strict();

const statementClaimBranchSchema = commonClaimSchema
  .extend({
    kind: z.literal('source_statement_record'),
    sourceEventTime: sourceEventTimeSchema,
    framingVersion: z.literal(1),
    headForm: z.literal('first_person_i_main_clause'),
    semantics: z.literal('source_attributed_statement'),
    typedProjection: z.null(),
  })
  .strict();

const claimBodySchema = z.discriminatedUnion('kind', [
  typedClaimBranchSchema,
  statementClaimBranchSchema,
]);

const keyInputBodySchema = z
  .union([
    z
      .object({
        kind: z.literal('typed_preference'),
        namespace: namespaceSchema,
        subjectId: UUID,
        meaning: completeClaimMeaningSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('source_statement_record'),
        namespace: namespaceSchema,
        subjectId: UUID,
        sourceEventTime: sourceEventTimeSchema,
        completeLiteral: literalSchema,
        semantics: z.literal('source_attributed_statement'),
      })
      .strict(),
  ])
  .superRefine((input, context) => {
    if (
      input.kind === 'typed_preference' &&
      (input.meaning.bundles.length !== 1 ||
        input.meaning.namespace !== input.namespace ||
        input.meaning.subjectId !== input.subjectId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Typed meaning identity mismatch' });
    }
  });

const evidenceHashInputBodySchema = z
  .object({
    sourceId: UUID,
    rawContentHash: HASH,
    unitId: HASH,
    kind: z.enum(['typed_preference', 'source_statement_record']),
    rawSpan: nonEmptySpanSchema,
    mappedSpan: nonEmptySpanSchema,
    literal: literalSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const rawWidth = input.rawSpan.end - input.rawSpan.start;
    const mappedWidth = input.mappedSpan.end - input.mappedSpan.start;
    if (rawWidth !== mappedWidth || input.literal.length !== rawWidth) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Evidence geometry mismatch' });
    }
  });

const unitIdHashInputBodySchema = z
  .object({
    rawContentHash: HASH,
    unitIndex: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(SOURCE_UNIT_MAX - 1),
    parentRawSpan: nonEmptySpanSchema,
    parentMappedSpan: nonEmptySpanSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.parentRawSpan.end - input.parentRawSpan.start !==
      input.parentMappedSpan.end - input.parentMappedSpan.start
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unit geometry mismatch' });
    }
  });

const dependencyHashInputBodySchema = z
  .object({
    logicalInput: keyInputBodySchema,
    meaningHash: HASH,
    rootIndex: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(DEPENDENCY_ROOT_MAX - 1),
    rootPath: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.logicalInput.kind === 'typed_preference') {
      const roots = input.logicalInput.meaning.bundles[0]?.rootPaths;
      if (
        !roots ||
        input.rootIndex >= roots.length ||
        roots[input.rootIndex] !== input.rootPath ||
        input.meaningHash !== meaningHashFromInput(input.logicalInput)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Typed dependency root mismatch',
        });
      }
    } else if (
      input.rootIndex !== 0 ||
      input.rootPath !== 'record' ||
      input.meaningHash !== meaningHashFromInput(input.logicalInput)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Statement dependency root mismatch',
      });
    }
  });

export const AutonomousPersonalClaimV3KeyInputOwnedDataSchema = keyInputBodySchema;
export type AutonomousPersonalClaimV3KeyInput = z.infer<
  typeof AutonomousPersonalClaimV3KeyInputOwnedDataSchema
>;

export type AutonomousPersonalClaimEvidenceHashInputV3 = z.infer<
  typeof evidenceHashInputBodySchema
>;
export type AutonomousPersonalSourceUnitIdHashInputV1 = z.infer<typeof unitIdHashInputBodySchema>;
export type AutonomousPersonalPredicateDependencyHashInputV1 = z.infer<
  typeof dependencyHashInputBodySchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function fixedError(code: string): z.ZodError {
  const path: (string | number)[] = [];
  const issue: z.ZodIssue = { code: z.ZodIssueCode.custom, path, message: code };
  Object.freeze(path);
  Object.freeze(issue);
  const error = new z.ZodError([issue]);
  Object.freeze(error.issues);
  return Object.freeze(error);
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new Error('Invalid bounded JSON');
  return Buffer.byteLength(serialized, 'utf8');
}

function ownHelperData<T>(value: unknown, schema: z.ZodType<T>): T {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  if (jsonBytes(owned) > HELPER_MAX_BYTES) throw new Error('Claim helper data exceeds limit');
  return schema.parse(owned);
}

function ownClaimData(value: unknown): AutonomousPersonalClaimV3 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  if (jsonBytes(owned) > CLAIM_MAX_BYTES) throw new Error('Claim data exceeds limit');
  return deepFreeze(AutonomousPersonalClaimV3OwnedDataSchema.parse(owned));
}

function ownMarkerData(value: unknown): AutonomousPersonalValueMarkerV3 {
  const owned = cloneBoundedAutomaticCaptureJson<unknown>(value, 'beginRequest');
  if (jsonBytes(owned) > MARKER_MAX_BYTES) throw new Error('Marker data exceeds limit');
  return deepFreeze(AutonomousPersonalValueMarkerV3OwnedDataSchema.parse(owned));
}

function sha256ExactUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function keyFromInput(input: AutonomousPersonalClaimV3KeyInput): string {
  if (input.kind === 'typed_preference') {
    return hashAutomaticCaptureV2({
      domain: 'engram-autonomous-preference-key-v1',
      preferenceIdentity: {
        namespace: input.namespace,
        subjectId: input.subjectId,
        meaning: input.meaning,
      },
    });
  }
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-statement-key-v1',
    statementIdentity: {
      namespace: input.namespace,
      subjectId: input.subjectId,
      canonicalSourceEventTime: input.sourceEventTime,
      completeLiteral: input.completeLiteral,
      semantics: 'source_attributed_statement',
    },
  });
}

function meaningHashFromInput(input: AutonomousPersonalClaimV3KeyInput): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-meaning-v1',
    logicalMeaning: {
      kind: input.kind,
      typedPreference: input.kind === 'typed_preference' ? input.meaning : null,
      sourceStatement:
        input.kind === 'source_statement_record'
          ? {
              namespace: input.namespace,
              subjectId: input.subjectId,
              sourceEventTime: input.sourceEventTime,
              completeLiteral: input.completeLiteral,
              semantics: 'source_attributed_statement',
            }
          : null,
    },
  });
}

function keylessInputFromClaim(
  claim: AutonomousPersonalClaimV3,
): AutonomousPersonalClaimV3KeyInput {
  if (claim.kind === 'typed_preference') {
    return {
      kind: 'typed_preference',
      namespace: claim.namespace,
      subjectId: claim.subjectId,
      meaning: claim.meaning,
    };
  }
  return {
    kind: 'source_statement_record',
    namespace: claim.namespace,
    subjectId: claim.subjectId,
    sourceEventTime: claim.sourceEventTime,
    completeLiteral: claim.evidence.literal,
    semantics: 'source_attributed_statement',
  };
}

function evidenceHashFromClaim(claim: AutonomousPersonalClaimV3): string {
  return hashAutomaticCaptureV2({
    domain: 'engram-autonomous-evidence-v1',
    evidence: {
      sourceId: claim.sourceId,
      rawContentHash: claim.evidence.rawContentHash,
      unitId: claim.evidence.unitId,
      kind: claim.kind,
      rawSpan: claim.evidence.rawSpan,
      mappedSpan: claim.evidence.mappedSpan,
      literalHash: claim.evidence.literalHash,
    },
  });
}

function refineClaim(claim: z.infer<typeof claimBodySchema>, context: z.RefinementCtx): void {
  if (Buffer.byteLength(JSON.stringify(claim), 'utf8') > CLAIM_MAX_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Claim metadata exceeds 32 KiB' });
  }

  const rawWidth = claim.evidence.rawSpan.end - claim.evidence.rawSpan.start;
  const mappedWidth = claim.evidence.mappedSpan.end - claim.evidence.mappedSpan.start;
  if (rawWidth !== mappedWidth || claim.evidence.literal.length !== rawWidth) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Claim evidence geometry mismatch' });
  }

  if (claim.evidence.literalHash !== sha256ExactUtf8(claim.evidence.literal)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Claim literal hash mismatch' });
  }
  if (claim.evidence.evidenceHash !== evidenceHashFromClaim(claim)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Claim evidence hash mismatch' });
  }

  const keyless = keylessInputFromClaim(claim);
  if (claim.key !== keyFromInput(keyless)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Claim logical key mismatch' });
  }

  if (claim.kind === 'typed_preference') {
    if (claim.interpretation.category !== 'preference') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Typed claim category must be preference',
        path: ['interpretation', 'category'],
      });
    }
    if (claim.bundle.coverage !== 'complete') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Typed claim bundle must be complete',
        path: ['bundle', 'coverage'],
      });
    }
    const spans = claim.bundle.evidence.spans;
    if (
      spans.length !== 1 ||
      spans[0]?.raw.start !== claim.evidence.rawSpan.start ||
      spans[0]?.raw.end !== claim.evidence.rawSpan.end ||
      spans[0]?.content.start !== claim.evidence.mappedSpan.start ||
      spans[0]?.content.end !== claim.evidence.mappedSpan.end ||
      claim.bundle.evidence.lexicalForm !== claim.evidence.literal
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Typed claim occurrence must equal its single bundle evidence span',
        path: ['bundle', 'evidence'],
      });
    }
    if (
      claim.meaning.bundles.length !== 1 ||
      claim.meaning.namespace !== claim.namespace ||
      claim.meaning.subjectId !== claim.subjectId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Typed claim meaning identity mismatch',
        path: ['meaning'],
      });
    }

    try {
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
        hashAutomaticCaptureV2(projected.meaning) !== hashAutomaticCaptureV2(claim.meaning)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Typed claim meaning must project from its complete bundle',
          path: ['meaning'],
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Typed claim meaning projection is invalid',
        path: ['meaning'],
      });
    }
  }
}

export const AutonomousPersonalClaimV3OwnedDataSchema = claimBodySchema
  .superRefine(refineClaim)
  .describe(
    'Strict Claim3 data for already-owned JSON; this does not prove source origin or authority.',
  );

export type AutonomousPersonalClaimV3 = z.infer<typeof AutonomousPersonalClaimV3OwnedDataSchema>;

const markerBodySchema = z
  .object({
    version: z.literal(3),
    family: z.literal('autonomous-personal-v1'),
    kind: z.enum(['typed_preference', 'source_statement_record']),
    key: HASH,
    namespace: namespaceSchema,
    subjectId: UUID,
  })
  .strict()
  .superRefine((marker, context) => {
    if (Buffer.byteLength(JSON.stringify(marker), 'utf8') > MARKER_MAX_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Marker data exceeds 16 KiB' });
    }
  });

export const AutonomousPersonalValueMarkerV3OwnedDataSchema = markerBodySchema;
export type AutonomousPersonalValueMarkerV3 = z.infer<
  typeof AutonomousPersonalValueMarkerV3OwnedDataSchema
>;

/** Bounded Claim3 facade. Parsed data remains untrusted and proves no origin or authority. */
export const AutonomousPersonalClaimV3Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalClaimV3 {
    try {
      return ownClaimData(value);
    } catch {
      throw fixedError(INVALID_CLAIM);
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalClaimV3> {
    try {
      return { success: true, data: ownClaimData(value) };
    } catch {
      return { success: false, error: fixedError(INVALID_CLAIM) };
    }
  },
});

/** Bounded marker3 facade; the marker is only the existing presence-hidden payload. */
export const AutonomousPersonalValueMarkerV3Schema = Object.freeze({
  parse(value: unknown): AutonomousPersonalValueMarkerV3 {
    try {
      return ownMarkerData(value);
    } catch {
      throw fixedError(INVALID_MARKER);
    }
  },
  safeParse(value: unknown): z.SafeParseReturnType<unknown, AutonomousPersonalValueMarkerV3> {
    try {
      return { success: true, data: ownMarkerData(value) };
    } catch {
      return { success: false, error: fixedError(INVALID_MARKER) };
    }
  },
});

/** Hash the exact occurrence literal and claim-visible occurrence evidence. DATA only. */
export function hashAutonomousPersonalClaimEvidenceV3(input: unknown): {
  literalHash: string;
  evidenceHash: string;
} {
  try {
    const value = ownHelperData(input, evidenceHashInputBodySchema);
    const literalHash = sha256ExactUtf8(value.literal);
    const evidenceHash = hashAutomaticCaptureV2({
      domain: 'engram-autonomous-evidence-v1',
      evidence: {
        sourceId: value.sourceId,
        rawContentHash: value.rawContentHash,
        unitId: value.unitId,
        kind: value.kind,
        rawSpan: value.rawSpan,
        mappedSpan: value.mappedSpan,
        literalHash,
      },
    });
    return deepFreeze({ literalHash, evidenceHash });
  } catch {
    throw fixedError(INVALID_EVIDENCE);
  }
}

/** Hash a parent mechanical unit before provider classification. DATA only. */
export function hashAutonomousPersonalSourceUnitIdV1(input: unknown): string {
  try {
    const value = ownHelperData(input, unitIdHashInputBodySchema);
    return hashAutomaticCaptureV2({
      domain: 'engram-autonomous-unit-v1',
      unit: {
        rawContentHash: value.rawContentHash,
        unitIndex: value.unitIndex,
        parentRawSpan: value.parentRawSpan,
        parentMappedSpan: value.parentMappedSpan,
      },
    });
  } catch {
    throw fixedError(INVALID_UNIT);
  }
}

/** Hash kind-specific logical meaning. DATA only. */
export function hashAutonomousPersonalClaimMeaningV3(input: unknown): string {
  try {
    const value = ownHelperData(input, keyInputBodySchema);
    return meaningHashFromInput(value);
  } catch {
    throw fixedError(INVALID_MEANING);
  }
}

/** Hash a keyless logical input. The helper never accepts a key field. DATA only. */
export function hashAutonomousPersonalClaimKeyV3(input: unknown): string {
  try {
    const value = ownHelperData(input, keyInputBodySchema);
    return keyFromInput(value);
  } catch {
    throw fixedError(INVALID_KEY);
  }
}

/** Hash one complete root dependency after checking its input against the logical meaning. DATA only. */
export function hashAutonomousPersonalPredicateDependencyV1(input: unknown): string {
  try {
    const value = ownHelperData(input, dependencyHashInputBodySchema);
    return hashAutomaticCaptureV2({
      domain: 'engram-autonomous-predicate-dependency-v1',
      predicateDependency: {
        kind: value.logicalInput.kind,
        meaningHash: value.meaningHash,
        rootIndex: value.rootIndex,
        rootPath: value.rootPath,
      },
    });
  } catch {
    throw fixedError(INVALID_DEPENDENCY);
  }
}
