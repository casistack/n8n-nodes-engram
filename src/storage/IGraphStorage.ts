import type { StorageObservation } from '../schemas/StorageObservation.schema';
import type {
  AutomaticBindingCommand,
  AutomaticBindingRecord,
} from '../schemas/AutomaticOperations.schema';
import type {
  AutomaticLegacyObservationRequest,
  AutomaticLegacyObservationResult,
} from '../schemas/AutomaticLedger.schema';
import type {
  QueueBinding,
  QueueStats,
  QueueClearOptions,
  QueueClearImpact,
  QueueLimits,
  QueueCommand,
  QueueResult,
  ExtractionJob,
  StagedExtraction,
} from '../schemas';
import type { AutomaticClaimReadScope } from './AutomaticClaimReadScope';
import type { AutomaticClaimReadResult } from '../schemas/AutomaticClaimRead.schema';
import type { CompositionalRetrievalSnapshotResultV3 } from '../schemas/CompositionalRetrievalSnapshotV3.schema';
import type { AutomaticCaptureBeginRequestV2 } from '../schemas/AutomaticCapture.schema';
import type {
  AutomaticCaptureBeginInternalResultV2,
  AutomaticHumanCompletionInternalResultV2,
  AutomaticCaptureAdminFenceRequestV2,
  AutomaticCaptureReadRequestV2,
  AutomaticCaptureReadResultV2,
  AutomaticCaptureResumeInternalResultV2,
  AutomaticCaptureCancelInternalResultV2,
} from '../schemas/AutomaticCaptureApi.schema';
import type { PrivateOneUseAutomaticLeaseHandle } from './AutomaticCaptureHandles';
import type {
  AutomaticAssistantCaptureIntentV2,
  AutomaticAssistantFinalWriterResultV2,
} from '../schemas/AutomaticAssistantCapture.schema';
import type { PrivateAutonomousPersonalAssistantFinalInvocationV4 } from './AutonomousPersonalAssistantFinalInvocationV4';
import type { AutomaticAssistantWorkBudgetV2 } from '../schemas/AutomaticAssistantWorkBudget.schema';
import type { CompositionalCaptureBeginMethodRequestV3 } from '../schemas/CompositionalAutomaticCaptureLifecycleV3.schema';
import type {
  CompositionalCaptureBeginInternalResultV3,
  CompositionalCaptureCompletionInternalResultV3,
  PrivateOneUseCompositionalCaptureLeaseHandleV3,
} from '../schemas/CompositionalAutomaticCaptureRegistryV3.schema';
import type {
  CompositionalClaimReviewRequestV3,
  CompositionalClaimReviewResultV3,
} from '../schemas/CompositionalClaimReviewV3.schema';
import type { AutonomousPersonalCaptureBeginV4InternalResult } from './AutonomousPersonalCaptureHandlesV4';
import type { AutonomousPersonalCompletionStorageV4Result } from '../schemas/AutonomousPersonalCompletionStorageV4.schema';
import type { PrivateAutonomousPersonalCompletionBackendOutcomeV4 } from './AutonomousPersonalCompletionBackendRegistryV4';
import type { AutonomousPersonalCaptureProviderPreflightV4 } from '../schemas/AutonomousPersonalCaptureProviderV4.schema';
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
  EpisodeRole,
  EpisodeSourceType,
  EpisodeKind,
  EpisodeTrustLevel,
  EpisodeReviewStatus,
} from '../schemas';

export interface EntitySearchResult {
  entity: EntityNode;
  score: number;
}

