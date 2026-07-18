import { MultiDirectedGraph } from 'graphology';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
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
  StorageMutationDiagnostics,
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
import { matchesEpisodeHygieneFilters } from './EpisodeHygiene';
import {
  CURRENT_GRAPH_DATA_VERSION,
  CreateEpisodicNodeSchema,
  EpisodicNodeSchema,
  migrateGraphData,
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

const PERSIST_LOCK_TIMEOUT_MS = 60000;
const PERSIST_LOCK_STALE_MS = 30000;
const PERSIST_LOCK_HEARTBEAT_MS = 5000;
const EMBEDDED_BACKUP_SUFFIX = '.pre-schema-2.0.backup.json';

interface MutationOptions<T> {
  operation?: string;
  itemCount?: number;
  shouldWriteSnapshot?: (result: T) => boolean;
}

export class GraphologyStorage implements IGraphStorage {
  private graph: MultiDirectedGraph<GraphNodeAttributes, GraphEdgeAttributes>;
  private searchProvider: MinisearchProvider;
  private persistPath: string | undefined;
  private initialized = false;
  private episodeOrder = new Map<string, number>();
  private nextOrder = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private lastMutationDiagnostics: StorageMutationDiagnostics | null = null;
  private migrationStatus: StorageMigrationStatus = {
    backend: 'embedded',
    target_version: CURRENT_GRAPH_DATA_VERSION,
    source_version: 'new',
    migration_required: false,
    legacy_episode_count: 0,
    automatic_migration_completed: false,
    backup: { created: false, verified: false, path: null },
  };

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
    await this.mutationTail;
  }

  getLastMutationDiagnostics(): StorageMutationDiagnostics | null {
    return this.lastMutationDiagnostics ? { ...this.lastMutationDiagnostics } : null;
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

    return this.runMutation(() => {
      this.graph.addNode(entity.uuid, { type: 'entity', data: entity });
      this.searchProvider.indexEntity(entity.uuid, {
        name: entity.name,
        summary: entity.summary,
        entity_type: entity.entity_type,
      });

      return entity;
    });
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
    return this.runMutation(() => {
      const existing = this.getEpisodeOrEntity(uuid, 'entity') as EntityNode | null;
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

      return updated;
    });
  }

  async deleteEntity(uuid: string): Promise<void> {
    await this.runMutation(() => {
      if (!this.graph.hasNode(uuid)) return;

      // Remove connected edges from search index before Graphology drops them
      this.graph.forEachEdge(uuid, (edgeKey, attrs) => {
        if (attrs.type === 'entity_edge') {
          this.searchProvider.removeEdge(edgeKey);
        }
      });

      this.searchProvider.removeEntity(uuid);
      this.graph.dropNode(uuid);
    });
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

    return this.runMutation(() => {
      // Ensure source and target nodes exist
      if (
        !this.graph.hasNode(edge.source_node_uuid) ||
        !this.graph.hasNode(edge.target_node_uuid)
      ) {
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

      return edge;
    });
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
    return this.runMutation(() => {
      const existing = this.getEdgeInternal(uuid);
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

      return updated;
    });
  }

  async deleteEdge(uuid: string): Promise<void> {
    await this.runMutation(() => {
      if (!this.graph.hasEdge(uuid)) return;
      this.searchProvider.removeEdge(uuid);
      this.graph.dropEdge(uuid);
    });
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

    return this.runMutation(
      () =>
        prepared.map(({ parsed, shouldAutoChain }) =>
          this.appendEpisodeInternal(parsed, shouldAutoChain),
        ),
      {
        operation: inputs.length === 1 ? 'append_episode' : 'append_episodes',
        itemCount: inputs.length,
        shouldWriteSnapshot: (results) => results.some((result) => result.created),
      },
    );
  }

  private appendEpisodeInternal(
    parsed: ReturnType<typeof CreateEpisodicNodeSchema.parse>,
    shouldAutoChain: boolean,
  ): AppendEpisodeResult {
    const existing = this.findEpisodeByIdempotency(parsed);
    if (existing) return { episode: existing, created: false };

    const createdAt = nowIso();
    const previousEpisodeUuid = shouldAutoChain
      ? (this.findLatestEpisode(parsed.group_id)?.uuid ?? null)
      : parsed.previous_episode_uuid;
    const episode: EpisodicNode = {
      uuid: generateUuid(),
      ...parsed,
      previous_episode_uuid: previousEpisodeUuid,
      created_at: createdAt,
      updated_at: createdAt,
    };

    this.graph.addNode(episode.uuid, { type: 'episode', data: episode });
    this.episodeOrder.set(episode.uuid, this.nextOrder++);

    const previous = previousEpisodeUuid
      ? this.getEpisodeOrEntity(previousEpisodeUuid, 'episode')
      : null;
    if (previous && previous.group_id === episode.group_id) {
      const chainKey = `next_${previousEpisodeUuid}_${episode.uuid}`;
      this.graph.addEdgeWithKey(chainKey, previousEpisodeUuid!, episode.uuid, {
        type: 'next_episode',
        data: null,
      });
    }

    return { episode, created: true };
  }

  private findEpisodeByIdempotency(input: CreateEpisodicNode): EpisodicNode | null {
    const matches: { source?: EpisodicNode; key?: EpisodicNode } = {};

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== input.group_id) return;

      if (
        input.source_message_id &&
        episode.source_message_id === input.source_message_id &&
        episode.episode_kind === input.episode_kind
      ) {
        matches.source = episode;
      }
      if (input.idempotency_key && episode.idempotency_key === input.idempotency_key) {
        matches.key = episode;
      }
    });

    if (matches.source && matches.key && matches.source.uuid !== matches.key.uuid) {
      throw new Error('Episode idempotency identifiers resolve to different existing episodes');
    }

    return matches.source ?? matches.key ?? null;
  }

  private findLatestEpisode(groupId: string): EpisodicNode | null {
    const episodes: EpisodicNode[] = [];
    const referencedPredecessors = new Set<string>();

    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId) return;
      episodes.push(episode);
      if (episode.previous_episode_uuid) {
        referencedPredecessors.add(episode.previous_episode_uuid);
      }
    });

    const tails = episodes.filter((episode) => !referencedPredecessors.has(episode.uuid));
    const candidates = tails.length > 0 ? tails : episodes;
    candidates.sort((a, b) => {
      const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (this.episodeOrder.get(b.uuid) ?? 0) - (this.episodeOrder.get(a.uuid) ?? 0);
    });
    return candidates[0] ?? null;
  }

  async getEpisode(uuid: string): Promise<EpisodicNode | null> {
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    if (attrs.type !== 'episode') return null;
    return attrs.data as EpisodicNode;
  }

  async getEpisodes(uuids: string[]): Promise<EpisodicNode[]> {
    const episodes: EpisodicNode[] = [];
    for (const uuid of [...new Set(uuids)]) {
      const episode = await this.getEpisode(uuid);
      if (episode) episodes.push(episode);
    }
    return episodes;
  }

  async listEpisodes(groupId: string, options: EpisodeFilterOptions = {}): Promise<EpisodicNode[]> {
    return this.collectEpisodes(groupId, options);
  }

  async updateEpisode(uuid: string, updates: UpdateEpisodeInput): Promise<EpisodicNode> {
    return this.runMutation(() => {
      const existing = this.getEpisodeOrEntity(uuid, 'episode') as EpisodicNode | null;
      if (!existing) throw new Error(`Episode not found: ${uuid}`);

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
      this.graph.setNodeAttribute(uuid, 'data', updated);
      return updated;
    });
  }

  async deleteEpisode(
    uuid: string,
    options: DeleteEpisodeOptions = {},
  ): Promise<DeleteEpisodeResult> {
    return this.runMutation(() => this.deleteEpisodeInternal(uuid, options));
  }

  async purgeEpisodes(
    groupId: string,
    filters: EpisodeFilterOptions,
    options: PurgeEpisodesOptions,
  ): Promise<PurgeEpisodesResult> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
      throw new Error('Episode purge limit must be an integer between 1 and 10000');
    }

    const execute = (): PurgeEpisodesResult => {
      const matches = this.collectEpisodes(groupId, {
        ...filters,
        offset: 0,
        limit: options.limit + 1,
      });
      const truncated = matches.length > options.limit;
      const selected = matches.slice(0, options.limit);
      const linkedEdges = new Set<string>();
      for (const episode of selected) {
        this.graph.forEachEdge((_edgeKey, attrs) => {
          if (attrs.type === 'entity_edge' && attrs.data?.episodes.includes(episode.uuid)) {
            linkedEdges.add(attrs.data.uuid);
          }
        });
      }

      if (options.dry_run) {
        return {
          matched_count: selected.length,
          deleted_count: 0,
          truncated,
          dry_run: true,
          linked_edge_count: linkedEdges.size,
          updated_edge_count: 0,
          deleted_edge_count: 0,
          episode_uuids: selected.map((episode) => episode.uuid),
        };
      }

      const results = selected.map((episode) => this.deleteEpisodeInternal(episode.uuid, options));
      return {
        matched_count: selected.length,
        deleted_count: results.filter((result) => result.deleted).length,
        truncated,
        dry_run: false,
        linked_edge_count: linkedEdges.size,
        updated_edge_count: results.reduce((total, result) => total + result.updated_edge_count, 0),
        deleted_edge_count: results.reduce((total, result) => total + result.deleted_edge_count, 0),
        episode_uuids: selected.map((episode) => episode.uuid),
      };
    };

    return options.dry_run ? execute() : this.runMutation(execute);
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

  async getEpisodeCount(groupId: string, filters: EpisodeFilterOptions = {}): Promise<number> {
    const countFilters = { ...filters };
    delete countFilters.limit;
    delete countFilters.offset;
    return this.collectEpisodes(groupId, countFilters).length;
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

  private collectEpisodes(groupId: string, options: EpisodeFilterOptions): EpisodicNode[] {
    const episodes: EpisodicNode[] = [];
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const episode = attrs.data as EpisodicNode;
      if (episode.group_id !== groupId || !this.matchesEpisodeFilters(episode, options)) return;
      episodes.push(episode);
    });

    const sortBy = options.sort_by ?? 'created_at';
    const direction = options.sort_order === 'asc' ? 1 : -1;
    episodes.sort((a, b) => {
      const timeDiff = new Date(a[sortBy]).getTime() - new Date(b[sortBy]).getTime();
      if (timeDiff !== 0) return timeDiff * direction;
      return (
        ((this.episodeOrder.get(a.uuid) ?? 0) - (this.episodeOrder.get(b.uuid) ?? 0)) * direction
      );
    });

    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit === undefined ? episodes.length : Math.max(0, options.limit);
    return episodes.slice(offset, offset + limit);
  }

  private matchesEpisodeFilters(episode: EpisodicNode, options: EpisodeFilterOptions): boolean {
    if (options.role && episode.role !== options.role) return false;
    if (options.source_type && episode.source_type !== options.source_type) return false;
    if (options.episode_kind && episode.episode_kind !== options.episode_kind) return false;
    if (options.trust_level && episode.trust_level !== options.trust_level) return false;
    if (options.review_status && episode.review_status !== options.review_status) return false;
    if (options.sender_id && episode.sender_id !== options.sender_id) return false;
    if (
      options.sender_name &&
      episode.sender_name?.toLocaleLowerCase() !== options.sender_name.toLocaleLowerCase()
    )
      return false;
    if (options.conversation_id && episode.conversation_id !== options.conversation_id)
      return false;
    if (options.source_message_id && episode.source_message_id !== options.source_message_id)
      return false;
    if (options.source_workflow_id && episode.source_workflow_id !== options.source_workflow_id)
      return false;
    if (options.source_execution_id && episode.source_execution_id !== options.source_execution_id)
      return false;
    if (
      (options.reference_after || options.reference_before) &&
      !isWithinDateRange(episode.reference_time, options.reference_after, options.reference_before)
    )
      return false;
    if (
      (options.created_after || options.created_before) &&
      !isWithinDateRange(episode.created_at, options.created_after, options.created_before)
    )
      return false;
    if (!matchesEpisodeHygieneFilters(episode, options)) return false;
    return true;
  }

  private deleteEpisodeInternal(uuid: string, options: DeleteEpisodeOptions): DeleteEpisodeResult {
    const episode = this.getEpisodeOrEntity(uuid, 'episode') as EpisodicNode | null;
    if (!episode) {
      return {
        episode_uuid: uuid,
        deleted: false,
        repaired_successor_count: 0,
        linked_edge_count: 0,
        updated_edge_count: 0,
        deleted_edge_count: 0,
      };
    }

    const repairChain = options.repair_chain ?? true;
    const cleanup = options.fact_cleanup ?? 'unlink';
    const successors: EpisodicNode[] = [];
    this.graph.forEachNode((_key, attrs) => {
      if (attrs.type !== 'episode') return;
      const candidate = attrs.data as EpisodicNode;
      if (candidate.group_id === episode.group_id && candidate.previous_episode_uuid === uuid) {
        successors.push(candidate);
      }
    });

    const linkedEdgeKeys: string[] = [];
    this.graph.forEachEdge((edgeKey, attrs) => {
      if (attrs.type === 'entity_edge' && attrs.data?.episodes.includes(uuid)) {
        linkedEdgeKeys.push(edgeKey);
      }
    });

    let updatedEdgeCount = 0;
    let deletedEdgeCount = 0;
    if (cleanup !== 'preserve') {
      for (const edgeKey of linkedEdgeKeys) {
        const edge = this.getEdgeInternal(edgeKey);
        if (!edge) continue;
        const remainingEpisodes = edge.episodes.filter((episodeUuid) => episodeUuid !== uuid);
        if (cleanup === 'delete_orphaned' && remainingEpisodes.length === 0) {
          this.searchProvider.removeEdge(edgeKey);
          this.graph.dropEdge(edgeKey);
          deletedEdgeCount++;
          continue;
        }
        const updatedEdge = {
          ...edge,
          episodes: remainingEpisodes,
          updated_at: nowIso(),
        };
        this.graph.setEdgeAttribute(edgeKey, 'data', updatedEdge);
        updatedEdgeCount++;
      }
    }

    if (repairChain) {
      for (const successor of successors) {
        this.graph.setNodeAttribute(successor.uuid, 'data', {
          ...successor,
          previous_episode_uuid: episode.previous_episode_uuid,
          updated_at: nowIso(),
        });
      }
    }

    this.graph.dropNode(uuid);
    this.episodeOrder.delete(uuid);

    if (repairChain && episode.previous_episode_uuid) {
      const previous = this.getEpisodeOrEntity(episode.previous_episode_uuid, 'episode');
      if (previous?.group_id === episode.group_id) {
        for (const successor of successors) {
          const chainKey = `next_${episode.previous_episode_uuid}_${successor.uuid}`;
          if (!this.graph.hasEdge(chainKey)) {
            this.graph.addEdgeWithKey(chainKey, episode.previous_episode_uuid, successor.uuid, {
              type: 'next_episode',
              data: null,
            });
          }
        }
      }
    }

    return {
      episode_uuid: uuid,
      deleted: true,
      repaired_successor_count: repairChain ? successors.length : 0,
      linked_edge_count: linkedEdgeKeys.length,
      updated_edge_count: updatedEdgeCount,
      deleted_edge_count: deletedEdgeCount,
    };
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
    await this.runMutation(() => {
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
    });
  }

  async clearAll(): Promise<void> {
    await this.runMutation(() => this.resetGraph());
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
      version: CURRENT_GRAPH_DATA_VERSION,
      exported_at: nowIso(),
      group_id: groupId,
      entities,
      edges,
      episodes,
    };
  }

  async importGraph(data: ImportGraphData): Promise<void> {
    const migrated = migrateGraphData(data).data;
    await this.runMutation(() => this.mergeGraphData(migrated));
  }

  async getMigrationStatus(): Promise<StorageMigrationStatus> {
    return {
      ...this.migrationStatus,
      backup: { ...this.migrationStatus.backup },
    };
  }

  async migrateStorageSchema(
    options: StorageSchemaMigrationOptions,
  ): Promise<StorageSchemaMigrationResult> {
    return {
      backend: 'embedded',
      dry_run: options.dry_run,
      matched_count: 0,
      migrated_count: 0,
      remaining_count: 0,
      backup_required: false,
      additive_only: false,
    };
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

    return this.runMutation(() => {
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

        episodes.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );

        const toRemove = episodes.slice(maxEpisodes);
        for (const ep of toRemove) {
          if (this.graph.hasNode(ep.uuid)) {
            this.graph.dropNode(ep.uuid);
            removed++;
          }
        }
      }

      return removed;
    });
  }

  // ===== Persistence =====

  private async runMutation<T>(
    mutation: () => T | Promise<T>,
    options: MutationOptions<T> = {},
  ): Promise<T> {
    const startedAt = nowIso();
    const totalStarted = performance.now();
    const queueStarted = performance.now();
    const previousMutation = this.mutationTail;
    let releaseQueue!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previousMutation;
    const queueWaitMs = performance.now() - queueStarted;

    let releaseFileLock: () => Promise<void> = async () => {};
    let rollbackData: GraphData | null = null;
    let lockWaitMs = 0;
    let diskRefreshMs = 0;
    let rollbackExportMs = 0;
    let mutationMs = 0;
    let snapshotWriteMs = 0;
    let rollbackRestoreMs = 0;
    let snapshotBytes: number | null = null;
    let snapshotWritten = false;
    let success = false;
    try {
      if (this.persistPath) {
        const lockStarted = performance.now();
        releaseFileLock = await this.acquirePersistLock();
        lockWaitMs = performance.now() - lockStarted;
        const refreshStarted = performance.now();
        await this.refreshFromDiskUnderLock();
        diskRefreshMs = performance.now() - refreshStarted;
      }

      const rollbackExportStarted = performance.now();
      rollbackData = await this.exportGraph();
      rollbackExportMs = performance.now() - rollbackExportStarted;

      const mutationStarted = performance.now();
      const result = await mutation();
      mutationMs = performance.now() - mutationStarted;

      const shouldWriteSnapshot = options.shouldWriteSnapshot?.(result) ?? true;
      if (this.persistPath && shouldWriteSnapshot) {
        const snapshotWriteStarted = performance.now();
        snapshotBytes = await this.writeSnapshotUnderLock();
        snapshotWriteMs = performance.now() - snapshotWriteStarted;
        snapshotWritten = true;
      }

      success = true;
      return result;
    } catch (error) {
      if (rollbackData) {
        const rollbackRestoreStarted = performance.now();
        this.replaceGraphData(rollbackData);
        rollbackRestoreMs = performance.now() - rollbackRestoreStarted;
      }
      throw error;
    } finally {
      try {
        await releaseFileLock();
      } finally {
        const round = (value: number): number => Math.round(value * 1000) / 1000;
        this.lastMutationDiagnostics = {
          operation: options.operation ?? 'mutation',
          started_at: startedAt,
          success,
          persistence_enabled: Boolean(this.persistPath),
          snapshot_written: snapshotWritten,
          item_count: options.itemCount ?? 1,
          queue_wait_ms: round(queueWaitMs),
          lock_wait_ms: round(lockWaitMs),
          disk_refresh_ms: round(diskRefreshMs),
          rollback_export_ms: round(rollbackExportMs),
          mutation_ms: round(mutationMs),
          snapshot_write_ms: round(snapshotWriteMs),
          rollback_restore_ms: round(rollbackRestoreMs),
          total_ms: round(performance.now() - totalStarted),
          snapshot_bytes: snapshotBytes,
        };
        releaseQueue();
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;

    const releaseFileLock = await this.acquirePersistLock();
    try {
      const data = await this.readAndMigratePersistedDataUnderLock();
      this.replaceGraphData(data);
    } catch (error) {
      throw new Error(
        `Engram: Failed to load or migrate embedded storage at ${this.persistPath}: ${(error as Error).message}`,
      );
    } finally {
      await releaseFileLock();
    }
  }

  private async refreshFromDiskUnderLock(): Promise<void> {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;

    const data = await this.readAndMigratePersistedDataUnderLock();
    this.replaceGraphData(data);
  }

  private async writeSnapshotUnderLock(): Promise<number> {
    if (!this.persistPath) return 0;

    const data = await this.exportGraph();
    const payload = JSON.stringify(data, null, 2);
    await this.writeTextAtomic(payload, this.persistPath);
    return Buffer.byteLength(payload, 'utf-8');
  }

  private async readAndMigratePersistedDataUnderLock(): Promise<GraphData> {
    if (!this.persistPath) throw new Error('Embedded persistence path is not configured');
    const raw = await fs.promises.readFile(this.persistPath, 'utf-8');
    const migration = migrateGraphData(JSON.parse(raw));
    const backupPath = `${this.persistPath}${EMBEDDED_BACKUP_SUFFIX}`;
    const legacyEpisodeCount = Math.max(
      migration.report.episode_defaults_applied.episode_kind,
      migration.report.episode_defaults_applied.trust_level,
      migration.report.episode_defaults_applied.review_status,
    );

    if (migration.report.migration_required) {
      const backupCreated = await this.ensureVerifiedMigrationBackup(raw, backupPath);
      await this.writeGraphDataAtomic(migration.data, this.persistPath);
      this.migrationStatus = {
        backend: 'embedded',
        target_version: CURRENT_GRAPH_DATA_VERSION,
        source_version: migration.report.source_version,
        migration_required: false,
        legacy_episode_count: legacyEpisodeCount,
        automatic_migration_completed: true,
        backup: {
          created: backupCreated,
          verified: true,
          path: backupPath,
        },
      };
      return migration.data;
    }

    const existingBackup = await this.inspectExistingBackup(backupPath, migration.data);
    this.migrationStatus = {
      backend: 'embedded',
      target_version: CURRENT_GRAPH_DATA_VERSION,
      source_version:
        existingBackup?.verified && existingBackup.sourceVersion
          ? existingBackup.sourceVersion
          : migration.report.source_version,
      migration_required: false,
      legacy_episode_count: existingBackup?.verified ? existingBackup.legacyEpisodeCount : 0,
      automatic_migration_completed: existingBackup?.verified ?? false,
      backup: {
        created: false,
        verified: existingBackup?.verified ?? false,
        path: existingBackup ? backupPath : null,
      },
    };
    return migration.data;
  }

  private async ensureVerifiedMigrationBackup(raw: string, backupPath: string): Promise<boolean> {
    let created = false;
    if (fs.existsSync(backupPath)) {
      const existing = await fs.promises.readFile(backupPath, 'utf-8');
      if (this.contentChecksum(existing) !== this.contentChecksum(raw)) {
        throw new Error(`Existing migration backup does not match source storage: ${backupPath}`);
      }
    } else {
      await this.writeTextAtomic(raw, backupPath);
      created = true;
    }

    const verified = await fs.promises.readFile(backupPath, 'utf-8');
    migrateGraphData(JSON.parse(verified));
    if (this.contentChecksum(verified) !== this.contentChecksum(raw)) {
      throw new Error(`Migration backup verification failed: ${backupPath}`);
    }
    await fs.promises.chmod(backupPath, 0o600);
    return created;
  }

  private async inspectExistingBackup(
    backupPath: string,
    currentData: GraphData,
  ): Promise<{
    sourceVersion: '1.0' | '2.0' | null;
    legacyEpisodeCount: number;
    verified: boolean;
  } | null> {
    if (!fs.existsSync(backupPath)) return null;
    try {
      const raw = await fs.promises.readFile(backupPath, 'utf-8');
      const migration = migrateGraphData(JSON.parse(raw));
      return {
        sourceVersion: migration.report.source_version,
        legacyEpisodeCount: Math.max(
          migration.report.episode_defaults_applied.episode_kind,
          migration.report.episode_defaults_applied.trust_level,
          migration.report.episode_defaults_applied.review_status,
        ),
        verified:
          this.contentChecksum(JSON.stringify(migration.data)) ===
          this.contentChecksum(JSON.stringify(currentData)),
      };
    } catch {
      return { sourceVersion: null, legacyEpisodeCount: 0, verified: false };
    }
  }

  private async writeGraphDataAtomic(data: GraphData, targetPath: string): Promise<void> {
    await this.writeTextAtomic(JSON.stringify(data, null, 2), targetPath);
  }

  private async writeTextAtomic(payload: string, targetPath: string): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${generateUuid()}.tmp`;

    try {
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
      await fs.promises.rename(tmpPath, targetPath);
      await fs.promises.chmod(targetPath, 0o600);
    } catch (error) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private contentChecksum(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private replaceGraphData(data: GraphData): void {
    this.resetGraph();
    this.mergeGraphData(data);
  }

  private resetGraph(): void {
    this.graph.clear();
    this.searchProvider.clear();
    this.episodeOrder.clear();
    this.nextOrder = 0;
  }

  private mergeGraphData(data: GraphData): void {
    // Import entities first because relationship edges require both endpoints.
    for (const entity of data.entities) {
      if (this.graph.hasNode(entity.uuid)) continue;
      this.graph.addNode(entity.uuid, { type: 'entity', data: entity });
      this.searchProvider.indexEntity(entity.uuid, {
        name: entity.name,
        summary: entity.summary,
        entity_type: entity.entity_type,
      });
    }

    const sortedEpisodes = [...data.episodes].sort((a, b) => {
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      return timeDiff;
    });
    for (const episode of sortedEpisodes) {
      if (this.graph.hasNode(episode.uuid)) continue;
      this.graph.addNode(episode.uuid, { type: 'episode', data: episode });
      this.episodeOrder.set(episode.uuid, this.nextOrder++);
    }

    for (const edge of data.edges) {
      if (
        this.graph.hasEdge(edge.uuid) ||
        !this.graph.hasNode(edge.source_node_uuid) ||
        !this.graph.hasNode(edge.target_node_uuid)
      ) {
        continue;
      }
      this.graph.addEdgeWithKey(edge.uuid, edge.source_node_uuid, edge.target_node_uuid, {
        type: 'entity_edge',
        data: edge,
      });
      this.searchProvider.indexEdge(edge.uuid, {
        name: edge.name,
        fact: edge.fact,
      });
    }

    for (const episode of data.episodes) {
      const previousUuid = episode.previous_episode_uuid;
      if (!previousUuid || !this.graph.hasNode(previousUuid) || !this.graph.hasNode(episode.uuid)) {
        continue;
      }
      const previous = this.getEpisodeOrEntity(previousUuid, 'episode');
      if (!previous || previous.group_id !== episode.group_id) continue;

      const chainKey = `next_${previousUuid}_${episode.uuid}`;
      if (!this.graph.hasEdge(chainKey)) {
        this.graph.addEdgeWithKey(chainKey, previousUuid, episode.uuid, {
          type: 'next_episode',
          data: null,
        });
      }
    }
  }

  private getEpisodeOrEntity(
    uuid: string,
    expectedType: NodeType,
  ): EntityNode | EpisodicNode | null {
    if (!this.graph.hasNode(uuid)) return null;
    const attrs = this.graph.getNodeAttributes(uuid);
    return attrs.type === expectedType ? attrs.data : null;
  }

  private getEdgeInternal(uuid: string): EntityEdge | null {
    if (!this.graph.hasEdge(uuid)) return null;
    const attrs = this.graph.getEdgeAttributes(uuid);
    return attrs.type === 'entity_edge' ? (attrs.data as EntityEdge) : null;
  }

  private async acquirePersistLock(): Promise<() => Promise<void>> {
    if (!this.persistPath) return async () => {};

    const lockPath = `${this.persistPath}.lock`;
    const startedAt = Date.now();

    for (;;) {
      try {
        const lockToken = generateUuid();
        const handle = await fs.promises.open(lockPath, 'wx');
        try {
          await handle.writeFile(
            `${lockToken}\n${process.pid}\n${new Date().toISOString()}\n`,
            'utf-8',
          );
        } catch (error) {
          await handle.close().catch(() => {});
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
          throw error;
        }
        const heartbeat = setInterval(() => {
          void handle.utimes(new Date(), new Date()).catch(() => {});
        }, PERSIST_LOCK_HEARTBEAT_MS);
        heartbeat.unref();
        return async () => {
          clearInterval(heartbeat);
          await handle.close().catch(() => {});
          try {
            const activeToken = (await fs.promises.readFile(lockPath, 'utf-8')).split('\n')[0];
            if (activeToken === lockToken) {
              await fs.promises.rm(lockPath, { force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
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
