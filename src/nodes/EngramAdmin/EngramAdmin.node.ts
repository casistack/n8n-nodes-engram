import { StorageAccumulator } from '../../storage/StorageDiagnostics';
import { automaticAdminProperties, executeAutomaticAdmin } from '../../utils/automaticAdmin';
import {
  AutonomousPersonalNativeAdminV4OutputSchema,
  type AutonomousPersonalNativeAdminV4Output,
} from '../../schemas/AutonomousPersonalNativeAdminV4.schema';
import { automaticProfileProperty, readAutomaticPolicy } from '../../utils/automaticMemory';
import {
  usesReplaySafeCaptureOutputs,
  replaySafeCaptureOutputsExpression,
  stoppedReplaySafeCapture,
  readReplaySafeHumanCaptureRequest,
} from '../../utils/replaySafeAutomaticAdmin';
import { fingerprint } from '../../extraction/QueueState';
import { existsSync, promises as fsPromises } from 'fs';
import { dirname } from 'path';
import { advancedExtractionProperties, readExtractionPolicy } from '../../utils/advancedExtraction';
import {
  processExtractionJobs,
  queueBinding,
  type ExtractionSettings,
} from '../../extraction/DurableExtraction';
import { jobs, exportQueueBackup, QueueClearRequiresReview } from '../../extraction/QueueState';
import { ExtractionTemperatureSchema } from '../../schemas';
import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type IDataObject,
  NodeOperationError,
} from 'n8n-workflow';
import { createHash } from 'crypto';

import { createStorage } from '../../storage/StorageFactory';
import type { EpisodeFilterOptions } from '../../storage/IGraphStorage';
import {
  ImportGraphDataSchema,
  migrateGraphData,
  type GraphData,
  type ImportGraphData,
} from '../../schemas';
import {
  readLatestAutonomousPersonalExecutionDiagnosticsV1,
  runWithAutonomousPersonalExecutionEntryV1,
} from '../../utils/AutonomousPersonalExecutionEntryV1';
import {
  markCurrentAutonomousPersonalExecutionStageV1,
  AutonomousPersonalExecutionScopeBudgetError,
  AutonomousPersonalExecutionScopeError,
} from '../../storage/AutonomousPersonalExecutionScopeV1';
import type { AutonomousPersonalExecutionDiagnosticsV1 } from '../../schemas/AutonomousPersonalExecutionDiagnosticsV1.schema';
import { nowIso } from '../../utils/temporal';
import { resolveStoragePath, migrateStorageIfNeeded } from '../../utils/helpers';
import { customStoragePathProperty } from '../../descriptions';
import { CommunityDetector } from '../../community/CommunityDetector';
import { CommunitySummarizer } from '../../community/CommunitySummarizer';
import { LlmClient } from '../../extraction/LlmClient';
import { EmbeddingService } from '../../embeddings';

interface DiagnosticsContext {
  storeIdentity?: string;
  backend: string;
  persistPath?: string;
  workflowId?: string;
  customStoragePathConfigured?: boolean;
  databaseConfigured?: boolean;
}

function nativeScopeFailureReason(
  error: unknown,
): 'budget_exhausted' | 'cancelled' | 'clock_invalid' | 'clock_regression' | undefined {
  if (error instanceof AutonomousPersonalExecutionScopeBudgetError) {
    return error.budgetReason === 'cancelled' ? 'cancelled' : 'budget_exhausted';
  }
  if (error instanceof AutonomousPersonalExecutionScopeError) {
    if (error.reason === 'clock_invalid' || error.reason === 'clock_regression') {
      return error.reason;
    }
  }
  return undefined;
}

function nativeUnconfirmedOutput(error: unknown): AutonomousPersonalNativeAdminV4Output {
  return AutonomousPersonalNativeAdminV4OutputSchema.parse({
    version: 4,
    should_process: false,
    status: 'unconfirmed',
    reason: nativeScopeFailureReason(error) ?? 'storage_error',
  });
}

function attachNativeExecutionDiagnostics(
  output: INodeExecutionData[][],
  diagnostics: Readonly<AutonomousPersonalExecutionDiagnosticsV1> | null,
): INodeExecutionData[][] {
  if (diagnostics === null) return output;
  try {
    return output.map((branch) =>
      branch.map((item) => {
        if (item.json === null || typeof item.json !== 'object' || Array.isArray(item.json)) {
          return item;
        }
        const parsed = AutonomousPersonalNativeAdminV4OutputSchema.safeParse({
          ...item.json,
          execution_diagnostics: diagnostics,
        });
        return parsed.success
          ? {
              ...item,
              json: { ...parsed.data, execution_diagnostics: diagnostics },
            }
          : item;
      }),
    );
  } catch {
    // Diagnostics are optional DATA and cannot change a capture outcome.
    return output;
  }
}

