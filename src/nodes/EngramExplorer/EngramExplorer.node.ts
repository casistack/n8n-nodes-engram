import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import { createStorage } from '../../storage/StorageFactory';
import { HybridSearchEngine } from '../../search/HybridSearchEngine';
import { nowIso } from '../../utils/temporal';
import { GraphTraverser } from '../../traversal/GraphTraverser';
import { EpisodeTraverser } from '../../traversal/EpisodeTraverser';

export class EngramExplorer implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Explorer',
    name: 'engramExplorer',
    icon: 'file:engram-explorer.png',
    group: ['transform'],
    version: [1, 2],
    description: 'Explore, create, update, and query the Engram knowledge graph',
    defaults: {
      name: 'Engram Explorer',
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
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Entity', value: 'entity' },
          { name: 'Relationship', value: 'relationship' },
          { name: 'Episode', value: 'episode' },
          { name: 'Traversal', value: 'traversal' },
        ],
        default: 'entity',
      },
      // Entity operations
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['entity'] } },
        options: [
          {
            name: 'Create',
            value: 'create',
            description: 'Create a new entity',
            action: 'Create an entity',
          },
          {
            name: 'Delete',
            value: 'delete',
            description: 'Delete an entity by UUID',
            action: 'Delete an entity',
          },
          {
            name: 'Get',
            value: 'get',
            description: 'Get an entity by UUID',
            action: 'Get an entity',
          },
          {
            name: 'Get by Name',
            value: 'getByName',
            description: 'Get an entity by name',
            action: 'Get an entity by name',
          },
          {
            name: 'List',
            value: 'list',
            description: 'List entities in a group',
            action: 'List entities',
          },
          {
            name: 'Search',
            value: 'search',
            description: 'Search entities by text',
            action: 'Search entities',
          },
          {
            name: 'Update',
            value: 'update',
            description: 'Update an existing entity',
            action: 'Update an entity',
          },
        ],
        default: 'search',
      },
      // Relationship operations
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['relationship'] } },
        options: [
          {
            name: 'Create',
            value: 'create',
            description: 'Create a new relationship between entities',
            action: 'Create a relationship',
          },
          {
            name: 'Delete',
            value: 'delete',
            description: 'Delete a relationship by UUID',
            action: 'Delete a relationship',
          },
          {
            name: 'Get',
            value: 'get',
            description: 'Get a relationship by UUID',
            action: 'Get a relationship',
          },
          {
            name: 'Get Between',
            value: 'getBetween',
            description: 'Get relationships between two entities',
            action: 'Get relationships between entities',
          },
          {
            name: 'Get for Entity',
            value: 'getForEntity',
            description: 'Get all relationships for an entity',
            action: 'Get relationships for entity',
          },
          {
            name: 'Search',
            value: 'search',
            description: 'Search relationships by text',
            action: 'Search relationships',
          },
          {
            name: 'Update',
            value: 'update',
            description: 'Update an existing relationship',
            action: 'Update a relationship',
          },
        ],
        default: 'search',
      },
      // Episode operations
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['episode'] } },
        options: [
          {
            name: 'Get',
            value: 'get',
            description: 'Get an episode by UUID',
            action: 'Get an episode',
          },
          {
            name: 'Get Count',
            value: 'getCount',
            description: 'Get episode count for a group',
            action: 'Get episode count',
          },
          {
            name: 'Get Recent',
            value: 'getRecent',
            description: 'Get recent episodes',
            action: 'Get recent episodes',
          },
        ],
        default: 'getRecent',
      },
      // Traversal operations
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['traversal'] } },
        options: [
          {
            name: 'BFS from Entity',
            value: 'bfsFromEntity',
            description: 'Breadth-first traversal from one or more seed entities',
            action: 'BFS from entity',
          },
          {
            name: 'BFS from Episodes',
            value: 'bfsFromEpisodes',
            description: 'Traverse from entities referenced in recent episodes',
            action: 'BFS from episodes',
          },
        ],
        default: 'bfsFromEntity',
      },
      // ===== Shared Parameters =====
      // Group ID — for operations that scope by group
      {
        displayName: 'Group ID',
        name: 'groupId',
        type: 'string',
        default: '',
        required: true,
        description: 'The session/group identifier to scope the query',
        displayOptions: {
          show: {
            operation: [
              'search',
              'getByName',
              'list',
              'getRecent',
              'getCount',
              'create',
              'bfsFromEpisodes',
            ],
          },
        },
      },
      // UUID — for operations that work on a specific item
      {
        displayName: 'UUID',
        name: 'uuid',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            operation: ['get', 'delete', 'getForEntity', 'update'],
          },
        },
        description: 'The unique identifier of the entity, relationship, or episode',
      },
      // Search query
      {
        displayName: 'Query',
        name: 'query',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: { operation: ['search'] },
        },
        description: 'Search query text to find matching entities or relationships',
      },
      // ===== Entity-specific Parameters =====
      // Entity name — for getByName and create
      {
        displayName: 'Entity Name',
        name: 'entityName',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['entity'],
            operation: ['getByName', 'create'],
          },
        },
        description: 'The name of the entity',
      },
      // Entity name for update (optional — only set if you want to rename)
      {
        displayName: 'Name',
        name: 'updateName',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resource: ['entity'],
            operation: ['update'],
          },
        },
        description: 'New name for the entity (leave empty to keep current)',
      },
      // Entity type
      {
        displayName: 'Entity Type',
        name: 'entityType',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resource: ['entity'],
            operation: ['create', 'update'],
          },
        },
        placeholder: 'e.g. person, organization, location, concept',
        description: 'The type/category of the entity',
      },
      // Summary
      {
        displayName: 'Summary',
        name: 'summary',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        displayOptions: {
          show: {
            resource: ['entity'],
            operation: ['create', 'update'],
          },
        },
        description: 'A text summary describing the entity',
      },
      // ===== Relationship-specific Parameters =====
      // Source/target UUIDs for create and getBetween
      {
        displayName: 'Source Entity UUID',
        name: 'sourceUuid',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['getBetween', 'create'],
          },
        },
        description: 'UUID of the source entity',
      },
      {
        displayName: 'Target Entity UUID',
        name: 'targetUuid',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['getBetween', 'create'],
          },
        },
        description: 'UUID of the target entity',
      },
      // Relationship name
      {
        displayName: 'Relationship Name',
        name: 'relationshipName',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['create', 'update'],
          },
        },
        placeholder: 'e.g. WORKS_AT, KNOWS, LIVES_IN',
        description: 'The name/type of the relationship (auto-uppercased)',
      },
      // Fact
      {
        displayName: 'Fact',
        name: 'fact',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['create'],
          },
        },
        description: 'The factual statement this relationship represents',
      },
      // Fact for update (not required)
      {
        displayName: 'Fact',
        name: 'factUpdate',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['update'],
          },
        },
        description: 'Updated factual statement (leave empty to keep current)',
      },
      // Valid At (for edge create)
      {
        displayName: 'Valid At',
        name: 'validAt',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['create'],
          },
        },
        placeholder: '2026-01-31T12:00:00.000Z',
        description: 'When this fact became true (ISO datetime). Defaults to now.',
      },
      // Expired At (for edge update)
      {
        displayName: 'Expired At',
        name: 'expiredAt',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['update'],
          },
        },
        placeholder: '2026-01-31T12:00:00.000Z',
        description: 'Set to mark this relationship as expired/superseded',
      },
      // Invalid At (for edge update)
      {
        displayName: 'Invalid At',
        name: 'invalidAt',
        type: 'string',
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['update'],
          },
        },
        placeholder: '2026-01-31T12:00:00.000Z',
        description: 'When this fact stopped being true',
      },
      // ===== Shared Optional Parameters =====
      // Attributes JSON (for create/update on both entities and relationships)
      {
        displayName: 'Attributes',
        name: 'attributes',
        type: 'json',
        default: '{}',
        displayOptions: {
          show: {
            operation: ['create', 'update'],
          },
        },
        description: 'Additional key-value attributes as JSON object',
      },
      // Limit
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        default: 10,
        typeOptions: {
          minValue: 1,
          maxValue: 100,
        },
        displayOptions: {
          show: { operation: ['search', 'list', 'getRecent'] },
        },
        description: 'Maximum number of results to return',
      },
      // Min relevance score for search operations
      {
        displayName: 'Min Relevance Score',
        name: 'minRelevanceScore',
        type: 'number',
        default: 0,
        typeOptions: {
          minValue: 0,
          maxValue: 1,
          numberStepSize: 0.1,
        },
        displayOptions: {
          show: { operation: ['search'] },
        },
        description:
          'Minimum relevance score (0-1) for results. Higher values return only more relevant matches.',
      },
      // ===== Traversal-specific Parameters =====
      {
        displayName: 'Seed Entity UUIDs',
        name: 'seedUuids',
        type: 'string',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['traversal'],
            operation: ['bfsFromEntity'],
          },
        },
        placeholder: 'uuid1, uuid2',
        description: 'Comma-separated UUIDs of seed entities to start traversal from',
      },
      {
        displayName: 'Max Hops',
        name: 'maxHops',
        type: 'number',
        default: 2,
        typeOptions: {
          minValue: 1,
          maxValue: 10,
        },
        displayOptions: {
          show: {
            resource: ['traversal'],
          },
        },
        description: 'Maximum BFS depth (number of hops from seed entities)',
      },
      {
        displayName: 'Max Entities',
        name: 'maxEntities',
        type: 'number',
        default: 50,
        typeOptions: {
          minValue: 1,
          maxValue: 500,
        },
        displayOptions: {
          show: {
            resource: ['traversal'],
          },
        },
        description: 'Maximum number of entities to return',
      },
      {
        displayName: 'Include Expired Edges',
        name: 'includeExpiredEdges',
        type: 'boolean',
        default: false,
        displayOptions: {
          show: {
            resource: ['traversal'],
          },
        },
        description: 'Whether to include expired/superseded edges in traversal',
      },
      {
        displayName: 'Episode Count',
        name: 'episodeCount',
        type: 'number',
        default: 5,
        typeOptions: {
          minValue: 1,
          maxValue: 50,
        },
        displayOptions: {
          show: {
            resource: ['traversal'],
            operation: ['bfsFromEpisodes'],
          },
        },
        description: 'Number of recent episodes to start traversal from',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const backend = this.getNodeParameter('backend', 0, 'embedded') as string;
    const resource = this.getNodeParameter('resource', 0) as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    let storage;
    if (backend === 'neo4j') {
      const credentials = await this.getCredentials('engramNeo4jApi');
      storage = createStorage({
        backend: 'neo4j',
        uri: credentials.uri as string,
        username: credentials.username as string,
        password: credentials.password as string,
        database: credentials.database as string,
      });
    } else {
      const workflowId = this.getWorkflow().id ?? 'default';
      storage = createStorage({
        backend: 'embedded',
        persistPath: `engram-data/${workflowId}-engram.json`,
      });
    }
    await storage.initialize();

    const returnData: INodeExecutionData[] = [];

    const ctx = this;
    try {
      for (let i = 0; i < items.length; i++) {
        try {
          if (resource === 'entity') {
            await executeEntityOperation(ctx, storage, operation, i, returnData);
          } else if (resource === 'relationship') {
            await executeRelationshipOperation(ctx, storage, operation, i, returnData);
          } else if (resource === 'episode') {
            await executeEpisodeOperation(ctx, storage, operation, i, returnData);
          } else if (resource === 'traversal') {
            await executeTraversalOperation(ctx, storage, operation, i, returnData);
          }
        } catch (error: unknown) {
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(
            ctx.getNode(),
            `Engram Explorer error: ${(error as Error).message}`,
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

async function executeEntityOperation(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'create') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const name = ctx.getNodeParameter('entityName', i) as string;
    const entityType = ctx.getNodeParameter('entityType', i, '') as string;
    const summary = ctx.getNodeParameter('summary', i, '') as string;
    const attributesRaw = ctx.getNodeParameter('attributes', i, '{}') as string | object;

    if (!name) {
      throw new NodeOperationError(ctx.getNode(), 'Entity Name is required', { itemIndex: i });
    }
    if (!groupId) {
      throw new NodeOperationError(ctx.getNode(), 'Group ID is required', { itemIndex: i });
    }

    const attributes = parseAttributes(attributesRaw);
    const entity = await storage.addEntity({
      name,
      group_id: groupId,
      entity_type: entityType || 'unknown',
      summary: summary || '',
      attributes,
    });
    returnData.push({ json: entity });
  } else if (operation === 'update') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }

    const updateName = ctx.getNodeParameter('updateName', i, '') as string;
    const entityType = ctx.getNodeParameter('entityType', i, '') as string;
    const summary = ctx.getNodeParameter('summary', i, '') as string;
    const attributesRaw = ctx.getNodeParameter('attributes', i, '{}') as string | object;

    const updates: Record<string, unknown> = {};
    if (updateName) updates.name = updateName;
    if (entityType) updates.entity_type = entityType;
    if (summary) updates.summary = summary;

    const attributes = parseAttributes(attributesRaw);
    if (Object.keys(attributes).length > 0) updates.attributes = attributes;

    const entity = await storage.updateEntity(uuid, updates);
    returnData.push({ json: entity });
  } else if (operation === 'search') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const query = ctx.getNodeParameter('query', i) as string;
    const limit = ctx.getNodeParameter('limit', i) as number;
    const minScore = ctx.getNodeParameter('minRelevanceScore', i, 0) as number;

    if (!query) {
      throw new NodeOperationError(ctx.getNode(), 'Query is required', { itemIndex: i });
    }

    const searchEngine = new HybridSearchEngine(storage);
    const results = await searchEngine.searchEntities(query, groupId, {
      limit,
      min_score: minScore,
    });
    for (const r of results) {
      returnData.push({ json: { ...r.entity, _score: r.score } });
    }
  } else if (operation === 'get') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    const entity = await storage.getEntity(uuid);
    if (entity) returnData.push({ json: entity });
  } else if (operation === 'getByName') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const name = ctx.getNodeParameter('entityName', i) as string;
    if (!name) {
      throw new NodeOperationError(ctx.getNode(), 'Entity Name is required', { itemIndex: i });
    }
    const entity = await storage.getEntityByName(name, groupId);
    if (entity) returnData.push({ json: entity });
  } else if (operation === 'list') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const limit = ctx.getNodeParameter('limit', i) as number;
    const entities = await storage.listEntities(groupId, { limit });
    for (const e of entities) {
      returnData.push({ json: e });
    }
  } else if (operation === 'delete') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    await storage.deleteEntity(uuid);
    returnData.push({ json: { success: true, deleted: uuid } });
  }
}

