import { z } from 'zod';
import { CompositionalCaptureNamespaceV3Schema } from './CompositionalCaptureNamespaceV3.schema';
import {
  CompositionalAutomaticClaimMeaningV2Schema,
  compositionalAutomaticClaimKeyV2,
} from './CompositionalAutomaticMemory.schema';
import { cloneBoundedAutomaticCaptureJson } from '../storage/BoundedAutomaticCaptureJson';
import { EpisodeKindSchema, EpisodeTrustLevelSchema } from './EpisodicNode.schema';

/** Plain-data schema bound. Public function entries additionally snapshot before any Zod call. */
function bounded<S extends z.ZodTypeAny>(schema: S, bytes: number) {
  return z.unknown().transform((value, context): z.infer<S> => {
    let owned: unknown;
    try {
      owned = cloneBoundedAutomaticCaptureJson(value, 'beginRequest');
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded retrieval data' });
      return z.NEVER;
    }
    if (Buffer.byteLength(JSON.stringify(owned), 'utf8') > bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retrieval data capacity exceeded',
      });
      return z.NEVER;
    }
    const parsed = schema.safeParse(owned);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return parsed.data;
  });
}

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const CompositionalRetrievalRequestV3Schema = z
  .object({
    namespace: CompositionalCaptureNamespaceV3Schema,
    mode: z.enum(['current', 'historical', 'asOf']),
  })
  .strict();
export const CompositionalRetrievalSessionReasonV3Schema = z.enum([
  'invalid_input',
  'invalid_resources',
  'invalid_intake',
  'invalid_session',
  'unsupported_mode',
  'invalid_snapshot',
  'missing_edge',
  'unsupported_family',
  'not_current_qualified',
  'unresolved_overlap',
  'internal_consistency_unproved',
  'incomplete_subject',
  'ambiguous_qualification',
  'budget_exhausted',
  'capacity',
]);
export type CompositionalRetrievalSessionReasonV3 = z.infer<
  typeof CompositionalRetrievalSessionReasonV3Schema
>;
const failure = z
  .object({ status: z.literal('deferred'), reason: CompositionalRetrievalSessionReasonV3Schema })
  .strict();
export type CompositionalRetrievalFailureV3 = z.infer<typeof failure>;

/** Plain data only: parsing this representation does not establish actual storage origin. */
const entryBody = z
  .object({
    status: z.literal('qualified_current_data'),
    edgeId: uuid,
    semanticKey: hash,
    namespace: CompositionalCaptureNamespaceV3Schema,
    subject: z
      .object({
        id: uuid,
        name: z
          .string()
          .min(1)
          .max(48 * 1024),
      })
      .strict(),
    meaning: CompositionalAutomaticClaimMeaningV2Schema,
    lexicalForm: z.string().min(1).max(4096),
    provenance: z
      .object({
        sourceId: uuid,
        operationId: uuid,
        terminalAt: z.string().datetime(),
        creationReview: z.enum(['accepted', 'proposed']),
        currentReview: z.literal('accepted'),
        reviewedAt: z.string().datetime().nullable(),
        reviewedBy: z.string().max(4096).nullable(),
        sourceMessageId: z.string().max(4096).nullable(),
        conversationId: z.string().max(4096).nullable(),
        senderId: z.string().max(4096).nullable(),
        senderName: z.string().max(4096).nullable(),
        referenceTime: z.string().datetime({ offset: true }).nullable(),
        sourceWorkflowId: z.string().max(4096).nullable(),
        sourceExecutionId: z.string().max(4096).nullable(),
        sourceRole: z.literal('human'),
        episodeKind: EpisodeKindSchema,
        sourceTrust: EpisodeTrustLevelSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.meaning.namespace !== value.namespace ||
      value.meaning.subjectId !== value.subject.id ||
      compositionalAutomaticClaimKeyV2(value.meaning) !== value.semanticKey
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retrieval meaning domain mismatch',
      });
  });
export const CompositionalRetrievalEntryV3Schema = bounded(entryBody, 48 * 1024);
export type CompositionalRetrievalEntryV3 = z.infer<typeof CompositionalRetrievalEntryV3Schema>;
const outcome = z.union([
  CompositionalRetrievalEntryV3Schema,
  z
    .object({
      status: z.enum(['hidden', 'deferred']),
      edgeId: uuid,
      reason: CompositionalRetrievalSessionReasonV3Schema,
    })
    .strict(),
]);
export type CompositionalRetrievalOutcomeV3 = z.infer<typeof outcome>;
const dataBody = z
  .object({
    status: z.literal('data'),
    entries: z.array(outcome).max(128),
    diagnostics: z
      .object({
        inspectedCandidates: z.number().int().min(0).max(128),
        samples: z
          .array(
            z
              .object({
                edgeId: uuid,
                status: z.enum(['qualified_current_data', 'hidden', 'deferred']),
                reason: CompositionalRetrievalSessionReasonV3Schema.optional(),
              })
              .strict(),
          )
          .max(8),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value.diagnostics), 'utf8') > 32768)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Retrieval diagnostics capacity exceeded',
      });
  });
export const CompositionalRetrievalDataV3Schema = bounded(dataBody, 512 * 1024);
export type CompositionalRetrievalDataV3 = z.infer<typeof CompositionalRetrievalDataV3Schema>;
export const CompositionalRetrievalReadResultV3Schema = z.union([
  CompositionalRetrievalDataV3Schema,
  failure,
]);
export type CompositionalRetrievalReadResultV3 = z.infer<
  typeof CompositionalRetrievalReadResultV3Schema
>;

declare const intakeBrand: unique symbol;
declare const sessionBrand: unique symbol;
/** Resource/data ownership tokens only; neither establishes actual backend origin. */
export type CompositionalRetrievalIntakeV3 = Readonly<{ [intakeBrand]: 'retrieval_intake' }>;
export type CompositionalRetrievalSessionV3 = Readonly<{ [sessionBrand]: 'retrieval_session' }>;
const intakeResult = z.union([
  z
    .object({ status: z.literal('intake'), intake: z.custom<CompositionalRetrievalIntakeV3>() })
    .strict(),
  failure,
]);
const prepareResult = z.union([
  z
    .object({
      status: z.literal('prepared_data'),
      session: z.custom<CompositionalRetrievalSessionV3>(),
    })
    .strict(),
  failure,
]);
export type CompositionalRetrievalBeginResultV3 = z.infer<typeof intakeResult>;
export type CompositionalRetrievalPrepareResultV3 = z.infer<typeof prepareResult>;
const ownedSnapshotResult = z.union([
  z.object({ status: z.literal('snapshot_data'), value: z.unknown() }).strict(),
  failure,
]);
export type CompositionalOwnedSnapshotDataResultV3 = z.infer<typeof ownedSnapshotResult>;
