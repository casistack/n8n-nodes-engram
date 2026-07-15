import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeExecutionData,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  type INodeProperties,
  type INodeType,
  type INodeTypeDescription,
  NodeOperationError,
} from 'n8n-workflow';

import { createStorage } from '../../storage/StorageFactory';
import type { EpisodeFilterOptions, UpdateEpisodeInput } from '../../storage/IGraphStorage';
import { HybridSearchEngine } from '../../search/HybridSearchEngine';
import { EmbeddingService } from '../../embeddings';
import { nowIso } from '../../utils/temporal';
import { resolveStoragePath, migrateStorageIfNeeded } from '../../utils/helpers';
import { customStoragePathProperty } from '../../descriptions';
import { GraphTraverser } from '../../traversal/GraphTraverser';
import { EpisodeTraverser } from '../../traversal/EpisodeTraverser';
import { ExtractionMetadataV2Schema, reviewExtractionMetadata } from '../../schemas';

function episodeFilterStringProperties(): INodeProperties[] {
  return [
    ['Sender ID', 'episodeSenderId', 'Only return episodes from this sender ID'],
    ['Sender Name', 'episodeSenderName', 'Only return episodes from this sender name'],
    ['Conversation ID', 'episodeConversationId', 'Only return episodes in this conversation'],
    ['Source Message ID', 'episodeSourceMessageId', 'Only return this source message'],
    ['Source Workflow ID', 'episodeSourceWorkflowId', 'Only return episodes from this workflow'],
    ['Source Execution ID', 'episodeSourceExecutionId', 'Only return episodes from this execution'],
  ].map(([displayName, name, description]) => ({
    displayName,
    name,
    type: 'string',
    default: '',
    displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
    description,
  }));
}

