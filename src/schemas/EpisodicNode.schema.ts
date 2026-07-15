import { z } from 'zod';

export const EpisodeRoleSchema = z.enum(['human', 'ai', 'system']);
export const EpisodeSourceTypeSchema = z.enum(['message', 'document', 'api']);
export const EpisodeKindSchema = z.enum([
  'active_human',
  'passive_human',
  'assistant_reply',
  'monitor_summary',
  'tool_output',
  'system',
  'legacy',
]);
export const EpisodeTrustLevelSchema = z.enum(['trusted', 'standard', 'unverified', 'untrusted']);
export const EpisodeReviewStatusSchema = z.enum(['proposed', 'accepted', 'rejected']);

export type EpisodeRole = z.infer<typeof EpisodeRoleSchema>;
export type EpisodeSourceType = z.infer<typeof EpisodeSourceTypeSchema>;
export type EpisodeKind = z.infer<typeof EpisodeKindSchema>;
export type EpisodeTrustLevel = z.infer<typeof EpisodeTrustLevelSchema>;
export type EpisodeReviewStatus = z.infer<typeof EpisodeReviewStatusSchema>;

const nullableIdentifier = z.string().trim().min(1).max(512).nullable().default(null);

const EpisodeMetadataSchema = z.object({
  source_message_id: nullableIdentifier,
  idempotency_key: nullableIdentifier,
  conversation_id: nullableIdentifier,
  sender_id: nullableIdentifier,
  sender_name: z.string().trim().min(1).max(512).nullable().default(null),
  episode_kind: EpisodeKindSchema.default('legacy'),
  quoted_message_id: nullableIdentifier,
  trust_level: EpisodeTrustLevelSchema.default('unverified'),
  confidence: z.number().min(0).max(1).nullable().default(null),
  review_status: EpisodeReviewStatusSchema.default('proposed'),
  source_workflow_id: nullableIdentifier,
  source_execution_id: nullableIdentifier,
  attributes: z.record(z.unknown()).default({}),
});

export const EpisodicNodeSchema = z.object({
  uuid: z.string().uuid(),
  group_id: z.string().min(1),
  content: z.string(),
  role: EpisodeRoleSchema,
  source_type: EpisodeSourceTypeSchema.default('message'),
  reference_time: z.string().datetime(),
  previous_episode_uuid: z.string().uuid().nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable().default(null),
  ...EpisodeMetadataSchema.shape,
});

export type EpisodicNode = z.infer<typeof EpisodicNodeSchema>;

export const CreateEpisodicNodeSchema = z.object({
  group_id: z.string().min(1),
  content: z.string(),
  role: EpisodeRoleSchema,
  source_type: EpisodeSourceTypeSchema.default('message'),
  reference_time: z.string().datetime(),
  previous_episode_uuid: z.string().uuid().nullable().default(null),
  ...EpisodeMetadataSchema.shape,
});

export type CreateEpisodicNode = z.input<typeof CreateEpisodicNodeSchema>;
