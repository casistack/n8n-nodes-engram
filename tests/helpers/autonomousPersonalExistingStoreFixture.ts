import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v5 as uuidV5 } from 'uuid';
import { z } from 'zod';
import { EntityEdgeSchema, EntityNodeSchema, EpisodicNodeSchema } from '../../src/schemas';
import { GraphDataSchema, type GraphData } from '../../src/schemas/GraphData.schema';
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';

const FIXTURE_UUID_NAMESPACE = '708c837d-f946-4e80-9d4f-992f4a2db91a';
const FIXTURE_BASE_TIME = Date.parse('2026-10-30T00:00:00.000Z');
const CONVERSATION_LENGTH = 32;
const MAX_SYNTHETIC_FIELD_BYTES = 512 * 1024;
const FORBIDDEN_PRIVILEGED_FIXTURE_ATTRIBUTES = new Set([
  'engram_actor_bindings_v1',
  'engram_source_envelope_v3',
  'engram_write_owner_v4',
  'engram_claim_v1',
  'engram_literal_v1',
]);

const countsSchema = z
  .object({
    episodes: z.number().int().min(1).max(100_000).optional(),
    entities: z.number().int().min(1).max(100_000).optional(),
    edges: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const byteShapeSchema = z
  .object({
    episodeContent: z.number().int().min(0).max(MAX_SYNTHETIC_FIELD_BYTES).default(160),
    entitySummary: z.number().int().min(0).max(MAX_SYNTHETIC_FIELD_BYTES).default(48),
    edgeFact: z.number().int().min(1).max(MAX_SYNTHETIC_FIELD_BYTES).default(64),
    episodeAttributePayload: z.number().int().min(0).max(MAX_SYNTHETIC_FIELD_BYTES).default(0),
    entityAttributePayload: z.number().int().min(0).max(MAX_SYNTHETIC_FIELD_BYTES).default(0),
    edgeAttributePayload: z.number().int().min(0).max(MAX_SYNTHETIC_FIELD_BYTES).default(0),
  })
  .strict()
  .default({});

const embeddingShapeSchema = z
  .object({
    entityDimensions: z.number().int().min(0).max(2048).default(0),
    edgeDimensions: z.number().int().min(0).max(2048).default(0),
  })
  .strict()
  .default({});

const optionsSchema = z
  .object({
    groupId: z.string().min(1).default('synthetic-existing-store'),
    scale: z.union([z.literal(1), z.literal(5)]).default(1),
    counts: countsSchema.optional(),
    bytes: byteShapeSchema,
    embeddings: embeddingShapeSchema,
  })
  .strict();

export type AutonomousPersonalExistingStoreFixtureOptions = z.input<typeof optionsSchema>;

export interface AutonomousPersonalExistingStoreFixtureShape {
  readonly graph: GraphData;
  readonly stats: {
    readonly episodeCount: number;
    readonly entityCount: number;
    readonly edgeCount: number;
    readonly serializedGraphBytes: number;
    readonly episodeContentBytes: number;
    readonly entitySummaryBytes: number;
    readonly edgeFactBytes: number;
    readonly episodeAttributeJsonBytes: number;
    readonly entityAttributeJsonBytes: number;
    readonly edgeAttributeJsonBytes: number;
    readonly entityEmbeddingCount: number;
    readonly edgeEmbeddingCount: number;
    readonly autonomousPersonalMarkerCount: number;
    readonly automaticOperationCount: number;
  };
}

export interface AutonomousPersonalPersistedExistingStoreFixture extends AutonomousPersonalExistingStoreFixtureShape {
  readonly directory: string;
  readonly file: string;
  readonly storage: GraphologyStorage;
  close(): Promise<void>;
}

const BASE_COUNTS = Object.freeze({ episodes: 592, entities: 155, edges: 113 });

function rowUuid(groupId: string, rowKind: string, index: number): string {
  return uuidV5(`${groupId}:${rowKind}:${index}`, FIXTURE_UUID_NAMESPACE);
}

function timestamp(index: number): string {
  return new Date(FIXTURE_BASE_TIME + index * 60_000).toISOString();
}

function fixedAsciiBytes(prefix: string, bytes: number): string {
  if (bytes === 0) return '';
  if (prefix.length >= bytes) return prefix.slice(0, bytes);
  return prefix + 'x'.repeat(bytes - prefix.length);
}

function fixtureAttributes(
  kind: string,
  index: number,
  payloadBytes: number,
): Record<string, unknown> {
  return {
    synthetic_fixture: {
      kind,
      row: index,
      payload: fixedAsciiBytes(`fixture-${kind}-${index}-`, payloadBytes),
    },
  };
}

function embedding(dimensions: number, rowIndex: number): number[] | null {
  if (dimensions === 0) return null;
  return Array.from({ length: dimensions }, (_value, index) => ((rowIndex + index) % 31) / 31);
}

function selectedCounts(
  scale: 1 | 5,
  override: z.infer<typeof countsSchema> | undefined,
): { episodes: number; entities: number; edges: number } {
  if (override) {
    return {
      episodes: override.episodes ?? BASE_COUNTS.episodes,
      entities: override.entities ?? BASE_COUNTS.entities,
      edges: override.edges ?? BASE_COUNTS.edges,
    };
  }
  return {
    episodes: BASE_COUNTS.episodes * scale,
    entities: BASE_COUNTS.entities * scale,
    edges: BASE_COUNTS.edges * scale,
  };
}

function sumUtf8(rows: readonly { readonly [key: string]: unknown }[], key: string): number {
  return rows.reduce((sum, row) => sum + Buffer.byteLength(String(row[key]), 'utf8'), 0);
}

function sumSerializedAttributes(
  rows: readonly { readonly attributes: Record<string, unknown> }[],
): number {
  return rows.reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.attributes), 'utf8'),
    0,
  );
}

