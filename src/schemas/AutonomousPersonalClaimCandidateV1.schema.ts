import { z } from 'zod';
import {
  AutonomousPersonalClaimV3OwnedDataSchema,
  hashAutonomousPersonalClaimKeyV3,
  hashAutonomousPersonalClaimMeaningV3,
  hashAutonomousPersonalPredicateDependencyV1,
  statementQualificationSchema,
} from './AutonomousPersonalClaimV3.schema';
import { CompositionalPreferenceV2BundleSchema } from './CompositionalPreferenceV2.schema';
import { AutonomousPersonalPolicyV3OwnedDataSchema } from './AutonomousPersonalPolicyV3.schema';

const HASH_64 = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_UTF16 = 65_536;
const UUID = z.string().uuid();
const HASH = z.string().regex(HASH_64);
const CATEGORY = z.enum([
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

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

const namespace = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0 && isWellFormedUnicode(value));

const sourceEventTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });

const span = z
  .object({
    start: z.number().int().safe().min(0).max(MAX_SOURCE_UTF16),
    end: z.number().int().safe().min(1).max(MAX_SOURCE_UTF16),
  })
  .strict()
  .refine((value) => value.start < value.end);

const inputCommon = {
  sourceId: UUID,
  contentHash: HASH,
  descriptorHash: HASH,
  namespace,
  subjectId: UUID,
  sourceHash: HASH,
  policy: AutonomousPersonalPolicyV3OwnedDataSchema,
  sourceEventTime,
  unitId: HASH,
  unitIndex: z.number().int().safe().min(0).max(31),
  category: CATEGORY,
  literal: z.string().refine(isWellFormedUnicode),
  rawSpan: span,
  mappedSpan: span,
};

const typedBundle = CompositionalPreferenceV2BundleSchema.superRefine((bundle, context) => {
  if (bundle.coverage !== 'complete') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['coverage'],
      message: 'Typed candidate bundle must be complete',
    });
  }
  if (bundle.evidence.spans.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence', 'spans'],
      message: 'Typed candidate bundle must identify one occurrence',
    });
  }
});

function refineLiteralSpanWidths(
  input: { literal: string; rawSpan: z.infer<typeof span>; mappedSpan: z.infer<typeof span> },
  context: z.RefinementCtx,
): void {
  if (
    input.literal.length !== input.rawSpan.end - input.rawSpan.start ||
    input.literal.length !== input.mappedSpan.end - input.mappedSpan.start
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Candidate literal and source spans must have equal UTF-16 widths',
    });
  }
}

const typedInputSchema = z
  .object({
    ...inputCommon,
    kind: z.literal('typed_preference'),
    category: z.literal('preference'),
    bundle: typedBundle,
  })
  .strict()
  .superRefine((input, context) => {
    refineLiteralSpanWidths(input, context);
    const occurrence = input.bundle.evidence.spans[0];
    if (
      input.bundle.evidence.lexicalForm !== input.literal ||
      !occurrence ||
      occurrence.raw.start !== input.rawSpan.start ||
      occurrence.raw.end !== input.rawSpan.end ||
      occurrence.content.start !== input.mappedSpan.start ||
      occurrence.content.end !== input.mappedSpan.end
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Typed evidence fields disagree' });
    }
  });

const statementInputSchema = z
  .object({
    ...inputCommon,
    kind: z.literal('source_statement_record'),
    bundle: z.null(),
    qualification: statementQualificationSchema.optional(),
  })
  .strict()
  .superRefine(refineLiteralSpanWidths);

/** Strict, owned DATA projection for one candidate recipe; it proves no Source4 authority. */
export const AutonomousPersonalClaimCandidateV1InputOwnedDataSchema = z.union([
  typedInputSchema,
  statementInputSchema,
]);

export type AutonomousPersonalClaimCandidateV1Input = z.infer<
  typeof AutonomousPersonalClaimCandidateV1InputOwnedDataSchema
>;

const dependencyReference = z
  .object({
    index: z.number().int().safe().min(0).max(31),
    dependencyHash: HASH,
  })
  .strict();

