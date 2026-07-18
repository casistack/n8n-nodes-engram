import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';
import { generateUuid } from '../utils/uuid';
import { nowIso } from '../utils/temporal';
import { cosineSimilarity } from '../embeddings/cosine';
import type {
  IGraphStorage,
  EntitySearchResult,
  EdgeSearchResult,
  ChangelogEntry,
  ListOptions,
  EntitySearchOptions,
  EdgeSearchOptions,
  VectorSearchOptions,
  RetentionPolicy,
  AppendEpisodeResult,
  EpisodeFilterOptions,
  UpdateEpisodeInput,
  DeleteEpisodeOptions,
  DeleteEpisodeResult,
  PurgeEpisodesOptions,
  PurgeEpisodesResult,
  StorageMigrationStatus,
  StorageSchemaMigrationOptions,
  StorageSchemaMigrationResult,
} from './IGraphStorage';
import type {
  EntityNode,
  CreateEntityNode,
  EntityEdge,
  CreateEntityEdge,
  EpisodicNode,
  CreateEpisodicNode,
  GraphData,
  ImportGraphData,
  GraphStats,
} from '../schemas';
import {
  CURRENT_GRAPH_DATA_VERSION,
  CreateEpisodicNodeSchema,
  EpisodicNodeSchema,
  migrateGraphData,
} from '../schemas';

export class Neo4jStorage implements IGraphStorage {
  private driver: Driver;
  private database: string;
  private initialized = false;
  private vectorIndexCreated = false;

