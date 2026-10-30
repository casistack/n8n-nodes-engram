import type { Driver, QueryResult } from 'neo4j-driver';
import { GraphDataSchema, type GraphData } from '../../src/schemas/GraphData.schema';
import { z } from 'zod';
import { EntityNodeSchema, EntityEdgeSchema, EpisodicNodeSchema } from '../../src/schemas';

const BATCH_ROWS = 100;
const MAX_ROWS = 5_000;
const MAX_BYTES = 32 * 1024 * 1024;
const ALLOWED_ROOT_KEYS = new Set([
  'version',
  'exported_at',
  'group_id',
  'entities',
  'episodes',
  'edges',
]);
const ordinaryAttributes = z
  .object({
    synthetic_fixture: z
      .object({
        kind: z.enum(['entity', 'episode', 'edge']),
        row: z.number().int().nonnegative(),
        payload: z.string(),
      })
      .strict(),
  })
  .strict();

function invalid(): never {
  throw new Error('Unsupported ordinary Neo4j fixture');
}

/** Test DATA only: never a source/claim/operation/binding/queue/format import path. */
function validateOrdinaryFixture(value: unknown): GraphData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  if (Object.keys(value).some((key) => !ALLOWED_ROOT_KEYS.has(key))) return invalid();
  const raw = value as Record<string, unknown>;
  z.array(EntityNodeSchema.strict()).parse(raw.entities);
  z.array(EntityEdgeSchema.strict()).parse(raw.edges);
  z.array(EpisodicNodeSchema.strict()).parse(raw.episodes);
  const graph = GraphDataSchema.parse(value);
  const all = [...graph.entities, ...graph.episodes, ...graph.edges];
  if (
    !graph.group_id ||
    all.length > MAX_ROWS ||
    Buffer.byteLength(JSON.stringify(graph)) > MAX_BYTES
  )
    return invalid();
  const ids = new Set<string>();
  for (const row of all) {
    if (row.group_id !== graph.group_id || ids.has(row.uuid)) return invalid();
    ids.add(row.uuid);
    // Allowlisting the builder's entire attribute shape rejects every reserved current/future key,
    // including nested metadata, rather than maintaining a partial reserved-key denylist.
    ordinaryAttributes.parse(row.attributes);
  }
  if (
    graph.entities.some(
      (row) => !['person', 'organization', 'location', 'concept'].includes(row.entity_type),
    )
  )
    return invalid();
  if (graph.edges.some((row) => !['RELATED_TO', 'MENTIONS', 'LOCATED_IN'].includes(row.name)))
    return invalid();
  if (
    graph.episodes.some(
      (row) =>
        row.source_type !== 'message' ||
        row.trust_level !== 'unverified' ||
        row.review_status !== 'proposed' ||
        (row.role === 'human'
          ? row.episode_kind !== 'active_human'
          : row.role !== 'ai' || row.episode_kind !== 'assistant_reply'),
    )
  )
    return invalid();
  const entities = new Set(graph.entities.map((row) => row.uuid));
  const episodes = new Map(graph.episodes.map((row) => [row.uuid, row]));
  for (const edge of graph.edges) {
    if (
      !entities.has(edge.source_node_uuid) ||
      !entities.has(edge.target_node_uuid) ||
      edge.episodes.some((id) => !episodes.has(id))
    )
      return invalid();
  }
  for (const episode of graph.episodes) {
    if (episode.previous_episode_uuid) {
      const previous = episodes.get(episode.previous_episode_uuid);
      if (
        !previous ||
        previous.conversation_id !== episode.conversation_id ||
        Date.parse(previous.created_at) >= Date.parse(episode.created_at)
      )
        return invalid();
    }
  }
  return graph;
}

function count(result: QueryResult, key: string): number {
  const value: unknown = result.records[0]?.get(key);
  return typeof value === 'number' ? value : (value as { toNumber(): number }).toNumber();
}

/**
 * Load a fresh, dedicated synthetic fixture namespace in one atomic transaction, using bounded
 * UNWIND batches. Qualification owns the database exclusively. This does not call/alter product
 * import guards or write privileged graph/format/epoch/auth metadata.
 */
export async function loadOrdinaryNeo4jFixture(
  driver: Driver,
  database: string,
  value: unknown,
): Promise<void> {
  const graph = validateOrdinaryFixture(value);
  const namespace = graph.group_id!;
  const allIds = [...graph.entities, ...graph.episodes, ...graph.edges].map((row) => row.uuid);
  const session = driver.session({ database });
  try {
    const tx = session.beginTransaction();
    try {
      const collision = await tx.run(
        `CALL {
         MATCH (n) WHERE n.group_id=$namespace OR n.uuid IN $ids
           OR (n:AutomaticOperation AND (n.namespace=$namespace OR n.operation_id IN $ids))
         RETURN count(n) AS nodes
       }
       CALL {
         MATCH ()-[r:RELATES_TO]->() WHERE r.group_id=$namespace OR r.uuid IN $ids
         RETURN count(r) AS edges
       }
       RETURN nodes+edges AS collisions`,
        { namespace, ids: allIds },
      );
      if (count(collision, 'collisions') !== 0)
        throw new Error('Ordinary fixture namespace or UUID already exists');
      const batch = async (rows: Record<string, unknown>[], text: string) => {
        for (let offset = 0; offset < rows.length; offset += BATCH_ROWS) {
          const chunk = rows.slice(offset, offset + BATCH_ROWS);
          const result = await tx.run(text, { rows: chunk });
          if (count(result, 'written') !== chunk.length)
            throw new Error('Incomplete ordinary fixture batch');
        }
      };
      await batch(
        graph.entities.map((row) => ({ ...row, attributes: JSON.stringify(row.attributes) })),
        'UNWIND $rows AS row CREATE (e:Entity) SET e=row RETURN count(e) AS written',
      );
      await batch(
        graph.episodes.map((row) => ({
          ...row,
          attributes: JSON.stringify(row.attributes),
          source_dedup_key: row.source_message_id
            ? JSON.stringify([namespace, row.source_message_id, row.episode_kind])
            : null,
          idempotency_dedup_key: row.idempotency_key
            ? JSON.stringify([namespace, row.idempotency_key])
            : null,
        })),
        'UNWIND $rows AS row CREATE (ep:Episode) SET ep=row RETURN count(ep) AS written',
      );
      await batch(
        graph.edges.map((row) => ({ ...row, attributes: JSON.stringify(row.attributes) })),
        `UNWIND $rows AS row
       MATCH (source:Entity {uuid:row.source_node_uuid}) MATCH (target:Entity {uuid:row.target_node_uuid})
       CREATE (source)-[r:RELATES_TO]->(target) SET r=row RETURN count(r) AS written`,
      );
      await batch(
        graph.episodes
          .filter((row) => row.previous_episode_uuid !== null)
          .map((row) => ({
            previous: row.previous_episode_uuid,
            current: row.uuid,
          })),
        `UNWIND $rows AS row MATCH (previous:Episode {uuid:row.previous}) MATCH (current:Episode {uuid:row.current})
          CREATE (previous)-[r:NEXT_EPISODE]->(current) RETURN count(r) AS written`,
      );
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        /* Preserve the original fixture failure. */
      }
      throw error;
    }
  } finally {
    await session.close();
  }
}
