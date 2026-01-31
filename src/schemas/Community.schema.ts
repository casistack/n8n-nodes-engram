import { z } from 'zod';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';

export const CommunityMemberSchema = z.object({
	entity: EntityNodeSchema,
	edges: z.array(EntityEdgeSchema),
});

export type CommunityMember = z.infer<typeof CommunityMemberSchema>;

export const CommunitySchema = z.object({
	id: z.string(),
	label: z.string(),
	members: z.array(CommunityMemberSchema),
	summary: z.string().nullable(),
	entity_count: z.number().int().nonnegative(),
	edge_count: z.number().int().nonnegative(),
	key_entities: z.array(z.string()),
});

export type Community = z.infer<typeof CommunitySchema>;

export const CommunityDetectionResultSchema = z.object({
	communities: z.array(CommunitySchema),
	total_entities: z.number().int().nonnegative(),
	unclustered_entities: z.number().int().nonnegative(),
	detection_method: z.literal('label_propagation'),
});

export type CommunityDetectionResult = z.infer<typeof CommunityDetectionResultSchema>;
