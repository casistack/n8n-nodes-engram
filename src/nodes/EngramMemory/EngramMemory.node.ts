/* eslint-disable n8n-nodes-base/node-dirname-against-convention */
import {
  NodeConnectionType,
  type IExecuteFunctions,
  type INodeType,
  type INodeTypeDescription,
  type SupplyData,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  NodeOperationError,
} from 'n8n-workflow';

import { logWrapper } from '../../utils/logWrapper';
import { getConnectionHintNoticeField } from '../../utils/sharedFields';
import {
  sessionIdOption,
  sessionKeyProperty,
  contextWindowLengthProperty,
  customStoragePathProperty,
} from '../../descriptions';
import { getSessionId, resolveStoragePath, migrateStorageIfNeeded } from '../../utils/helpers';

import { EngramChatMemory } from '../../memory/EngramChatMemory';
import { createStorage } from '../../storage/StorageFactory';

export class EngramMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Engram Memory',
    name: 'engramMemory',
    icon: 'file:engram.png',
    group: ['transform'],
    version: [1, 2],
    description:
      'Knowledge graph memory for AI agents. Stores conversations as episodes and optionally extracts entities and relationships.',
    defaults: {
      name: 'Engram Memory',
    },
    codex: {
      categories: ['AI'],
      subcategories: {
        AI: ['Memory'],
      },
      resources: {
        primaryDocumentation: [
          {
            url: 'https://github.com/casistack/n8n-nodes-engram',
          },
        ],
      },
    },
    inputs: [],
    outputs: [NodeConnectionType.AiMemory],
    outputNames: ['Memory'],
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
            enableExtraction: ['enabled'],
          },
        },
      },
    ],
    properties: [
      getConnectionHintNoticeField([NodeConnectionType.AiAgent]),
      // Session config
      sessionIdOption,
      sessionKeyProperty,
      // Backend selection
      {
        displayName: 'Storage Backend',
        name: 'backend',
        type: 'options',
        options: [
          {
            name: 'Embedded (Graphology)',
            value: 'embedded',
            description:
              'Zero-setup in-memory graph with JSON file persistence. No external services needed.',
          },
          {
            name: 'Neo4j (Remote)',
            value: 'neo4j',
            description: 'Remote Neo4j graph database. Requires Neo4j server and credentials.',
          },
        ],
        default: 'embedded',
        description: 'Where to store the knowledge graph data',
      },
      customStoragePathProperty,
      // Context Window
      {
        ...contextWindowLengthProperty,
        default: 10,
        description: 'Number of recent conversation turns to include as context for the AI',
      },
      // Extraction settings
      {
        displayName: 'Knowledge Extraction',
        name: 'enableExtraction',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Only store conversation episodes (no entity/relationship extraction)',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description: 'Extract entities and relationships from conversations using an LLM',
          },
        ],
        default: 'disabled',
        description:
          'Whether to extract entities and relationships from conversations using an LLM. Requires Engram Extraction LLM credential.',
      },
      {
        displayName: 'Store Human Episodes',
        name: 'storeHumanEpisodes',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: { show: { '@version': [2] } },
        description: 'Whether human messages should be persisted as episodes',
      },
      {
        displayName: 'Human Episode Kind',
        name: 'humanEpisodeKind',
        type: 'options',
        options: [
          {
            name: 'Active Human',
            value: 'active_human',
            description: 'A message sent directly to the agent in an active conversation',
          },
          {
            name: 'Passive Human',
            value: 'passive_human',
            description: 'A human message observed or curated outside the active conversation',
          },
        ],
        default: 'active_human',
        displayOptions: { show: { '@version': [2] } },
        description:
          'Provenance kind applied to stored human episodes and human extraction sources',
      },
      {
        displayName: 'Store AI Episodes',
        name: 'storeAiEpisodes',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: { show: { '@version': [2] } },
        description: 'Whether assistant replies should be persisted as episodes',
      },
      {
        displayName: 'Extract from Human Messages',
        name: 'extractHuman',
        type: 'options',
        options: [
          { name: 'Enabled', value: 'enabled' },
          { name: 'Disabled', value: 'disabled' },
        ],
        default: 'enabled',
        displayOptions: {
          show: { '@version': [2], enableExtraction: ['enabled'] },
        },
        description: 'Whether human message content is eligible for knowledge extraction',
      },
      {
        displayName: 'Extract from AI Messages',
        name: 'extractAi',
        type: 'options',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        default: 'disabled',
        displayOptions: {
          show: { '@version': [2], enableExtraction: ['enabled'] },
        },
        description: 'Whether assistant reply content is eligible for knowledge extraction',
      },
      {
        displayName: 'Extract from System and Tool Content',
        name: 'extractSystemTool',
        type: 'options',
        options: [
          { name: 'Disabled', value: 'disabled' },
          { name: 'Enabled', value: 'enabled' },
        ],
        default: 'disabled',
        displayOptions: {
          show: { '@version': [2], enableExtraction: ['enabled'] },
        },
        description:
          'Whether recognized system messages and tool outputs are eligible for knowledge extraction',
      },
      {
        displayName: 'Auto-Accept Confidence',
        name: 'autoAcceptConfidence',
        type: 'number',
        default: 0.85,
        typeOptions: { minValue: 0, maxValue: 1, numberStepSize: 0.05 },
        displayOptions: {
          show: { '@version': [2], enableExtraction: ['enabled'] },
        },
        description: 'Facts at or above this confidence are accepted automatically',
      },
      {
        displayName: 'Reject Below Confidence',
        name: 'rejectBelowConfidence',
        type: 'number',
        default: 0.3,
        typeOptions: { minValue: 0, maxValue: 1, numberStepSize: 0.05 },
        displayOptions: {
          show: { '@version': [2], enableExtraction: ['enabled'] },
        },
        description:
          'Facts below this confidence are rejected; intermediate confidence remains proposed',
      },
      {
        displayName: 'Memory Fact Policy',
        name: 'memoryFactPolicy',
        type: 'options',
        options: [
          {
            name: 'Accepted Facts Only',
            value: 'acceptedOnly',
            description: 'Inject only accepted facts and manually created graph data',
          },
          {
            name: 'All Facts (Legacy)',
            value: 'all',
            description: 'Allow proposed and rejected extraction records into memory context',
          },
        ],
        default: 'acceptedOnly',
        displayOptions: { show: { '@version': [2], enableExtraction: ['enabled'] } },
        description: 'Which reviewed fact states may be injected into agent memory',
      },
      {
        displayName: 'Context Token Budget',
        name: 'contextTokenBudget',
        type: 'number',
        default: 2000,
        typeOptions: { minValue: 100, maxValue: 32000 },
        displayOptions: { show: { '@version': [2] } },
        description:
          'Approximate total token budget shared by entity, fact, provenance, and traversal context',
      },
      {
        displayName: 'Retrieval Sender ID',
        name: 'retrievalSenderId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts supported by episodes from this sender',
      },
      {
        displayName: 'Retrieval Episode Kind',
        name: 'retrievalEpisodeKind',
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
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts supported by this episode kind',
      },
      {
        displayName: 'Retrieval Trust Level',
        name: 'retrievalTrustLevel',
        type: 'options',
        options: [
          { name: 'Any', value: '' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Standard', value: 'standard' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts supported by episodes at this trust level',
      },
      {
        displayName: 'Retrieval Source Workflow ID',
        name: 'retrievalSourceWorkflowId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts written by this source workflow',
      },
      {
        displayName: 'Retrieval Source Execution ID',
        name: 'retrievalSourceExecutionId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts written by this source execution',
      },
      {
        displayName: 'Retrieval Reference Time After',
        name: 'retrievalReferenceAfter',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts supported at or after this time',
      },
      {
        displayName: 'Retrieval Reference Time Before',
        name: 'retrievalReferenceBefore',
        type: 'dateTime',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Only retrieve facts supported at or before this time',
      },
      {
        displayName: 'Source Message ID',
        name: 'sourceMessageId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Stable upstream message ID used to deduplicate retried deliveries',
      },
      {
        displayName: 'Idempotency Key',
        name: 'episodeIdempotencyKey',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Optional stable turn key used when no source message ID is available',
      },
      {
        displayName: 'Conversation ID',
        name: 'conversationId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Upstream conversation or thread ID. Defaults to the Engram session ID.',
      },
      {
        displayName: 'Sender ID',
        name: 'senderId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Stable identifier for the human sender',
      },
      {
        displayName: 'Sender Name',
        name: 'senderName',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Display name for the human sender',
      },
      {
        displayName: 'Quoted Message ID',
        name: 'quotedMessageId',
        type: 'string',
        default: '',
        displayOptions: { show: { '@version': [2] } },
        description: 'Optional identifier of the message being quoted or replied to',
      },
      {
        displayName: 'Episode Trust Level',
        name: 'episodeTrustLevel',
        type: 'options',
        options: [
          { name: 'Standard', value: 'standard' },
          { name: 'Trusted', value: 'trusted' },
          { name: 'Unverified', value: 'unverified' },
          { name: 'Untrusted', value: 'untrusted' },
        ],
        default: 'standard',
        displayOptions: { show: { '@version': [2] } },
        description: 'Initial trust classification applied to stored human and AI episodes',
      },
      {
        displayName: 'Episode Attributes',
        name: 'episodeAttributes',
        type: 'json',
        default: '{}',
        displayOptions: { show: { '@version': [2] } },
        description: 'Additional source-specific episode metadata as a JSON object',
      },
      {
        // eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
        displayName: 'Extraction Model',
        name: 'extractionModel',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getModels',
        },
        default: '',
        hint: 'Chat/text LLM for entity extraction. Not an embedding model — Engram uses text search.',
        description:
          'Select the model to use for extracting entities and relationships. The list is fetched from your LLM provider. Choose a fast, cheap model — extraction prompts are short.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Max Facts per Query',
        name: 'maxFactsPerQuery',
        type: 'number',
        default: 10,
        typeOptions: {
          minValue: 1,
          maxValue: 50,
        },
        description: 'Maximum number of relevant facts to include as context',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Min Relevance Score',
        name: 'minRelevanceScore',
        type: 'number',
        default: 0.5,
        typeOptions: {
          minValue: 0,
          maxValue: 1,
          numberStepSize: 0.1,
        },
        description: 'Minimum relevance score (0-1) for facts to be included in context',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Entity Types',
        name: 'entityTypes',
        type: 'string',
        default: 'person, organization, location, concept, event',
        description: 'Comma-separated list of entity types to extract from conversations',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      // Embedding settings
      {
        displayName: 'Semantic Search (Embeddings)',
        name: 'enableEmbeddings',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Text search only (default). No embedding API calls.',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description:
              'Generate embeddings for entities/facts and use hybrid text+vector search (RRF). Requires extraction to be enabled.',
          },
        ],
        default: 'disabled',
        description:
          'When enabled, generates vector embeddings for entities and facts during extraction, and uses hybrid text+vector search with Reciprocal Rank Fusion for better semantic matching.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        // eslint-disable-next-line n8n-nodes-base/node-param-display-name-wrong-for-dynamic-options
        displayName: 'Embedding Model',
        name: 'embeddingModel',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getModels',
        },
        default: '',
        hint: 'Select an embedding model (e.g. text-embedding-3-small). Uses the same LLM provider credential.',
        description:
          'The embedding model to use for generating vectors. Must be an embedding model, not a chat model. The list is fetched from your LLM provider.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
            enableEmbeddings: ['enabled'],
          },
        },
      },
      // Graph Traversal
      {
        displayName: 'Graph Traversal (BFS)',
        name: 'enableTraversal',
        type: 'options',
        options: [
          {
            name: 'Disabled',
            value: 'disabled',
            description: 'Standard search only.',
          },
          {
            name: 'Enabled',
            value: 'enabled',
            description:
              'After search, do a shallow BFS from matched entities to enrich context with related facts.',
          },
        ],
        default: 'disabled',
        description:
          'When enabled, enriches memory context by walking the knowledge graph outward from matched entities. Adds related entities and relationships as additional context for the AI.',
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
          },
        },
      },
      {
        displayName: 'Traversal Hops',
        name: 'traversalHops',
        type: 'number',
        default: 1,
        typeOptions: {
          minValue: 1,
          maxValue: 5,
        },
        displayOptions: {
          show: {
            enableExtraction: ['enabled'],
            enableTraversal: ['enabled'],
          },
        },
        description:
          'Number of hops to walk from matched entities. 1 = direct neighbors only, 2 = neighbors of neighbors, etc.',
      },
      // Retention settings
      {
        displayName: 'Retention Policy',
        name: 'retentionType',
        type: 'options',
        options: [
          {
            name: 'Keep Forever',
            value: 'forever',
            description: 'Never delete episodes',
          },
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
        default: 'forever',
        description: 'How long to keep conversation episodes',
      },
      {
        displayName: 'Retention Value',
        name: 'retentionValue',
        type: 'number',
        default: 30,
        typeOptions: {
          minValue: 1,
        },
        description: 'Number of days or maximum episodes to keep (depends on retention type)',
        displayOptions: {
          hide: {
            retentionType: ['forever'],
          },
        },
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
          // Try with auth first, fall back to without auth (some providers like OpenRouter don't need it for /models)
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
            // Retry without auth header
            response = await this.helpers.httpRequest({
              method: 'GET',
              url: `${baseUrl}/models`,
              timeout: 10000,
            });
          }

          // Handle both { data: [...] } (OpenAI) and direct [...] (some providers) formats
          const modelList = response.data || response;
          const models = (Array.isArray(modelList) ? modelList : []) as Array<{
            id: string;
            name?: string;
            owned_by?: string;
          }>;

          if (models.length === 0) {
            return [{ name: 'No models found — check Base URL in credential', value: '' }];
          }

          return models
            .map((m) => ({
              name: m.id,
              value: m.id,
              description: m.owned_by ? `Provider: ${m.owned_by}` : undefined,
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

  async supplyData(this: IExecuteFunctions, itemIndex: number): Promise<SupplyData> {
    const sessionId = getSessionId(this, itemIndex);
    const backend = this.getNodeParameter('backend', itemIndex, 'embedded') as string;
    const contextWindow = this.getNodeParameter('contextWindowLength', itemIndex, 10) as number;
    const enableExtraction =
      (this.getNodeParameter('enableExtraction', itemIndex, 'disabled') as string) === 'enabled';
    const maxFactsPerQuery = this.getNodeParameter('maxFactsPerQuery', itemIndex, 10) as number;
    const minRelevanceScore = this.getNodeParameter('minRelevanceScore', itemIndex, 0.5) as number;
    const retentionType = this.getNodeParameter('retentionType', itemIndex, 'forever') as string;
    const retentionValue = this.getNodeParameter('retentionValue', itemIndex, 30) as number;
    const nodeVersion = this.getNode().typeVersion ?? 1;
    const usesGovernanceControls = nodeVersion >= 2;
    const storeHumanEpisodes = usesGovernanceControls
      ? (this.getNodeParameter('storeHumanEpisodes', itemIndex, 'enabled') as string) === 'enabled'
      : true;
    const humanEpisodeKind = usesGovernanceControls
      ? (this.getNodeParameter('humanEpisodeKind', itemIndex, 'active_human') as
          | 'active_human'
          | 'passive_human')
      : 'active_human';
    const storeAiEpisodes = usesGovernanceControls
      ? (this.getNodeParameter('storeAiEpisodes', itemIndex, 'enabled') as string) === 'enabled'
      : true;
    const extractHuman = usesGovernanceControls
      ? (this.getNodeParameter('extractHuman', itemIndex, 'enabled') as string) === 'enabled'
      : true;
    const extractAi = usesGovernanceControls
      ? (this.getNodeParameter('extractAi', itemIndex, 'disabled') as string) === 'enabled'
      : true;
    const extractSystemTool = usesGovernanceControls
      ? (this.getNodeParameter('extractSystemTool', itemIndex, 'disabled') as string) === 'enabled'
      : false;
    const autoAcceptConfidence = usesGovernanceControls
      ? (this.getNodeParameter('autoAcceptConfidence', itemIndex, 0.85) as number)
      : undefined;
    const rejectBelowConfidence = usesGovernanceControls
      ? (this.getNodeParameter('rejectBelowConfidence', itemIndex, 0.3) as number)
      : undefined;
    const acceptedOnlyRetrieval = usesGovernanceControls
      ? (this.getNodeParameter('memoryFactPolicy', itemIndex, 'acceptedOnly') as string) ===
        'acceptedOnly'
      : false;

    try {
      // Get or create storage instance
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
        const customPath = this.getNodeParameter('customStoragePath', itemIndex, '') as string;
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

      // Apply retention policy before loading
      if (retentionType !== 'forever') {
        await storage.applyRetention(sessionId, {
          type: retentionType as 'days' | 'max_episodes',
          value: retentionValue,
        });
      }

      // Build extraction LLM config if enabled
      let llmConfig;
      let entityTypes;
      let extractionCreds;
      if (enableExtraction) {
        extractionCreds = await this.getCredentials('engramExtractionApi');
        const model = this.getNodeParameter('extractionModel', itemIndex, '') as string;
        if (!model) {
          throw new NodeOperationError(
            this.getNode(),
            'Extraction Model is required when Knowledge Extraction is enabled',
            {
              description:
                'Select a model from the dropdown. If the list is empty, verify your Engram Extraction LLM credential has a valid Base URL and API Key.',
            },
          );
        }
        llmConfig = {
          apiKey: extractionCreds.apiKey as string,
          baseUrl: extractionCreds.baseUrl as string,
          model,
        };

        const entityTypesRaw = this.getNodeParameter(
          'entityTypes',
          itemIndex,
          'person, organization, location, concept, event',
        ) as string;
        entityTypes = entityTypesRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }

      // Build embedding config if enabled
      let embeddingConfig;
      if (enableExtraction && llmConfig) {
        const enableEmbeddings =
          (this.getNodeParameter('enableEmbeddings', itemIndex, 'disabled') as string) ===
          'enabled';

        if (enableEmbeddings) {
          const embeddingModel = this.getNodeParameter('embeddingModel', itemIndex, '') as string;

          if (embeddingModel && extractionCreds) {
            // Reuse the extraction API credential already fetched above
            embeddingConfig = {
              apiKey: extractionCreds.apiKey as string,
              baseUrl: extractionCreds.baseUrl as string,
              model: embeddingModel,
            };
          }
        }
      }

      // Build traversal config if enabled
      let enableTraversal = false;
      let traversalHops = 1;
      if (enableExtraction) {
        enableTraversal =
          (this.getNodeParameter('enableTraversal', itemIndex, 'disabled') as string) === 'enabled';
        if (enableTraversal) {
          traversalHops = this.getNodeParameter('traversalHops', itemIndex, 1) as number;
        }
      }

      const memory = new EngramChatMemory({
        storage,
        groupId: sessionId,
        memoryKey: 'chat_history',
        returnMessages: true,
        inputKey: 'input',
        outputKey: 'output',
        contextWindow,
        maxFactsPerQuery,
        minRelevanceScore,
        enableExtraction: enableExtraction && !!llmConfig,
        llmConfig,
        entityTypes,
        embeddingConfig,
        enableTraversal,
        traversalHops,
        storeHumanEpisodes,
        humanEpisodeKind,
        storeAiEpisodes,
        extractHuman,
        extractAi,
        extractSystemTool,
        acceptedOnlyRetrieval,
        contextTokenBudget: usesGovernanceControls
          ? (this.getNodeParameter('contextTokenBudget', itemIndex, 2000) as number)
          : undefined,
        includeProvenanceInContext: usesGovernanceControls,
        retrievalFilters: usesGovernanceControls
          ? {
              sender_id:
                (this.getNodeParameter('retrievalSenderId', itemIndex, '') as string).trim() ||
                undefined,
              episode_kind: ((this.getNodeParameter(
                'retrievalEpisodeKind',
                itemIndex,
                '',
              ) as string) || undefined) as
                | 'active_human'
                | 'passive_human'
                | 'assistant_reply'
                | 'monitor_summary'
                | 'tool_output'
                | 'system'
                | 'legacy'
                | undefined,
              trust_level: ((this.getNodeParameter(
                'retrievalTrustLevel',
                itemIndex,
                '',
              ) as string) || undefined) as
                | 'trusted'
                | 'standard'
                | 'unverified'
                | 'untrusted'
                | undefined,
              source_workflow_id:
                (
                  this.getNodeParameter('retrievalSourceWorkflowId', itemIndex, '') as string
                ).trim() || undefined,
              source_execution_id:
                (
                  this.getNodeParameter('retrievalSourceExecutionId', itemIndex, '') as string
                ).trim() || undefined,
              reference_after:
                (this.getNodeParameter('retrievalReferenceAfter', itemIndex, '') as string) ||
                undefined,
              reference_before:
                (this.getNodeParameter('retrievalReferenceBefore', itemIndex, '') as string) ||
                undefined,
            }
          : undefined,
        requireExtractionConfidence: usesGovernanceControls,
        extractionThresholdPolicy: usesGovernanceControls
          ? {
              autoAcceptThreshold: autoAcceptConfidence!,
              rejectBelowThreshold: rejectBelowConfidence!,
            }
          : undefined,
        episodeMetadata: usesGovernanceControls
          ? {
              source_message_id:
                (this.getNodeParameter('sourceMessageId', itemIndex, '') as string).trim() || null,
              idempotency_key:
                (this.getNodeParameter('episodeIdempotencyKey', itemIndex, '') as string).trim() ||
                null,
              conversation_id:
                (this.getNodeParameter('conversationId', itemIndex, '') as string).trim() ||
                sessionId,
              sender_id:
                (this.getNodeParameter('senderId', itemIndex, '') as string).trim() || null,
              sender_name:
                (this.getNodeParameter('senderName', itemIndex, '') as string).trim() || null,
              quoted_message_id:
                (this.getNodeParameter('quotedMessageId', itemIndex, '') as string).trim() || null,
              trust_level: this.getNodeParameter('episodeTrustLevel', itemIndex, 'standard') as
                | 'trusted'
                | 'standard'
                | 'unverified'
                | 'untrusted',
              source_workflow_id: this.getWorkflow().id ?? null,
              source_execution_id: this.getExecutionId(),
              attributes: parseEpisodeAttributes(
                this.getNodeParameter('episodeAttributes', itemIndex, '{}'),
              ),
            }
          : undefined,
      });

      return {
        response: logWrapper(memory, this),
      };
    } catch (error: unknown) {
      if (error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(
        this.getNode(),
        `Failed to initialize Engram memory: ${(error as Error).message}`,
        {
          description:
            backend === 'neo4j'
              ? 'Check your Neo4j credentials and server connection'
              : 'Check file system permissions for embedded storage',
        },
      );
    }
  }
}

function parseEpisodeAttributes(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
