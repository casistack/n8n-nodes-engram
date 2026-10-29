import { z } from 'zod';
import { EntityNodeSchema } from './EntityNode.schema';
import { EntityEdgeSchema } from './EntityEdge.schema';
import { EpisodicNodeSchema } from './EpisodicNode.schema';
import { AutomaticLedgerSchema } from './AutomaticLedger.schema';

export const CURRENT_GRAPH_DATA_VERSION = '2.0' as const;

const GraphMetadataSchema = z.object({
  extraction_epoch: z.string().uuid().optional(),
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

const LegacyKnownSchema = GraphDataContentsSchema.extend({
  version: z.literal('1.0'),
});
const LegacyRawSchema = LegacyKnownSchema.passthrough();

const CurrentKnownSchema = GraphDataContentsSchema.extend({
  version: z.literal(CURRENT_GRAPH_DATA_VERSION),
  automatic_operations_v1: AutomaticLedgerSchema.optional(),
});
const CurrentRawSchema = CurrentKnownSchema.passthrough();

function rejectReservedAutomaticRoots(
  data: Record<string, unknown>,
  allowed: 'automatic_operations_v1' | null,
  context: z.RefinementCtx,
): void {
  for (const key of Object.keys(data)) {
    if (key.startsWith('automatic_operations_') && (allowed === null || key !== allowed)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Unknown or legacy automatic operation roots are forbidden',
        path: [key],
      });
    }
  }
}

function knownLegacyFields(
  data: z.infer<typeof LegacyKnownSchema>,
): z.infer<typeof LegacyKnownSchema> {
  return {
    version: data.version,
    exported_at: data.exported_at,
    ...(data.group_id !== undefined ? { group_id: data.group_id } : {}),
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
    entities: data.entities,
    edges: data.edges,
    episodes: data.episodes,
  };
}

function knownCurrentFields(
  data: z.infer<typeof CurrentKnownSchema>,
): z.infer<typeof CurrentKnownSchema> {
  return {
    version: data.version,
    exported_at: data.exported_at,
    ...(data.group_id !== undefined ? { group_id: data.group_id } : {}),
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
    entities: data.entities,
    edges: data.edges,
    episodes: data.episodes,
    ...(data.automatic_operations_v1 !== undefined
      ? { automatic_operations_v1: data.automatic_operations_v1 }
      : {}),
  };
}

function validateCurrentGraphData(
  data: z.infer<typeof CurrentRawSchema>,
  context: z.RefinementCtx,
): void {
  rejectReservedAutomaticRoots(data, 'automatic_operations_v1', context);
  // Keep 0.7.2 rootless GraphData parse/import behavior unchanged. Combined caps apply
  // only when an operational ledger is present and this schema is validating its snapshot.
  if (data.automatic_operations_v1 !== undefined) {
    if (data.entities.length + data.edges.length + data.episodes.length > 100_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ledger-bearing graph snapshot exceeds 100,000 graph records',
        path: ['episodes'],
      });
    }
    if (Buffer.byteLength(JSON.stringify(knownCurrentFields(data)), 'utf8') > 100 * 1024 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ledger-bearing graph snapshot must not exceed 100 MiB serialized',
        path: ['automatic_operations_v1'],
      });
    }
  }
}

export const LegacyGraphDataSchema = LegacyRawSchema.superRefine((data, context) => {
  rejectReservedAutomaticRoots(data, null, context);
}).transform((data) => knownLegacyFields(data));

export const GraphDataSchema = CurrentRawSchema.superRefine(validateCurrentGraphData).transform(
  (data) => knownCurrentFields(data),
);

export const ImportGraphDataSchema = z
  .discriminatedUnion('version', [LegacyRawSchema, CurrentRawSchema])
  .superRefine((data, context) => {
    if (data.version === '1.0') rejectReservedAutomaticRoots(data, null, context);
    else validateCurrentGraphData(data, context);
  })
  .transform((data) =>
    data.version === '1.0' ? knownLegacyFields(data) : knownCurrentFields(data),
  );

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
