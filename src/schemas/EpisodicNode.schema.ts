import { z } from 'zod';

export const EpisodicNodeSchema = z.object({
  uuid: z.string().uuid(),
  group_id: z.string().min(1),
  content: z.string(),
  role: z.enum(['human', 'ai', 'system']),
  source_type: z.enum(['message', 'document', 'api']).default('message'),
  reference_time: z.string().datetime(),
  previous_episode_uuid: z.string().uuid().nullable().default(null),
  created_at: z.string().datetime(),
});

export type EpisodicNode = z.infer<typeof EpisodicNodeSchema>;

export const CreateEpisodicNodeSchema = z.object({
  group_id: z.string().min(1),
  content: z.string(),
  role: z.enum(['human', 'ai', 'system']),
  source_type: z.enum(['message', 'document', 'api']).default('message'),
  reference_time: z.string().datetime(),
  previous_episode_uuid: z.string().uuid().nullable().default(null),
});

export type CreateEpisodicNode = z.input<typeof CreateEpisodicNodeSchema>;