export class EngramExplorer implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Explorer',
    name: 'engramExplorer',
    icon: 'file:engram-explorer.png',
    group: ['transform'],
    version: [1, 2, 3],
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
      {
        name: 'engramExtractionApi',
        required: false,
        displayOptions: {
          show: {
            searchMode: ['hybrid'],
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
            name: 'Get Changelog',
            value: 'getChangelog',
            description: 'Get recently created, expired, or invalidated relationships',
            action: 'Get relationship changelog',
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
            name: 'Review',
            value: 'review',
            description: 'Accept, reject, or return an extracted fact to proposed state',
            action: 'Review a relationship fact',
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
            name: 'Get by Date Range',
            value: 'getByDateRange',
            description: 'Get episodes within a date range',
            action: 'Get episodes by date range',
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
          {
            name: 'List',
            value: 'list',
            description: 'List and filter episodes in a group',
            action: 'List episodes',
          },
          {
            name: 'Update',
            value: 'update',
            description: 'Update episode content or governance metadata',
            action: 'Update an episode',
          },
          {
            name: 'Delete',
            value: 'delete',
            description: 'Delete an episode and manage linked fact provenance',
            action: 'Delete an episode',
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
              'getByDateRange',
              'getCount',
              'getChangelog',
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
            operation: ['get', 'delete', 'getForEntity', 'update', 'review'],
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
      {
        displayName: 'Search Mode',
        name: 'searchMode',
        type: 'options',
        default: 'text',
        displayOptions: {
          show: {
            operation: ['search'],
            resource: ['entity', 'relationship'],
          },
        },
        options: [
          {
            name: 'Text Only',
            value: 'text',
            description: 'Search using full-text matching only.',
          },
          {
            name: 'Hybrid (Text + Semantic)',
            value: 'hybrid',
            description:
              'Combine full-text search with embedding-based semantic search using RRF fusion.',
          },
        ],
        description: 'How search results should be retrieved and ranked.',
      },
      {
        displayName: 'Embedding Model',
        name: 'embeddingModel',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getModels',
        },
        default: '',
        displayOptions: {
          show: {
            operation: ['search'],
            resource: ['entity', 'relationship'],
            searchMode: ['hybrid'],
          },
        },
        description:
          'Embedding model used for semantic search. Uses the Engram Extraction LLM credential.',
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
      {
        displayName: 'Fact Review Status',
        name: 'factReviewFilter',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Accepted', value: 'accepted' },
          { name: 'Proposed', value: 'proposed' },
          { name: 'Rejected', value: 'rejected' },
        ],
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts in this review state',
      },
      {
        displayName: 'Source Sender ID',
        name: 'factSenderIdFilter',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported by episodes from this sender',
      },
      {
        displayName: 'Source Episode Kind',
        name: 'factEpisodeKindFilter',
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
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported by this episode kind',
      },
      {
        displayName: 'Source Trust Level',
        name: 'factTrustFilter',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Standard', value: 'standard' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported at this trust level',
      },
      {
        displayName: 'Source Workflow ID',
        name: 'factSourceWorkflowFilter',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported by this source workflow',
      },
      {
        displayName: 'Source Execution ID',
        name: 'factSourceExecutionFilter',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported by this source execution',
      },
      {
        displayName: 'Source Reference Time After',
        name: 'factReferenceAfter',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported at or after this time',
      },
      {
        displayName: 'Source Reference Time Before',
        name: 'factReferenceBefore',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['relationship'], operation: ['search'] } },
        description: 'Only return facts supported at or before this time',
      },
      {
        displayName: 'Review Status',
        name: 'factReviewStatus',
        type: 'options',
        options: [
          { name: 'Accepted', value: 'accepted' },
          { name: 'Rejected', value: 'rejected' },
          { name: 'Proposed', value: 'proposed' },
        ],
        default: 'accepted',
        displayOptions: { show: { resource: ['relationship'], operation: ['review'] } },
        description: 'New review state for the extracted fact',
      },
      {
        displayName: 'Reviewed By',
        name: 'factReviewedBy',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { resource: ['relationship'], operation: ['review'] } },
        description: 'Operator or process identifier responsible for this review decision',
      },
      {
        displayName: 'Confidence Override',
        name: 'factConfidenceOverride',
        type: 'string',
        default: '',
        placeholder: '0.9 or null',
        displayOptions: { show: { resource: ['relationship'], operation: ['review'] } },
        description: 'Optional confidence from 0 to 1, null to clear, or empty to preserve',
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
          show: { operation: ['search', 'list', 'getRecent', 'getByDateRange', 'getChangelog'] },
        },
        description: 'Maximum number of results to return',
      },
      {
        displayName: 'Offset',
        name: 'offset',
        type: 'number',
        default: 0,
        typeOptions: {
          minValue: 0,
        },
        displayOptions: {
          show: {
            resource: ['entity', 'episode'],
            operation: ['list'],
          },
        },
        description: 'Number of matching entities to skip before returning results',
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
      {
        displayName: 'Retrieval Diagnostics',
        name: 'retrievalDiagnostics',
        type: 'options',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        default: 'disabled',
        displayOptions: {
          show: {
            operation: ['search'],
            resource: ['entity', 'relationship'],
          },
        },
        description:
          'Return one aggregate record with bounded candidate decisions and a context-budget preview',
      },
      {
        displayName: 'Diagnostics Candidate Limit',
        name: 'diagnosticsCandidateLimit',
        type: 'number',
        default: 100,
        typeOptions: {
          minValue: 1,
          maxValue: 250,
        },
        displayOptions: {
          show: {
            operation: ['search'],
            resource: ['entity', 'relationship'],
            retrievalDiagnostics: ['enabled'],
          },
        },
        description: 'Maximum number of candidate decisions included in the audit trace',
      },
      {
        displayName: 'Context Preview Token Budget',
        name: 'diagnosticsContextTokenBudget',
        type: 'number',
        default: 1000,
        typeOptions: {
          minValue: 64,
          maxValue: 100000,
        },
        displayOptions: {
          show: {
            operation: ['search'],
            resource: ['entity', 'relationship'],
            retrievalDiagnostics: ['enabled'],
          },
        },
        description: 'Token budget used to demonstrate which complete context items would fit',
      },
      // ===== Temporal Parameters =====
      // From Date — for episode date range and relationship search
      {
        displayName: 'From Date',
        name: 'fromDate',
        type: 'dateTime',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['episode'],
            operation: ['getByDateRange'],
          },
        },
        description: 'Start of date range (ISO 8601)',
      },
      // To Date — for episode date range
      {
        displayName: 'To Date',
        name: 'toDate',
        type: 'dateTime',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['episode'],
            operation: ['getByDateRange'],
          },
        },
        description: 'End of date range (ISO 8601)',
      },
      // ===== Episode Lifecycle Parameters =====
      {
        displayName: 'Role',
        name: 'episodeRoleFilter',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Human', value: 'human' },
          { name: 'AI', value: 'ai' },
          { name: 'System', value: 'system' },
        ],
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes with this message role',
      },
      {
        displayName: 'Source Type',
        name: 'episodeSourceTypeFilter',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Message', value: 'message' },
          { name: 'Document', value: 'document' },
          { name: 'API', value: 'api' },
        ],
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes from this source type',
      },
      {
        displayName: 'Episode Kind',
        name: 'episodeKindFilter',
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
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes with this provenance kind',
      },
      {
        displayName: 'Trust Level',
        name: 'episodeTrustFilter',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Standard', value: 'standard' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes with this trust level',
      },
      {
        displayName: 'Review Status',
        name: 'episodeReviewFilter',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Proposed', value: 'proposed' },
          { name: 'Accepted', value: 'accepted' },
          { name: 'Rejected', value: 'rejected' },
        ],
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes with this review status',
      },
      ...episodeFilterStringProperties(),
      {
        displayName: 'Reference Time After',
        name: 'episodeReferenceAfter',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes referenced at or after this time',
      },
      {
        displayName: 'Reference Time Before',
        name: 'episodeReferenceBefore',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes referenced at or before this time',
      },
      {
        displayName: 'Created After',
        name: 'episodeCreatedAfter',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes created at or after this time',
      },
      {
        displayName: 'Created Before',
        name: 'episodeCreatedBefore',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
        description: 'Only return episodes created at or before this time',
      },
      {
        displayName: 'Sort By',
        name: 'episodeSortBy',
        type: 'options',
        options: [
          { name: 'Reference Time', value: 'reference_time' },
          { name: 'Created At', value: 'created_at' },
        ],
        default: 'reference_time',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
      },
      {
        displayName: 'Sort Order',
        name: 'episodeSortOrder',
        type: 'options',
        options: [
          { name: 'Newest First', value: 'desc' },
          { name: 'Oldest First', value: 'asc' },
        ],
        default: 'desc',
        displayOptions: { show: { resource: ['episode'], operation: ['list'] } },
      },
      {
        displayName: 'Content',
        name: 'episodeContentUpdate',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['update'] } },
        description: 'Replacement content. Leave empty to keep the current content.',
      },
      {
        displayName: 'Sender Name',
        name: 'episodeSenderNameUpdate',
        type: 'string',
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['update'] } },
        description: 'Replacement sender name. Leave empty to keep the current value.',
      },
      {
        displayName: 'Trust Level',
        name: 'episodeTrustUpdate',
        type: 'options',
        options: [
          { name: 'No Change', value: '' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Standard', value: 'standard' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['update'] } },
      },
      {
        displayName: 'Review Status',
        name: 'episodeReviewUpdate',
        type: 'options',
        options: [
          { name: 'No Change', value: '' },
          { name: 'Proposed', value: 'proposed' },
          { name: 'Accepted', value: 'accepted' },
          { name: 'Rejected', value: 'rejected' },
        ],
        default: '',
        displayOptions: { show: { resource: ['episode'], operation: ['update'] } },
      },
      {
        displayName: 'Confidence',
        name: 'episodeConfidenceUpdate',
        type: 'string',
        default: '',
        placeholder: '0.85 or null',
        displayOptions: { show: { resource: ['episode'], operation: ['update'] } },
        description: 'Set a value from 0 to 1, use null to clear it, or leave empty unchanged',
      },
      {
        displayName: 'Repair Episode Chain',
        name: 'repairEpisodeChain',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: { show: { resource: ['episode'], operation: ['delete'] } },
        description: 'Reconnect successor episodes to the deleted episode predecessor',
      },
      {
        displayName: 'Linked Fact Handling',
        name: 'episodeFactCleanup',
        type: 'options',
        options: [
          { name: 'Unlink Episode', value: 'unlink' },
          { name: 'Preserve References', value: 'preserve' },
          { name: 'Delete Orphaned Facts', value: 'delete_orphaned' },
        ],
        default: 'unlink',
        displayOptions: { show: { resource: ['episode'], operation: ['delete'] } },
        description: 'How facts linked to the deleted episode should be handled',
      },
      // Since Date — for relationship changelog
      {
        displayName: 'Since Date',
        name: 'sinceDate',
        type: 'dateTime',
        default: '',
        required: true,
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['getChangelog'],
          },
        },
        description: 'Show changes since this date (ISO 8601)',
      },
      // Optional date filters for relationship search
      {
        displayName: 'Valid After',
        name: 'searchValidAfter',
        type: 'dateTime',
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['search'],
          },
        },
        description: 'Only return facts that became valid after this date',
      },
      {
        displayName: 'Valid Before',
        name: 'searchValidBefore',
        type: 'dateTime',
        default: '',
        displayOptions: {
          show: {
            resource: ['relationship'],
            operation: ['search'],
          },
        },
        description: 'Only return facts that became valid before this date',
      },
      // Optional created_after filter for entity search and list
      {
        displayName: 'Created After',
        name: 'createdAfter',
        type: 'dateTime',
        default: '',
        displayOptions: {
          show: {
            operation: ['search', 'list'],
            resource: ['entity', 'relationship'],
          },
        },
        description: 'Only return results created after this date',
      },
      {
        displayName: 'Created Before',
        name: 'createdBefore',
        type: 'dateTime',
        default: '',
        displayOptions: {
          show: {
            operation: ['search', 'list'],
            resource: ['entity', 'relationship'],
          },
        },
        description: 'Only return results created before this date',
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

  methods = {
    loadOptions: {
      async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        let credentials;
        try {
          credentials = await this.getCredentials('engramExtractionApi');
        } catch {
          return [{ name: 'Configure credential first', value: '' }];
        }

        const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
        const apiKey = credentials.apiKey as string;

        try {
          let response;
          try {
            response = await this.helpers.httpRequest({
              method: 'GET',
              url: `${baseUrl}/models`,
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
              timeout: 10000,
            });
          } catch {
            response = await this.helpers.httpRequest({
              method: 'GET',
              url: `${baseUrl}/models`,
              timeout: 10000,
            });
          }

          const modelList = response.data || response;
          const models = (Array.isArray(modelList) ? modelList : []) as Array<{
            id: string;
            owned_by?: string;
          }>;

          if (models.length === 0) {
            return [{ name: 'No models found — check Base URL in credential', value: '' }];
          }

          return models
            .map((model) => ({
              name: model.id,
              value: model.id,
              description: model.owned_by ? `Provider: ${model.owned_by}` : undefined,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
          return [
            {
              name: `Error: ${(error as Error).message.slice(0, 80)}`,
              value: '',
            },
          ];
        }
      },
    },
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
    }
    await storage.initialize();

    const returnData: INodeExecutionData[] = [];

    try {
      for (let i = 0; i < items.length; i++) {
        try {
          if (resource === 'entity') {
            await executeEntityOperation(this, storage, operation, i, returnData);
          } else if (resource === 'relationship') {
            await executeRelationshipOperation(this, storage, operation, i, returnData);
          } else if (resource === 'episode') {
            await executeEpisodeOperation(this, storage, operation, i, returnData);
          } else if (resource === 'traversal') {
            await executeTraversalOperation(this, storage, operation, i, returnData);
          }
        } catch (error: unknown) {
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(
            this.getNode(),
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const query = ctx.getNodeParameter('query', i) as string;
    const limit = ctx.getNodeParameter('limit', i) as number;
    const minScore = ctx.getNodeParameter('minRelevanceScore', i, 0) as number;
    const createdAfter = ctx.getNodeParameter('createdAfter', i, '') as string;
    const createdBefore = ctx.getNodeParameter('createdBefore', i, '') as string;
    const diagnosticsEnabled =
      (ctx.getNodeParameter('retrievalDiagnostics', i, 'disabled') as string) === 'enabled';

    if (!query) {
      throw new NodeOperationError(ctx.getNode(), 'Query is required', { itemIndex: i });
    }

    const searchEngine = await createExplorerSearchEngine(ctx, storage, i);
    const results = await searchEngine.search(query, groupId, {
      limit,
      minScore,
      createdAfter: createdAfter || undefined,
      createdBefore: createdBefore || undefined,
      includeDiagnostics: diagnosticsEnabled,
      diagnosticsCandidateLimit: ctx.getNodeParameter(
        'diagnosticsCandidateLimit',
        i,
        100,
      ) as number,
    });
    if (diagnosticsEnabled) {
      const contextPreview = searchEngine.formatAsContextWithAudit(
        { ...results, edges: [] },
        ctx.getNodeParameter('diagnosticsContextTokenBudget', i, 1000) as number,
        true,
      );
      returnData.push({
        json: {
          results: results.entities.map((result) => ({
            ...result.entity,
            _score: result.score,
          })),
          _retrieval_audit: {
            ...results.audit,
            context_budget: contextPreview.audit,
          },
          _context_preview: contextPreview.context,
        },
      });
      return;
    }
    for (const r of results.entities) {
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const name = ctx.getNodeParameter('entityName', i) as string;
    if (!name) {
      throw new NodeOperationError(ctx.getNode(), 'Entity Name is required', { itemIndex: i });
    }
    const entity = await storage.getEntityByName(name, groupId);
    if (entity) returnData.push({ json: entity });
  } else if (operation === 'list') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const limit = ctx.getNodeParameter('limit', i) as number;
    const offset = ctx.getNodeParameter('offset', i, 0) as number;
    const createdAfter = ctx.getNodeParameter('createdAfter', i, '') as string;
    const createdBefore = ctx.getNodeParameter('createdBefore', i, '') as string;
    const entities = await storage.listEntities(groupId, {
      limit,
      offset,
      created_after: createdAfter || undefined,
      created_before: createdBefore || undefined,
    });
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const query = ctx.getNodeParameter('query', i) as string;
    const limit = ctx.getNodeParameter('limit', i) as number;
    const minScore = ctx.getNodeParameter('minRelevanceScore', i, 0) as number;
    const validAfter = ctx.getNodeParameter('searchValidAfter', i, '') as string;
    const validBefore = ctx.getNodeParameter('searchValidBefore', i, '') as string;
    const createdAfter = ctx.getNodeParameter('createdAfter', i, '') as string;
    const createdBefore = ctx.getNodeParameter('createdBefore', i, '') as string;
    const diagnosticsEnabled =
      (ctx.getNodeParameter('retrievalDiagnostics', i, 'disabled') as string) === 'enabled';

    if (!query) {
      throw new NodeOperationError(ctx.getNode(), 'Query is required', { itemIndex: i });
    }

    const searchEngine = await createExplorerSearchEngine(ctx, storage, i);
    const reviewStatus = ctx.getNodeParameter('factReviewFilter', i, '') as
      | 'proposed'
      | 'accepted'
      | 'rejected'
      | '';
    const results = await searchEngine.search(query, groupId, {
      limit,
      minScore,
      validAfter: validAfter || undefined,
      validBefore: validBefore || undefined,
      createdAfter: createdAfter || undefined,
      createdBefore: createdBefore || undefined,
      includeDiagnostics: diagnosticsEnabled,
      diagnosticsCandidateLimit: ctx.getNodeParameter(
        'diagnosticsCandidateLimit',
        i,
        100,
      ) as number,
      retrievalFilters: {
        review_statuses: reviewStatus ? [reviewStatus] : undefined,
        sender_id:
          (ctx.getNodeParameter('factSenderIdFilter', i, '') as string).trim() || undefined,
        episode_kind: ((ctx.getNodeParameter('factEpisodeKindFilter', i, '') as string) ||
          undefined) as
          | 'active_human'
          | 'passive_human'
          | 'assistant_reply'
          | 'monitor_summary'
          | 'tool_output'
          | 'system'
          | 'legacy'
          | undefined,
        trust_level: ((ctx.getNodeParameter('factTrustFilter', i, '') as string) || undefined) as
          | 'trusted'
          | 'standard'
          | 'unverified'
          | 'untrusted'
          | undefined,
        source_workflow_id:
          (ctx.getNodeParameter('factSourceWorkflowFilter', i, '') as string).trim() || undefined,
        source_execution_id:
          (ctx.getNodeParameter('factSourceExecutionFilter', i, '') as string).trim() || undefined,
        reference_after: (ctx.getNodeParameter('factReferenceAfter', i, '') as string) || undefined,
        reference_before:
          (ctx.getNodeParameter('factReferenceBefore', i, '') as string) || undefined,
      },
    });
    if (diagnosticsEnabled) {
      const contextPreview = searchEngine.formatAsContextWithAudit(
        { ...results, entities: [] },
        ctx.getNodeParameter('diagnosticsContextTokenBudget', i, 1000) as number,
        true,
      );
      returnData.push({
        json: {
          results: results.edges.map((result) => ({
            ...result.edge,
            _score: result.score,
            _source: result.sourceEntity.name,
            _target: result.targetEntity.name,
            _provenance: result.provenance,
          })),
          _retrieval_audit: {
            ...results.audit,
            context_budget: contextPreview.audit,
          },
          _context_preview: contextPreview.context,
        },
      });
      return;
    }
    for (const r of results.edges) {
      returnData.push({
        json: {
          ...r.edge,
          _score: r.score,
          _source: r.sourceEntity.name,
          _target: r.targetEntity.name,
          _provenance: r.provenance,
        },
      });
    }
  } else if (operation === 'review') {
    const uuid = (ctx.getNodeParameter('uuid', i) as string).trim();
    const reviewStatus = ctx.getNodeParameter('factReviewStatus', i, 'accepted') as
      | 'proposed'
      | 'accepted'
      | 'rejected';
    const reviewedBy = (ctx.getNodeParameter('factReviewedBy', i) as string).trim();
    const confidenceRaw = (ctx.getNodeParameter('factConfidenceOverride', i, '') as string).trim();
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }
    if (!reviewedBy) {
      throw new NodeOperationError(ctx.getNode(), 'Reviewed By is required', { itemIndex: i });
    }

    const edge = await storage.getEdge(uuid);
    if (!edge) {
      throw new NodeOperationError(ctx.getNode(), `Relationship not found: ${uuid}`, {
        itemIndex: i,
      });
    }
    let confidence: number | null | undefined;
    if (confidenceRaw === 'null') {
      confidence = null;
    } else if (confidenceRaw) {
      confidence = Number(confidenceRaw);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new NodeOperationError(ctx.getNode(), 'Confidence must be between 0 and 1 or null', {
          itemIndex: i,
        });
      }
    }

    const reviewedAt = nowIso();
    const metadata = ExtractionMetadataV2Schema.parse({
      ...reviewExtractionMetadata(
        edge.attributes.engram_extraction,
        reviewStatus,
        reviewedBy,
        reviewedAt,
        confidence,
      ),
      episode_uuids: edge.episodes,
    });
    const updated = await storage.updateEdge(uuid, {
      attributes: { ...edge.attributes, engram_extraction: metadata },
    });
    returnData.push({ json: updated });
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
  } else if (operation === 'getChangelog') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const sinceDate = ctx.getNodeParameter('sinceDate', i) as string;
    const limit = ctx.getNodeParameter('limit', i, 50) as number;

    if (!sinceDate) {
      throw new NodeOperationError(ctx.getNode(), 'Since Date is required', { itemIndex: i });
    }

    const entries = await storage.getEdgeChangelog(groupId, sinceDate, { limit });
    for (const entry of entries) {
      returnData.push({
        json: {
          ...entry.edge,
          _change_type: entry.change_type,
          _changed_at: entry.changed_at,
          _source: entry.sourceEntity.name,
          _target: entry.targetEntity.name,
        },
      });
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const limit = ctx.getNodeParameter('limit', i) as number;
    const episodes = await storage.getRecentEpisodes(groupId, limit);
    for (const ep of episodes) {
      returnData.push({ json: ep });
    }
  } else if (operation === 'getByDateRange') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const fromDate = ctx.getNodeParameter('fromDate', i) as string;
    const toDate = ctx.getNodeParameter('toDate', i) as string;
    const limit = ctx.getNodeParameter('limit', i, 50) as number;

    if (!fromDate || !toDate) {
      throw new NodeOperationError(ctx.getNode(), 'Both From Date and To Date are required', {
        itemIndex: i,
      });
    }

    const episodes = await storage.getEpisodesByDateRange(groupId, fromDate, toDate, limit);
    for (const ep of episodes) {
      returnData.push({ json: ep });
    }
  } else if (operation === 'getCount') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    const count = await storage.getEpisodeCount(groupId);
    returnData.push({ json: { group_id: groupId, episode_count: count } });
  } else if (operation === 'list') {
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
    if (!groupId) {
      throw new NodeOperationError(ctx.getNode(), 'Group ID is required', { itemIndex: i });
    }

    const filters = buildEpisodeFilters(ctx, i);
    filters.limit = ctx.getNodeParameter('limit', i, 10) as number;
    filters.offset = ctx.getNodeParameter('offset', i, 0) as number;
    filters.sort_by = ctx.getNodeParameter(
      'episodeSortBy',
      i,
      'reference_time',
    ) as EpisodeFilterOptions['sort_by'];
    filters.sort_order = ctx.getNodeParameter(
      'episodeSortOrder',
      i,
      'desc',
    ) as EpisodeFilterOptions['sort_order'];

    const episodes = await storage.listEpisodes(groupId, filters);
    for (const episode of episodes) {
      returnData.push({ json: episode });
    }
  } else if (operation === 'update') {
    const uuid = (ctx.getNodeParameter('uuid', i) as string).trim();
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }

    const updates: UpdateEpisodeInput = {};
    const content = ctx.getNodeParameter('episodeContentUpdate', i, '') as string;
    const senderName = ctx.getNodeParameter('episodeSenderNameUpdate', i, '') as string;
    const trustLevel = ctx.getNodeParameter('episodeTrustUpdate', i, '') as string;
    const reviewStatus = ctx.getNodeParameter('episodeReviewUpdate', i, '') as string;
    const confidenceRaw = (ctx.getNodeParameter('episodeConfidenceUpdate', i, '') as string).trim();
    const attributesRaw = ctx.getNodeParameter('attributes', i, '{}') as string | object;

    if (content) updates.content = content;
    if (senderName) updates.sender_name = senderName;
    if (trustLevel) updates.trust_level = trustLevel as UpdateEpisodeInput['trust_level'];
    if (reviewStatus) updates.review_status = reviewStatus as UpdateEpisodeInput['review_status'];
    if (confidenceRaw === 'null') {
      updates.confidence = null;
    } else if (confidenceRaw) {
      const confidence = Number(confidenceRaw);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new NodeOperationError(ctx.getNode(), 'Confidence must be between 0 and 1 or null', {
          itemIndex: i,
        });
      }
      updates.confidence = confidence;
    }

    const attributes = parseAttributes(attributesRaw);
    if (Object.keys(attributes).length > 0) updates.attributes = attributes;
    if (Object.keys(updates).length === 0) {
      throw new NodeOperationError(ctx.getNode(), 'Provide at least one episode field to update', {
        itemIndex: i,
      });
    }

    const episode = await storage.updateEpisode(uuid, updates);
    returnData.push({ json: episode });
  } else if (operation === 'delete') {
    const uuid = (ctx.getNodeParameter('uuid', i) as string).trim();
    if (!uuid) {
      throw new NodeOperationError(ctx.getNode(), 'UUID is required', { itemIndex: i });
    }

    const result = await storage.deleteEpisode(uuid, {
      repair_chain:
        (ctx.getNodeParameter('repairEpisodeChain', i, 'enabled') as string) === 'enabled',
      fact_cleanup: ctx.getNodeParameter('episodeFactCleanup', i, 'unlink') as
        | 'preserve'
        | 'unlink'
        | 'delete_orphaned',
    });
    returnData.push({ json: { ...result } });
  }
}