export class EngramAdmin implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Admin',
    name: 'engramAdmin',
    icon: 'file:engram-admin.png',
    group: ['transform'],
    version: [1, 2, 3],
    description: 'Manage and administer the Engram knowledge graph',
    defaults: {
      name: 'Engram Admin',
    },
    inputs: [NodeConnectionType.Main],
    outputs: replaySafeCaptureOutputsExpression,
    credentials: [
      {
        name: 'engramNeo4jApi',
        required: false,
        displayOptions: {
          show: {
            backend: ['neo4j'],
          },
        },
      },
      {
        name: 'engramExtractionApi',
        required: false,
      },
    ],
    properties: [
      ...automaticAdminProperties,
      {
        ...automaticProfileProperty,
        displayOptions: { show: { '@version': [3], resource: ['extractionQueue'] } },
      },
      {
        displayName: 'Backend',
        name: 'backend',
        type: 'options',
        options: [
          { name: 'Embedded (Graphology)', value: 'embedded' },
          { name: 'Neo4j (Remote)', value: 'neo4j' },
        ],
        default: 'embedded',
      },
      customStoragePathProperty,
      // ===== Resource =====
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Automatic Memory',
            value: 'automaticMemory',
            description: 'Capture human memory and manage verified actor bindings',
          },
          {
            name: 'Extraction Queue',
            value: 'extractionQueue',
            description: 'Process and inspect durable extraction jobs',
          },
          {
            name: 'Monitoring',
            value: 'monitoring',
            description: 'Graph statistics and group monitoring',
          },
          {
            name: 'Lifecycle',
            value: 'lifecycle',
            description: 'Data retention, clearing groups, and cleanup',
          },
          {
            name: 'Hygiene',
            value: 'hygiene',
            description: 'Find orphaned entities, duplicates, and stale edges',
          },
          {
            name: 'Portability',
            value: 'portability',
            description: 'Export and import graph data',
          },
          {
            name: 'Analysis',
            value: 'analysis',
            description: 'Community detection and graph analysis',
          },
        ],
        default: 'monitoring',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'queueStatus',
        options: [
          { name: 'Status', value: 'queueStatus', action: 'Inspect extraction queue' },
          { name: 'Process Jobs', value: 'queueProcess', action: 'Process extraction jobs' },
          { name: 'Pause Job', value: 'queuePause', action: 'Pause extraction job' },
          { name: 'Resume Job', value: 'queueResume', action: 'Resume extraction job' },
          { name: 'Retry Job', value: 'queueRetry', action: 'Retry extraction job' },
          {
            name: 'Rebind Job',
            value: 'queueRebind',
            action: 'Rebind pending extraction configuration',
          },
          { name: 'Cancel Job', value: 'queueCancel', action: 'Cancel extraction job' },
          {
            name: 'Compact Job Diagnostics',
            value: 'queueCompact',
            action: 'Compact completed job diagnostics',
          },
          {
            name: 'Export Queue Backup',
            value: 'queueExport',
            action: 'Export extraction queue backup',
          },
          {
            name: 'Import Queue Backup',
            value: 'queueImport',
            action: 'Import paused extraction queue backup',
          },
        ],
        displayOptions: { show: { resource: ['extractionQueue'], '@version': [2, 3] } },
      },
      {
        displayName: 'Memory Workflow ID',
        name: 'queueStorageWorkflowId',
        type: 'string',
        default: '',
        required: true,
        description:
          'Producer workflow ID used in the embedded store filename; separate workers must point at the original store',
        displayOptions: { show: { resource: ['extractionQueue'], backend: ['embedded'] } },
      },
      {
        displayName: 'Queue Group ID',
        name: 'queueGroupId',
        type: 'string',
        default: '',
        required: true,
        description: 'Exact existing memory namespace; use the same store as the Memory node',
        displayOptions: { show: { resource: ['extractionQueue'] } },
      },
      {
        displayName: 'Worker Batch Size',
        name: 'queueBatchSize',
        type: 'number',
        default: 1,
        typeOptions: { minValue: 1, maxValue: 10 },
        description: 'Maximum jobs processed sequentially during this worker execution',
        displayOptions: { show: { operation: ['queueProcess'] } },
      },
      {
        displayName: 'Extraction Route ID',
        name: 'extractionRouteId',
        type: 'string',
        default: '',
        description: 'Nonsecret route identifier matching the Memory node',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Extraction Model',
        name: 'queueModel',
        type: 'string',
        default: '',
        description: 'Exact extraction model configured on the producer Memory node',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Extraction Temperature Mode',
        name: 'queueTemperatureMode',
        type: 'options',
        default: 'legacy',
        options: [
          { name: 'Legacy', value: 'legacy' },
          { name: 'Provider Default', value: 'providerDefault' },
          { name: 'Custom', value: 'custom' },
        ],
        description: 'Match the producer generation setting',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Extraction Temperature',
        name: 'queueTemperature',
        type: 'number',
        default: 0,
        description: 'Custom extraction temperature matching the producer',
        displayOptions: {
          show: {
            resource: ['extractionQueue', 'automaticMemory'],
            queueTemperatureMode: ['custom'],
          },
        },
      },
      {
        displayName: 'Entity Types',
        name: 'queueEntityTypes',
        type: 'string',
        default: 'person, organization, location, concept, event',
        description: 'Comma-separated types matching the producer',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Auto-Accept Confidence',
        name: 'queueAutoAccept',
        type: 'number',
        default: 0.85,
        typeOptions: { minValue: 0, maxValue: 1 },
        description: 'Confidence threshold matching the producer',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Reject Below Confidence',
        name: 'queueRejectBelow',
        type: 'number',
        default: 0.3,
        typeOptions: { minValue: 0, maxValue: 1 },
        description: 'Rejection threshold matching the producer',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Worker Embeddings',
        name: 'queueEmbeddings',
        type: 'options',
        default: 'disabled',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        description: 'Match the producer embedding configuration',
        displayOptions: { show: { resource: ['extractionQueue', 'automaticMemory'] } },
      },
      {
        displayName: 'Embedding Model',
        name: 'queueEmbeddingModel',
        type: 'string',
        default: '',
        description: 'Embedding model matching the producer',
        displayOptions: {
          show: { resource: ['extractionQueue', 'automaticMemory'], queueEmbeddings: ['enabled'] },
        },
      },
      ...advancedExtractionProperties.map((property) => ({
        ...property,
        displayOptions: {
          show: { resource: ['extractionQueue', 'automaticMemory'], '@version': [2, 3] },
        },
        ...(property.name === 'advancedExtractionPolicy' ? { default: 'bounded' } : {}),
      })),
      {
        displayName: 'Job ID',
        name: 'queueJobId',
        type: 'string',
        default: '',
        description: 'Exact job UUID from queue status',
        displayOptions: {
          show: {
            operation: [
              'queuePause',
              'queueResume',
              'queueRetry',
              'queueCancel',
              'queueCompact',
              'queueRebind',
            ],
          },
        },
      },
      {
        displayName: 'Operator',
        name: 'queueOperator',
        type: 'string',
        default: '',
        description: 'Operator identity recorded with the queue control decision',
        displayOptions: {
          show: {
            operation: [
              'queuePause',
              'queueResume',
              'queueRetry',
              'queueCancel',
              'queueCompact',
              'queueRebind',
            ],
          },
        },
      },
      {
        displayName: 'Reason',
        name: 'queueReason',
        type: 'string',
        default: '',
        description: 'Reason recorded for the explicit queue decision',
        displayOptions: {
          show: {
            operation: [
              'queuePause',
              'queueResume',
              'queueRetry',
              'queueCancel',
              'queueCompact',
              'queueRebind',
            ],
          },
        },
      },
      {
        displayName: 'Create Import Destination',
        name: 'queueImportCreate',
        type: 'options',
        default: 'disabled',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Reviewed New Destination', value: 'enabled' },
        ],
        description:
          'Allow a paused backup import to create the explicitly selected embedded destination; requires a custom directory',
        displayOptions: { show: { operation: ['queueImport'], backend: ['embedded'] } },
      },
      {
        displayName: 'Queue Backup',
        name: 'queueBackup',
        type: 'json',
        default: '{}',
        description: 'Versioned queue-aware backup; imports are paused and collisions rejected',
        displayOptions: { show: { operation: ['queueImport'] } },
      },
      {
        displayName: 'Queue Clear Review',
        name: 'queueClearReview',
        type: 'options',
        default: 'disabled',
        options: [
          { name: 'Preview Required', value: 'disabled' },
          { name: 'Reviewed Queue Impact', value: 'enabled' },
        ],
        description:
          'Explicitly permit whole-store or group clearing to erase extraction ownership and fence outstanding work after reviewing the preview',
        displayOptions: {
          show: { operation: ['clearGroup', 'bulkClearGroups', 'clearAll'], '@version': [2, 3] },
        },
      },
      // ===== Operations per resource =====
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['monitoring'] } },
        options: [
          {
            name: 'Stats',
            value: 'stats',
            description: 'Get graph statistics with enhanced metrics',
            action: 'Get graph statistics',
          },
          {
            name: 'List Groups',
            value: 'listGroups',
            description: 'List all groups/sessions with per-group statistics',
            action: 'List all groups',
          },
          {
            name: 'Group Stats',
            value: 'groupStats',
            description: 'Get detailed statistics for a specific group/session',
            action: 'Get group statistics',
          },
          {
            name: 'Embedding Coverage',
            value: 'embeddingCoverage',
            description: 'Report embedding coverage for semantic and hybrid search',
            action: 'Report embedding coverage',
          },
          {
            name: 'Diagnostics',
            value: 'diagnostics',
            description: 'Run read-only operational diagnostics',
            action: 'Run diagnostics',
          },
        ],
        default: 'stats',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['lifecycle'] } },
        options: [
          {
            name: 'Apply Retention',
            value: 'applyRetention',
            description: 'Remove old episodes based on a retention policy',
            action: 'Apply retention policy',
          },
          {
            name: 'Clear Group',
            value: 'clearGroup',
            description: 'Clear all data for a specific group/session',
            action: 'Clear a group',
          },
          {
            name: 'Bulk Clear Groups',
            value: 'bulkClearGroups',
            description: 'Clear multiple groups/sessions at once',
            action: 'Bulk clear groups',
          },
          {
            name: 'Clear All',
            value: 'clearAll',
            description: 'Clear ALL data from the graph (destructive!)',
            action: 'Clear all data',
          },
          {
            name: 'Purge Episodes',
            value: 'purgeEpisodes',
            description: 'Preview or delete episodes matching provenance filters',
            action: 'Purge episodes',
          },
          {
            name: 'Migrate Storage Schema',
            value: 'migrateStorageSchema',
            description: 'Preview or apply bounded storage schema normalization',
            action: 'Migrate storage schema',
          },
        ],
        default: 'applyRetention',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['hygiene'] } },
        options: [
          {
            name: 'Orphaned Entities',
            value: 'orphanedEntities',
            description: 'Find or remove entities with no relationships',
            action: 'Find orphaned entities',
          },
          {
            name: 'Duplicate Entities',
            value: 'duplicateEntities',
            description: 'Find entities with duplicate or similar names',
            action: 'Find duplicate entities',
          },
          {
            name: 'Expire Stale Edges',
            value: 'expireStaleEdges',
            description: 'Find and expire edges with broken references or past validity',
            action: 'Expire stale edges',
          },
          {
            name: 'Rebuild Search Index',
            value: 'rebuildSearchIndex',
            description: 'Rebuild the embedded full-text search index from stored graph data',
            action: 'Rebuild search index',
          },
          {
            name: 'Backfill Embeddings',
            value: 'backfillEmbeddings',
            description: 'Backfill missing entity and relationship embeddings',
            action: 'Backfill embeddings',
          },
        ],
        default: 'orphanedEntities',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['portability'] } },
        options: [
          {
            name: 'Export',
            value: 'export',
            description: 'Export graph data as JSON',
            action: 'Export graph data',
          },
          {
            name: 'Import',
            value: 'import',
            description: 'Import graph data from JSON',
            action: 'Import graph data',
          },
        ],
        default: 'export',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['analysis'] } },
        options: [
          {
            name: 'Detect Communities',
            value: 'detectCommunities',
            description: 'Detect entity communities/clusters using label propagation',
            action: 'Detect communities',
          },
        ],
        default: 'detectCommunities',
      },
      // ===== Parameters (displayOptions unchanged) =====
      // --- Group ID (required) for single-group operations ---
      {
        displayName: 'Group ID',
        name: 'groupId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            operation: [
              'clearGroup',
              'applyRetention',
              'groupStats',
              'expireStaleEdges',
              'duplicateEntities',
              'orphanedEntities',
              'detectCommunities',
              'purgeEpisodes',
            ],
          },
        },
        description: 'The group/session ID to operate on',
      },
      // --- Group ID (optional filter) for global operations ---
      {
        displayName: 'Group ID',
        name: 'groupIdFilter',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            operation: ['export', 'stats', 'embeddingCoverage', 'backfillEmbeddings'],
          },
        },
        description:
          'Optional: limit to a specific group/session. Leave empty to include all groups.',
      },
      {
        displayName: 'Include Deep Checks',
        name: 'includeDeepChecks',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Only run quick storage and stats checks',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description: 'Export graph data to calculate expensive data-quality diagnostics',
          },
        ],
        default: 'disabled',
        displayOptions: {
          show: {
            operation: ['diagnostics'],
          },
        },
        description:
          'Whether to run graph-wide checks. Enable only when you are comfortable scanning the full graph.',
      },
      // --- Retention parameters ---
      {
        displayName: 'Retention Type',
        name: 'retentionType',
        type: 'options',
        options: [
          {
            name: 'Keep for N Days',
            value: 'days',
            description: 'Delete episodes older than N days',
          },
          {
            name: 'Keep Last N Episodes',
            value: 'max_episodes',
            description: 'Keep only the most recent N episodes',
          },
        ],
        default: 'days',
        displayOptions: {
          show: {
            operation: ['applyRetention'],
          },
        },
        description: 'How to determine which episodes to remove',
      },
      {
        displayName: 'Retention Value',
        name: 'retentionValue',
        type: 'number',
        default: 30,
        typeOptions: {
          minValue: 1,
        },
        displayOptions: {
          show: {
            operation: ['applyRetention'],
          },
        },
        description: 'Number of days or maximum episodes to keep',
      },
      {
        displayName: 'Migration Mode',
        name: 'storageMigrationMode',
        type: 'options',
        options: [
          { name: 'Dry Run', value: 'dryRun' },
          { name: 'Migrate', value: 'migrate' },
        ],
        default: 'dryRun',
        displayOptions: { show: { operation: ['migrateStorageSchema'] } },
        description: 'Preview legacy records or add conservative defaults in a bounded write batch',
      },
      {
        displayName: 'Migration Batch Limit',
        name: 'storageMigrationLimit',
        type: 'number',
        default: 500,
        typeOptions: { minValue: 1, maxValue: 10000 },
        displayOptions: { show: { operation: ['migrateStorageSchema'] } },
        description: 'Maximum number of legacy records to normalize in this execution',
      },
      {
        displayName: 'Confirm Migration',
        name: 'confirmStorageMigration',
        type: 'options',
        options: [
          { name: 'Not Confirmed', value: 'notConfirmed' },
          { name: 'Confirmed', value: 'confirmed' },
        ],
        default: 'notConfirmed',
        displayOptions: {
          show: {
            operation: ['migrateStorageSchema'],
            storageMigrationMode: ['migrate'],
          },
        },
        description: 'Required before applying the bounded migration batch',
      },
      // --- Episode purge parameters ---
      {
        displayName: 'Episode Kind',
        name: 'purgeEpisodeKind',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Active Human', value: 'active_human' },
          { name: 'Passive Human', value: 'passive_human' },
          { name: 'Assistant Reply', value: 'assistant_reply' },
          { name: 'Monitor Summary', value: 'monitor_summary' },
          { name: 'Tool Output', value: 'tool_output' },
          { name: 'System', value: 'system' },
          { name: 'Legacy', value: 'legacy' },
        ],
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes with this provenance kind',
      },
      {
        displayName: 'Trust Level',
        name: 'purgeTrustLevel',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Standard', value: 'standard' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes with this trust level',
      },
      {
        displayName: 'Review Status',
        name: 'purgeReviewStatus',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Proposed', value: 'proposed' },
          { name: 'Accepted', value: 'accepted' },
          { name: 'Rejected', value: 'rejected' },
        ],
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes with this review status',
      },
      {
        displayName: 'Sender ID',
        name: 'purgeSenderId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes from this sender ID',
      },
      {
        displayName: 'Conversation ID',
        name: 'purgeConversationId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes from this conversation',
      },
      {
        displayName: 'Source Workflow ID',
        name: 'purgeSourceWorkflowId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes written by this workflow',
      },
      {
        displayName: 'Source Execution ID',
        name: 'purgeSourceExecutionId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes written by this execution',
      },
      {
        displayName: 'Reference Time After',
        name: 'purgeReferenceAfter',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes referenced at or after this time',
      },
      {
        displayName: 'Reference Time Before',
        name: 'purgeReferenceBefore',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Only match episodes referenced at or before this time',
      },
      {
        displayName: 'Malformed Content Rule',
        name: 'purgeHygieneRule',
        type: 'options',
        options: [
          { name: 'Any Content', value: '' },
          { name: 'Empty Assistant Output', value: 'empty_assistant_output' },
        ],
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Optionally match assistant episodes whose content is empty or an empty array',
      },
      {
        displayName: 'Content Contains',
        name: 'purgeContentContains',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description:
          'Case-insensitive content fragment to match, such as a distinctive part of a historical synthetic instruction',
      },
      {
        displayName: 'Maximum Episodes',
        name: 'purgeLimit',
        type: 'number',
        default: 100,
        typeOptions: { minValue: 1, maxValue: 10000 },
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Maximum number of matching episodes to preview or delete in one execution',
      },
      {
        displayName: 'Execution Mode',
        name: 'purgeMode',
        type: 'options',
        options: [
          { name: 'Dry Run', value: 'dryRun' },
          { name: 'Delete', value: 'delete' },
        ],
        default: 'dryRun',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Preview matching episodes or permanently delete them',
      },
      {
        displayName: 'Repair Episode Chain',
        name: 'purgeRepairChain',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'Reconnect successor episodes to retained predecessors',
      },
      {
        displayName: 'Linked Fact Handling',
        name: 'purgeFactCleanup',
        type: 'options',
        options: [
          { name: 'Unlink Episodes', value: 'unlink' },
          { name: 'Preserve References', value: 'preserve' },
          { name: 'Delete Orphaned Facts', value: 'delete_orphaned' },
        ],
        default: 'unlink',
        displayOptions: { show: { operation: ['purgeEpisodes'] } },
        description: 'How facts linked to deleted episodes should be handled',
      },
      {
        displayName: 'Confirm Episode Purge',
        name: 'confirmEpisodePurge',
        type: 'options',
        options: [
          { name: 'Not Confirmed', value: 'notConfirmed' },
          { name: 'Confirmed', value: 'confirmed' },
        ],
        default: 'notConfirmed',
        displayOptions: {
          show: { operation: ['purgeEpisodes'], purgeMode: ['delete'] },
        },
        description: 'Must be confirmed before matching episodes are permanently deleted',
      },
      // --- Bulk clear parameters ---
      {
        displayName: 'Group IDs',
        name: 'groupIds',
        type: 'json',
        default: '[]',
        required: true,
        displayOptions: {
          show: {
            operation: ['bulkClearGroups'],
          },
        },
        description: 'JSON array of group/session IDs to clear, e.g. ["session-1", "session-2"]',
      },
      {
        displayName: 'Confirm Destructive',
        name: 'confirmDestructive',
        type: 'boolean',
        default: false,
        displayOptions: {
          show: {
            operation: ['bulkClearGroups', 'clearAll'],
          },
        },
        description: 'Safety latch: must be enabled before destructive global operations proceed',
      },
      // --- Orphaned entities parameters ---
      {
        displayName: 'Delete Orphans',
        name: 'deleteOrphans',
        type: 'boolean',
        default: false,
        displayOptions: {
          show: {
            operation: ['orphanedEntities'],
          },
        },
        description:
          'If enabled, orphaned entities will be deleted. Otherwise, they are only listed.',
      },
      // --- Expire stale edges parameters ---
      {
        displayName: 'Dry Run',
        name: 'dryRun',
        type: 'boolean',
        default: true,
        displayOptions: {
          show: {
            operation: ['expireStaleEdges', 'backfillEmbeddings'],
          },
        },
        description:
          'If enabled, reports what would change without modifying graph data. Disable to perform the selected maintenance operation.',
      },
      {
        displayName: 'Backfill Target',
        name: 'backfillTarget',
        type: 'options',
        options: [
          {
            name: 'Entities and Relationships',
            value: 'both',
            description: 'Backfill missing entity name embeddings and relationship fact embeddings',
          },
          {
            name: 'Entities Only',
            value: 'entities',
            description: 'Backfill only entity name embeddings',
          },
          {
            name: 'Relationships Only',
            value: 'relationships',
            description: 'Backfill only relationship fact embeddings',
          },
        ],
        default: 'both',
        displayOptions: {
          show: {
            operation: ['backfillEmbeddings'],
          },
        },
        description: 'Which missing embeddings to backfill',
      },
      {
        displayName: 'Embedding Model',
        name: 'backfillEmbeddingModel',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            operation: ['backfillEmbeddings'],
          },
        },
        description:
          'Embedding model to use when Dry Run is disabled. Uses the Engram Extraction LLM credential.',
      },
      {
        displayName: 'Backfill Limit',
        name: 'backfillLimit',
        type: 'number',
        default: 50,
        typeOptions: {
          minValue: 1,
          maxValue: 500,
        },
        displayOptions: {
          show: {
            operation: ['backfillEmbeddings'],
          },
        },
        description: 'Maximum number of missing embeddings to process in one execution',
      },
      // --- List groups parameters ---
      {
        displayName: 'Include Per-Group Stats',
        name: 'includeStats',
        type: 'boolean',
        default: true,
        displayOptions: {
          show: {
            operation: ['listGroups'],
          },
        },
        description:
          'Include entity/edge/episode counts per group. Slightly slower for large deployments.',
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        default: 100,
        typeOptions: {
          minValue: 1,
          maxValue: 500,
        },
        displayOptions: {
          show: {
            operation: ['listGroups'],
          },
        },
        description: 'Maximum number of groups to return',
      },
      // --- Export guardrails ---
      {
        displayName: 'Maximum Export Items',
        name: 'maxExportItems',
        type: 'number',
        default: 0,
        typeOptions: {
          minValue: 0,
        },
        displayOptions: {
          show: {
            operation: ['export'],
          },
        },
        description:
          'Optional safety limit across entities, relationships, and episodes. Set 0 to preserve existing unlimited export behavior.',
      },
      // --- Import data ---
      {
        displayName: 'Import Data',
        name: 'importData',
        type: 'json',
        default: '{}',
        required: true,
        displayOptions: {
          show: {
            operation: ['import'],
          },
        },
        description:
          'JSON data to import (must contain entities, edges, and episodes arrays from a previous export)',
      },
      {
        displayName: 'Import Mode',
        name: 'importMode',
        type: 'options',
        options: [
          {
            name: 'Import',
            value: 'import',
            description: 'Validate and write the graph data',
          },
          {
            name: 'Dry Run',
            value: 'dryRun',
            description: 'Validate only and report what would be imported',
          },
        ],
        default: 'import',
        displayOptions: {
          show: {
            operation: ['import'],
          },
        },
        description: 'Whether to write the import or only validate it',
      },
      {
        displayName: 'Maximum Import Items',
        name: 'maxImportItems',
        type: 'number',
        default: 0,
        typeOptions: {
          minValue: 0,
        },
        displayOptions: {
          show: {
            operation: ['import'],
          },
        },
        description:
          'Optional safety limit across entities, relationships, and episodes. Set 0 to preserve existing unlimited import behavior.',
      },
      // --- Community Detection Parameters ---
      {
        displayName: 'Min Community Size',
        name: 'minCommunitySize',
        type: 'number',
        default: 2,
        typeOptions: {
          minValue: 2,
          maxValue: 100,
        },
        displayOptions: {
          show: {
            operation: ['detectCommunities'],
          },
        },
        description: 'Minimum number of entities required to form a community',
      },
      {
        displayName: 'Generate Summaries',
        name: 'generateSummaries',
        type: 'boolean',
        default: false,
        displayOptions: {
          show: {
            operation: ['detectCommunities'],
          },
        },
        description:
          'Use an LLM to generate natural language summaries for each community. Requires Engram Extraction LLM credential.',
      },
      {
        displayName: 'Summary Model',
        name: 'summaryModel',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            operation: ['detectCommunities'],
            generateSummaries: [true],
          },
        },
        placeholder: 'e.g. gpt-4o-mini',
        description: 'LLM model to use for generating community summaries',
      },
      {
        displayName: 'Summary Concurrency',
        name: 'summaryConcurrency',
        type: 'number',
        default: 3,
        typeOptions: {
          minValue: 1,
          maxValue: 10,
        },
        displayOptions: {
          show: {
            operation: ['detectCommunities'],
            generateSummaries: [true],
          },
        },
        description: 'Number of communities to summarize concurrently',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const safe = usesReplaySafeCaptureOutputs(this.getNode().parameters);
    try {
      // The ONE original configured entry opens here, before credentials/storage create or
      // initialize; legacy and missing modes call the original path unchanged.
      return await runWithAutonomousPersonalExecutionEntryV1(this, async () => {
        const output = await executeAdminCore.call(this, safe);
        // Include output projection in the body so the scope's final check follows it.
        markCurrentAutonomousPersonalExecutionStageV1('final_check');
        return attachNativeExecutionDiagnostics(
          output,
          readLatestAutonomousPersonalExecutionDiagnosticsV1(this),
        );
      });
    } catch (error) {
      if (!safe) throw error;
      const output: INodeExecutionData[][] = [
        [],
        this.getInputData().map((_item, index) => ({
          json:
            this.getNode().parameters?.automaticPreferenceInterpreter === 'autonomousPersonalV1'
              ? nativeUnconfirmedOutput(error)
              : stoppedReplaySafeCapture(),
          pairedItem: { item: index },
        })),
      ];
      return attachNativeExecutionDiagnostics(
        output,
        readLatestAutonomousPersonalExecutionDiagnosticsV1(this),
      );
    }
  }
}

