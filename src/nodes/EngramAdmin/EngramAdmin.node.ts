import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  type IDataObject,
  NodeOperationError,
} from 'n8n-workflow';

import { createStorage } from '../../storage/StorageFactory';
import { GraphDataSchema, type GraphData } from '../../schemas';
import { nowIso } from '../../utils/temporal';
import { resolveStoragePath, migrateStorageIfNeeded } from '../../utils/helpers';
import { customStoragePathProperty } from '../../descriptions';
import { CommunityDetector } from '../../community/CommunityDetector';
import { CommunitySummarizer } from '../../community/CommunitySummarizer';
import { LlmClient } from '../../extraction/LlmClient';

interface DiagnosticsContext {
  backend: string;
  persistPath?: string;
  workflowId?: string;
  customStoragePathConfigured?: boolean;
  databaseConfigured?: boolean;
}

export class EngramAdmin implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Admin',
    name: 'engramAdmin',
    icon: 'file:engram-admin.png',
    group: ['transform'],
    version: [1, 2],
    description: 'Manage and administer the Engram knowledge graph',
    defaults: {
      name: 'Engram Admin',
    },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],
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
        displayOptions: {
          show: {
            generateSummaries: [true],
          },
        },
      },
    ],
    properties: [
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
            operation: ['export', 'stats'],
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
            operation: ['expireStaleEdges'],
          },
        },
        description:
          'If enabled, only reports stale edges without modifying them. Disable to actually expire them.',
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
    const items = this.getInputData();
    const backend = this.getNodeParameter('backend', 0, 'embedded') as string;
    const resource = this.getNodeParameter('resource', 0, 'monitoring') as string;
    const operation = this.getNodeParameter('operation', 0) as string;

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
        backend,
        databaseConfigured: Boolean((credentials.database as string | undefined)?.trim()),
      };
    } else {
      const workflowId = this.getWorkflow().id ?? 'default';
      const customPath = this.getNodeParameter('customStoragePath', 0, '') as string;
      const persistPath = resolveStoragePath({
        customStoragePath: customPath,
        workflowId,
      });

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
        backend,
        persistPath,
        workflowId,
        customStoragePathConfigured: customPath.trim().length > 0,
      };
    }
    await storage.initialize();

    const returnData: INodeExecutionData[] = [];

    try {
      for (let i = 0; i < items.length; i++) {
        try {
          const beforeLength = returnData.length;

          if (resource === 'monitoring') {
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
          if (returnData.length === beforeLength) {
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

    return [returnData.length > 0 ? returnData : [{ json: {} }]];
  }
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
  } else if (operation === 'diagnostics') {
    const includeDeepChecks =
      (ctx.getNodeParameter('includeDeepChecks', i, 'disabled') as string) === 'enabled';
    const stats = await storage.getStats();
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
      diagnostics.embedded_storage = {
        workflow_id: diagnosticsContext.workflowId,
        persist_path: diagnosticsContext.persistPath,
        custom_storage_path_configured: diagnosticsContext.customStoragePathConfigured,
      };
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
    await storage.clearGroup(groupId);
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

    const cleared: string[] = [];
    const failed: Array<{ group_id: string; error: string }> = [];

    for (const gid of groupIds) {
      try {
        await storage.clearGroup(gid);
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
    await storage.clearAll();
    returnData.push({
      json: { success: true, operation: 'clearAll' },
    });
  }
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
    const data = await storage.exportGraph(groupId || undefined);
    returnData.push({ json: data as unknown as IDataObject });
  } else if (operation === 'import') {
    const importData = ctx.getNodeParameter('importData', i) as unknown;
    const parsed = GraphDataSchema.safeParse(importData);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issuePath = firstIssue?.path.length ? firstIssue.path.join('.') : 'root';
      throw new NodeOperationError(ctx.getNode(), 'Invalid import data format', {
        itemIndex: i,
        description: `Import data must match the Engram export schema. First issue: ${issuePath} - ${firstIssue?.message ?? 'unknown validation error'}.`,
      });
    }

    const graphData: GraphData = parsed.data;
    await storage.importGraph(graphData);
    returnData.push({
      json: {
        success: true,
        operation: 'import',
        imported: {
          entities: graphData.entities.length,
          edges: graphData.edges.length,
          episodes: graphData.episodes.length,
        },
      },
    });
  }
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
