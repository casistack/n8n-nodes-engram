import { MultiDirectedGraph } from 'graphology';
import * as fs from 'fs';
import * as path from 'path';
import { generateUuid } from '../utils/uuid';
import { nowIso, isOlderThanDays, isWithinDateRange } from '../utils/temporal';
import { MinisearchProvider } from '../search/MinisearchProvider';
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
} from './IGraphStorage';
import type {
  EntityNode,
  CreateEntityNode,
  EntityEdge,
  CreateEntityEdge,
  EpisodicNode,
  CreateEpisodicNode,
  GraphData,
  GraphStats,
} from '../schemas';

type NodeType = 'entity' | 'episode';

interface GraphNodeAttributes {
  type: NodeType;
  data: EntityNode | EpisodicNode;
}

interface GraphEdgeAttributes {
  type: 'entity_edge' | 'next_episode';
  data: EntityEdge | null;
}

const PERSIST_LOCK_TIMEOUT_MS = 5000;
const PERSIST_LOCK_STALE_MS = 30000;

export class GraphologyStorage implements IGraphStorage {
  private graph: MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>;
  private searchProvider: MinisearchProvider;
  private persistPath: string | undefined;
  private initialized = false;
  private episodeOrder = new Map<string, number>();
  private nextOrder = 0;

  constructor(persistPath?: string) {
    this.graph = new MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>();
    this.searchProvider = new MinisearchProvider();
    if (persistPath) {
      // Validate path to prevent traversal attacks
      const resolved = path.resolve(persistPath);
      if (resolved.includes('..') || resolved.startsWith('/etc') || resolved.startsWith('/dev')) {
        throw new Error(`Invalid persist path: ${persistPath}`);
      }
      this.persistPath = resolved;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.persistPath) {
      await this.loadFromDisk();
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.persistPath) {
      await this.saveToDisk();
    }
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

    this.graph.addNode(entity.uuid, { type: 'entity', data: entity });
    this.searchProvider.indexEntity(entity.uuid, {
      name: entity.name,
      summary: entity.summary,
      entity_type: entity.entity_type,
    });
    await this.persistIfConfigured();

    return entity;
  }

  async getEntity(uuid: string): Promise<EntityNode | null> {
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    if (attrs.type !== 'entity') return null;
    return attrs.data as EntityNode;
  }

  async getEntityByName(name: string, groupId: string): Promise<EntityNode | null> {
    const normalized = name.toLowerCase().trim();
    let found: EntityNode | null = null;

    this.graph.forEachNode((key, attrs) => {
      if (found) return;
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      if (entity.group_id === groupId && entity.name.toLowerCase().trim() === normalized) {
        found = entity;
      }
    });

    return found;
  }

  async updateEntity(uuid: string, updates: Partial<EntityNode>): Promise<EntityNode> {
    const existing = await this.getEntity(uuid);
    if (!existing) throw new Error(`Entity not found: ${uuid}`);

    const updated: EntityNode = {
      ...existing,
      ...updates,
      uuid: existing.uuid,
      created_at: existing.created_at,
      updated_at: nowIso(),
    };

    this.graph.setNodeAttribute(uuid, 'data', updated);
    this.searchProvider.indexEntity(updated.uuid, {
      name: updated.name,
      summary: updated.summary,
      entity_type: updated.entity_type,
    });
    await this.persistIfConfigured();

    return updated;
  }

  async deleteEntity(uuid: string): Promise<void> {
    if (!this.graph.hasNode(uuid)) return;

    // Remove connected edges from search index before Graphology drops them
    this.graph.forEachEdge(uuid, (edgeKey, attrs) => {
      if (attrs.type === 'entity_edge') {
        this.searchProvider.removeEdge(edgeKey);
      }
    });

    this.searchProvider.removeEntity(uuid);
    this.graph.dropNode(uuid);
    await this.persistIfConfigured();
  }