async function executeAdminCore(
  this: IExecuteFunctions,
  safe: boolean,
): Promise<INodeExecutionData[][]> {
  markCurrentAutonomousPersonalExecutionStageV1('initialize');
  const items = this.getInputData();
  const backend = this.getNodeParameter('backend', 0, 'embedded') as string;
  const resource = this.getNodeParameter('resource', 0, 'monitoring') as string;
  const operation = this.getNodeParameter('operation', 0) as string;
  if (safe && this.getNode().parameters?.automaticPreferenceInterpreter !== 'autonomousPersonalV1')
    readReplaySafeHumanCaptureRequest(this, 0);

  let storage;
  let diagnosticsContext: DiagnosticsContext;

  if (backend === 'neo4j') {
    const credentials = await this.getCredentials('engramNeo4jApi');
    storage = createStorage({
      backend: 'neo4j',
      uri: credentials.uri as string,
      username: credentials.username as string,
      password: credentials.password as string,
      database: credentials.database as string,
    });
    diagnosticsContext = {
      storeIdentity: fingerprint({
        backend,
        uri: credentials.uri,
        database: credentials.database ?? 'neo4j',
      }),
      backend,
      databaseConfigured: Boolean((credentials.database as string | undefined)?.trim()),
    };
  } else {
    const workflowId =
      resource === 'automaticMemory'
        ? (this.getNodeParameter('automaticWorkflowId', 0, '') as string)
        : resource === 'extractionQueue'
          ? (this.getNodeParameter('queueStorageWorkflowId', 0, '') as string).trim()
          : (this.getWorkflow().id ?? 'default');
    if (resource === 'extractionQueue' && !workflowId)
      throw new Error('Memory Workflow ID is required for an embedded worker');
    if (resource === 'automaticMemory' && !workflowId.trim())
      throw new Error('Memory Workflow ID is required for automatic memory administration');
    const customPath = this.getNodeParameter('customStoragePath', 0, '') as string;
    const persistPath = resolveStoragePath({
      customStoragePath: customPath,
      workflowId,
    });

    if (resource === 'extractionQueue' && !existsSync(persistPath)) {
      if (
        operation !== 'queueImport' ||
        this.getNodeParameter('queueImportCreate', 0, 'disabled') !== 'enabled' ||
        !customPath.trim()
      )
        throw new Error(
          'Producer memory store not found; verify the workflow ID and storage directory',
        );
      await fsPromises.mkdir(dirname(persistPath), { recursive: true });
    }
    if (resource !== 'extractionQueue' && !safe)
      migrateStorageIfNeeded({
        newPath: persistPath,
        workflowId,
        staticData: this.getWorkflowStaticData('node'),
        logger: this.logger,
      });

    storage = createStorage({
      backend: 'embedded',
      persistPath,
    });
    diagnosticsContext = {
      storeIdentity: fingerprint({ backend: 'embedded', persistPath }),
      backend,
      persistPath,
      workflowId,
      customStoragePathConfigured: customPath.trim().length > 0,
    };
  }
  try {
    await storage.initialize();
  } catch (error) {
    if (
      backend === 'neo4j' &&
      this.getNode().parameters?.automaticPreferenceInterpreter === 'autonomousPersonalV1'
    ) {
      try {
        await storage.close();
      } catch {
        // The outer fixed output preserves the original initialization failure.
      }
    }
    throw error;
  }

  const returnData: INodeExecutionData[] = [];
  const stoppedData: INodeExecutionData[] = [];

  try {
    for (let i = 0; i < items.length; i++) {
      try {
        const beforeLength = returnData.length;

        if (resource === 'automaticMemory') {
          const result = await executeAutomaticAdmin(
            this,
            storage,
            operation,
            i,
            diagnosticsContext.storeIdentity!,
            safe,
          );
          (safe && result.should_process !== true ? stoppedData : returnData).push({
            json: result,
            ...(safe ? { pairedItem: { item: i } } : {}),
          });
        } else if (resource === 'extractionQueue') {
          await executeExtractionQueue(this, storage, operation, i, returnData);
        } else if (resource === 'monitoring') {
          await executeMonitoring(this, storage, operation, i, returnData, diagnosticsContext);
        } else if (resource === 'lifecycle') {
          await executeLifecycle(this, storage, operation, i, returnData);
        } else if (resource === 'hygiene') {
          await executeHygiene(this, storage, operation, i, returnData);
        } else if (resource === 'portability') {
          await executePortability(this, storage, operation, i, returnData);
        } else if (resource === 'analysis') {
          await executeAnalysis(this, storage, operation, i, returnData);
        }

        // Fallback for v1 workflows where resource defaults to 'monitoring'
        // but operation may belong to a different resource
        if (!safe && returnData.length === beforeLength) {
          await executeLifecycle(this, storage, operation, i, returnData);
          if (returnData.length === beforeLength) {
            await executeHygiene(this, storage, operation, i, returnData);
          }
          if (returnData.length === beforeLength) {
            await executePortability(this, storage, operation, i, returnData);
          }
          if (returnData.length === beforeLength) {
            await executeAnalysis(this, storage, operation, i, returnData);
          }
        }
      } catch (error: unknown) {
        if (safe) {
          stoppedData.push({
            json:
              this.getNode().parameters?.automaticPreferenceInterpreter === 'autonomousPersonalV1'
                ? nativeUnconfirmedOutput(error)
                : stoppedReplaySafeCapture(),
            pairedItem: { item: i },
          });
          continue;
        }
        if (error instanceof QueueClearRequiresReview) {
          returnData.push({
            json: {
              operation,
              dry_run: true,
              queue_review_required: true,
              queue_impact: error.impact,
            },
          });
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(
          this.getNode(),
          `Engram Admin error: ${(error as Error).message}`,
          { itemIndex: i },
        );
      }
    }
  } finally {
    if (backend === 'neo4j') {
      await storage.close();
    }
  }

  return safe ? [returnData, stoppedData] : [returnData.length > 0 ? returnData : [{ json: {} }]];
}

// =============================================
// MONITORING
// =============================================

async function executeMonitoring(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
  diagnosticsContext: DiagnosticsContext,
): Promise<void> {
  if (operation === 'stats') {
    const groupId = (ctx.getNodeParameter('groupIdFilter', i, '') as string).trim();
    const baseStats = await storage.getStats(groupId || undefined);
    const data = await storage.exportGraph(groupId || undefined);

    const activeEdges = data.edges.filter((e) => e.expired_at === null).length;
    const expiredEdges = data.edges.filter((e) => e.expired_at !== null).length;
    const groupCount = baseStats.group_ids.length;

    const enhancedStats = {
      ...baseStats,
      group_count: groupCount,
      active_edge_count: activeEdges,
      expired_edge_count: expiredEdges,
      avg_edges_per_entity:
        baseStats.entity_count > 0
          ? Math.round((baseStats.edge_count / baseStats.entity_count) * 100) / 100
          : 0,
      avg_episodes_per_group:
        groupCount > 0 ? Math.round((baseStats.episode_count / groupCount) * 100) / 100 : 0,
      storage_backend: diagnosticsContext.backend,
      data_span_days:
        baseStats.oldest_episode && baseStats.newest_episode
          ? Math.round(
              ((new Date(baseStats.newest_episode).getTime() -
                new Date(baseStats.oldest_episode).getTime()) /
                (1000 * 60 * 60 * 24)) *
                10,
            ) / 10
          : null,
    };

    returnData.push({ json: enhancedStats as unknown as IDataObject });
  } else if (operation === 'listGroups') {
    const includeStats = ctx.getNodeParameter('includeStats', i, true) as boolean;
    const limit = ctx.getNodeParameter('limit', i, 100) as number;
    const globalStats = await storage.getStats();
    const allGroupIds = globalStats.group_ids.slice(0, limit);

    if (includeStats) {
      for (const gid of allGroupIds) {
        const gStats = await storage.getStats(gid);
        returnData.push({
          json: {
            group_id: gid,
            entity_count: gStats.entity_count,
            edge_count: gStats.edge_count,
            episode_count: gStats.episode_count,
            entity_types: gStats.entity_types,
            oldest_episode: gStats.oldest_episode,
            newest_episode: gStats.newest_episode,
          },
        });
      }
    } else {
      for (const gid of allGroupIds) {
        returnData.push({ json: { group_id: gid } });
      }
    }

    if (returnData.length === 0) {
      returnData.push({
        json: {
          message: 'No groups found',
          total_groups: 0,
        },
      });
    }
  } else if (operation === 'groupStats') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Group Stats operation',
        { itemIndex: i },
      );
    }

    const gStats = await storage.getStats(groupId);
    const gData = await storage.exportGraph(groupId);

    const activeEdges = gData.edges.filter((e) => e.expired_at === null).length;
    const expiredEdges = gData.edges.filter((e) => e.expired_at !== null).length;

    const relationshipTypes: Record<string, number> = {};
    for (const edge of gData.edges) {
      relationshipTypes[edge.name] = (relationshipTypes[edge.name] || 0) + 1;
    }

    returnData.push({
      json: {
        group_id: groupId,
        entity_count: gStats.entity_count,
        edge_count: gStats.edge_count,
        episode_count: gStats.episode_count,
        entity_types: gStats.entity_types,
        relationship_types: relationshipTypes,
        active_edge_count: activeEdges,
        expired_edge_count: expiredEdges,
        avg_edges_per_entity:
          gStats.entity_count > 0
            ? Math.round((gStats.edge_count / gStats.entity_count) * 100) / 100
            : 0,
        oldest_episode: gStats.oldest_episode,
        newest_episode: gStats.newest_episode,
        data_span_days:
          gStats.oldest_episode && gStats.newest_episode
            ? Math.round(
                ((new Date(gStats.newest_episode).getTime() -
                  new Date(gStats.oldest_episode).getTime()) /
                  (1000 * 60 * 60 * 24)) *
                  10,
              ) / 10
            : null,
      },
    });
  } else if (operation === 'embeddingCoverage') {
    const groupId = (ctx.getNodeParameter('groupIdFilter', i, '') as string).trim();
    const data = await storage.exportGraph(groupId || undefined);
    const entitiesWithEmbeddings = data.entities.filter(
      (entity) => Array.isArray(entity.name_embedding) && entity.name_embedding.length > 0,
    ).length;
    const edgesWithEmbeddings = data.edges.filter(
      (edge) => Array.isArray(edge.fact_embedding) && edge.fact_embedding.length > 0,
    ).length;

    returnData.push({
      json: {
        operation: 'embeddingCoverage',
        group_id: groupId || null,
        entity_count: data.entities.length,
        edge_count: data.edges.length,
        entities_with_name_embeddings: entitiesWithEmbeddings,
        edges_with_fact_embeddings: edgesWithEmbeddings,
        entity_embedding_coverage:
          data.entities.length > 0
            ? Math.round((entitiesWithEmbeddings / data.entities.length) * 10000) / 100
            : 0,
        edge_embedding_coverage:
          data.edges.length > 0
            ? Math.round((edgesWithEmbeddings / data.edges.length) * 10000) / 100
            : 0,
        missing_entity_embeddings: data.entities.length - entitiesWithEmbeddings,
        missing_edge_embeddings: data.edges.length - edgesWithEmbeddings,
      },
    });
  } else if (operation === 'diagnostics') {
    const includeDeepChecks =
      (ctx.getNodeParameter('includeDeepChecks', i, 'disabled') as string) === 'enabled';
    const stats = await storage.getStats();
    const migrationStatus = await storage.getMigrationStatus();
    const warnings: string[] = [];

    if (stats.group_ids.length === 0) {
      warnings.push('No groups found. Engram storage is initialized but currently empty.');
    }

    if (stats.entity_count > 0 && stats.edge_count === 0) {
      warnings.push('Entities exist but no relationships were found.');
    }

    const diagnostics: IDataObject = {
      operation: 'diagnostics',
      status: 'ok',
      storage_backend: diagnosticsContext.backend,
      initialized: true,
      migration: migrationStatus,
      quick_checks: {
        group_count: stats.group_ids.length,
        entity_count: stats.entity_count,
        edge_count: stats.edge_count,
        episode_count: stats.episode_count,
        entity_types: stats.entity_types,
        oldest_episode: stats.oldest_episode,
        newest_episode: stats.newest_episode,
      },
      warnings,
      deep_checks: includeDeepChecks ? null : 'disabled',
    };

    if (diagnosticsContext.backend === 'embedded') {
      const lastMutation = storage.getLastMutationDiagnostics?.() ?? null;
      diagnostics.embedded_storage = {
        workflow_id: diagnosticsContext.workflowId,
        persist_path: diagnosticsContext.persistPath,
        custom_storage_path_configured: diagnosticsContext.customStoragePathConfigured,
        last_mutation: lastMutation as unknown as IDataObject,
      };
      if (lastMutation && lastMutation.total_ms >= 5000) {
        warnings.push(
          `The last embedded mutation took ${lastMutation.total_ms} ms. Review its phase timings and storage size.`,
        );
      }
    } else if (diagnosticsContext.backend === 'neo4j') {
      diagnostics.neo4j = {
        database_configured: diagnosticsContext.databaseConfigured,
      };
    }

    if (includeDeepChecks) {
      const data = await storage.exportGraph();
      const entityUuids = new Set(data.entities.map((entity) => entity.uuid));
      const danglingEdges = data.edges.filter(
        (edge) =>
          !entityUuids.has(edge.source_node_uuid) || !entityUuids.has(edge.target_node_uuid),
      );
      const duplicateEntityKeys = new Map<string, number>();

      for (const entity of data.entities) {
        const key = `${entity.group_id}:${entity.name.toLowerCase().trim()}`;
        duplicateEntityKeys.set(key, (duplicateEntityKeys.get(key) ?? 0) + 1);
      }

      const duplicateEntityNameCount = [...duplicateEntityKeys.values()].filter(
        (count) => count > 1,
      ).length;

      if (danglingEdges.length > 0) {
        warnings.push(`${danglingEdges.length} dangling edge(s) reference missing entities.`);
      }

      if (duplicateEntityNameCount > 0) {
        warnings.push(`${duplicateEntityNameCount} duplicate entity name group(s) found.`);
      }

      diagnostics.deep_checks = {
        scanned_full_graph: true,
        active_edge_count: data.edges.filter((edge) => edge.expired_at === null).length,
        expired_edge_count: data.edges.filter((edge) => edge.expired_at !== null).length,
        invalidated_edge_count: data.edges.filter((edge) => edge.invalid_at !== null).length,
        dangling_edge_count: danglingEdges.length,
        duplicate_entity_name_groups: duplicateEntityNameCount,
        entities_with_name_embeddings: data.entities.filter(
          (entity) => Array.isArray(entity.name_embedding) && entity.name_embedding.length > 0,
        ).length,
        edges_with_fact_embeddings: data.edges.filter(
          (edge) => Array.isArray(edge.fact_embedding) && edge.fact_embedding.length > 0,
        ).length,
      };
    }

    returnData.push({ json: diagnostics });
  }
}