  constructor(uri: string, username: string, password: string, database?: string) {
    // Force IPv4 — Neo4j listens on 127.0.0.1 but Node.js 17+ resolves localhost to IPv6 ::1
    const resolvedUri = uri.replace('://localhost:', '://127.0.0.1:');
    this.driver = neo4j.driver(resolvedUri, neo4j.auth.basic(username, password));
    this.database = database ?? 'neo4j';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Verify connectivity
    await this.driver.verifyConnectivity();

    // Create indexes and constraints
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        // Entity indexes
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.uuid)');
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.group_id)');
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.name)');

        // Episode indexes
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (ep:Episode) ON (ep.uuid)');
        await tx.run('CREATE INDEX IF NOT EXISTS FOR (ep:Episode) ON (ep.group_id)');
        await tx.run(
          'CREATE CONSTRAINT episode_source_dedup IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.source_dedup_key IS UNIQUE',
        );
        await tx.run(
          'CREATE CONSTRAINT episode_idempotency_dedup IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.idempotency_dedup_key IS UNIQUE',
        );
        await tx.run(
          'CREATE CONSTRAINT episode_group_lock IF NOT EXISTS FOR (lock:EpisodeGroupLock) REQUIRE lock.group_id IS UNIQUE',
        );

        // Full-text search indexes
        await tx.run(
          'CREATE FULLTEXT INDEX entitySearch IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.summary, e.entity_type]',
        );
        await tx.run(
          'CREATE FULLTEXT INDEX edgeSearch IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON EACH [r.name, r.fact]',
        );
      });
    } finally {
      await session.close();
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private getSession(): Session {
    return this.driver.session({ database: this.database });
  }

  private sourceDedupKey(input: {
    group_id: string;
    source_message_id?: string | null;
    episode_kind?: string;
  }): string | null {
    if (!input.source_message_id || !input.episode_kind) return null;
    return JSON.stringify([input.group_id, input.source_message_id, input.episode_kind]);
  }

  private idempotencyDedupKey(input: {
    group_id: string;
    idempotency_key?: string | null;
  }): string | null {
    if (!input.idempotency_key) return null;
    return JSON.stringify([input.group_id, input.idempotency_key]);
  }

  private buildEpisodeFilter(
    alias: string,
    groupId: string,
    options: EpisodeFilterOptions,
  ): { where: string; params: Record<string, unknown> } {
    const clauses = [`${alias}.group_id = $filter_group_id`];
    const params: Record<string, unknown> = { filter_group_id: groupId };
    const equalityFilters: Array<[keyof EpisodeFilterOptions, string]> = [
      ['role', 'role'],
      ['source_type', 'source_type'],
      ['episode_kind', 'episode_kind'],
      ['trust_level', 'trust_level'],
      ['review_status', 'review_status'],
      ['sender_id', 'sender_id'],
      ['conversation_id', 'conversation_id'],
      ['source_message_id', 'source_message_id'],
      ['source_workflow_id', 'source_workflow_id'],
      ['source_execution_id', 'source_execution_id'],
    ];
    for (const [optionKey, property] of equalityFilters) {
      const value = options[optionKey];
      if (typeof value !== 'string' || value === '') continue;
      clauses.push(`${alias}.${property} = $filter_${property}`);
      params[`filter_${property}`] = value;
    }
    if (options.sender_name) {
      clauses.push(`toLower(${alias}.sender_name) = toLower($filter_sender_name)`);
      params.filter_sender_name = options.sender_name;
    }
    const dateFilters: Array<[keyof EpisodeFilterOptions, string, '>=' | '<=']> = [
      ['reference_after', 'reference_time', '>='],
      ['reference_before', 'reference_time', '<='],
      ['created_after', 'created_at', '>='],
      ['created_before', 'created_at', '<='],
    ];
    for (const [optionKey, property, operator] of dateFilters) {
      const value = options[optionKey];
      if (typeof value !== 'string' || value === '') continue;
      clauses.push(`${alias}.${property} ${operator} $filter_${optionKey}`);
      params[`filter_${optionKey}`] = value;
    }
    if (options.hygiene_rule === 'empty_assistant_output') {
      clauses.push(`${alias}.role = 'ai' AND ${alias}.content =~ '^\\s*(?:\\[\\s*\\])?\\s*$'`);
    }
    const contentContains = options.content_contains?.trim();
    if (contentContains) {
      clauses.push(`toLower(${alias}.content) CONTAINS toLower($filter_content_contains)`);
      params.filter_content_contains = contentContains;
    }
    return { where: clauses.join(' AND '), params };
  }

  private buildEpisodeListQuery(
    groupId: string,
    options: EpisodeFilterOptions,
  ): { query: string; params: Record<string, unknown> } {
    const { where, params } = this.buildEpisodeFilter('ep', groupId, options);
    const sortBy = options.sort_by === 'reference_time' ? 'reference_time' : 'created_at';
    const sortOrder = options.sort_order === 'asc' ? 'ASC' : 'DESC';
    let query = `MATCH (ep:Episode) WHERE ${where}
      RETURN ep
      ORDER BY ep.${sortBy} ${sortOrder}, coalesce(ep.append_sequence, 0) ${sortOrder}, ep.uuid ${sortOrder}`;
    if (options.offset !== undefined) {
      query += ' SKIP $offset';
      params.offset = neo4j.int(Math.max(0, options.offset));
    }
    if (options.limit !== undefined) {
      query += ' LIMIT $limit';
      params.limit = neo4j.int(Math.max(0, options.limit));
    }
    return { query, params };
  }

  private async lockEpisodeGroup(tx: ManagedTransaction, groupId: string): Promise<void> {
    await tx.run(
      `MERGE (lock:EpisodeGroupLock {group_id: $group_id})
       SET lock.sequence = coalesce(lock.sequence, 0) + 1,
           lock.updated_at = $updated_at`,
      { group_id: groupId, updated_at: nowIso() },
    );
  }

  private async countEdgesLinkedToEpisodes(episodeUuids: string[]): Promise<number> {
    if (episodeUuids.length === 0) return 0;
    const session = this.getSession();
    try {
      return await session.executeRead((tx) =>
        this.countEdgesLinkedToEpisodesInTransaction(tx, episodeUuids),
      );
    } finally {
      await session.close();
    }
  }

  private async countEdgesLinkedToEpisodesInTransaction(
    tx: ManagedTransaction,
    episodeUuids: string[],
  ): Promise<number> {
    if (episodeUuids.length === 0) return 0;
    const result = await tx.run(
      `MATCH ()-[r:RELATES_TO]->()
       WHERE any(episodeUuid IN $episode_uuids WHERE episodeUuid IN r.episodes)
       RETURN count(r) AS count`,
      { episode_uuids: episodeUuids },
    );
    return result.records[0]?.get('count').toNumber() ?? 0;
  }

  private async deleteEpisodeInTransaction(
    tx: ManagedTransaction,
    uuid: string,
    options: DeleteEpisodeOptions,
    groupAlreadyLocked = false,
  ): Promise<DeleteEpisodeResult> {
    const existingResult = await tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
    if (existingResult.records.length === 0) {
      return {
        episode_uuid: uuid,
        deleted: false,
        repaired_successor_count: 0,
        linked_edge_count: 0,
        updated_edge_count: 0,
        deleted_edge_count: 0,
      };
    }
    const episode = this.recordToEpisode(existingResult.records[0].get('ep').properties);
    if (!groupAlreadyLocked) await this.lockEpisodeGroup(tx, episode.group_id);

    const linkedResult = await tx.run(
      'MATCH ()-[r:RELATES_TO]->() WHERE $uuid IN r.episodes RETURN r',
      { uuid },
    );
    const cleanup = options.fact_cleanup ?? 'unlink';
    let updatedEdgeCount = 0;
    let deletedEdgeCount = 0;
    if (cleanup !== 'preserve') {
      for (const record of linkedResult.records) {
        const edge = this.recordToEdge(record.get('r').properties);
        const remainingEpisodes = edge.episodes.filter((episodeUuid) => episodeUuid !== uuid);
        if (cleanup === 'delete_orphaned' && remainingEpisodes.length === 0) {
          await tx.run('MATCH ()-[r:RELATES_TO {uuid: $edge_uuid}]->() DELETE r', {
            edge_uuid: edge.uuid,
          });
          deletedEdgeCount++;
        } else {
          await tx.run(
            `MATCH ()-[r:RELATES_TO {uuid: $edge_uuid}]->()
             SET r.episodes = $episodes, r.updated_at = $updated_at`,
            { edge_uuid: edge.uuid, episodes: remainingEpisodes, updated_at: nowIso() },
          );
          updatedEdgeCount++;
        }
      }
    }

    const successorResult = await tx.run(
      `MATCH (successor:Episode {group_id: $group_id})
       WHERE successor.previous_episode_uuid = $uuid
       RETURN successor.uuid AS uuid`,
      { group_id: episode.group_id, uuid },
    );
    const successorUuids = successorResult.records.map((record) => record.get('uuid') as string);
    const repairChain = options.repair_chain ?? true;
    if (repairChain) {
      for (const successorUuid of successorUuids) {
        await tx.run(
          `MATCH (successor:Episode {uuid: $successor_uuid})
           SET successor.previous_episode_uuid = $previous_uuid,
               successor.updated_at = $updated_at`,
          {
            successor_uuid: successorUuid,
            previous_uuid: episode.previous_episode_uuid,
            updated_at: nowIso(),
          },
        );
      }
    }

    await tx.run('MATCH (ep:Episode {uuid: $uuid}) DETACH DELETE ep', { uuid });
    if (repairChain && episode.previous_episode_uuid) {
      for (const successorUuid of successorUuids) {
        await tx.run(
          `MATCH (previous:Episode {uuid: $previous_uuid})
           MATCH (successor:Episode {uuid: $successor_uuid})
           MERGE (previous)-[:NEXT_EPISODE]->(successor)`,
          { previous_uuid: episode.previous_episode_uuid, successor_uuid: successorUuid },
        );
      }
    }

    return {
      episode_uuid: uuid,
      deleted: true,
      repaired_successor_count: repairChain ? successorUuids.length : 0,
      linked_edge_count: linkedResult.records.length,
      updated_edge_count: updatedEdgeCount,
      deleted_edge_count: deletedEdgeCount,
    };
  }

  // ===== Entity Operations =====

  async addEntity(input: CreateEntityNode): Promise<EntityNode> {
    const now = nowIso();
    const entity: EntityNode = {
      uuid: generateUuid(),
      name: input.name,
      group_id: input.group_id,
      summary: input.summary ?? '',
      entity_type: input.entity_type ?? 'unknown',
      name_embedding: input.name_embedding ?? null,
      attributes: input.attributes ?? {},
      created_at: now,
      updated_at: now,
    };

    // Lazily create vector index when first embedding is stored
    if (entity.name_embedding && entity.name_embedding.length > 0) {
      await this.ensureVectorIndex(entity.name_embedding.length);
    }

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `CREATE (e:Entity {
						uuid: $uuid,
						name: $name,
						group_id: $group_id,
						summary: $summary,
						entity_type: $entity_type,
						name_embedding: $name_embedding,
						attributes: $attributes,
						created_at: $created_at,
						updated_at: $updated_at
					})`,
          {
            ...entity,
            attributes: JSON.stringify(entity.attributes),
            name_embedding: entity.name_embedding,
          },
        );
      });
    } finally {
      await session.close();
    }

    return entity;
  }

  async getEntity(uuid: string): Promise<EntityNode | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run('MATCH (e:Entity {uuid: $uuid}) RETURN e', { uuid });
      });

      if (result.records.length === 0) return null;
      return this.recordToEntity(result.records[0].get('e').properties);
    } finally {
      await session.close();
    }
  }

  async getEntityByName(name: string, groupId: string): Promise<EntityNode | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          'MATCH (e:Entity {group_id: $groupId}) WHERE toLower(e.name) = toLower($name) RETURN e LIMIT 1',
          { name, groupId },
        );
      });

      if (result.records.length === 0) return null;
      return this.recordToEntity(result.records[0].get('e').properties);
    } finally {
      await session.close();
    }
  }

  async updateEntity(uuid: string, updates: Partial<EntityNode>): Promise<EntityNode> {
    const session = this.getSession();
    try {
      const setClauses: string[] = ['e.updated_at = $updated_at'];
      const params: Record<string, unknown> = {
        uuid,
        updated_at: nowIso(),
      };

      if (updates.name !== undefined) {
        setClauses.push('e.name = $name');
        params.name = updates.name;
      }
      if (updates.summary !== undefined) {
        setClauses.push('e.summary = $summary');
        params.summary = updates.summary;
      }
      if (updates.entity_type !== undefined) {
        setClauses.push('e.entity_type = $entity_type');
        params.entity_type = updates.entity_type;
      }
      if (updates.attributes !== undefined) {
        setClauses.push('e.attributes = $attributes');
        params.attributes = JSON.stringify(updates.attributes);
      }
      if (updates.name_embedding !== undefined) {
        setClauses.push('e.name_embedding = $name_embedding');
        params.name_embedding = updates.name_embedding;
        // Lazily create vector index when first embedding is stored
        if (updates.name_embedding && updates.name_embedding.length > 0) {
          await this.ensureVectorIndex(updates.name_embedding.length);
        }
      }

      const result = await session.executeWrite(async (tx) => {
        return tx.run(
          `MATCH (e:Entity {uuid: $uuid}) SET ${setClauses.join(', ')} RETURN e`,
          params,
        );
      });

      if (result.records.length === 0) {
        throw new Error(`Entity not found: ${uuid}`);
      }

      return this.recordToEntity(result.records[0].get('e').properties);
    } finally {
      await session.close();
    }
  }

  async deleteEntity(uuid: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run('MATCH (e:Entity {uuid: $uuid}) DETACH DELETE e', { uuid });
      });
    } finally {
      await session.close();
    }
  }

  async listEntities(groupId: string, options?: ListOptions): Promise<EntityNode[]> {
    const session = this.getSession();
    try {
      let query = 'MATCH (e:Entity {group_id: $groupId})';
      const params: Record<string, unknown> = { groupId };
      const whereClauses: string[] = [];

      if (options?.entity_type) {
        whereClauses.push('e.entity_type = $entity_type');
        params.entity_type = options.entity_type;
      }
      if (options?.created_after) {
        whereClauses.push('e.created_at >= $created_after');
        params.created_after = options.created_after;
      }
      if (options?.created_before) {
        whereClauses.push('e.created_at <= $created_before');
        params.created_before = options.created_before;
      }
      if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
      }

      query += ' RETURN e ORDER BY e.created_at DESC';

      if (options?.offset) {
        query += ' SKIP $offset';
        params.offset = neo4j.int(options.offset);
      }
      if (options?.limit) {
        query += ' LIMIT $limit';
        params.limit = neo4j.int(options.limit);
      }

      const result = await session.executeRead(async (tx) => {
        return tx.run(query, params);
      });

      return result.records.map((r) => this.recordToEntity(r.get('e').properties));
    } finally {
      await session.close();
    }
  }

  // ===== Edge Operations =====

  async addEdge(input: CreateEntityEdge): Promise<EntityEdge> {
    const now = nowIso();
    const edge: EntityEdge = {
      uuid: generateUuid(),
      group_id: input.group_id,
      source_node_uuid: input.source_node_uuid,
      target_node_uuid: input.target_node_uuid,
      name: input.name,
      fact: input.fact,
      fact_embedding: input.fact_embedding ?? null,
      episodes: input.episodes ?? [],
      valid_at: input.valid_at ?? null,
      invalid_at: input.invalid_at ?? null,
      expired_at: input.expired_at ?? null,
      attributes: input.attributes ?? {},
      created_at: now,
      updated_at: now,
    };

    // Lazily create vector index when first embedding is stored
    if (edge.fact_embedding && edge.fact_embedding.length > 0) {
      await this.ensureVectorIndex(edge.fact_embedding.length);
    }

    const session = this.getSession();
    try {
      const result = await session.executeWrite(async (tx) => {
        return tx.run(
          `MATCH (source:Entity {uuid: $source_node_uuid})
					 MATCH (target:Entity {uuid: $target_node_uuid})
					 CREATE (source)-[r:RELATES_TO {
						uuid: $uuid,
						group_id: $group_id,
						source_node_uuid: $source_node_uuid,
						target_node_uuid: $target_node_uuid,
						name: $name,
						fact: $fact,
						fact_embedding: $fact_embedding,
						episodes: $episodes,
						valid_at: $valid_at,
						invalid_at: $invalid_at,
						expired_at: $expired_at,
						attributes: $attributes,
						created_at: $created_at,
						updated_at: $updated_at
					 }]->(target)
					 RETURN r`,
          {
            ...edge,
            attributes: JSON.stringify(edge.attributes),
          },
        );
      });

      if (result.records.length === 0) {
        throw new Error(
          `Cannot create edge: source entity (${input.source_node_uuid}) or target entity (${input.target_node_uuid}) not found`,
        );
      }
    } finally {
      await session.close();
    }

    return edge;
  }

  async getEdge(uuid: string): Promise<EntityEdge | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() RETURN r', { uuid });
      });

      if (result.records.length === 0) return null;
      return this.recordToEdge(result.records[0].get('r').properties);
    } finally {
      await session.close();
    }
  }

  async getEdgesBetween(sourceUuid: string, targetUuid: string): Promise<EntityEdge[]> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (s:Entity {uuid: $sourceUuid})-[r:RELATES_TO]->(t:Entity {uuid: $targetUuid})
					 RETURN r
					 UNION
					 MATCH (s:Entity {uuid: $targetUuid})-[r:RELATES_TO]->(t:Entity {uuid: $sourceUuid})
					 RETURN r`,
          { sourceUuid, targetUuid },
        );
      });

      return result.records.map((rec) => this.recordToEdge(rec.get('r').properties));
    } finally {
      await session.close();
    }
  }

  async getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (e:Entity {uuid: $entityUuid})-[r:RELATES_TO]->()
					 RETURN r
					 UNION
					 MATCH (e:Entity {uuid: $entityUuid})<-[r:RELATES_TO]-()
					 RETURN r`,
          { entityUuid },
        );
      });

      return result.records.map((rec) => this.recordToEdge(rec.get('r').properties));
    } finally {
      await session.close();
    }
  }

  async updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge> {
    const session = this.getSession();
    try {
      const setClauses: string[] = ['r.updated_at = $updated_at'];
      const params: Record<string, unknown> = {
        uuid,
        updated_at: nowIso(),
      };

      if (updates.name !== undefined) {
        setClauses.push('r.name = $name');
        params.name = updates.name;
      }
      if (updates.fact !== undefined) {
        setClauses.push('r.fact = $fact');
        params.fact = updates.fact;
      }
      if (updates.valid_at !== undefined) {
        setClauses.push('r.valid_at = $valid_at');
        params.valid_at = updates.valid_at;
      }
      if (updates.invalid_at !== undefined) {
        setClauses.push('r.invalid_at = $invalid_at');
        params.invalid_at = updates.invalid_at;
      }
      if (updates.expired_at !== undefined) {
        setClauses.push('r.expired_at = $expired_at');
        params.expired_at = updates.expired_at;
      }
      if (updates.episodes !== undefined) {
        setClauses.push('r.episodes = $episodes');
        params.episodes = updates.episodes;
      }
      if (updates.attributes !== undefined) {
        setClauses.push('r.attributes = $attributes');
        params.attributes = JSON.stringify(updates.attributes);
      }
      if (updates.fact_embedding !== undefined) {
        setClauses.push('r.fact_embedding = $fact_embedding');
        params.fact_embedding = updates.fact_embedding;
        if (updates.fact_embedding && updates.fact_embedding.length > 0) {
          await this.ensureVectorIndex(updates.fact_embedding.length);
        }
      }

      const result = await session.executeWrite(async (tx) => {
        return tx.run(
          `MATCH ()-[r:RELATES_TO {uuid: $uuid}]->()
					 SET ${setClauses.join(', ')}
					 RETURN r`,
          params,
        );
      });

      if (result.records.length === 0) {
        throw new Error(`Edge not found: ${uuid}`);
      }

      return this.recordToEdge(result.records[0].get('r').properties);
    } finally {
      await session.close();
    }
  }

  async deleteEdge(uuid: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run('MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() DELETE r', { uuid });
      });
    } finally {
      await session.close();
    }
  }

  // ===== Episode Operations =====

  async addEpisode(input: CreateEpisodicNode): Promise<EpisodicNode> {
    const result = await this.appendEpisodeWithOptions(input, false);
    return result.episode;
  }

  async appendEpisode(input: CreateEpisodicNode): Promise<AppendEpisodeResult> {
    return this.appendEpisodeWithOptions(input, true);
  }

  async appendEpisodes(inputs: CreateEpisodicNode[]): Promise<AppendEpisodeResult[]> {
    return this.appendEpisodesWithOptions(inputs, true);
  }

  private async appendEpisodeWithOptions(
    input: CreateEpisodicNode,
    autoChain: boolean,
  ): Promise<AppendEpisodeResult> {
    return (await this.appendEpisodesWithOptions([input], autoChain))[0];
  }

  private async appendEpisodesWithOptions(
    inputs: CreateEpisodicNode[],
    autoChain: boolean,
  ): Promise<AppendEpisodeResult[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > 1000) throw new Error('Episode append batch cannot exceed 1000 episodes');

    const groupId = inputs[0].group_id;
    if (inputs.some((input) => input.group_id !== groupId)) {
      throw new Error('Episode append batch must contain exactly one group ID');
    }

    const prepared = inputs.map((input) => ({
      shouldAutoChain:
        autoChain && !Object.prototype.hasOwnProperty.call(input, 'previous_episode_uuid'),
      parsed: CreateEpisodicNodeSchema.parse(input),
    }));

    const session = this.getSession();
    try {
      return await session.executeWrite(async (tx) => {
        const lockResult = await tx.run(
          `MERGE (lock:EpisodeGroupLock {group_id: $group_id})
           SET lock.sequence = coalesce(lock.sequence, 0) + $batch_size,
               lock.updated_at = $updated_at
           RETURN lock.sequence AS sequence`,
          {
            group_id: groupId,
            batch_size: neo4j.int(prepared.length),
            updated_at: nowIso(),
          },
        );
        const sequenceValue = lockResult.records[0]?.get('sequence');
        const finalSequence = neo4j.isInt(sequenceValue)
          ? sequenceValue.toNumber()
          : Number(sequenceValue ?? prepared.length);
        const firstSequence = finalSequence - prepared.length + 1;
        const results: AppendEpisodeResult[] = [];

        for (const [index, item] of prepared.entries()) {
          results.push(
            await this.appendEpisodeInTransaction(
              tx,
              item.parsed,
              item.shouldAutoChain,
              firstSequence + index,
            ),
          );
        }
        return results;
      });
    } finally {
      await session.close();
    }
  }

  private async appendEpisodeInTransaction(
    tx: ManagedTransaction,
    parsed: ReturnType<typeof CreateEpisodicNodeSchema.parse>,
    shouldAutoChain: boolean,
    appendSequence: number,
  ): Promise<AppendEpisodeResult> {
    const sourceDedupKey = this.sourceDedupKey(parsed);
    const idempotencyDedupKey = this.idempotencyDedupKey(parsed);

    if (sourceDedupKey || idempotencyDedupKey) {
      const existingResult = await tx.run(
        `MATCH (ep:Episode)
         WHERE ($source_dedup_key IS NOT NULL AND ep.source_dedup_key = $source_dedup_key)
            OR ($idempotency_dedup_key IS NOT NULL AND ep.idempotency_dedup_key = $idempotency_dedup_key)
         RETURN ep`,
        {
          source_dedup_key: sourceDedupKey,
          idempotency_dedup_key: idempotencyDedupKey,
        },
      );
      const existingEpisodes = new Map<string, EpisodicNode>();
      for (const record of existingResult.records) {
        const existing = this.recordToEpisode(record.get('ep').properties);
        existingEpisodes.set(existing.uuid, existing);
      }
      if (existingEpisodes.size > 1) {
        throw new Error('Episode idempotency identifiers resolve to different existing episodes');
      }
      const existing = existingEpisodes.values().next().value as EpisodicNode | undefined;
      if (existing) return { episode: existing, created: false };
    }

    let previousEpisodeUuid = parsed.previous_episode_uuid;
    if (shouldAutoChain) {
      const previousResult = await tx.run(
        `MATCH (ep:Episode {group_id: $group_id})
         RETURN ep.uuid AS uuid
         ORDER BY coalesce(ep.append_sequence, 0) DESC, ep.created_at DESC, ep.uuid DESC
         LIMIT 1`,
        { group_id: parsed.group_id },
      );
      previousEpisodeUuid = (previousResult.records[0]?.get('uuid') as string | undefined) ?? null;
    }

    const createdAt = nowIso();
    const episode: EpisodicNode = {
      uuid: generateUuid(),
      ...parsed,
      previous_episode_uuid: previousEpisodeUuid,
      created_at: createdAt,
      updated_at: createdAt,
    };

    await tx.run(
      `CREATE (ep:Episode {
							uuid: $uuid,
						group_id: $group_id,
						content: $content,
						role: $role,
						source_type: $source_type,
						reference_time: $reference_time,
						previous_episode_uuid: $previous_episode_uuid,
						created_at: $created_at,
						updated_at: $updated_at,
						source_message_id: $source_message_id,
						idempotency_key: $idempotency_key,
						conversation_id: $conversation_id,
						sender_id: $sender_id,
						sender_name: $sender_name,
						episode_kind: $episode_kind,
						quoted_message_id: $quoted_message_id,
						trust_level: $trust_level,
						confidence: $confidence,
						review_status: $review_status,
						source_workflow_id: $source_workflow_id,
						source_execution_id: $source_execution_id,
						attributes: $attributes,
						append_sequence: $append_sequence,
						source_dedup_key: $source_dedup_key,
						idempotency_dedup_key: $idempotency_dedup_key
						})`,
      {
        ...episode,
        attributes: JSON.stringify(episode.attributes),
        append_sequence: appendSequence,
        source_dedup_key: sourceDedupKey,
        idempotency_dedup_key: idempotencyDedupKey,
      },
    );

    if (episode.previous_episode_uuid) {
      await tx.run(
        `MATCH (prev:Episode {uuid: $prevUuid})
							 MATCH (curr:Episode {uuid: $currUuid})
							 CREATE (prev)-[:NEXT_EPISODE]->(curr)`,
        {
          prevUuid: episode.previous_episode_uuid,
          currUuid: episode.uuid,
        },
      );
    }

    return { episode, created: true };
  }

  async getEpisode(uuid: string): Promise<EpisodicNode | null> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
      });

      if (result.records.length === 0) return null;
      return this.recordToEpisode(result.records[0].get('ep').properties);
    } finally {
      await session.close();
    }
  }

  async getEpisodes(uuids: string[]): Promise<EpisodicNode[]> {
    const uniqueUuids = [...new Set(uuids)];
    if (uniqueUuids.length === 0) return [];
    const session = this.getSession();
    try {
      const result = await session.executeRead((tx) =>
        tx.run('MATCH (ep:Episode) WHERE ep.uuid IN $uuids RETURN ep', { uuids: uniqueUuids }),
      );
      return result.records.map((record) => this.recordToEpisode(record.get('ep').properties));
    } finally {
      await session.close();
    }
  }

  async listEpisodes(groupId: string, options: EpisodeFilterOptions = {}): Promise<EpisodicNode[]> {
    const { query, params } = this.buildEpisodeListQuery(groupId, options);

    const session = this.getSession();
    try {
      const result = await session.executeRead((tx) => tx.run(query, params));
      return result.records.map((record) => this.recordToEpisode(record.get('ep').properties));
    } finally {
      await session.close();
    }
  }

  async updateEpisode(uuid: string, updates: UpdateEpisodeInput): Promise<EpisodicNode> {
    const session = this.getSession();
    try {
      return await session.executeWrite(async (tx) => {
        const existingResult = await tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
        if (existingResult.records.length === 0) throw new Error(`Episode not found: ${uuid}`);
        const existing = this.recordToEpisode(existingResult.records[0].get('ep').properties);
        await this.lockEpisodeGroup(tx, existing.group_id);

        const updated = EpisodicNodeSchema.parse({
          ...existing,
          ...updates,
          uuid: existing.uuid,
          group_id: existing.group_id,
          source_message_id: existing.source_message_id,
          idempotency_key: existing.idempotency_key,
          episode_kind: existing.episode_kind,
          previous_episode_uuid: existing.previous_episode_uuid,
          created_at: existing.created_at,
          updated_at: nowIso(),
        });
        const result = await tx.run(
          `MATCH (ep:Episode {uuid: $uuid})
           SET ep.content = $content,
               ep.sender_name = $sender_name,
               ep.trust_level = $trust_level,
               ep.confidence = $confidence,
               ep.review_status = $review_status,
               ep.attributes = $attributes,
               ep.updated_at = $updated_at
           RETURN ep`,
          { ...updated, attributes: JSON.stringify(updated.attributes) },
        );
        return this.recordToEpisode(result.records[0].get('ep').properties);
      });
    } finally {
      await session.close();
    }
  }

  async deleteEpisode(
    uuid: string,
    options: DeleteEpisodeOptions = {},
  ): Promise<DeleteEpisodeResult> {
    const session = this.getSession();
    try {
      return await session.executeWrite((tx) => this.deleteEpisodeInTransaction(tx, uuid, options));
    } finally {
      await session.close();
    }
  }

  async purgeEpisodes(
    groupId: string,
    filters: EpisodeFilterOptions,
    options: PurgeEpisodesOptions,
  ): Promise<PurgeEpisodesResult> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
      throw new Error('Episode purge limit must be an integer between 1 and 10000');
    }

    const selectionOptions: EpisodeFilterOptions = {
      ...filters,
      offset: 0,
      limit: options.limit + 1,
    };
    if (options.dry_run) {
      const selected = await this.listEpisodes(groupId, selectionOptions);
      const truncated = selected.length > options.limit;
      const episodes = selected.slice(0, options.limit);
      const episodeUuids = episodes.map((episode) => episode.uuid);
      const linkedEdgeCount = await this.countEdgesLinkedToEpisodes(episodeUuids);
      return {
        matched_count: episodes.length,
        deleted_count: 0,
        truncated,
        dry_run: true,
        linked_edge_count: linkedEdgeCount,
        updated_edge_count: 0,
        deleted_edge_count: 0,
        episode_uuids: episodeUuids,
      };
    }

    const session = this.getSession();
    try {
      return await session.executeWrite(async (tx) => {
        await this.lockEpisodeGroup(tx, groupId);
        const { query, params } = this.buildEpisodeListQuery(groupId, selectionOptions);
        const selectedResult = await tx.run(query, params);
        const selected = selectedResult.records.map((record) =>
          this.recordToEpisode(record.get('ep').properties),
        );
        const truncated = selected.length > options.limit;
        const episodes = selected.slice(0, options.limit);
        const episodeUuids = episodes.map((episode) => episode.uuid);
        const linkedEdgeCount = await this.countEdgesLinkedToEpisodesInTransaction(
          tx,
          episodeUuids,
        );
        const results: DeleteEpisodeResult[] = [];
        for (const uuid of episodeUuids) {
          results.push(await this.deleteEpisodeInTransaction(tx, uuid, options, true));
        }
        return {
          matched_count: episodes.length,
          deleted_count: results.filter((result) => result.deleted).length,
          truncated,
          dry_run: false,
          linked_edge_count: linkedEdgeCount,
          updated_edge_count: results.reduce(
            (total, result) => total + result.updated_edge_count,
            0,
          ),
          deleted_edge_count: results.reduce(
            (total, result) => total + result.deleted_edge_count,
            0,
          ),
          episode_uuids: episodeUuids,
        };
      });
    } finally {
      await session.close();
    }
  }

  async getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (ep:Episode {group_id: $groupId})
					 RETURN ep
					 ORDER BY coalesce(ep.append_sequence, 0) DESC, ep.created_at DESC, ep.uuid DESC
					 LIMIT $limit`,
          { groupId, limit: neo4j.int(limit) },
        );
      });

      const episodes = result.records.map((r) => this.recordToEpisode(r.get('ep').properties));

      // Return in chronological order (oldest first)
      return episodes.reverse();
    } finally {
      await session.close();
    }
  }

  async getEpisodeCount(groupId: string, filters: EpisodeFilterOptions = {}): Promise<number> {
    const { where, params } = this.buildEpisodeFilter('ep', groupId, filters);
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(`MATCH (ep:Episode) WHERE ${where} RETURN count(ep) as cnt`, params);
      });

      return result.records[0]?.get('cnt').toNumber() ?? 0;
    } finally {
      await session.close();
    }
  }

  async getEpisodesByDateRange(
    groupId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<EpisodicNode[]> {
    const session = this.getSession();
    try {
      let cypher = `MATCH (ep:Episode {group_id: $groupId})
				WHERE ep.reference_time >= $from AND ep.reference_time <= $to
				RETURN ep
				ORDER BY ep.reference_time ASC`;

      const params: Record<string, unknown> = { groupId, from, to };

      if (limit) {
        cypher += ' LIMIT $limit';
        params.limit = neo4j.int(limit);
      }

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, params);
      });

      return result.records.map((r) => this.recordToEpisode(r.get('ep').properties));
    } finally {
      await session.close();
    }
  }

  // ===== Changelog =====

  async getEdgeChangelog(
    groupId: string,
    since: string,
    options?: { limit?: number },
  ): Promise<ChangelogEntry[]> {
    const session = this.getSession();
    try {
      const cypher = `MATCH (source:Entity)-[r:RELATES_TO]->(target:Entity)
				WHERE r.group_id = $groupId AND (
					r.created_at >= $since
					OR (r.expired_at IS NOT NULL AND r.expired_at >= $since)
					OR (r.invalid_at IS NOT NULL AND r.invalid_at >= $since)
				)
				RETURN r, source, target
				ORDER BY r.updated_at DESC`;

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, { groupId, since });
      });

      const entries: ChangelogEntry[] = [];
      const sinceTs = new Date(since).getTime();

      for (const rec of result.records) {
        const edge = this.recordToEdge(rec.get('r').properties);
        const sourceEntity = this.recordToEntity(rec.get('source').properties);
        const targetEntity = this.recordToEntity(rec.get('target').properties);

        if (new Date(edge.created_at).getTime() >= sinceTs) {
          entries.push({
            edge,
            sourceEntity,
            targetEntity,
            change_type: 'created',
            changed_at: edge.created_at,
          });
        }

        if (edge.expired_at && new Date(edge.expired_at).getTime() >= sinceTs) {
          entries.push({
            edge,
            sourceEntity,
            targetEntity,
            change_type: 'expired',
            changed_at: edge.expired_at,
          });
        } else if (
          edge.invalid_at &&
          new Date(edge.invalid_at).getTime() >= sinceTs &&
          !edge.expired_at
        ) {
          entries.push({
            edge,
            sourceEntity,
            targetEntity,
            change_type: 'invalidated',
            changed_at: edge.invalid_at,
          });
        }
      }

      entries.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
      const limit = options?.limit ?? entries.length;
      return entries.slice(0, limit);
    } finally {
      await session.close();
    }
  }

  // ===== Search =====

  /** Escape Lucene special characters so user input doesn't cause parse errors */
  private sanitizeLuceneQuery(query: string): string {
    // Lucene special chars: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
    const sanitized = query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (ch) => `\\${ch}`);
    return sanitized.trim();
  }

  async searchEntities(
    query: string,
    groupId: string,
    options?: EntitySearchOptions,
  ): Promise<EntitySearchResult[]> {
    const safeQuery = this.sanitizeLuceneQuery(query);
    if (!safeQuery) return [];

    const limit = options?.limit ?? 10;
    const session = this.getSession();
    try {
      let cypher = `CALL db.index.fulltext.queryNodes('entitySearch', $query)
				YIELD node, score
				WHERE node.group_id = $groupId`;

      const params: Record<string, unknown> = { query: safeQuery, groupId };

      if (options?.entity_type) {
        cypher += ' AND node.entity_type = $entityType';
        params.entityType = options.entity_type;
      }
      if (options?.created_after) {
        cypher += ' AND node.created_at >= $createdAfter';
        params.createdAfter = options.created_after;
      }
      if (options?.created_before) {
        cypher += ' AND node.created_at <= $createdBefore';
        params.createdBefore = options.created_before;
      }

      cypher += ' RETURN node, score ORDER BY score DESC LIMIT $limit';
      params.limit = neo4j.int(limit);

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, params);
      });

      const maxScore = result.records.length > 0 ? (result.records[0].get('score') as number) : 1;

      return result.records
        .filter((r) => {
          const score = (r.get('score') as number) / (maxScore || 1);
          return score >= (options?.min_score ?? 0);
        })
        .map((r) => ({
          entity: this.recordToEntity(r.get('node').properties),
          score: (r.get('score') as number) / (maxScore || 1),
        }));
    } finally {
      await session.close();
    }
  }

  async searchEdges(
    query: string,
    groupId: string,
    options?: EdgeSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    const safeQuery = this.sanitizeLuceneQuery(query);
    if (!safeQuery) return [];

    const limit = options?.limit ?? 10;
    const includeExpired = options?.include_expired ?? false;
    const session = this.getSession();
    try {
      let cypher = `CALL db.index.fulltext.queryRelationships('edgeSearch', $query)
				YIELD relationship, score
				WHERE relationship.group_id = $groupId`;

      const params: Record<string, unknown> = {
        query: safeQuery,
        groupId,
        limit: neo4j.int(limit),
      };

      if (!includeExpired) {
        cypher += ' AND relationship.expired_at IS NULL';
      }
      if (options?.valid_after) {
        cypher += ' AND relationship.valid_at >= $validAfter';
        params.validAfter = options.valid_after;
      }
      if (options?.valid_before) {
        cypher += ' AND relationship.valid_at <= $validBefore';
        params.validBefore = options.valid_before;
      }
      if (options?.created_after) {
        cypher += ' AND relationship.created_at >= $createdAfter';
        params.createdAfter = options.created_after;
      }
      if (options?.created_before) {
        cypher += ' AND relationship.created_at <= $createdBefore';
        params.createdBefore = options.created_before;
      }

      cypher += ` WITH relationship, score
				ORDER BY score DESC LIMIT $limit
				MATCH (source:Entity {uuid: relationship.source_node_uuid})
				MATCH (target:Entity {uuid: relationship.target_node_uuid})
				RETURN relationship, source, target, score`;

      const result = await session.executeRead(async (tx) => {
        return tx.run(cypher, params);
      });

      const maxScore = result.records.length > 0 ? (result.records[0].get('score') as number) : 1;

      return result.records
        .filter((r) => {
          const score = (r.get('score') as number) / (maxScore || 1);
          return score >= (options?.min_score ?? 0);
        })
        .map((r) => ({
          edge: this.recordToEdge(r.get('relationship').properties),
          sourceEntity: this.recordToEntity(r.get('source').properties),
          targetEntity: this.recordToEntity(r.get('target').properties),
          score: (r.get('score') as number) / (maxScore || 1),
        }));
    } finally {
      await session.close();
    }
  }

  // ===== Vector Search =====

  /**
   * Lazily create Neo4j vector indexes on first embedding insert.
   * Wrapped in try/catch — older Neo4j versions gracefully skip.
   */
  private async ensureVectorIndex(dimensions: number): Promise<void> {
    if (this.vectorIndexCreated) return;

    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        // Entity name embedding vector index (Neo4j 5.11+)
        await tx.run(
          `CREATE VECTOR INDEX entityNameEmbedding IF NOT EXISTS
					 FOR (e:Entity)
					 ON (e.name_embedding)
					 OPTIONS {indexConfig: {
						\`vector.dimensions\`: $dimensions,
						\`vector.similarity_function\`: 'cosine'
					 }}`,
          { dimensions: neo4j.int(dimensions) },
        );
        // Note: Neo4j does not support vector indexes on relationships.
        // Edge fact_embedding uses brute-force cosine similarity in searchEdgesByVector().
      });
      this.vectorIndexCreated = true;
    } catch (error) {
      // Neo4j < 5.11 doesn't support vector indexes — log and continue
      console.warn(
        'Engram: Could not create vector indexes (Neo4j may not support them):',
        (error as Error).message,
      );
    } finally {
      await session.close();
    }
  }

  async searchEntitiesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    // Try native vector index first
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `CALL db.index.vector.queryNodes('entityNameEmbedding', $topK, $vector)
					 YIELD node, score
					 WHERE node.group_id = $groupId AND score >= $minScore
					 RETURN node, score
					 ORDER BY score DESC
					 LIMIT $limit`,
          {
            vector,
            groupId,
            topK: neo4j.int(limit * 2),
            minScore,
            limit: neo4j.int(limit),
          },
        );
      });

      return result.records.map((r) => ({
        entity: this.recordToEntity(r.get('node').properties),
        score: r.get('score') as number,
      }));
    } catch {
      // Vector index doesn't exist — fall back to brute-force
      return this.bruteForceEntityVectorSearch(vector, groupId, options);
    } finally {
      await session.close();
    }
  }

  async searchEdgesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    // Brute-force approach for edges — Neo4j vector indexes on relationships
    // are less reliably supported across versions
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (source:Entity)-[r:RELATES_TO]->(target:Entity)
					 WHERE r.group_id = $groupId
					   AND r.fact_embedding IS NOT NULL
					   AND r.expired_at IS NULL
					 RETURN r, source, target`,
          { groupId },
        );
      });

      const scored: EdgeSearchResult[] = [];
      for (const rec of result.records) {
        const edgeProps = rec.get('r').properties;
        const embedding = edgeProps.fact_embedding as number[] | null;
        if (!embedding || embedding.length !== vector.length) continue;

        try {
          const score = cosineSimilarity(vector, embedding);
          if (score < minScore) continue;

          scored.push({
            edge: this.recordToEdge(edgeProps),
            sourceEntity: this.recordToEntity(rec.get('source').properties),
            targetEntity: this.recordToEntity(rec.get('target').properties),
            score,
          });
        } catch {
          // Skip edges with incompatible embedding dimensions
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } finally {
      await session.close();
    }
  }

  private async bruteForceEntityVectorSearch(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (e:Entity {group_id: $groupId})
					 WHERE e.name_embedding IS NOT NULL
					 RETURN e`,
          { groupId },
        );
      });

      const scored: EntitySearchResult[] = [];
      for (const rec of result.records) {
        const entity = this.recordToEntity(rec.get('e').properties);
        if (!entity.name_embedding || entity.name_embedding.length !== vector.length) continue;

        try {
          const score = cosineSimilarity(vector, entity.name_embedding);
          if (score >= minScore) {
            scored.push({ entity, score });
          }
        } catch {
          // Skip entities with incompatible embedding dimensions
        }
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } finally {
      await session.close();
    }
  }

  // ===== Graph Management =====

  async clearGroup(groupId: string): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        // Delete edges first
        await tx.run(
          `MATCH ()-[r:RELATES_TO {group_id: $groupId}]->()
					 DELETE r`,
          { groupId },
        );
        // Delete nodes (entities + episodes)
        await tx.run(
          `MATCH (n)
					 WHERE n.group_id = $groupId AND (n:Entity OR n:Episode)
					 DETACH DELETE n`,
          { groupId },
        );
      });
    } finally {
      await session.close();
    }
  }

  async clearAll(): Promise<void> {
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        await tx.run('MATCH (n) WHERE n:Entity OR n:Episode DETACH DELETE n');
      });
    } finally {
      await session.close();
    }
  }

  async exportGraph(groupId?: string): Promise<GraphData> {
    const entities: EntityNode[] = [];
    const edges: EntityEdge[] = [];
    const episodes: EpisodicNode[] = [];

    const session = this.getSession();
    try {
      const entityQuery = groupId
        ? 'MATCH (e:Entity {group_id: $groupId}) RETURN e'
        : 'MATCH (e:Entity) RETURN e';

      const entityResult = await session.executeRead(async (tx) => {
        return tx.run(entityQuery, groupId ? { groupId } : {});
      });
      for (const r of entityResult.records) {
        entities.push(this.recordToEntity(r.get('e').properties));
      }

      const edgeQuery = groupId
        ? 'MATCH ()-[r:RELATES_TO {group_id: $groupId}]->() RETURN r'
        : 'MATCH ()-[r:RELATES_TO]->() RETURN r';

      const edgeResult = await session.executeRead(async (tx) => {
        return tx.run(edgeQuery, groupId ? { groupId } : {});
      });
      for (const r of edgeResult.records) {
        edges.push(this.recordToEdge(r.get('r').properties));
      }

      const episodeQuery = groupId
        ? 'MATCH (ep:Episode {group_id: $groupId}) RETURN ep'
        : 'MATCH (ep:Episode) RETURN ep';

      const episodeResult = await session.executeRead(async (tx) => {
        return tx.run(episodeQuery, groupId ? { groupId } : {});
      });
      for (const r of episodeResult.records) {
        episodes.push(this.recordToEpisode(r.get('ep').properties));
      }
    } finally {
      await session.close();
    }

    return {
      version: CURRENT_GRAPH_DATA_VERSION,
      exported_at: nowIso(),
      group_id: groupId,
      entities,
      edges,
      episodes,
    };
  }

  async importGraph(sourceData: ImportGraphData): Promise<void> {
    const data = migrateGraphData(sourceData).data;
    const session = this.getSession();
    try {
      await session.executeWrite(async (tx) => {
        // Import entities
        for (const entity of data.entities) {
          await tx.run(
            `MERGE (e:Entity {uuid: $uuid})
						 SET e += {
							name: $name,
							group_id: $group_id,
							summary: $summary,
							entity_type: $entity_type,
							name_embedding: $name_embedding,
							attributes: $attributes,
							created_at: $created_at,
							updated_at: $updated_at
						 }`,
            {
              ...entity,
              attributes: JSON.stringify(entity.attributes),
            },
          );
        }

        // Import episodes
        for (const episode of data.episodes) {
          await tx.run(
            `MERGE (ep:Episode {uuid: $uuid})
						 SET ep += {
							group_id: $group_id,
							content: $content,
							role: $role,
							source_type: $source_type,
							reference_time: $reference_time,
							previous_episode_uuid: $previous_episode_uuid,
							created_at: $created_at,
							updated_at: $updated_at,
							source_message_id: $source_message_id,
							idempotency_key: $idempotency_key,
							conversation_id: $conversation_id,
							sender_id: $sender_id,
							sender_name: $sender_name,
							episode_kind: $episode_kind,
							quoted_message_id: $quoted_message_id,
							trust_level: $trust_level,
							confidence: $confidence,
							review_status: $review_status,
							source_workflow_id: $source_workflow_id,
							source_execution_id: $source_execution_id,
							attributes: $attributes,
							source_dedup_key: $source_dedup_key,
							idempotency_dedup_key: $idempotency_dedup_key
						 }`,
            {
              ...episode,
              attributes: JSON.stringify(episode.attributes),
              source_dedup_key: this.sourceDedupKey(episode),
              idempotency_dedup_key: this.idempotencyDedupKey(episode),
            },
          );
        }

        // Import edges
        for (const edge of data.edges) {
          await tx.run(
            `MATCH (source:Entity {uuid: $source_node_uuid})
						 MATCH (target:Entity {uuid: $target_node_uuid})
						 MERGE (source)-[r:RELATES_TO {uuid: $uuid}]->(target)
						 SET r += {
							group_id: $group_id,
							source_node_uuid: $source_node_uuid,
							target_node_uuid: $target_node_uuid,
							name: $name,
							fact: $fact,
							fact_embedding: $fact_embedding,
							episodes: $episodes,
							valid_at: $valid_at,
							invalid_at: $invalid_at,
							expired_at: $expired_at,
							attributes: $attributes,
							created_at: $created_at,
							updated_at: $updated_at
						 }`,
            {
              ...edge,
              attributes: JSON.stringify(edge.attributes),
            },
          );
        }

        // Recreate episode chains
        for (const episode of data.episodes) {
          if (episode.previous_episode_uuid) {
            await tx.run(
              `MATCH (prev:Episode {uuid: $prevUuid})
							 MATCH (curr:Episode {uuid: $currUuid})
							 MERGE (prev)-[:NEXT_EPISODE]->(curr)`,
              {
                prevUuid: episode.previous_episode_uuid,
                currUuid: episode.uuid,
              },
            );
          }
        }
      });
    } finally {
      await session.close();
    }
  }

  async getMigrationStatus(): Promise<StorageMigrationStatus> {
    const legacyEpisodeCount = await this.countLegacyEpisodes();
    return {
      backend: 'neo4j',
      target_version: CURRENT_GRAPH_DATA_VERSION,
      source_version: 'database',
      migration_required: legacyEpisodeCount > 0,
      legacy_episode_count: legacyEpisodeCount,
      automatic_migration_completed: false,
      backup: { created: false, verified: false, path: null },
    };
  }

  async migrateStorageSchema(
    options: StorageSchemaMigrationOptions,
  ): Promise<StorageSchemaMigrationResult> {
    const limit = Math.min(10000, Math.max(1, Math.floor(options.limit)));
    const matchedCount = await this.countLegacyEpisodes();
    if (options.dry_run || matchedCount === 0) {
      return {
        backend: 'neo4j',
        dry_run: options.dry_run,
        matched_count: matchedCount,
        migrated_count: 0,
        remaining_count: matchedCount,
        backup_required: false,
        additive_only: true,
      };
    }

    const session = this.getSession();
    let migratedCount = 0;
    try {
      migratedCount = await session.executeWrite(async (tx) => {
        const result = await tx.run(
          `MATCH (ep:Episode)
           WHERE ep.episode_kind IS NULL
              OR ep.trust_level IS NULL
              OR ep.review_status IS NULL
              OR ep.source_type IS NULL
           WITH ep ORDER BY ep.uuid LIMIT $limit
           SET ep.episode_kind = coalesce(ep.episode_kind, 'legacy'),
               ep.trust_level = coalesce(ep.trust_level, 'unverified'),
               ep.review_status = coalesce(ep.review_status, 'proposed'),
               ep.source_type = coalesce(ep.source_type, 'message')
           RETURN count(ep) AS migrated`,
          { limit: neo4j.int(limit) },
        );
        return result.records[0]?.get('migrated').toNumber() ?? 0;
      });
    } finally {
      await session.close();
    }

    return {
      backend: 'neo4j',
      dry_run: false,
      matched_count: matchedCount,
      migrated_count: migratedCount,
      remaining_count: await this.countLegacyEpisodes(),
      backup_required: false,
      additive_only: true,
    };
  }

  private async countLegacyEpisodes(): Promise<number> {
    const session = this.getSession();
    try {
      const result = await session.executeRead(async (tx) =>
        tx.run(
          `MATCH (ep:Episode)
           WHERE ep.episode_kind IS NULL
              OR ep.trust_level IS NULL
              OR ep.review_status IS NULL
              OR ep.source_type IS NULL
           RETURN count(ep) AS count`,
        ),
      );
      return result.records[0]?.get('count').toNumber() ?? 0;
    } finally {
      await session.close();
    }
  }

  async getStats(groupId?: string): Promise<GraphStats> {
    const session = this.getSession();
    try {
      const where = groupId ? ' WHERE n.group_id = $groupId' : '';
      const params = groupId ? { groupId } : {};

      const result = await session.executeRead(async (tx) => {
        return tx.run(
          `MATCH (n)
					 ${where}
					 WITH n
					 WHERE n:Entity OR n:Episode
					 RETURN
						sum(CASE WHEN n:Entity THEN 1 ELSE 0 END) as entityCount,
						sum(CASE WHEN n:Episode THEN 1 ELSE 0 END) as episodeCount,
						collect(DISTINCT n.group_id) as groupIds,
						collect(CASE WHEN n:Entity THEN n.entity_type ELSE null END) as entityTypes,
						min(CASE WHEN n:Episode THEN n.created_at ELSE null END) as oldestEpisode,
						max(CASE WHEN n:Episode THEN n.created_at ELSE null END) as newestEpisode`,
          params,
        );
      });

      // Count edges separately
      const edgeResult = await session.executeRead(async (tx) => {
        const edgeWhere = groupId ? 'WHERE r.group_id = $groupId' : '';
        return tx.run(
          `MATCH ()-[r:RELATES_TO]->() ${edgeWhere} RETURN count(r) as edgeCount`,
          params,
        );
      });

      const record = result.records[0];
      const entityTypesList = (record.get('entityTypes') as string[]).filter(Boolean);
      const entityTypes: Record<string, number> = {};
      for (const t of entityTypesList) {
        entityTypes[t] = (entityTypes[t] ?? 0) + 1;
      }

      return {
        entity_count: record.get('entityCount').toNumber(),
        edge_count: edgeResult.records[0].get('edgeCount').toNumber(),
        episode_count: record.get('episodeCount').toNumber(),
        group_ids: record.get('groupIds') as string[],
        entity_types: entityTypes,
        oldest_episode: record.get('oldestEpisode') ?? null,
        newest_episode: record.get('newestEpisode') ?? null,
      };
    } finally {
      await session.close();
    }
  }

  // ===== Retention =====

  async applyRetention(groupId: string, policy: RetentionPolicy): Promise<number> {
    if (policy.type === 'forever') return 0;

    const session = this.getSession();
    try {
      if (policy.type === 'days' && policy.value) {
        const cutoffDate = new Date(Date.now() - policy.value * 24 * 60 * 60 * 1000).toISOString();

        const result = await session.executeWrite(async (tx) => {
          return tx.run(
            `MATCH (ep:Episode {group_id: $groupId})
						 WHERE ep.created_at < $cutoffDate
						 DETACH DELETE ep
						 RETURN count(*) as removed`,
            { groupId, cutoffDate },
          );
        });

        return result.records[0]?.get('removed')?.toNumber() ?? 0;
      }

      if (policy.type === 'max_episodes' && policy.value) {
        const result = await session.executeWrite(async (tx) => {
          return tx.run(
            `MATCH (ep:Episode {group_id: $groupId})
						 WITH ep ORDER BY ep.created_at DESC
						 SKIP $maxEpisodes
						 WITH collect(ep) as toDelete, count(ep) as cnt
						 UNWIND toDelete as ep
						 DETACH DELETE ep
						 RETURN cnt as removed`,
            { groupId, maxEpisodes: neo4j.int(policy.value!) },
          );
        });

        return result.records[0]?.get('removed')?.toNumber() ?? 0;
      }

      return 0;
    } finally {
      await session.close();
    }
  }

  // ===== Record Conversion Helpers =====

  private recordToEntity(props: Record<string, unknown>): EntityNode {
    return {
      uuid: props.uuid as string,
      name: props.name as string,
      group_id: props.group_id as string,
      summary: (props.summary as string) ?? '',
      entity_type: (props.entity_type as string) ?? 'unknown',
      name_embedding: (props.name_embedding as number[] | null) ?? null,
      attributes: this.parseJsonField(props.attributes, {}),
      created_at: props.created_at as string,
      updated_at: props.updated_at as string,
    };
  }

  private recordToEdge(props: Record<string, unknown>): EntityEdge {
    return {
      uuid: props.uuid as string,
      group_id: props.group_id as string,
      source_node_uuid: props.source_node_uuid as string,
      target_node_uuid: props.target_node_uuid as string,
      name: props.name as string,
      fact: props.fact as string,
      fact_embedding: (props.fact_embedding as number[] | null) ?? null,
      episodes: (props.episodes as string[]) ?? [],
      valid_at: (props.valid_at as string | null) ?? null,
      invalid_at: (props.invalid_at as string | null) ?? null,
      expired_at: (props.expired_at as string | null) ?? null,
      attributes: this.parseJsonField(props.attributes, {}),
      created_at: props.created_at as string,
      updated_at: props.updated_at as string,
    };
  }

  private recordToEpisode(props: Record<string, unknown>): EpisodicNode {
    return EpisodicNodeSchema.parse({
      uuid: props.uuid as string,
      group_id: props.group_id as string,
      content: props.content as string,
      role: props.role as 'human' | 'ai' | 'system',
      source_type: (props.source_type as 'message' | 'document' | 'api') ?? 'message',
      reference_time: props.reference_time as string,
      previous_episode_uuid: (props.previous_episode_uuid as string | null) ?? null,
      created_at: props.created_at as string,
      updated_at: (props.updated_at as string | null) ?? null,
      source_message_id: (props.source_message_id as string | null) ?? null,
      idempotency_key: (props.idempotency_key as string | null) ?? null,
      conversation_id: (props.conversation_id as string | null) ?? null,
      sender_id: (props.sender_id as string | null) ?? null,
      sender_name: (props.sender_name as string | null) ?? null,
      episode_kind: props.episode_kind,
      quoted_message_id: (props.quoted_message_id as string | null) ?? null,
      trust_level: props.trust_level,
      confidence: (props.confidence as number | null) ?? null,
      review_status: props.review_status,
      source_workflow_id: (props.source_workflow_id as string | null) ?? null,
      source_execution_id: (props.source_execution_id as string | null) ?? null,
      attributes: this.parseJsonField(props.attributes, {}),
    });
  }

  private parseJsonField(
    value: unknown,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return fallback;
      }
    }
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }
    return fallback;
  }
}