const referenceSchema = z
  .object({
    unitIndex: z.number().int().safe().min(0).max(31),
    kind: z.enum(['typed_preference', 'source_statement_record']),
    category: CATEGORY,
    key: HASH,
    evidenceHash: HASH,
    meaningHash: HASH,
    dependencies: z.array(dependencyReference).min(1).max(32),
    rawSpan: span,
    mappedSpan: span,
    qualification: statementQualificationSchema.optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (
      (reference.qualification !== undefined && reference.kind !== 'source_statement_record') ||
      reference.rawSpan.end - reference.rawSpan.start !==
        reference.mappedSpan.end - reference.mappedSpan.start ||
      reference.dependencies.some((dependency, index) => dependency.index !== index) ||
      (reference.kind === 'typed_preference' && reference.category !== 'preference') ||
      (reference.kind === 'source_statement_record' && reference.dependencies.length !== 1)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid candidate reference DATA',
      });
    }
  });

export type AutonomousPersonalClaimCandidateV1Reference = z.infer<typeof referenceSchema>;

const candidateResult = z
  .object({
    kind: z.literal('candidate'),
    claim: AutonomousPersonalClaimV3OwnedDataSchema,
    reference: referenceSchema,
    dependencyCount: z.number().int().safe().min(1).max(32),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.reference.kind !== candidate.claim.kind ||
      candidate.reference.category !== candidate.claim.interpretation.category ||
      candidate.reference.key !== candidate.claim.key ||
      candidate.reference.evidenceHash !== candidate.claim.evidence.evidenceHash ||
      candidate.reference.rawSpan.start !== candidate.claim.evidence.rawSpan.start ||
      candidate.reference.rawSpan.end !== candidate.claim.evidence.rawSpan.end ||
      candidate.reference.mappedSpan.start !== candidate.claim.evidence.mappedSpan.start ||
      candidate.reference.mappedSpan.end !== candidate.claim.evidence.mappedSpan.end ||
      candidate.dependencyCount !== candidate.reference.dependencies.length ||
      candidate.reference.qualification !==
        (candidate.claim.kind === 'source_statement_record'
          ? candidate.claim.qualification
          : undefined)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Candidate DATA fields disagree' });
      return;
    }

    const logicalInput =
      candidate.claim.kind === 'typed_preference'
        ? {
            kind: 'typed_preference' as const,
            namespace: candidate.claim.namespace,
            subjectId: candidate.claim.subjectId,
            meaning: candidate.claim.meaning,
          }
        : {
            kind: 'source_statement_record' as const,
            namespace: candidate.claim.namespace,
            subjectId: candidate.claim.subjectId,
            sourceEventTime: candidate.claim.sourceEventTime,
            completeLiteral: candidate.claim.evidence.literal,
            semantics: 'source_attributed_statement' as const,
            ...(candidate.claim.qualification === undefined
              ? {}
              : { qualification: candidate.claim.qualification }),
          };
    try {
      const meaningHash = hashAutonomousPersonalClaimMeaningV3(logicalInput);
      const key = hashAutonomousPersonalClaimKeyV3(logicalInput);
      const rootPaths =
        candidate.claim.kind === 'typed_preference'
          ? candidate.claim.meaning.bundles[0]!.rootPaths
          : ['record'];
      const dependencies = rootPaths.map((rootPath, index) => ({
        index,
        dependencyHash: hashAutonomousPersonalPredicateDependencyV1({
          logicalInput,
          meaningHash,
          rootIndex: index,
          rootPath,
        }),
      }));
      if (
        candidate.reference.meaningHash !== meaningHash ||
        candidate.claim.key !== key ||
        JSON.stringify(candidate.reference.dependencies) !== JSON.stringify(dependencies)
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Candidate hash DATA disagrees' });
      }
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Candidate hash DATA is invalid' });
    }
  });

/** Strict package-internal output DATA. A candidate is not a write permit or source proof. */
export const AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema = z.union([
  candidateResult,
  z.object({ kind: z.literal('candidate_capacity') }).strict(),
  z.object({ kind: z.literal('aggregate_capacity') }).strict(),
]);

export type AutonomousPersonalClaimCandidateV1Result = z.infer<
  typeof AutonomousPersonalClaimCandidateV1ResultOwnedDataSchema
>;