// =============================================
// LIFECYCLE
// =============================================

async function executeLifecycle(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'applyRetention') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Apply Retention operation',
        { itemIndex: i },
      );
    }
    const retentionType = ctx.getNodeParameter('retentionType', i) as string;
    const retentionValue = ctx.getNodeParameter('retentionValue', i) as number;

    const removed = await storage.applyRetention(groupId, {
      type: retentionType as 'days' | 'max_episodes',
      value: retentionValue,
    });

    returnData.push({
      json: {
        success: true,
        operation: 'applyRetention',
        group_id: groupId,
        policy: { type: retentionType, value: retentionValue },
        episodes_removed: removed,
      },
    });
  } else if (operation === 'migrateStorageSchema') {
    const mode = ctx.getNodeParameter('storageMigrationMode', i, 'dryRun') as string;
    const dryRun = mode !== 'migrate';
    if (
      !dryRun &&
      (ctx.getNodeParameter('confirmStorageMigration', i, 'notConfirmed') as string) !== 'confirmed'
    ) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Confirm Migration must be set to Confirmed before applying schema changes',
        { itemIndex: i },
      );
    }

    const result = await storage.migrateStorageSchema({
      dry_run: dryRun,
      limit: ctx.getNodeParameter('storageMigrationLimit', i, 500) as number,
    });
    returnData.push({
      json: {
        success: true,
        operation: 'migrateStorageSchema',
        ...result,
      },
    });
  } else if (operation === 'purgeEpisodes') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Purge Episodes operation',
        { itemIndex: i },
      );
    }

    const mode = ctx.getNodeParameter('purgeMode', i, 'dryRun') as string;
    const dryRun = mode !== 'delete';
    if (
      !dryRun &&
      (ctx.getNodeParameter('confirmEpisodePurge', i, 'notConfirmed') as string) !== 'confirmed'
    ) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Confirm Episode Purge must be set to Confirmed before deleting episodes',
        { itemIndex: i },
      );
    }

    const filters = buildEpisodePurgeFilters(ctx, i);
    const result = await storage.purgeEpisodes(groupId, filters, {
      dry_run: dryRun,
      limit: ctx.getNodeParameter('purgeLimit', i, 100) as number,
      repair_chain:
        (ctx.getNodeParameter('purgeRepairChain', i, 'enabled') as string) === 'enabled',
      fact_cleanup: ctx.getNodeParameter('purgeFactCleanup', i, 'unlink') as
        | 'preserve'
        | 'unlink'
        | 'delete_orphaned',
    });

    returnData.push({
      json: {
        success: true,
        operation: 'purgeEpisodes',
        group_id: groupId,
        ...result,
      },
    });
  } else if (operation === 'clearGroup') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Clear Group operation',
        {
          itemIndex: i,
          description: 'Provide the session/group ID whose data you want to delete.',
        },
      );
    }
    await storage.clearGroup(groupId, {
      allowQueued: ctx.getNodeParameter('queueClearReview', i, 'disabled') === 'enabled',
    });
    returnData.push({
      json: { success: true, operation: 'clearGroup', group_id: groupId },
    });
  } else if (operation === 'bulkClearGroups') {
    const confirmDestructive = ctx.getNodeParameter('confirmDestructive', i, false) as boolean;
    if (!confirmDestructive) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Confirm Destructive must be enabled to proceed with Bulk Clear Groups',
        {
          itemIndex: i,
          description: 'This is a safety measure. Enable "Confirm Destructive" to proceed.',
        },
      );
    }

    const groupIdsRaw = ctx.getNodeParameter('groupIds', i) as unknown;
    let groupIds: string[];
    if (Array.isArray(groupIdsRaw)) {
      groupIds = groupIdsRaw.filter((id): id is string => typeof id === 'string' && id.length > 0);
    } else {
      throw new NodeOperationError(ctx.getNode(), 'Group IDs must be a JSON array of strings', {
        itemIndex: i,
      });
    }

    if (groupIds.length === 0) {
      throw new NodeOperationError(ctx.getNode(), 'Group IDs array is empty', {
        itemIndex: i,
      });
    }

    const allowQueued = ctx.getNodeParameter('queueClearReview', i, 'disabled') === 'enabled';
    if (!allowQueued && storage.previewQueueClear) {
      const total = { sources: 0, jobs: 0 };
      for (const gid of groupIds) {
        const impact = await storage.previewQueueClear(gid);
        total.sources += impact.sources;
        total.jobs += impact.jobs;
      }
      if (total.sources) throw new QueueClearRequiresReview(total);
    }
    const cleared: string[] = [];
    const failed: Array<{ group_id: string; error: string }> = [];

    for (const gid of groupIds) {
      try {
        await storage.clearGroup(gid, { allowQueued });
        cleared.push(gid);
      } catch (err) {
        failed.push({ group_id: gid, error: (err as Error).message });
      }
    }

    returnData.push({
      json: {
        success: failed.length === 0,
        operation: 'bulkClearGroups',
        cleared,
        failed,
        total_cleared: cleared.length,
        total_failed: failed.length,
      },
    });
  } else if (operation === 'clearAll') {
    const confirmDestructive = ctx.getNodeParameter('confirmDestructive', i, false) as boolean;
    if (!confirmDestructive) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Confirm Destructive must be enabled to proceed with Clear All',
        {
          itemIndex: i,
          description: 'This is a safety measure. Enable "Confirm Destructive" to proceed.',
        },
      );
    }
    await storage.clearAll({
      allowQueued: ctx.getNodeParameter('queueClearReview', i, 'disabled') === 'enabled',
    });
    returnData.push({
      json: { success: true, operation: 'clearAll' },
    });
  }
}

