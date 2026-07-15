import { z } from 'zod';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';

export const CURRENT_GRAPH_DATA_VERSION = '2.0' as const;

const GraphMetadataSchema = z.object({
  checksum_sha256: z.string().optional(),
  checksum_algorithm: z.literal('sha256').optional(),
  generated_by: z.string().optional(),
  entity_count: z.number().int().nonnegative().optional(),
  edge_count: z.number().int().nonnegative().optional(),
  episode_count: z.number().int().nonnegative().optional(),
});

const GraphDataContentsSchema = z.object({
  exported_at: z.string().datetime(),
  group_id: z.string().optional(),
  metadata: GraphMetadataSchema.optional(),
  entities: z.array(EntityNodeSchema),
  edges: z.array(EntityEdgeSchema),
  episodes: z.array(EpisodicNodeSchema),
});

export const LegacyGraphDataSchema = GraphDataContentsSchema.extend({
  version: z.literal('1.0'),
});

export const GraphDataSchema = GraphDataContentsSchema.extend({
  version: z.literal(CURRENT_GRAPH_DATA_VERSION),
});

export const ImportGraphDataSchema = z.discriminatedUnion('version', [
  LegacyGraphDataSchema,
  GraphDataSchema,
]);

export type GraphData = z.infer<typeof GraphDataSchema>;
export type ImportGraphData = z.input<typeof ImportGraphDataSchema>;

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