function buildEpisodeFilters(ctx: IExecuteFunctions, i: number): EpisodeFilterOptions {
  const filters: EpisodeFilterOptions = {};
  const values = {
    role: ctx.getNodeParameter('episodeRoleFilter', i, '') as string,
    source_type: ctx.getNodeParameter('episodeSourceTypeFilter', i, '') as string,
    episode_kind: ctx.getNodeParameter('episodeKindFilter', i, '') as string,
    trust_level: ctx.getNodeParameter('episodeTrustFilter', i, '') as string,
    review_status: ctx.getNodeParameter('episodeReviewFilter', i, '') as string,
    sender_id: (ctx.getNodeParameter('episodeSenderId', i, '') as string).trim(),
    sender_name: (ctx.getNodeParameter('episodeSenderName', i, '') as string).trim(),
    conversation_id: (ctx.getNodeParameter('episodeConversationId', i, '') as string).trim(),
    source_message_id: (ctx.getNodeParameter('episodeSourceMessageId', i, '') as string).trim(),
    source_workflow_id: (ctx.getNodeParameter('episodeSourceWorkflowId', i, '') as string).trim(),
    source_execution_id: (ctx.getNodeParameter('episodeSourceExecutionId', i, '') as string).trim(),
    reference_after: ctx.getNodeParameter('episodeReferenceAfter', i, '') as string,
    reference_before: ctx.getNodeParameter('episodeReferenceBefore', i, '') as string,
    created_after: ctx.getNodeParameter('episodeCreatedAfter', i, '') as string,
    created_before: ctx.getNodeParameter('episodeCreatedBefore', i, '') as string,
  };

  for (const [key, value] of Object.entries(values)) {
    if (value) {
      (filters as Record<string, unknown>)[key] = value;
    }
  }
  return filters;
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
    const groupId = (ctx.getNodeParameter('groupId', i) as string).trim();
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

async function createExplorerSearchEngine(
  ctx: IExecuteFunctions,
  storage: Awaited<ReturnType<typeof createStorage>>,
  itemIndex: number,
): Promise<HybridSearchEngine> {
  const searchMode = ctx.getNodeParameter('searchMode', itemIndex, 'text') as string;
  if (searchMode !== 'hybrid') {
    return new HybridSearchEngine(storage);
  }

  const embeddingModel = ctx.getNodeParameter('embeddingModel', itemIndex, '') as string;
  if (!embeddingModel) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Embedding Model is required when Search Mode is set to Hybrid (Text + Semantic)',
      { itemIndex },
    );
  }

  const credentials = await ctx.getCredentials('engramExtractionApi');
  const embeddingService = new EmbeddingService({
    apiKey: credentials.apiKey as string,
    baseUrl: credentials.baseUrl as string,
    model: embeddingModel,
  });

  return new HybridSearchEngine(storage, embeddingService);
}
