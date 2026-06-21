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

export interface EntitySearchResult {
  entity: EntityNode;
  score: number;
}

export interface EdgeSearchResult {
  edge: EntityEdge;
  sourceEntity: EntityNode;
  targetEntity: EntityNode;
  score: number;
}

export interface ListOptions {
  entity_type?: string;
  limit?: number;
  offset?: number;
  created_after?: string;
  created_before?: string;
}

export interface EntitySearchOptions {
  limit?: number;
  entity_type?: string;
  min_score?: number;
  created_after?: string;
  created_before?: string;
}

export interface EdgeSearchOptions {
  limit?: number;
  min_score?: number;
  include_expired?: boolean;
  valid_after?: string;
  valid_before?: string;
  created_after?: string;
  created_before?: string;
}

export interface VectorSearchOptions {
  limit?: number;
  min_score?: number;
}

export interface ChangelogEntry {
  edge: EntityEdge;
  sourceEntity: EntityNode;
  targetEntity: EntityNode;
  change_type: 'created' | 'expired' | 'invalidated';
  changed_at: string;
}

export interface RetentionPolicy {
  type: 'forever' | 'days' | 'max_episodes';
  value?: number;
}

export interface IGraphStorage {
  // === Lifecycle ===
  initialize(): Promise<void>;
  close(): Promise<void>;

  // === Entity Operations ===
  addEntity(entity: CreateEntityNode): Promise<EntityNode>;
  getEntity(uuid: string): Promise<EntityNode | null>;
  getEntityByName(name: string, groupId: string): Promise<EntityNode | null>;
  updateEntity(uuid: string, updates: Partial<EntityNode>): Promise<EntityNode>;
  deleteEntity(uuid: string): Promise<void>;
  listEntities(groupId: string, options?: ListOptions): Promise<EntityNode[]>;

  // === Edge/Relationship Operations ===
  addEdge(edge: CreateEntityEdge): Promise<EntityEdge>;
  getEdge(uuid: string): Promise<EntityEdge | null>;
  getEdgesBetween(sourceUuid: string, targetUuid: string): Promise<EntityEdge[]>;
  getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]>;
  updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge>;
  deleteEdge(uuid: string): Promise<void>;

  // === Episode Operations ===
  addEpisode(episode: CreateEpisodicNode): Promise<EpisodicNode>;
  getEpisode(uuid: string): Promise<EpisodicNode | null>;
  getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]>;
  getEpisodeCount(groupId: string): Promise<number>;
  getEpisodesByDateRange(
    groupId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<EpisodicNode[]>;

  // === Changelog ===
  getEdgeChangelog(
    groupId: string,
    since: string,
    options?: { limit?: number },
  ): Promise<ChangelogEntry[]>;

  // === Search ===
  searchEntities(
    query: string,
    groupId: string,
    options?: EntitySearchOptions,
  ): Promise<EntitySearchResult[]>;

  searchEdges(
    query: string,
    groupId: string,
    options?: EdgeSearchOptions,
  ): Promise<EdgeSearchResult[]>;

  // === Vector Search (optional — embedding support) ===
  searchEntitiesByVector?(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EntitySearchResult[]>;

  searchEdgesByVector?(
    vector: number[],
    groupId: string,
    options?: VectorSearchOptions,
  ): Promise<EdgeSearchResult[]>;

  // === Graph Management ===
  clearGroup(groupId: string): Promise<void>;
  clearAll(): Promise<void>;
  exportGraph(groupId?: string): Promise<GraphData>;
  importGraph(data: GraphData): Promise<void>;
  getStats(groupId?: string): Promise<GraphStats>;
  rebuildSearchIndex?(): Promise<{ indexed_entities: number; indexed_edges: number }>;

  // === Retention ===
  applyRetention(groupId: string, policy: RetentionPolicy): Promise<number>;
}
