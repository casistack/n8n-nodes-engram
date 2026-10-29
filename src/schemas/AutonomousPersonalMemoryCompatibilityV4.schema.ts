import { z } from 'zod';
import { GraphDataSchema } from './GraphData.schema';
import { AutomaticActorSchema } from './AutomaticMemory.schema';

/** Internal read diagnostics only; a null stop does not grant processing permission. */
export const AutonomousPersonalMemoryReadStopV4Schema = z
  .enum(['invalid_reader', 'budget_exhausted', 'resource_exhausted'])
  .nullable();
export type AutonomousPersonalMemoryReadStopV4 = z.infer<
  typeof AutonomousPersonalMemoryReadStopV4Schema
>;

/** Same-snapshot namespace DATA for the fixed legacy compatibility reader. */
export const AutonomousPersonalMemoryCompatibilityDataV4Schema = z
  .object({
    namespace: AutomaticActorSchema.shape.namespace,
    backendNow: z.string().datetime(),
    graph: GraphDataSchema,
  })
  .strict();
export type AutonomousPersonalMemoryCompatibilityDataV4 = z.infer<
  typeof AutonomousPersonalMemoryCompatibilityDataV4Schema
>;