export interface EdgeSearchResult {
  match_evidence?: { text: boolean; vector: boolean };
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

export interface AppendEpisodeResult {
  episode: EpisodicNode;
  created: boolean;
}

export type EpisodeHygieneRule = 'empty_assistant_output';

export interface StorageMutationDiagnostics {
  operation: string;
  started_at: string;
  success: boolean;
  persistence_enabled: boolean;
  snapshot_written: boolean;
  item_count: number;
  queue_wait_ms: number;
  lock_wait_ms: number;
  disk_refresh_ms: number;
  rollback_export_ms: number;
  mutation_ms: number;
  snapshot_write_ms: number;
  rollback_restore_ms: number;
  total_ms: number;
  snapshot_bytes: number | null;
  rollback_diagnostic?: 'rollback_persistence_failed';
}

export interface EpisodeFilterOptions {
  role?: EpisodeRole;
  source_type?: EpisodeSourceType;
  episode_kind?: EpisodeKind;
  trust_level?: EpisodeTrustLevel;
  review_status?: EpisodeReviewStatus;
  sender_id?: string;
  sender_name?: string;
  conversation_id?: string;
  source_message_id?: string;
  source_workflow_id?: string;
  source_execution_id?: string;
  reference_after?: string;
  reference_before?: string;
  created_after?: string;
  created_before?: string;
  hygiene_rule?: EpisodeHygieneRule;
  content_contains?: string;
  limit?: number;
  offset?: number;
  sort_by?: 'reference_time' | 'created_at';
  sort_order?: 'asc' | 'desc';
}

export type UpdateEpisodeInput = Partial<
  Pick<
    EpisodicNode,
    'content' | 'sender_name' | 'trust_level' | 'confidence' | 'review_status' | 'attributes'
  >
>;

export type EpisodeFactCleanupPolicy = 'preserve' | 'unlink' | 'delete_orphaned';

export interface DeleteEpisodeOptions {
  repair_chain?: boolean;
  fact_cleanup?: EpisodeFactCleanupPolicy;
}

export interface DeleteEpisodeResult {
  episode_uuid: string;
  deleted: boolean;
  repaired_successor_count: number;
  linked_edge_count: number;
  updated_edge_count: number;
  deleted_edge_count: number;
}

export interface PurgeEpisodesOptions extends DeleteEpisodeOptions {
  dry_run?: boolean;
  limit: number;
}

export interface PurgeEpisodesResult {
  matched_count: number;
  deleted_count: number;
  truncated: boolean;
  dry_run: boolean;
  linked_edge_count: number;
  updated_edge_count: number;
  deleted_edge_count: number;
  episode_uuids: string[];
}

export interface StorageMigrationStatus {
  backend: 'embedded' | 'neo4j';
  target_version: '2.0';
  source_version: '1.0' | '2.0' | 'database' | 'new';
  migration_required: boolean;
  legacy_episode_count: number;
  automatic_migration_completed: boolean;
  backup: {
    created: boolean;
    verified: boolean;
    path: string | null;
  };
}

export interface StorageSchemaMigrationOptions {
  dry_run: boolean;
  limit: number;
}

export interface StorageSchemaMigrationResult {
  backend: 'embedded' | 'neo4j';
  dry_run: boolean;
  matched_count: number;
  migrated_count: number;
  remaining_count: number;
  backup_required: boolean;
  additive_only: boolean;
}

export interface IGraphStorage {
  /** Fixed native V4 entry only; the opaque attempt is not JSON or permission. */
  beginAndClaimAutonomousPersonalCaptureV4?(
    input: unknown,
    attempt: unknown,
  ): Promise<AutonomousPersonalCaptureBeginV4InternalResult>;
  /** Fixed native provider preparation; consumes its initial handle before backend I/O. */
  prepareAutonomousPersonalCaptureProviderV4?(
    handle: unknown,
  ): Promise<AutonomousPersonalCaptureProviderPreflightV4>;
  /** Native completion observation only; the result grants no continuation authority. */
  completeAutonomousPersonalCaptureV4?(
    handle: unknown,
  ): Promise<AutonomousPersonalCompletionStorageV4Result>;
  /** Fixed native completion path; returns an opaque, one-use backend outcome token. */
  completeAutonomousPersonalCaptureForNativeV4?(
    handle: unknown,
  ): Promise<PrivateAutonomousPersonalCompletionBackendOutcomeV4>;
  /** Opt-in richer human capture; an initial lease is not agent permission. */
  beginAndClaimCompositionalCaptureV3?(
    input: CompositionalCaptureBeginMethodRequestV3,
  ): Promise<CompositionalCaptureBeginInternalResultV3>;
  completeCompositionalHumanCaptureV3?(
    handle: PrivateOneUseCompositionalCaptureLeaseHandleV3,
  ): Promise<CompositionalCaptureCompletionInternalResultV3>;
  /** Explicit operator review; atomically updates an attributed claim/value pair. */
  reviewCompositionalClaimV3?(
    request: CompositionalClaimReviewRequestV3,
  ): Promise<CompositionalClaimReviewResultV3>;
  /** Internal write-only final saving. Never grants agent or delivery permission. */
  saveAssistantFinalV2?(
    intent: AutomaticAssistantCaptureIntentV2,
    budget?: AutomaticAssistantWorkBudgetV2,
  ): Promise<AutomaticAssistantFinalWriterResultV2>;
  /** Fixed native V4 final writer; only a genuine one-use invocation is accepted. */
  saveAssistantFinalV4?(
    invocation: PrivateAutonomousPersonalAssistantFinalInvocationV4,
  ): Promise<AutomaticAssistantFinalWriterResultV2>;
  /** Internal opt-in capture capability; a claimed lease is not processing permission. */
  beginAndClaimAutomaticCaptureV2?(
    request: AutomaticCaptureBeginRequestV2,
    mode?: 'existingStore',
  ): Promise<AutomaticCaptureBeginInternalResultV2>;
  completeHumanCaptureV2?(
    handle: PrivateOneUseAutomaticLeaseHandle<'human_turn_memory'>,
    plan: StagedExtraction,
  ): Promise<AutomaticHumanCompletionInternalResultV2>;
  /** Explicit authorized operator controls; none may grant agent processing. */
  resumeAutomaticCaptureV2?(
    request: AutomaticCaptureAdminFenceRequestV2,
  ): Promise<AutomaticCaptureResumeInternalResultV2>;
  cancelAutomaticCaptureV2?(
    request: AutomaticCaptureAdminFenceRequestV2,
  ): Promise<AutomaticCaptureCancelInternalResultV2>;
  getAutomaticCaptureOutcomeV2?(
    request: AutomaticCaptureReadRequestV2,
  ): Promise<AutomaticCaptureReadResultV2>;
  automaticBindingCommand?(command: AutomaticBindingCommand): Promise<AutomaticBindingRecord>;
  /** Explicitly records bounded legacy-unconfirmed observation; never grants processing permission. */
  observeLegacyAutomaticSource?(
    request: AutomaticLegacyObservationRequest,
  ): Promise<AutomaticLegacyObservationResult>;
  // Optional extraction transaction capabilities; absent on third-party adapters.
  withExtractionDiagnostics?<T>(
    observer: (value: StorageObservation) => void,
    operation: () => Promise<T>,
  ): Promise<T>;
  supportsDurableExtraction?(): boolean;
  extractionBackend?(): 'embedded' | 'neo4j';
  /** Read-only configured-store identity DATA; it grants no graph access or write authority. */
  getNativeAutomaticCaptureStoreIdentityV4?(): string | null;
  importExtractionBackup?(input: unknown): Promise<void>;
  previewQueueClear?(groupId?: string): Promise<QueueClearImpact>;
  readExtractionSnapshot?(groupId?: string): Promise<GraphData>;
  /** Internal coherent V2 commitment read; no caller receipt or processing permit. */
  readAutomaticClaimContext?(
    groupId: string,
    edgeId: string,
    scope: AutomaticClaimReadScope,
  ): Promise<AutomaticClaimReadResult>;
  /** Internal coherent full-root V3 retrieval snapshot; never grants processing permission. */
  readCompositionalRetrievalSnapshotV3?(
    scope: AutomaticClaimReadScope,
  ): Promise<CompositionalRetrievalSnapshotResultV3>;
  appendEpisodesWithExtraction?(
    episodes: CreateEpisodicNode[],
    eligible: number[],
    binding: QueueBinding,
    limits: QueueLimits,
  ): Promise<{ results: AppendEpisodeResult[]; jobs: ExtractionJob[]; queue: QueueStats }>;
  appendAutomaticEpisodes?(episodes: CreateEpisodicNode[]): Promise<AppendEpisodeResult[]>;
  appendAutomaticEpisodesWithExtraction?(
    episodes: CreateEpisodicNode[],
    eligible: number[],
    binding: QueueBinding,
    limits: QueueLimits,
  ): Promise<{ results: AppendEpisodeResult[]; jobs: ExtractionJob[]; queue: QueueStats }>;
  extractionQueueCommand?(command: QueueCommand): Promise<QueueResult>;
  applyStagedExtraction?(plan: StagedExtraction): Promise<void>;

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
  getEdgesBetween(sourceUuid: string, targetUuid: string, limit?: number): Promise<EntityEdge[]>;
  getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]>;
  updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge>;
  deleteEdge(uuid: string): Promise<void>;

