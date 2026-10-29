import { z } from 'zod';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import {
  EpisodeKindSchema,
  EpisodeTrustLevelSchema,
  EpisodeReviewStatusSchema,
} from './EpisodicNode.schema';
export const CompositionalRuntimeSearchHitV3Schema = z
  .object({
    edge: EntityEdgeSchema.strict(),
    sourceEntity: EntityNodeSchema.strict(),
    targetEntity: EntityNodeSchema.strict(),
    score: z.number().finite(),
    match_evidence: z.object({ text: z.boolean(), vector: z.boolean() }).strict().optional(),
  })
  .strict();
export const CompositionalRuntimeSearchFiltersV3Schema = z
  .object({
    sender_id: z.string().max(4096).optional(),
    episode_kind: EpisodeKindSchema.optional(),
    trust_level: EpisodeTrustLevelSchema.optional(),
    source_workflow_id: z.string().max(4096).optional(),
    source_execution_id: z.string().max(4096).optional(),
    reference_after: z.string().max(128).optional(),
    reference_before: z.string().max(128).optional(),
    review_statuses: z.array(EpisodeReviewStatusSchema).max(3).optional(),
  })
  .strict();
export const CompositionalRuntimeSearchViewV3Schema = z
  .object({ mode: z.enum(['current', 'historical', 'asOf']), at: z.string().max(128).optional() })
  .strict();