function buildEpisodePurgeFilters(ctx: IExecuteFunctions, i: number): EpisodeFilterOptions {
  const filters: EpisodeFilterOptions = {};
  const values = {
    episode_kind: ctx.getNodeParameter('purgeEpisodeKind', i, '') as string,
    trust_level: ctx.getNodeParameter('purgeTrustLevel', i, '') as string,
    review_status: ctx.getNodeParameter('purgeReviewStatus', i, '') as string,
    sender_id: (ctx.getNodeParameter('purgeSenderId', i, '') as string).trim(),
    conversation_id: (ctx.getNodeParameter('purgeConversationId', i, '') as string).trim(),
    source_workflow_id: (ctx.getNodeParameter('purgeSourceWorkflowId', i, '') as string).trim(),
    source_execution_id: (ctx.getNodeParameter('purgeSourceExecutionId', i, '') as string).trim(),
    reference_after: ctx.getNodeParameter('purgeReferenceAfter', i, '') as string,
    reference_before: ctx.getNodeParameter('purgeReferenceBefore', i, '') as string,
    hygiene_rule: ctx.getNodeParameter('purgeHygieneRule', i, '') as string,
    content_contains: (ctx.getNodeParameter('purgeContentContains', i, '') as string).trim(),
  };

  for (const [key, value] of Object.entries(values)) {
    if (value) {
      (filters as Record<string, unknown>)[key] = value;
    }
  }
  return filters;
}

