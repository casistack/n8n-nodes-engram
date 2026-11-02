import { z } from 'zod';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { statementQualificationSchema } from './AutonomousPersonalClaimV3.schema';
import { AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema } from './AutonomousPersonalQualifiedClaimV4.schema';
import { CompositionalAutomaticClaimMeaningV2Schema } from './CompositionalAutomaticMemory.schema';

const episode = EpisodicNodeSchema.shape;
const proof = AutonomousPersonalQualifiedClaimProofV4OwnedDataSchema;
const source = z
  .object({
    sourceMessageId: episode.source_message_id.removeDefault(),
    conversationId: episode.conversation_id.removeDefault(),
    senderId: episode.sender_id.removeDefault(),
    senderName: episode.sender_name.removeDefault(),
    episodeKind: episode.episode_kind.removeDefault(),
    trustLevel: episode.trust_level.removeDefault(),
    reviewStatus: z.literal('accepted'),
    referenceTime: z.string().max(64).pipe(episode.reference_time),
    sourceWorkflowId: episode.source_workflow_id.removeDefault(),
    sourceExecutionId: episode.source_execution_id.removeDefault(),
  })
  .strict();
const common = {
  version: z.literal(4),
  rowHash: z.string().regex(/^[a-f0-9]{64}$/u),
  proof,
  terminalAt: proof.innerType().shape.createdAt,
  creationReviewState: z.enum(['accepted', 'proposed']),
  confidence: z.number().min(0).max(1).nullable(),
  source,
};

/** Already-owned compact display DATA, never a creator, parent, or write permit. */
export const AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('typed_preference'),
        meaning: CompositionalAutomaticClaimMeaningV2Schema,
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('source_statement_record'),
        statementLiteral: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              value.length <= 4096 &&
              Array.from(value).length <= 2048 &&
              Buffer.byteLength(value, 'utf8') <= 4096,
          ),
        sourceEventTime: proof.innerType().shape.sourceEventTime,
        qualification: statementQualificationSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((candidate, context) => {
    // Refinements may run after a non-fatal field-bound failure; do not
    // serialize an oversized rejected field while checking the total cap.
    if (
      candidate.source.referenceTime.length > 64 ||
      (candidate.kind === 'source_statement_record' && candidate.statementLiteral.length > 4096)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Oversized compact claim candidate DATA',
      });
      return;
    }
    if (
      candidate.proof.kind !== candidate.kind ||
      candidate.proof.reviewState !== 'accepted' ||
      (candidate.kind === 'typed_preference' &&
        (candidate.meaning.namespace !== candidate.proof.namespace ||
          candidate.meaning.subjectId !== candidate.proof.subjectId)) ||
      (candidate.kind === 'source_statement_record' &&
        candidate.sourceEventTime !== candidate.proof.sourceEventTime) ||
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 48 * 1024
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid compact claim candidate DATA',
      });
    }
  });

export type AutonomousPersonalMemoryParentQualifiedClaimCandidateV4Data = z.infer<
  typeof AutonomousPersonalMemoryParentQualifiedClaimCandidateV4OwnedDataSchema
>;