async function executeRelationshipOperation(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'create') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const sourceUuid = ctx.getNodeParameter('sourceUuid', i) as string;
    const targetUuid = ctx.getNodeParameter('targetUuid', i) as string;
    const name = ctx.getNodeParameter('relationshipName', i, '') as string;
    const fact = ctx.getNodeParameter('fact', i) as string;
    const validAt = ctx.getNodeParameter('validAt', i, '') as string;
    const attributesRaw = ctx.getNodeParameter('attributes', i, '{}') as string | object;

    if (!groupId || !sourceUuid || !targetUuid || !fact) {
      throw new NodeOperationError(
        ctx.getNode(),
        'Group ID, Source UUID, Target UUID, and Fact are all required',
        { itemIndex: i },
      );
    }

    const attributes = parseAttributes(attributesRaw);
    const edgeName = name ? name.toUpperCase().replace(/\s+/g, '_') : 'RELATES_TO';

    const edge = await storage.addEdge({
      group_id: groupId,
      source_node_uuid: sourceUuid,
      target_node_uuid: targetUuid,
      name: edgeName,
      fact,
      valid_at: validAt || nowIso(),
      attributes,
    });
    returnData.push({ json: edge });
  } else if (operation === 'get') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    const edge = await storage.getEdge(uuid);
    if (edge) returnData.push({ json: edge });
  } else if (operation === 'update') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }

    const name = ctx.getNodeParameter('relationshipName', i, '') as string;
    const fact = ctx.getNodeParameter('factUpdate', i, '') as string;
    const expiredAt = ctx.getNodeParameter('expiredAt', i, '') as string;
    const invalidAt = ctx.getNodeParameter('invalidAt', i, '') as string;
    const attributesRaw = ctx.getNodeParameter('attributes', i, '{}') as string | object;

    const updates: Record<string, unknown> = {};
    if (name) updates.name = name.toUpperCase().replace(/\s+/g, '_');
    if (fact) updates.fact = fact;
    if (expiredAt) updates.expired_at = expiredAt;
    if (invalidAt) updates.invalid_at = invalidAt;

    const attributes = parseAttributes(attributesRaw);
    if (Object.keys(attributes).length > 0) updates.attributes = attributes;

    const edge = await storage.updateEdge(uuid, updates);
    returnData.push({ json: edge });
  } else if (operation === 'search') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const query = ctx.getNodeParameter('query', i) as string;
    const limit = ctx.getNodeParameter('limit', i) as number;
    const minScore = ctx.getNodeParameter('minRelevanceScore', i, 0) as number;

    if (!query) {
      throw new NodeOperationError(ctx.getNode(), 'Query is required', { itemIndex: i });
    }

    const searchEngine = new HybridSearchEngine(storage);
    const results = await searchEngine.searchEdges(query, groupId, {
      limit,
      min_score: minScore,
    });
    for (const r of results) {
      returnData.push({
        json: {
          ...r.edge,
          _score: r.score,
          _source: r.sourceEntity.name,
          _target: r.targetEntity.name,
        },
      });
    }
  } else if (operation === 'getForEntity') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    const edges = await storage.getEdgesForEntity(uuid);
    for (const e of edges) {
      returnData.push({ json: e });
    }
  } else if (operation === 'getBetween') {
    const sourceUuid = ctx.getNodeParameter('sourceUuid', i) as string;
    const targetUuid = ctx.getNodeParameter('targetUuid', i) as string;
    if (!sourceUuid || !targetUuid) {
      throw new NodeOperationError(ctx.getNode(), 'Both Source UUID and Target UUID are required', {
        itemIndex: i,
      });
    }
    const edges = await storage.getEdgesBetween(sourceUuid, targetUuid);
    for (const e of edges) {
      returnData.push({ json: e });
    }
  } else if (operation === 'delete') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    await storage.deleteEdge(uuid);
    returnData.push({ json: { success: true, deleted: uuid } });
  }
}