// =============================================
// HYGIENE
// =============================================

async function executeHygiene(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'orphanedEntities') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Orphaned Entities operation',
        { itemIndex: i },
      );
    }
    const deleteOrphans = ctx.getNodeParameter('deleteOrphans', i, false) as boolean;

    const entities = await storage.listEntities(groupId, { limit: 10000 });
    const orphaned: Array<{
      uuid: string;
      name: string;
      entity_type: string;
      summary: string;
      created_at: string;
    }> = [];

    for (const entity of entities) {
      const edges = await storage.getEdgesForEntity(entity.uuid);
      if (edges.length === 0) {
        orphaned.push({
          uuid: entity.uuid,
          name: entity.name,
          entity_type: entity.entity_type,
          summary: entity.summary,
          created_at: entity.created_at,
        });
      }
    }

    if (deleteOrphans) {
      for (const o of orphaned) {
        await storage.deleteEntity(o.uuid);
      }
    }

    returnData.push({
      json: {
        operation: 'orphanedEntities',
        group_id: groupId,
        orphaned,
        total_orphaned: orphaned.length,
        deleted: deleteOrphans,
      },
    });
  } else if (operation === 'duplicateEntities') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Duplicate Entities operation',
        { itemIndex: i },
      );
    }

    const entities = await storage.listEntities(groupId, { limit: 10000 });
    const nameMap = new Map<string, typeof entities>();

    for (const entity of entities) {
      const key = entity.name.toLowerCase().trim();
      if (!nameMap.has(key)) nameMap.set(key, []);
      nameMap.get(key)!.push(entity);
    }

    const duplicateGroups: Array<{
      canonical_name: string;
      count: number;
      entities: Array<{
        uuid: string;
        name: string;
        entity_type: string;
        edge_count: number;
        created_at: string;
      }>;
    }> = [];

    for (const [canonicalName, group] of nameMap) {
      if (group.length > 1) {
        const enriched = [];
        for (const e of group) {
          const edges = await storage.getEdgesForEntity(e.uuid);
          enriched.push({
            uuid: e.uuid,
            name: e.name,
            entity_type: e.entity_type,
            edge_count: edges.length,
            created_at: e.created_at,
          });
        }
        duplicateGroups.push({
          canonical_name: canonicalName,
          count: group.length,
          entities: enriched,
        });
      }
    }

    returnData.push({
      json: {
        operation: 'duplicateEntities',
        group_id: groupId,
        duplicate_groups: duplicateGroups,
        total_duplicate_groups: duplicateGroups.length,
      },
    });
  } else if (operation === 'expireStaleEdges') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Expire Stale Edges operation',
        { itemIndex: i },
      );
    }
    const dryRun = ctx.getNodeParameter('dryRun', i, true) as boolean;

    const data = await storage.exportGraph(groupId);
    const entityUuids = new Set(data.entities.map((e) => e.uuid));
    const staleEdges: Array<{
      uuid: string;
      name: string;
      fact: string;
      reason: string;
    }> = [];

    for (const edge of data.edges) {
      if (edge.expired_at) continue;

      if (!entityUuids.has(edge.source_node_uuid) || !entityUuids.has(edge.target_node_uuid)) {
        staleEdges.push({
          uuid: edge.uuid,
          name: edge.name,
          fact: edge.fact,
          reason: 'dangling_reference',
        });
      } else if (edge.invalid_at && new Date(edge.invalid_at) < new Date()) {
        staleEdges.push({
          uuid: edge.uuid,
          name: edge.name,
          fact: edge.fact,
          reason: 'past_invalid_at',
        });
      }
    }

    if (!dryRun) {
      for (const edge of staleEdges) {
        await storage.updateEdge(edge.uuid, { expired_at: nowIso() });
      }
    }

    returnData.push({
      json: {
        operation: 'expireStaleEdges',
        group_id: groupId,
        dry_run: dryRun,
        stale_edges: staleEdges,
        total_stale: staleEdges.length,
        expired: !dryRun,
      },
    });
  } else if (operation === 'rebuildSearchIndex') {
    if (typeof storage.rebuildSearchIndex !== 'function') {
      returnData.push({
        json: {
          operation: 'rebuildSearchIndex',
          status: 'skipped',
          reason: 'Storage backend does not require a local full-text index rebuild.',
        },
      });
      return;
    }

    const result = await storage.rebuildSearchIndex();
    returnData.push({
      json: {
        operation: 'rebuildSearchIndex',
        status: 'ok',
        ...result,
      },
    });
  } else if (operation === 'backfillEmbeddings') {
    const groupId = (ctx.getNodeParameter('groupIdFilter', i, '') as string).trim();
    const dryRun = ctx.getNodeParameter('dryRun', i, true) as boolean;
    const target = ctx.getNodeParameter('backfillTarget', i, 'both') as string;
    const limit = ctx.getNodeParameter('backfillLimit', i, 50) as number;
    const data = await storage.exportGraph(groupId || undefined);

    const missingEntities =
      target === 'relationships'
        ? []
        : data.entities.filter(
            (entity) => !Array.isArray(entity.name_embedding) || entity.name_embedding.length === 0,
          );
    const missingEdges =
      target === 'entities'
        ? []
        : data.edges.filter(
            (edge) => !Array.isArray(edge.fact_embedding) || edge.fact_embedding.length === 0,
          );

    const candidates = [
      ...missingEntities.map((entity) => ({ kind: 'entity' as const, uuid: entity.uuid, entity })),
      ...missingEdges.map((edge) => ({ kind: 'edge' as const, uuid: edge.uuid, edge })),
    ].slice(0, limit);

    if (dryRun) {
      returnData.push({
        json: {
          operation: 'backfillEmbeddings',
          mode: 'dryRun',
          group_id: groupId || null,
          target,
          limit,
          missing_entity_embeddings: missingEntities.length,
          missing_edge_embeddings: missingEdges.length,
          planned_updates: candidates.length,
          written: false,
        },
      });
      return;
    }

    const model = (ctx.getNodeParameter('backfillEmbeddingModel', i, '') as string).trim();
    if (!model) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Embedding Model is required when Backfill Embeddings dry run is disabled',
        { itemIndex: i },
      );
    }

    const credentials = await ctx.getCredentials('engramExtractionApi');
    const embeddingService = new EmbeddingService({
      apiKey: credentials.apiKey as string,
      baseUrl: credentials.baseUrl as string,
      model,
    });
    const updated: string[] = [];
    const failed: Array<{ uuid: string; kind: string; error: string }> = [];

    for (const candidate of candidates) {
      try {
        if (candidate.kind === 'entity') {
          const result = await embeddingService.embed(candidate.entity.name);
          await storage.updateEntity(candidate.entity.uuid, {
            name_embedding: result.embedding,
            attributes: mergeMaintenanceAttributes(candidate.entity.attributes, {
              embedding_backfilled_at: nowIso(),
              embedding_model: model,
            }),
          });
        } else {
          const result = await embeddingService.embed(candidate.edge.fact);
          await storage.updateEdge(candidate.edge.uuid, {
            fact_embedding: result.embedding,
            attributes: mergeMaintenanceAttributes(candidate.edge.attributes, {
              embedding_backfilled_at: nowIso(),
              embedding_model: model,
            }),
          });
        }
        updated.push(candidate.uuid);
      } catch (error) {
        failed.push({
          uuid: candidate.uuid,
          kind: candidate.kind,
          error: (error as Error).message,
        });
      }
    }

    returnData.push({
      json: {
        operation: 'backfillEmbeddings',
        mode: 'write',
        group_id: groupId || null,
        target,
        limit,
        updated,
        failed,
        total_updated: updated.length,
        total_failed: failed.length,
        written: true,
      },
    });
  }
}

