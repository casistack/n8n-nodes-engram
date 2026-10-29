import { z } from 'zod';
import { CompositionalAutomaticClaimMeaningV2Schema } from './CompositionalAutomaticMemory.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { CompositionalRuntimeSearchHitV3Schema } from './CompositionalRuntimeSearchV3.schema';
import { EpisodeKindSchema, EpisodeTrustLevelSchema } from './EpisodicNode.schema';

const episode = EpisodicNodeSchema.shape;

/** Minimal source attribution retained by the Claim3 search display. */
export const AutonomousPersonalRuntimeSearchSourceV4OwnedDataSchema = z
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

const confidence = z.number().min(0).max(1).nullable();
const nullableSourceText = z.string().trim().min(1).max(512).nullable();
const governedProvenance = z
  .object({
    source_episode_uuid: z.string().uuid(),
    source_message_id: episode.source_message_id.removeDefault(),
    conversation_id: episode.conversation_id.removeDefault(),
    speaker_role: z.literal('human'),
    sender_id: episode.sender_id.removeDefault(),
    sender_name: episode.sender_name.removeDefault(),
    episode_kind: EpisodeKindSchema,
    reference_time: z.string().max(64).pipe(episode.reference_time),
    trust_level: EpisodeTrustLevelSchema,
    episode_review_status: z.literal('accepted'),
    source_workflow_id: nullableSourceText,
    source_execution_id: nullableSourceText,
    fact_confidence: confidence,
    fact_review_status: z.literal('accepted'),
  })
  .strict();
const sourceEventTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  });

/** Safe display DATA only; this intentionally has no proof, row hash, or creator records. */
export const AutonomousPersonalRuntimeDisplayV4OwnedDataSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('typed_preference'),
      meaning: CompositionalAutomaticClaimMeaningV2Schema,
      confidence,
      source: AutonomousPersonalRuntimeSearchSourceV4OwnedDataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('source_statement_record'),
      statementLiteral: z.string().min(1).max(4096),
      sourceEventTime,
      confidence,
      source: AutonomousPersonalRuntimeSearchSourceV4OwnedDataSchema,
    })
    .strict(),
]);

/** An immutable verified ranked hit. The private display registry holds structured meaning. */
export const AutonomousPersonalRuntimeGovernedHitV4OwnedDataSchema =
  CompositionalRuntimeSearchHitV3Schema.extend({
    edge: EntityEdgeSchema.strict(),
    sourceEntity: EntityNodeSchema.strict(),
    targetEntity: EntityNodeSchema.strict(),
    provenance: z.array(governedProvenance).length(1),
  }).strict();

export const AutonomousPersonalRuntimeSearchDecisionReasonV4Schema = z.enum([
  'included',
  'automatic_claim_authority',
  'automatic_claim_row_mismatch',
  'review_status_filtered',
  'no_source_episode_matched_filters',
  'autonomous_personal_historical_unsupported',
  'autonomous_personal_as_of_unsupported',
]);

export const AutonomousPersonalRuntimeSearchDecisionV4OwnedDataSchema = z
  .object({
    candidate_id: z.string().uuid(),
    candidate_type: z.literal('fact'),
    score: z.number().finite(),
    included: z.boolean(),
    reasons: z.array(AutonomousPersonalRuntimeSearchDecisionReasonV4Schema).min(1).max(1),
  })
  .strict();

export const AutonomousPersonalRuntimeSearchResultV4OwnedDataSchema = z
  .object({
    results: z.array(AutonomousPersonalRuntimeGovernedHitV4OwnedDataSchema).max(200),
    decisions: z.array(AutonomousPersonalRuntimeSearchDecisionV4OwnedDataSchema).max(200),
  })
  .strict();

export type AutonomousPersonalRuntimeSearchSourceV4 = z.infer<
  typeof AutonomousPersonalRuntimeSearchSourceV4OwnedDataSchema
>;
export type AutonomousPersonalRuntimeDisplayV4 = z.infer<
  typeof AutonomousPersonalRuntimeDisplayV4OwnedDataSchema
>;
export type AutonomousPersonalRuntimeGovernedHitV4 = z.infer<
  typeof AutonomousPersonalRuntimeGovernedHitV4OwnedDataSchema
>;
export type AutonomousPersonalRuntimeSearchDecisionV4 = z.infer<
  typeof AutonomousPersonalRuntimeSearchDecisionV4OwnedDataSchema
>;
export type AutonomousPersonalRuntimeSearchResultV4 = z.infer<
  typeof AutonomousPersonalRuntimeSearchResultV4OwnedDataSchema
>;