  async listEntities(groupId: string, options?: ListOptions): Promise<EntityNode[]> {
    const entities: EntityNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      if (entity.group_id !== groupId) return;
      if (options?.entity_type && entity.entity_type !== options.entity_type) return;
      if (
        (options?.created_after || options?.created_before) &&
        !isWithinDateRange(entity.created_at, options?.created_after, options?.created_before)
      )
        return;
      entities.push(entity);
    });

    entities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? entities.length;
    return entities.slice(offset, offset + limit);
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

    // Ensure source and target nodes exist
    if (!this.graph.hasNode(edge.source_node_uuid) || !this.graph.hasNode(edge.target_node_uuid)) {
      throw new Error(
        `Cannot create edge: source (${edge.source_node_uuid}) or target (${edge.target_node_uuid}) node not found`,
      );
    }

    this.graph.addEdgeWithKey(edge.uuid, edge.source_node_uuid, edge.target_node_uuid, {
      type: 'entity_edge',
      data: edge,
    });

    this.searchProvider.indexEdge(edge.uuid, {
      name: edge.name,
      fact: edge.fact,
    });
    await this.persistIfConfigured();

    return edge;
  }

  async getEdge(uuid: string): Promise<EntityEdge | null> {
    if (!this.graph.hasEdge(uuid)) return null;
    const attrs = this.graph.getEdgeAttributes(uuid);
    if (attrs.type !== 'entity_edge') return null;
    return attrs.data as EntityEdge;
  }

  async getEdgesBetween(sourceUuid: string, targetUuid: string): Promise<EntityEdge[]> {
    const edges: EntityEdge[] = [];

    if (!this.graph.hasNode(sourceUuid) || !this.graph.hasNode(targetUuid)) return edges;

    this.graph.forEachEdge(sourceUuid, (edgeKey, attrs, source, target) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      if (
        (source === sourceUuid && target === targetUuid) ||
        (source === targetUuid && target === sourceUuid)
      ) {
        edges.push(attrs.data as EntityEdge);
      }
    });

    return edges;
  }

  async getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]> {
    const edges: EntityEdge[] = [];

    if (!this.graph.hasNode(entityUuid)) return edges;

    this.graph.forEachEdge(entityUuid, (_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      edges.push(attrs.data as EntityEdge);
    });

    return edges;
  }

  async updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge> {
    const existing = await this.getEdge(uuid);
    if (!existing) throw new Error(`Edge not found: ${uuid}`);

    const updated: EntityEdge = {
      ...existing,
      ...updates,
      uuid: existing.uuid,
      source_node_uuid: existing.source_node_uuid,
      target_node_uuid: existing.target_node_uuid,
      created_at: existing.created_at,
      updated_at: nowIso(),
    };

    this.graph.setEdgeAttribute(uuid, 'data', updated);
    this.searchProvider.indexEdge(updated.uuid, {
      name: updated.name,
      fact: updated.fact,
    });
    await this.persistIfConfigured();

    return updated;
  }

  async deleteEdge(uuid: string): Promise<void> {
    if (!this.graph.hasEdge(uuid)) return;
    this.searchProvider.removeEdge(uuid);
    this.graph.dropEdge(uuid);
    await this.persistIfConfigured();
  }

  // ===== Episode Operations =====

  async addEpisode(input: CreateEpisodicNode): Promise<EpisodicNode> {
    const episode: EpisodicNode = {
      uuid: generateUuid(),
      group_id: input.group_id,
      content: input.content,
      role: input.role,
      source_type: input.source_type ?? 'message',
      reference_time: input.reference_time,
      previous_episode_uuid: input.previous_episode_uuid ?? null,
      created_at: nowIso(),
    };

    this.graph.addNode(episode.uuid, { type: 'episode', data: episode });
    this.episodeOrder.set(episode.uuid, this.nextOrder++);

    // Chain to previous episode
    if (episode.previous_episode_uuid && this.graph.hasNode(episode.previous_episode_uuid)) {
      const chainKey = `next_${episode.previous_episode_uuid}_${episode.uuid}`;
      this.graph.addEdgeWithKey(chainKey, episode.previous_episode_uuid, episode.uuid, {
        type: 'next_episode',
        data: null,
      });
    }

    await this.persistIfConfigured();
    return episode;
  }

  async getEpisode(uuid: string): Promise<EpisodicNode | null> {
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    if (attrs.type !== 'episode') return null;
    return attrs.data as EpisodicNode;
  }

  async getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]> {
    const episodes: EpisodicNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId) return;
      episodes.push(episode);
    });

    episodes.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      // Tiebreak by insertion order (descending) when timestamps are equal
      return (this.episodeOrder.get(b.uuid) ?? 0) - (this.episodeOrder.get(a.uuid) ?? 0);
    });

    return episodes.slice(0, limit).reverse();
  }

  async getEpisodeCount(groupId: string): Promise<number> {
    let count = 0;
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id === groupId) count++;
    });
    return count;
  }

  async getEpisodesByDateRange(
    groupId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<EpisodicNode[]> {
    const episodes: EpisodicNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId) return;
      if (!isWithinDateRange(episode.reference_time, from, to)) return;
      episodes.push(episode);
    });

    episodes.sort(
      (a, b) => new Date(a.reference_time).getTime() - new Date(b.reference_time).getTime(),
    );
    return limit ? episodes.slice(0, limit) : episodes;
  }

  // ===== Changelog =====

  async getEdgeChangelog(
    groupId: string,
    since: string,
    options?: { limit?: number },
  ): Promise<ChangelogEntry[]> {
    const entries: ChangelogEntry[] = [];
    const sinceTs = new Date(since).getTime();

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      const edge = attrs.data as EntityEdge;
      if (edge.group_id !== groupId) return;

      const createdTs = new Date(edge.created_at).getTime();
      const expiredTs = edge.expired_at ? new Date(edge.expired_at).getTime() : null;
      const invalidTs = edge.invalid_at ? new Date(edge.invalid_at).getTime() : null;

      const sourceNode = this.graph.hasNode(edge.source_node_uuid)
        ? this.graph.getNodeAttributes(edge.source_node_uuid)
        : null;
      const targetNode = this.graph.hasNode(edge.target_node_uuid)
        ? this.graph.getNodeAttributes(edge.target_node_uuid)
        : null;
      if (!sourceNode || !targetNode) return;
      if (sourceNode.type !== 'entity' || targetNode.type !== 'entity') return;

      const sourceEntity = sourceNode.data as EntityNode;
      const targetEntity = targetNode.data as EntityNode;

      if (createdTs >= sinceTs) {
        entries.push({
          edge,
          sourceEntity,
          targetEntity,
          change_type: 'created',
          changed_at: edge.created_at,
        });
      }

      if (expiredTs && expiredTs >= sinceTs) {
        entries.push({
          edge,
          sourceEntity,
          targetEntity,
          change_type: 'expired',
          changed_at: edge.expired_at!,
        });
      } else if (invalidTs && invalidTs >= sinceTs && !expiredTs) {
        entries.push({
          edge,
          sourceEntity,
          targetEntity,
          change_type: 'invalidated',
          changed_at: edge.invalid_at!,
        });
      }
    });

    entries.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
    const limit = options?.limit ?? entries.length;
    return entries.slice(0, limit);
  }

  // ===== Search =====

  async searchEntities(
    query: string,
    groupId: string,
    options?: EntitySearchOptions,
  ): Promise<EntitySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;

    const textResults = this.searchProvider.searchEntities(query, limit * 3);

    const results: EntitySearchResult[] = [];
    for (const tr of textResults) {
      if (tr.score < minScore) continue;

      const entity = await this.getEntity(tr.id);
      if (!entity || entity.group_id !== groupId) continue;
      if (options?.entity_type && entity.entity_type !== options.entity_type) continue;
      if (
        (options?.created_after || options?.created_before) &&
        !isWithinDateRange(entity.created_at, options?.created_after, options?.created_before)
      )
        continue;

      results.push({ entity, score: tr.score });
    }

    return results.slice(0, limit);
  }

  async searchEdges(
    query: string,
    groupId: string,
    options?: EdgeSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;
    const includeExpired = options?.include_expired ?? false;

    const textResults = this.searchProvider.searchEdges(query, limit * 3);

    const results: EdgeSearchResult[] = [];
    for (const tr of textResults) {
      if (tr.score < minScore) continue;

      const edge = await this.getEdge(tr.id);
      if (!edge || edge.group_id !== groupId) continue;
      if (!includeExpired && edge.expired_at !== null) continue;
      if (
        (options?.valid_after || options?.valid_before) &&
        !isWithinDateRange(edge.valid_at, options?.valid_after, options?.valid_before)
      )
        continue;
      if (
        (options?.created_after || options?.created_before) &&
        !isWithinDateRange(edge.created_at, options?.created_after, options?.created_before)
      )
        continue;

      const sourceEntity = await this.getEntity(edge.source_node_uuid);
      const targetEntity = await this.getEntity(edge.target_node_uuid);
      if (!sourceEntity || !targetEntity) continue;

      results.push({ edge, sourceEntity, targetEntity, score: tr.score });
    }

    return results.slice(0, limit);
  }

  // ===== Vector Search =====

  async searchEntitiesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;
    const results: EntitySearchResult[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      if (entity.group_id !== groupId) return;
      if (!entity.name_embedding || entity.name_embedding.length !== vector.length) return;

      try {
        const score = cosineSimilarity(vector, entity.name_embedding);
        if (score >= minScore) {
          results.push({ entity, score });
        }
      } catch {
        // Skip entities with incompatible embedding dimensions
      }
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async searchEdgesByVector(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EdgeSearchResult[]> {
    const limit = options?.limit ?? 10;
    const minScore = options?.min_score ?? 0;
    const results: EdgeSearchResult[] = [];

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      const edge = attrs.data as EntityEdge;
      if (edge.group_id !== groupId) return;
      if (!edge.fact_embedding || edge.fact_embedding.length !== vector.length) return;

      try {
        const score = cosineSimilarity(vector, edge.fact_embedding);
        if (score < minScore) return;

        // Need source and target entities
        const sourceNode = this.graph.hasNode(edge.source_node_uuid)
          ? this.graph.getNodeAttributes(edge.source_node_uuid)
          : null;
        const targetNode = this.graph.hasNode(edge.target_node_uuid)
          ? this.graph.getNodeAttributes(edge.target_node_uuid)
          : null;

        if (!sourceNode || !targetNode) return;
        if (sourceNode.type !== 'entity' || targetNode.type !== 'entity') return;

        results.push({
          edge,
          sourceEntity: sourceNode.data as EntityNode,
          targetEntity: targetNode.data as EntityNode,
          score,
        });
      } catch {
        // Skip edges with incompatible embedding dimensions
      }
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ===== Graph Management =====

  async clearGroup(groupId: string): Promise<void> {
    const nodesToRemove: string[] = [];

    this.graph.forEachNode((key, attrs) => {
      const data = attrs.data;
      if ('group_id' in data && data.group_id === groupId) {
        nodesToRemove.push(key);
      }
    });

    // Also find edges belonging to this group
    const edgesToRemove: string[] = [];
    this.graph.forEachEdge((edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data) {
        const edge = attrs.data as EntityEdge;
        if (edge.group_id === groupId) {
          edgesToRemove.push(edgeKey);
        }
      }
    });

    for (const edgeKey of edgesToRemove) {
      this.searchProvider.removeEdge(edgeKey);
      if (this.graph.hasEdge(edgeKey)) {
        this.graph.dropEdge(edgeKey);
      }
    }

    for (const key of nodesToRemove) {
      this.searchProvider.removeEntity(key);
      if (this.graph.hasNode(key)) {
        this.graph.dropNode(key);
      }
    }

    await this.persistIfConfigured();
  }

  async clearAll(): Promise<void> {
    this.graph.clear();
    this.searchProvider.clear();
    this.episodeOrder.clear();
    this.nextOrder = 0;
    await this.persistIfConfigured();
  }

  async exportGraph(groupId?: string): Promise<GraphData> {
    const entities: EntityNode[] = [];
    const edges: EntityEdge[] = [];
    const episodes: EpisodicNode[] = [];

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type === 'entity') {
        const entity = attrs.data as EntityNode;
        if (!groupId || entity.group_id === groupId) entities.push(entity);
      } else if (attrs.type === 'episode') {
        const episode = attrs.data as EpisodicNode;
        if (!groupId || episode.group_id === groupId) episodes.push(episode);
      }
    });

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data) {
        const edge = attrs.data as EntityEdge;
        if (!groupId || edge.group_id === groupId) edges.push(edge);
      }
    });

    return {
      version: '1.0',
      exported_at: nowIso(),
      group_id: groupId,
      entities,
      edges,
      episodes,
    };
  }

  async importGraph(data: GraphData): Promise<void> {
    // Import entities first (nodes must exist before edges)
    for (const entity of data.entities) {
      if (!this.graph.hasNode(entity.uuid)) {
        this.graph.addNode(entity.uuid, { type: 'entity', data: entity });
        this.searchProvider.indexEntity(entity.uuid, {
          name: entity.name,
          summary: entity.summary,
          entity_type: entity.entity_type,
        });
      }
    }

    // Import episodes (sorted by created_at to restore order)
    const sortedEpisodes = [...data.episodes].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    for (const episode of sortedEpisodes) {
      if (!this.graph.hasNode(episode.uuid)) {
        this.graph.addNode(episode.uuid, { type: 'episode', data: episode });
        this.episodeOrder.set(episode.uuid, this.nextOrder++);
      }
    }

    // Import edges
    for (const edge of data.edges) {
      if (
        !this.graph.hasEdge(edge.uuid) &&
        this.graph.hasNode(edge.source_node_uuid) &&
        this.graph.hasNode(edge.target_node_uuid)
      ) {
        this.graph.addEdgeWithKey(edge.uuid, edge.source_node_uuid, edge.target_node_uuid, {
          type: 'entity_edge',
          data: edge,
        });
        this.searchProvider.indexEdge(edge.uuid, {
          name: edge.name,
          fact: edge.fact,
        });
      }
    }

    // Re-create episode chains
    for (const episode of data.episodes) {
      if (
        episode.previous_episode_uuid &&
        this.graph.hasNode(episode.previous_episode_uuid) &&
        this.graph.hasNode(episode.uuid)
      ) {
        const chainKey = `next_${episode.previous_episode_uuid}_${episode.uuid}`;
        if (!this.graph.hasEdge(chainKey)) {
          this.graph.addEdgeWithKey(chainKey, episode.previous_episode_uuid, episode.uuid, {
            type: 'next_episode',
            data: null,
          });
        }
      }
    }

    await this.persistIfConfigured();
  }

  async getStats(groupId?: string): Promise<GraphStats> {
    let entityCount = 0;
    let edgeCount = 0;
    let episodeCount = 0;
    const groupIds = new Set<string>();
    const entityTypes: Record<string, number> = {};
    let oldestEpisode: string | null = null;
    let newestEpisode: string | null = null;

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type === 'entity') {
        const entity = attrs.data as EntityNode;
        if (groupId && entity.group_id !== groupId) return;

        entityCount++;
        groupIds.add(entity.group_id);
        entityTypes[entity.entity_type] = (entityTypes[entity.entity_type] ?? 0) + 1;
      } else if (attrs.type === 'episode') {
        const episode = attrs.data as EpisodicNode;
        if (groupId && episode.group_id !== groupId) return;

        episodeCount++;
        groupIds.add(episode.group_id);

        if (!oldestEpisode || episode.created_at < oldestEpisode) {
          oldestEpisode = episode.created_at;
        }
        if (!newestEpisode || episode.created_at > newestEpisode) {
          newestEpisode = episode.created_at;
        }
      }
    });

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data) {
        const edge = attrs.data as EntityEdge;
        if (groupId && edge.group_id !== groupId) return;
        edgeCount++;
      }
    });

    return {
      entity_count: entityCount,
      edge_count: edgeCount,
      episode_count: episodeCount,
      group_ids: [...groupIds],
      entity_types: entityTypes,
      oldest_episode: oldestEpisode,
      newest_episode: newestEpisode,
    };
  }

  async rebuildSearchIndex(): Promise<{ indexed_entities: number; indexed_edges: number }> {
    let indexedEntities = 0;
    let indexedEdges = 0;

    this.searchProvider.clear();

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'entity') return;
      const entity = attrs.data as EntityNode;
      this.searchProvider.indexEntity(entity.uuid, {
        name: entity.name,
        summary: entity.summary,
        entity_type: entity.entity_type,
      });
      indexedEntities++;
    });

    this.graph.forEachEdge((_edgeKey, attrs) => {
      if (attrs.type !== 'entity_edge' || !attrs.data) return;
      const edge = attrs.data as EntityEdge;
      this.searchProvider.indexEdge(edge.uuid, {
        name: edge.name,
        fact: edge.fact,
      });
      indexedEdges++;
    });

    return {
      indexed_entities: indexedEntities,
      indexed_edges: indexedEdges,
    };
  }

  // ===== Retention =====

  async applyRetention(groupId: string, policy: RetentionPolicy): Promise<number> {
    if (policy.type === 'forever') return 0;

    let removed = 0;

    if (policy.type === 'days' && policy.value) {
      const days = policy.value;
      const episodesToRemove: string[] = [];

      this.graph.forEachNode((key, attrs) => {
        if (attrs.type !== 'episode') return;
        const episode = attrs.data as EpisodicNode;
        if (episode.group_id !== groupId) return;
        if (isOlderThanDays(episode.created_at, days)) {
          episodesToRemove.push(key);
        }
      });

      for (const key of episodesToRemove) {
        if (this.graph.hasNode(key)) {
          this.graph.dropNode(key);
          removed++;
        }
      }
    }

    if (policy.type === 'max_episodes' && policy.value) {
      const maxEpisodes = policy.value;
      const episodes: { uuid: string; created_at: string }[] = [];

      this.graph.forEachNode((_key, attrs) => {
        if (attrs.type !== 'episode') return;
        const episode = attrs.data as EpisodicNode;
        if (episode.group_id !== groupId) return;
        episodes.push({ uuid: episode.uuid, created_at: episode.created_at });
      });

      episodes.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const toRemove = episodes.slice(maxEpisodes);
      for (const ep of toRemove) {
        if (this.graph.hasNode(ep.uuid)) {
          this.graph.dropNode(ep.uuid);
          removed++;
        }
      }
    }

    if (removed > 0) {
      await this.persistIfConfigured();
    }

    return removed;
  }

  // ===== Persistence =====

  private async persistIfConfigured(): Promise<void> {
    if (this.persistPath) {
      await this.saveToDisk();
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.persistPath) return;

    const data = await this.exportGraph();
    const dir = path.dirname(this.persistPath);

    await fs.promises.mkdir(dir, { recursive: true });

    const payload = JSON.stringify(data, null, 2);
    const tmpPath = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
    const releaseLock = await this.acquirePersistLock();

    try {
      await fs.promises.writeFile(tmpPath, payload, 'utf-8');
      await fs.promises.rename(tmpPath, this.persistPath);
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await releaseLock();
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;

    try {
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as GraphData;
      await this.importGraph(data);
    } catch {
      // If file is corrupted, start fresh
      console.error(`Engram: Failed to load graph from ${this.persistPath}, starting fresh`);
    }
  }

  private async acquirePersistLock(): Promise<() => Promise<void>> {
    if (!this.persistPath) return async () => {};

    const lockPath = `${this.persistPath}.lock`;
    const startedAt = Date.now();

    for (;;) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx');
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf-8');
        await handle.close();
        return async () => {
          await fs.promises.rm(lockPath, { force: true });
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;

        const lockIsStale = await this.isPersistLockStale(lockPath);
        if (lockIsStale) {
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }

        if (Date.now() - startedAt > PERSIST_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for Engram storage lock: ${lockPath}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async isPersistLockStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await fs.promises.stat(lockPath);
      return Date.now() - stats.mtimeMs > PERSIST_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}