// =============================================
// PORTABILITY
// =============================================

async function executePortability(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'export') {
    const groupId = (ctx.getNodeParameter('groupIdFilter', i, '') as string).trim();
    const maxExportItems = ctx.getNodeParameter('maxExportItems', i, 0) as number;
    const data = await storage.exportGraph(groupId || undefined);
    const totalItems = countGraphItems(data);

    if (maxExportItems > 0 && totalItems > maxExportItems) {
      throw new NodeOperationError(ctx.getNode(), 'Export exceeds configured safety limit', {
        itemIndex: i,
        description: `Export contains ${totalItems} items, which exceeds Maximum Export Items (${maxExportItems}). Increase the limit or export a single group.`,
      });
    }

    const exportData: GraphData = {
      ...data,
      metadata: {
        checksum_sha256: graphChecksum(data),
        checksum_algorithm: 'sha256',
        generated_by: 'n8n-nodes-engram',
        entity_count: data.entities.length,
        edge_count: data.edges.length,
        episode_count: data.episodes.length,
      },
    };

    returnData.push({ json: exportData as unknown as IDataObject });
  } else if (operation === 'import') {
    const importData = ctx.getNodeParameter('importData', i) as unknown;
    const importMode = ctx.getNodeParameter('importMode', i, 'import') as string;
    const maxImportItems = ctx.getNodeParameter('maxImportItems', i, 0) as number;
    const parsed = ImportGraphDataSchema.safeParse(importData);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issuePath = firstIssue?.path.length ? firstIssue.path.join('.') : 'root';
      throw new NodeOperationError(ctx.getNode(), 'Invalid import data format', {
        itemIndex: i,
        description: `Import data must match the Engram export schema. First issue: ${issuePath} - ${firstIssue?.message ?? 'unknown validation error'}.`,
      });
    }

    const sourceGraphData = parsed.data;
    const totalItems = countGraphItems(sourceGraphData);

    if (maxImportItems > 0 && totalItems > maxImportItems) {
      throw new NodeOperationError(ctx.getNode(), 'Import exceeds configured safety limit', {
        itemIndex: i,
        description: `Import contains ${totalItems} items, which exceeds Maximum Import Items (${maxImportItems}). Increase the limit or split the import.`,
      });
    }

    const checksum = sourceGraphData.metadata?.checksum_sha256;
    if (checksum && checksum !== graphChecksum(importData as ImportGraphData)) {
      throw new NodeOperationError(ctx.getNode(), 'Import checksum verification failed', {
        itemIndex: i,
        description:
          'The import metadata checksum does not match the graph contents. Re-export the data or inspect it before importing.',
      });
    }

    const migration = migrateGraphData(importData);
    const graphData = migration.data;

    if (importMode !== 'dryRun') {
      await storage.importGraph(graphData);
    }

    returnData.push({
      json: {
        success: true,
        operation: 'import',
        mode: importMode,
        checksum_verified: Boolean(checksum),
        migration: migration.report,
        warnings: migration.report.warnings,
        imported: {
          entities: graphData.entities.length,
          edges: graphData.edges.length,
          episodes: graphData.episodes.length,
        },
        written: importMode !== 'dryRun',
      },
    });
  }
}

function countGraphItems(data: GraphData | ImportGraphData): number {
  return data.entities.length + data.edges.length + data.episodes.length;
}

function graphChecksum(data: GraphData | ImportGraphData): string {
  const checksumData = {
    version: data.version,
    exported_at: data.exported_at,
    group_id: data.group_id,
    entities: data.entities,
    edges: data.edges,
    episodes: data.episodes,
  };

  return createHash('sha256').update(JSON.stringify(checksumData)).digest('hex');
}

