import { z } from 'zod';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EntityNodeSchema } from './EntityNode.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { AutonomousPersonalOperationV4OwnedDataSchema } from './AutonomousPersonalOperationV4.schema';

/** Strict candidate-row DATA from one owned claim index; this is not creator qualification. */
export const AutonomousPersonalClaimIndexCandidateRowsV4OwnedDataSchema = z
  .object({
    edge: EntityEdgeSchema,
    subject: EntityNodeSchema,
    value: EntityNodeSchema,
    source: EpisodicNodeSchema,
    operation: AutonomousPersonalOperationV4OwnedDataSchema,
  })
  .strict();

export type AutonomousPersonalClaimIndexCandidateRowsV4 = z.infer<
  typeof AutonomousPersonalClaimIndexCandidateRowsV4OwnedDataSchema
>;