  // === Episode Operations ===
  addEpisode(episode: CreateEpisodicNode): Promise<EpisodicNode>;
  appendEpisode(episode: CreateEpisodicNode): Promise<AppendEpisodeResult>;
  appendEpisodes(episodes: CreateEpisodicNode[]): Promise<AppendEpisodeResult[]>;
  getEpisode(uuid: string): Promise<EpisodicNode | null>;
  getEpisodes(uuids: string[]): Promise<EpisodicNode[]>;
  listEpisodes(groupId: string, options?: EpisodeFilterOptions): Promise<EpisodicNode[]>;
  updateEpisode(uuid: string, updates: UpdateEpisodeInput): Promise<EpisodicNode>;
  deleteEpisode(uuid: string, options?: DeleteEpisodeOptions): Promise<DeleteEpisodeResult>;
  purgeEpisodes(
    groupId: string,
    filters: EpisodeFilterOptions,
    options: PurgeEpisodesOptions,
  ): Promise<PurgeEpisodesResult>;
  getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]>;
  getEpisodeCount(groupId: string, filters?: EpisodeFilterOptions): Promise<number>;
  getEpisodesByDateRange(
    groupId: string,
    from: string,
    to: string,
    limit?: number,
  ): Promise<EpisodicNode[]>;
  getLastMutationDiagnostics?(): StorageMutationDiagnostics | null;

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
  clearGroup(groupId: string, options?: QueueClearOptions): Promise<void>;
  clearAll(options?: QueueClearOptions): Promise<void>;
  exportGraph(groupId?: string): Promise<GraphData>;
  importGraph(data: ImportGraphData): Promise<void>;
  getStats(groupId?: string): Promise<GraphStats>;
  getMigrationStatus(): Promise<StorageMigrationStatus>;
  migrateStorageSchema(
    options: StorageSchemaMigrationOptions,
  ): Promise<StorageSchemaMigrationResult>;
  rebuildSearchIndex?(): Promise<{ indexed_entities: number; indexed_edges: number }>;

  // === Retention ===
  applyRetention(groupId: string, policy: RetentionPolicy): Promise<number>;
}