function mergeMaintenanceAttributes(
  attributes: Record<string, unknown>,
  maintenanceAttributes: Record<string, unknown>,
): Record<string, unknown> {
  const existingMaintenance =
    typeof attributes.engram_maintenance === 'object' && attributes.engram_maintenance !== null
      ? (attributes.engram_maintenance as Record<string, unknown>)
      : {};

  return {
    ...attributes,
    engram_maintenance: {
      ...existingMaintenance,
      ...maintenanceAttributes,
    },
  };
}

// =============================================
// ANALYSIS
// =============================================

async function executeAnalysis(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'detectCommunities') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID is required for Detect Communities operation',
        { itemIndex: i },
      );
    }

    const minCommunitySize = ctx.getNodeParameter('minCommunitySize', i, 2) as number;
    const generateSummaries = ctx.getNodeParameter('generateSummaries', i, false) as boolean;

    const detector = new CommunityDetector(storage);
    let result = await detector.detect(groupId, { minCommunitySize });

    if (generateSummaries) {
      const extractionCreds = await ctx.getCredentials('engramExtractionApi');
      const model = ctx.getNodeParameter('summaryModel', i, '') as string;
      const concurrency = ctx.getNodeParameter('summaryConcurrency', i, 3) as number;

      if (!model) {
        throw new NodeOperationError(
          ctx.getNode(),
          'Summary Model is required when Generate Summaries is enabled',
          { itemIndex: i },
        );
      }

      const llm = new LlmClient({
        apiKey: extractionCreds.apiKey as string,
        baseUrl: extractionCreds.baseUrl as string,
        model,
      });
      const summarizer = new CommunitySummarizer(llm);
      result = await summarizer.summarizeAll(result, concurrency);
    }

    returnData.push({
      json: {
        total_entities: result.total_entities,
        unclustered_entities: result.unclustered_entities,
        detection_method: result.detection_method,
        community_count: result.communities.length,
        communities: result.communities.map((c) => ({
          id: c.id,
          label: c.label,
          summary: c.summary,
          entity_count: c.entity_count,
          edge_count: c.edge_count,
          key_entities: c.key_entities,
          members: c.members.map((m) => ({
            uuid: m.entity.uuid,
            name: m.entity.name,
            entity_type: m.entity.entity_type,
            edge_count: m.edges.length,
          })),
        })),
      },
    });
  }
}

async function executeExtractionQueue(
  ctx: IExecuteFunctions,
  storage: import('../../storage/IGraphStorage').IGraphStorage,
  operation: string,
  i: number,
  output: INodeExecutionData[],
): Promise<void> {
  if (
    (ctx.getNode().typeVersion ?? 1) < 2 ||
    !storage.readExtractionSnapshot ||
    !storage.extractionQueueCommand
  )
    throw new Error('Durable extraction requires supported Memory and Admin v2');
  const group = ctx.getNodeParameter('queueGroupId', i, '') as string;
  if (!group.trim()) throw new Error('Queue Group ID is required');
  if (operation === 'queueExport') {
    output.push({
      json: exportQueueBackup(
        await storage.readExtractionSnapshot(group),
      ) as unknown as IDataObject,
    });
    return;
  }
  if (operation === 'queueImport') {
    if (!storage.importExtractionBackup) throw new Error('Queue-aware import is unsupported');
    const raw = ctx.getNodeParameter('queueBackup', i, '{}');
    let input: unknown = raw;
    if (typeof raw === 'string') {
      try {
        input = JSON.parse(raw);
      } catch {
        throw new Error('Invalid queue backup JSON');
      }
    }
    // Imported namespace must be explicit; do not silently select another destination.
    const envelope = input as {
      graph?: { group_id?: string; episodes?: Array<{ group_id: string }> };
    };
    if (
      envelope.graph?.group_id !== group ||
      envelope.graph?.episodes?.some((ep) => ep.group_id !== group)
    )
      throw new Error('Queue backup namespace must match Queue Group ID');
    await storage.importExtractionBackup(input);
    output.push({ json: { operation, imported: true, paused: true } });
    return;
  }
  if (operation === 'queueStatus') {
    const snapshot = await storage.readExtractionSnapshot(group);
    const priority = (state: string) =>
      state === 'failed'
        ? 0
        : state === 'leased' || state === 'staged'
          ? 1
          : state === 'pending' || state === 'retry_wait' || state === 'paused'
            ? 2
            : 3;
    const all = jobs(snapshot).sort(
      (a, b) =>
        priority(a.state) - priority(b.state) ||
        a.created_at.localeCompare(b.created_at) ||
        a.uuid.localeCompare(b.uuid),
    );
    output.push({
      json: {
        operation,
        pending: all.filter((job) => !['completed', 'cancelled', 'failed'].includes(job.state))
          .length,
        failed: all.filter((job) => job.state === 'failed').length,
        oldest_pending_at:
          all
            .filter((job) => !['completed', 'cancelled', 'failed'].includes(job.state))
            .map((job) => job.created_at)
            .sort()[0] ?? null,
        jobs: all.slice(0, 100).map((job) => ({
          uuid: job.uuid,
          state: job.state,
          attempts: job.processing_attempts,
          recoveries: job.recoveries,
          created_at: job.created_at,
          last_error: job.last_error,
        })),
        truncated: all.length > 100,
      },
    });
    return;
  }
  let settings: ExtractionSettings | undefined;
  const route = ctx.getNodeParameter('extractionRouteId', i, '') as string;
  if (['queueProcess', 'queueResume', 'queueRetry', 'queueRebind'].includes(operation)) {
    const credentials = await ctx.getCredentials('engramExtractionApi');
    const model = ctx.getNodeParameter('queueModel', i, '') as string;
    if (!model || !route) throw new Error('Extraction model and route must match the producer');
    const mode = ctx.getNodeParameter('queueTemperatureMode', i, 'legacy');
    const temperature = ExtractionTemperatureSchema.parse(
      mode === 'custom'
        ? { mode, value: ctx.getNodeParameter('queueTemperature', i, 0) }
        : { mode },
    );
    const policy = readExtractionPolicy((name, fallback) =>
      ctx.getNodeParameter(name, i, fallback as string),
    );
    if (policy.mode !== 'bounded') throw new Error('Durable worker requires bounded extraction');
    settings = {
      ...((ctx.getNode().typeVersion ?? 1) >= 3 &&
      readAutomaticPolicy((name, fallback) => ctx.getNodeParameter(name, i, fallback as string))
        .profileId !== 'existing'
        ? {
            automaticPolicy: readAutomaticPolicy((name, fallback) =>
              ctx.getNodeParameter(name, i, fallback as string),
            ),
          }
        : {}),
      llm: {
        apiKey: credentials.apiKey as string,
        baseUrl: credentials.baseUrl as string,
        model,
        temperature,
      },
      policy,
      types: (
        ctx.getNodeParameter(
          'queueEntityTypes',
          i,
          'person, organization, location, concept, event',
        ) as string
      )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      threshold: {
        autoAcceptThreshold: ctx.getNodeParameter('queueAutoAccept', i, 0.85) as number,
        rejectBelowThreshold: ctx.getNodeParameter('queueRejectBelow', i, 0.3) as number,
      },
    };
    if (ctx.getNodeParameter('queueEmbeddings', i, 'disabled') === 'enabled') {
      const embeddingModel = ctx.getNodeParameter('queueEmbeddingModel', i, '') as string;
      if (!embeddingModel) throw new Error('Embedding model is required');
      settings.embeddings = {
        apiKey: credentials.apiKey as string,
        baseUrl: credentials.baseUrl as string,
        model: embeddingModel,
      };
    }
  }
  if (operation === 'queueProcess') {
    const snapshot = await storage.readExtractionSnapshot(group);
    const configured = queueBinding(route, settings!);
    const mismatch = jobs(snapshot).filter(
      (job) =>
        !['completed', 'cancelled'].includes(job.state) &&
        (job.binding.config_hash !== configured.config_hash ||
          job.binding.route_id !== configured.route_id),
    ).length;
    const timing = new StorageAccumulator();
    const process = () =>
      processExtractionJobs(
        storage,
        group,
        route,
        settings!,
        ctx.getNodeParameter('queueBatchSize', i, 1) as number,
      );
    const results = storage.withExtractionDiagnostics
      ? await storage.withExtractionDiagnostics((value) => timing.observe(value), process)
      : await process();
    output.push({
      json: {
        operation,
        processed: results.length,
        configuration_mismatch_count: mismatch,
        storage_breakdown: timing.snapshot(),
        results: results as unknown as IDataObject[],
      },
    });
    return;
  }
  const controls: Record<string, 'pause' | 'resume' | 'retry' | 'cancel' | 'compact' | 'rebind'> = {
    queuePause: 'pause',
    queueResume: 'resume',
    queueRetry: 'retry',
    queueCancel: 'cancel',
    queueCompact: 'compact',
    queueRebind: 'rebind',
  };
  if (!controls[operation]) throw new Error('Unsupported queue operation');
  const result = await storage.extractionQueueCommand({
    action: 'control',
    group_id: group,
    job_uuid: ctx.getNodeParameter('queueJobId', i, '') as string,
    operation: controls[operation],
    actor: ctx.getNodeParameter('queueOperator', i, '') as string,
    reason: ctx.getNodeParameter('queueReason', i, '') as string,
    ...(settings ? { binding: queueBinding(route, settings) } : {}),
  });
  output.push({ json: { operation, job_uuid: result.job!.uuid, state: result.job!.state } });
}
