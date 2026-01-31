import { z } from 'zod';

export const EntityNodeSchema = z.object({
	uuid: z.string().uuid(),
	name: z.string().min(1),
	group_id: z.string().min(1),
	summary: z.string().default(''),
	entity_type: z.string().default('unknown'),
	name_embedding: z.array(z.number()).nullable().default(null),
	attributes: z.record(z.unknown()).default({}),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export type EntityNode = z.infer<typeof EntityNodeSchema>;

export const CreateEntityNodeSchema = z.object({
	name: z.string().min(1),
	group_id: z.string().min(1),
	summary: z.string().default(''),
	entity_type: z.string().default('unknown'),
	name_embedding: z.array(z.number()).nullable().default(null),
	attributes: z.record(z.unknown()).default({}),
});

export type CreateEntityNode = z.input<typeof CreateEntityNodeSchema>;