async function executeEpisodeOperation(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'get') {
    const uuid = ctx.getNodeParameter('uuid', i) as string;
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    const episode = await storage.getEpisode(uuid);
    if (episode) returnData.push({ json: episode });
  } else if (operation === 'getRecent') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const limit = ctx.getNodeParameter('limit', i) as number;
    const episodes = await storage.getRecentEpisodes(groupId, limit);
    for (const ep of episodes) {
      returnData.push({ json: ep });
    }
  } else if (operation === 'getCount') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    const count = await storage.getEpisodeCount(groupId);
    returnData.push({ json: { group_id: groupId, episode_count: count } });
  }
}

async function executeTraversalOperation(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  operation: string,
  i: number,
  returnData: INodeExecutionData[],
): Promise<void> {
  if (operation === 'bfsFromEntity') {
    const seedUuidsRaw = ctx.getNodeParameter('seedUuids', i) as string;
    const seedUuids = seedUuidsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (seedUuids.length === 0) {
      throw new NodeOperationError(ctx.getNode(), 'At least one Seed Entity UUID is required', {
        itemIndex: i,
      });
    }

    const maxHops = ctx.getNodeParameter('maxHops', i, 2) as number;
    const maxEntities = ctx.getNodeParameter('maxEntities', i, 50) as number;
    const includeExpiredEdges = ctx.getNodeParameter('includeExpiredEdges', i, false) as boolean;

    const traverser = new GraphTraverser();
    const result = await traverser.traverse(storage, seedUuids, {
      maxHops,
      maxEntities,
      includeExpiredEdges,
    });

    returnData.push({
      json: {
        entity_count: result.entities.length,
        edge_count: result.edges.length,
        total_hops: result.total_hops,
        seed_entities: result.seed_entities,
        context: result.context,
        entities: result.entities,
        edges: result.edges,
        paths: result.paths.map((p) => ({
          entity_uuid: p.entity.uuid,
          entity_name: p.entity.name,
          hop: p.hop,
          via_edge_uuid: p.via_edge?.uuid ?? null,
        })),
      },
    });
  } else if (operation === 'bfsFromEpisodes') {
    const groupId = ctx.getNodeParameter('groupId', i) as string;
    if (!groupId) {
      throw new NodeOperationError(ctx.getNode(), 'Group ID is required', { itemIndex: i });
    }

    const maxHops = ctx.getNodeParameter('maxHops', i, 2) as number;
    const maxEntities = ctx.getNodeParameter('maxEntities', i, 50) as number;
    const includeExpiredEdges = ctx.getNodeParameter('includeExpiredEdges', i, false) as boolean;
    const episodeCount = ctx.getNodeParameter('episodeCount', i, 5) as number;

    const traverser = new EpisodeTraverser();
    const result = await traverser.traverseFromRecentEpisodes(storage, groupId, {
      maxHops,
      maxEntities,
      includeExpiredEdges,
      episodeCount,
    });

    returnData.push({
      json: {
        entity_count: result.entities.length,
        edge_count: result.edges.length,
        total_hops: result.total_hops,
        seed_entities: result.seed_entities,
        context: result.context,
        entities: result.entities,
        edges: result.edges,
        paths: result.paths.map((p) => ({
          entity_uuid: p.entity.uuid,
          entity_name: p.entity.name,
          hop: p.hop,
          via_edge_uuid: p.via_edge?.uuid ?? null,
        })),
      },
    });
  }
}

function parseAttributes(raw: string | object): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}
