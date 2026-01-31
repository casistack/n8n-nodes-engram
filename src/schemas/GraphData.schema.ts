import { z } from 'zod';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';

export const GraphDataSchema = z.object({
	version: z.literal('1.0'),
	exported_at: z.string().datetime(),
	group_id: z.string().optional(),
	entities: z.array(EntityNodeSchema),
	edges: z.array(EntityEdgeSchema),
	episodes: z.array(EpisodicNodeSchema),
});

export type GraphData = z.infer<typeof GraphDataSchema>;

export const GraphStatsSchema = z.object({
	entity_count: z.number().int().nonnegative(),
	edge_count: z.number().int().nonnegative(),
	episode_count: z.number().int().nonnegative(),
	group_ids: z.array(z.string()),
	entity_types: z.record(z.number().int().nonnegative()),
	oldest_episode: z.string().datetime().nullable(),
	newest_episode: z.string().datetime().nullable(),
});

export type GraphStats = z.infer<typeof GraphStatsSchema>;