function countPrivilegedFixtureAttributes(graph: GraphData): number {
  return [...graph.entities, ...graph.edges, ...graph.episodes].filter((row) =>
    Object.keys(row.attributes).some((key) => FORBIDDEN_PRIVILEGED_FIXTURE_ATTRIBUTES.has(key)),
  ).length;
}

/**
 * Creates an ordinary, deterministic DATA fixture. It has no native Source4,
 * Claim3, actor-binding, or automatic-ledger rows. The 1x/5x defaults match
 * reported row counts only; byte-shape options are required for workload studies.
 */
export function buildAutonomousPersonalExistingStoreFixture(
  optionsValue: AutonomousPersonalExistingStoreFixtureOptions = {},
): AutonomousPersonalExistingStoreFixtureShape {
  const options = optionsSchema.parse(optionsValue);
  const counts = selectedCounts(options.scale, options.counts);
  if (counts.edges > 0 && counts.entities < 2) {
    throw new Error('Existing-store fixture edges require at least two entities');
  }

  const episodeIds = Array.from({ length: counts.episodes }, (_value, index) =>
    rowUuid(options.groupId, 'episode', index),
  );
  const entityIds = Array.from({ length: counts.entities }, (_value, index) =>
    rowUuid(options.groupId, 'entity', index),
  );

  const entities = Array.from({ length: counts.entities }, (_value, index) =>
    EntityNodeSchema.parse({
      uuid: entityIds[index],
      group_id: options.groupId,
      name: `Synthetic existing entity ${index}`,
      summary: fixedAsciiBytes(`ordinary entity summary ${index} `, options.bytes.entitySummary),
      entity_type: ['person', 'organization', 'location', 'concept'][index % 4],
      name_embedding: embedding(options.embeddings.entityDimensions, index),
      attributes: fixtureAttributes('entity', index, options.bytes.entityAttributePayload),
      created_at: timestamp(index),
      updated_at: timestamp(index),
    }),
  );

  const episodes = Array.from({ length: counts.episodes }, (_value, index) => {
    const conversationIndex = Math.floor(index / CONVERSATION_LENGTH);
    const offsetInConversation = index % CONVERSATION_LENGTH;
    const role = index % 2 === 0 ? 'human' : 'ai';
    return EpisodicNodeSchema.parse({
      uuid: episodeIds[index],
      group_id: options.groupId,
      content: fixedAsciiBytes(
        `ordinary synthetic ${role} message ${index} `,
        options.bytes.episodeContent,
      ),
      role,
      source_type: 'message',
      reference_time: timestamp(index),
      previous_episode_uuid: offsetInConversation === 0 ? null : episodeIds[index - 1],
      created_at: timestamp(index),
      updated_at: timestamp(index),
      source_message_id: `message:${index}`,
      idempotency_key: null,
      conversation_id: `conversation:${conversationIndex}`,
      sender_id: role === 'human' ? `human:${conversationIndex}` : `assistant:${conversationIndex}`,
      sender_name: role === 'human' ? 'Synthetic human' : 'Synthetic assistant',
      episode_kind: role === 'human' ? 'active_human' : 'assistant_reply',
      quoted_message_id: null,
      trust_level: 'unverified',
      confidence: null,
      review_status: 'proposed',
      source_workflow_id: 'workflow:synthetic-existing-store',
      source_execution_id: `execution:${conversationIndex}`,
      attributes: fixtureAttributes('episode', index, options.bytes.episodeAttributePayload),
    });
  });

  const edges = Array.from({ length: counts.edges }, (_value, index) => {
    const sourceIndex = index % counts.entities;
    const targetIndex = (sourceIndex + 1) % counts.entities;
    const episodeIndex = index % counts.episodes;
    return EntityEdgeSchema.parse({
      uuid: rowUuid(options.groupId, 'edge', index),
      group_id: options.groupId,
      source_node_uuid: entityIds[sourceIndex],
      target_node_uuid: entityIds[targetIndex],
      name: ['RELATED_TO', 'MENTIONS', 'LOCATED_IN'][index % 3],
      fact: fixedAsciiBytes(`ordinary synthetic relation ${index} `, options.bytes.edgeFact),
      fact_embedding: embedding(options.embeddings.edgeDimensions, index),
      episodes: [episodeIds[episodeIndex]],
      valid_at: timestamp(episodeIndex),
      invalid_at: null,
      expired_at: null,
      attributes: fixtureAttributes('edge', index, options.bytes.edgeAttributePayload),
      created_at: timestamp(index),
      updated_at: timestamp(index),
    });
  });

  const graph = GraphDataSchema.parse({
    version: '2.0',
    exported_at: timestamp(0),
    group_id: options.groupId,
    entities,
    edges,
    episodes,
  });
  const stats = {
    episodeCount: graph.episodes.length,
    entityCount: graph.entities.length,
    edgeCount: graph.edges.length,
    serializedGraphBytes: Buffer.byteLength(JSON.stringify(graph), 'utf8'),
    episodeContentBytes: sumUtf8(graph.episodes, 'content'),
    entitySummaryBytes: sumUtf8(graph.entities, 'summary'),
    edgeFactBytes: sumUtf8(graph.edges, 'fact'),
    episodeAttributeJsonBytes: sumSerializedAttributes(graph.episodes),
    entityAttributeJsonBytes: sumSerializedAttributes(graph.entities),
    edgeAttributeJsonBytes: sumSerializedAttributes(graph.edges),
    entityEmbeddingCount: graph.entities.filter((entity) => entity.name_embedding !== null).length,
    edgeEmbeddingCount: graph.edges.filter((edge) => edge.fact_embedding !== null).length,
    autonomousPersonalMarkerCount: countPrivilegedFixtureAttributes(graph),
    automaticOperationCount: graph.automatic_operations_v1?.operations.length ?? 0,
  };
  return { graph, stats };
}

/**
 * Persists an ordinary fixture by calling GraphologyStorage.importGraph once.
 * Native capture rows are intentionally absent; callers must create them through
 * the actual capture APIs in any end-to-end benchmark.
 */
export async function createAutonomousPersonalPersistedExistingStoreFixture(
  options: AutonomousPersonalExistingStoreFixtureOptions = {},
): Promise<AutonomousPersonalPersistedExistingStoreFixture> {
  const shape = buildAutonomousPersonalExistingStoreFixture(options);
  const directory = mkdtempSync(join(tmpdir(), 'engram-existing-store-fixture-'));
  const file = join(directory, 'store.json');
  const storage = new GraphologyStorage(file);
  try {
    await storage.initialize();
    await storage.importGraph(shape.graph);
    return {
      ...shape,
      directory,
      file,
      storage,
      async close() {
        try {
          await storage.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await storage.close();
    } catch {
      // The setup failure remains authoritative; always remove this fixture's directory.
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
