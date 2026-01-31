import { z } from 'zod';

export const EntityEdgeSchema = z.object({
	uuid: z.string().uuid(),
	group_id: z.string().min(1),
	source_node_uuid: z.string().uuid(),
	target_node_uuid: z.string().uuid(),
	name: z.string().min(1),
	fact: z.string().min(1),
	fact_embedding: z.array(z.number()).nullable().default(null),
	episodes: z.array(z.string().uuid()).default([]),
	valid_at: z.string().datetime().nullable().default(null),
	invalid_at: z.string().datetime().nullable().default(null),
	expired_at: z.string().datetime().nullable().default(null),
	attributes: z.record(z.unknown()).default({}),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export type EntityEdge = z.infer<typeof EntityEdgeSchema>;

export const CreateEntityEdgeSchema = z.object({
	group_id: z.string().min(1),
	source_node_uuid: z.string().uuid(),
	target_node_uuid: z.string().uuid(),
	name: z.string().min(1),
	fact: z.string().min(1),
	fact_embedding: z.array(z.number()).nullable().default(null),
	episodes: z.array(z.string().uuid()).default([]),
	valid_at: z.string().datetime().nullable().default(null),
	invalid_at: z.string().datetime().nullable().default(null),
	expired_at: z.string().datetime().nullable().default(null),
	attributes: z.record(z.unknown()).default({}),
});

export type CreateEntityEdge = z.input<typeof CreateEntityEdgeSchema>;
