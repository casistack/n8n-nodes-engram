import { BaseChatMemory } from '@langchain/classic/memory/chat_memory';
import type { BaseChatMemoryInput } from '@langchain/classic/memory/chat_memory';
import {
  getInputValue,
  getOutputValue,
  type InputValues,
  type MemoryVariables,
  type OutputValues,
} from '@langchain/core/memory';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { IGraphStorage } from '../storage/IGraphStorage';
import {
  EngramChatMessageHistory,
  type EpisodeWriteMetadata,
  type HumanEpisodeKind,
} from './EngramChatMessageHistory';
import { ExtractionPipeline } from '../extraction/ExtractionPipeline';
import type { ExtractionSource } from '../extraction/ExtractionSource';
import { HybridSearchEngine } from '../search/HybridSearchEngine';
import { EmbeddingService, type EmbeddingConfig } from '../embeddings';
import type { LlmClientConfig } from '../extraction/LlmClient';
import { GraphTraverser } from '../traversal/GraphTraverser';
import { extractionMetadataFromAttributes, type ExtractionThresholdPolicy } from '../schemas';
import type { RetrievalFilters } from '../search/RetrievalGovernance';
import { estimateContextTokens } from '../search/ContextBudget';

export interface EngramChatMemoryInput extends BaseChatMemoryInput {
  storage: IGraphStorage;
  groupId: string;
  memoryKey?: string;
  contextWindow?: number;
  maxFactsPerQuery?: number;
  minRelevanceScore?: number;
  enableExtraction?: boolean;
  llmConfig?: LlmClientConfig;
  entityTypes?: string[];
  /** Optional embedding config for semantic search */
  embeddingConfig?: EmbeddingConfig;
  /** Enable shallow BFS traversal to enrich context with related entities */
  enableTraversal?: boolean;
  /** BFS depth for traversal enrichment (default: 1) */
  traversalHops?: number;
  storeHumanEpisodes?: boolean;
  humanEpisodeKind?: HumanEpisodeKind;
  storeAiEpisodes?: boolean;
  extractHuman?: boolean;
  extractAi?: boolean;
  extractSystemTool?: boolean;
  episodeMetadata?: EpisodeWriteMetadata;
  acceptedOnlyRetrieval?: boolean;
  requireExtractionConfidence?: boolean;
  extractionThresholdPolicy?: ExtractionThresholdPolicy;
  retrievalFilters?: RetrievalFilters;
  contextTokenBudget?: number;
  includeProvenanceInContext?: boolean;
}

/**
 * Engram knowledge graph memory for n8n AI agents.
 *
 * loadMemoryVariables() returns:
 *   - Relevant facts from the knowledge graph (as a SystemMessage)
 *   - Recent conversation history (as HumanMessage/AIMessage)
 *
 * saveContext() stores:
 *   - Human and AI messages as episodes in the graph
 *   - (With extraction enabled) Extracts entities and relationships via LLM
 */
export class EngramChatMemory extends BaseChatMemory {
  storage: IGraphStorage;
  groupId: string;
  memoryKey: string;
  contextWindow: number;
  maxFactsPerQuery: number;
  minRelevanceScore: number;
  enableExtraction: boolean;
  private extractionPipeline: ExtractionPipeline | null = null;
  private searchEngine: HybridSearchEngine;

  private engramHistory: EngramChatMessageHistory;
  private enableTraversal: boolean;
  private traversalHops: number;
  private storeHumanEpisodes: boolean;
  private humanEpisodeKind: HumanEpisodeKind;
  private storeAiEpisodes: boolean;
  private extractHuman: boolean;
  private extractAi: boolean;
  private extractSystemTool: boolean;
  private episodeMetadata: EpisodeWriteMetadata;
  private acceptedOnlyRetrieval: boolean;
  private retrievalFilters: RetrievalFilters;
  private contextTokenBudget?: number;
  private includeProvenanceInContext: boolean;

  constructor(fields: EngramChatMemoryInput) {
    const history = new EngramChatMessageHistory({
      storage: fields.storage,
      groupId: fields.groupId,
      contextWindow: fields.contextWindow ?? 10,
      humanEpisodeKind: fields.humanEpisodeKind,
    });

    super({
      chatHistory: history,
      returnMessages: fields.returnMessages ?? true,
      inputKey: fields.inputKey ?? 'input',
      outputKey: fields.outputKey ?? 'output',
    });

    this.storage = fields.storage;
    this.groupId = fields.groupId;
    this.memoryKey = fields.memoryKey ?? 'chat_history';
    this.contextWindow = fields.contextWindow ?? 10;
    this.maxFactsPerQuery = fields.maxFactsPerQuery ?? 10;
    this.minRelevanceScore = fields.minRelevanceScore ?? 0.5;
    this.enableExtraction = fields.enableExtraction ?? false;
    this.engramHistory = history;
    this.enableTraversal = fields.enableTraversal ?? false;
    this.traversalHops = fields.traversalHops ?? 1;
    this.storeHumanEpisodes = fields.storeHumanEpisodes ?? true;
    this.humanEpisodeKind = fields.humanEpisodeKind ?? 'active_human';
    this.storeAiEpisodes = fields.storeAiEpisodes ?? true;
    this.extractHuman = fields.extractHuman ?? true;
    this.extractAi = fields.extractAi ?? true;
    this.extractSystemTool = fields.extractSystemTool ?? false;
    this.episodeMetadata = fields.episodeMetadata ?? {};
    this.acceptedOnlyRetrieval = fields.acceptedOnlyRetrieval ?? false;
    this.retrievalFilters = fields.retrievalFilters ?? {};
    this.contextTokenBudget = fields.contextTokenBudget;
    this.includeProvenanceInContext = fields.includeProvenanceInContext ?? false;
    if (
      this.contextTokenBudget !== undefined &&
      (!Number.isInteger(this.contextTokenBudget) || this.contextTokenBudget < 1)
    ) {
      throw new Error('Context token budget must be a positive integer');
    }

    // Create embedding service if config provided
    const embeddingService = fields.embeddingConfig
      ? new EmbeddingService(fields.embeddingConfig)
      : undefined;

    // Initialize hybrid search engine (with optional embeddings)
    this.searchEngine = new HybridSearchEngine(fields.storage, embeddingService);

    // Initialize extraction pipeline if enabled and LLM config provided
    if (this.enableExtraction && fields.llmConfig) {
      this.extractionPipeline = new ExtractionPipeline(fields.storage, {
        llmConfig: fields.llmConfig,
        entityTypes: fields.entityTypes ?? [
          'person',
          'organization',
          'location',
          'concept',
          'event',
        ],
        groupId: fields.groupId,
        embeddingConfig: fields.embeddingConfig,
        requireConfidence: fields.requireExtractionConfidence,
        thresholdPolicy: fields.extractionThresholdPolicy,
      });
    }
  }

  get memoryKeys(): string[] {
    return [this.memoryKey];
  }

  async loadMemoryVariables(values: InputValues): Promise<MemoryVariables> {
    // Get recent conversation history
    const messages = await this.chatHistory.getMessages();

    // Try to find relevant facts from the knowledge graph
    const currentInput = this.extractInputText(values);
    const factMessages = await this.getRelevantFacts(currentInput);

    // Combine: facts first (as system context), then conversation history
    const allMessages = [...factMessages, ...messages];

    if (this.returnMessages) {
      return { [this.memoryKey]: allMessages };
    }

    // Format as string if returnMessages is false
    const formatted = allMessages
      .map((m) => {
        const type = m._getType();
        const prefix = type === 'human' ? 'Human' : type === 'ai' ? 'AI' : 'System';
        return `${prefix}: ${m.content}`;
      })
      .join('\n');

    return { [this.memoryKey]: formatted };
  }

  async saveContext(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
    // n8n agents may pass multiple keys (input, system_message, formatting_instructions).
    // LangChain's BaseChatMemory.saveContext throws if it sees >1 key without an explicit
    // inputKey/outputKey. Filter down to just the keys we care about to avoid this.
    const filteredInput: InputValues = {};
    const inputKey = this.inputKey || 'input';
    if (inputValues[inputKey] !== undefined) {
      filteredInput[inputKey] = inputValues[inputKey];
    } else {
      // Fallback: pass the first key so LangChain doesn't get an empty object
      const firstKey = Object.keys(inputValues)[0];
      if (firstKey) filteredInput[firstKey] = inputValues[firstKey];
    }

    const filteredOutput: OutputValues = {};
    const outputKey = this.outputKey || 'output';
    if (outputValues[outputKey] !== undefined) {
      filteredOutput[outputKey] = outputValues[outputKey];
    } else {
      const firstKey = Object.keys(outputValues)[0];
      if (firstKey) filteredOutput[firstKey] = outputValues[firstKey];
    }

    const humanInput = getInputValue(filteredInput, this.inputKey);
    const aiOutput = getOutputValue(filteredOutput, this.outputKey);

    const humanText = this.stringifyMessageValue(humanInput);
    const aiText = this.stringifyMessageValue(aiOutput);
    const humanEpisode = this.storeHumanEpisodes
      ? await this.engramHistory.addMessageAndGetEpisode(
          new HumanMessage(humanInput),
          this.metadataForEpisodeKind(this.humanEpisodeKind),
        )
      : null;
    const aiEpisode = this.storeAiEpisodes
      ? await this.engramHistory.addMessageAndGetEpisode(
          new AIMessage(aiOutput),
          this.metadataForEpisodeKind('assistant_reply'),
        )
      : null;

    // If extraction is enabled, extract entities and relationships
    if (this.enableExtraction) {
      const sources: ExtractionSource[] = [];
      if (this.extractHuman && humanText) {
        sources.push(
          humanEpisode
            ? this.episodeToExtractionSource(humanEpisode)
            : this.transientExtractionSource(humanText, 'human', this.humanEpisodeKind),
        );
      }
      if (this.extractAi && aiText) {
        sources.push(
          aiEpisode
            ? this.episodeToExtractionSource(aiEpisode)
            : this.transientExtractionSource(aiText, 'ai', 'assistant_reply'),
        );
      }
      if (this.extractSystemTool) {
        sources.push(...this.extractSystemToolSources(inputValues, outputValues));
      }
      await this.runExtraction(sources);
    }
  }

  async clear(): Promise<void> {
    await this.engramHistory.clear();
  }

  /**
   * Search the knowledge graph for facts relevant to the current input.
   * Uses HybridSearchEngine which merges text + vector results via RRF when embeddings are enabled.
   */
  private async getRelevantFacts(query: string): Promise<SystemMessage[]> {
    if (!query.trim()) return [];

    try {
      const results = await this.searchEngine.search(query, this.groupId, {
        limit: this.maxFactsPerQuery,
        minScore: this.minRelevanceScore,
        acceptedOnly: this.acceptedOnlyRetrieval,
        retrievalFilters: this.retrievalFilters,
      });

      if (results.edges.length === 0 && results.entities.length === 0) return [];

      const prefix = 'Relevant knowledge from memory:\n';
      const availableBudget =
        this.contextTokenBudget === undefined
          ? undefined
          : Math.max(0, this.contextTokenBudget - estimateContextTokens(prefix) - 1);
      const traversalBudget =
        availableBudget === undefined || !this.enableTraversal
          ? undefined
          : Math.floor(availableBudget * 0.25);
      const searchBudget =
        availableBudget === undefined ? undefined : availableBudget - (traversalBudget ?? 0);
      let contextText = this.searchEngine.formatAsContext(
        results,
        searchBudget,
        this.includeProvenanceInContext,
      );

      // Enrich with shallow BFS traversal from matched entities
      if (this.enableTraversal && results.entities.length > 0) {
        try {
          const seedUuids = results.entities.map((r) => r.entity.uuid);
          const traverser = new GraphTraverser();
          const traversal = await traverser.traverse(this.storage, seedUuids, {
            maxHops: this.traversalHops,
            maxEntities: 20,
            entityFilter: this.acceptedOnlyRetrieval
              ? (entity) => this.isAcceptedAttributes(entity.attributes)
              : undefined,
            edgeFilter: this.acceptedOnlyRetrieval
              ? (edge) => this.isAcceptedAttributes(edge.attributes)
              : undefined,
          });
          if (traversal.edges.length > 0) {
            const filters: RetrievalFilters = {
              ...this.retrievalFilters,
              review_statuses: this.acceptedOnlyRetrieval
                ? ['accepted']
                : this.retrievalFilters.review_statuses,
            };
            const governedEdges = await this.searchEngine.governTraversalEdges(
              traversal.edges,
              filters,
            );
            const traversalContext = this.searchEngine.formatAsContext(
              { entities: [], edges: governedEdges },
              traversalBudget,
              this.includeProvenanceInContext,
            );
            if (traversalContext) {
              contextText += (contextText ? '\n\n' : '') + traversalContext;
            }
          }
        } catch (err) {
          console.warn('Engram: Traversal enrichment failed:', (err as Error).message);
        }
      }

      if (!contextText) return [];

      return [new SystemMessage(prefix + contextText)];
    } catch (error) {
      // Search may fail if no entities indexed yet - that's fine
      console.warn('Engram: Failed to retrieve relevant facts:', (error as Error).message);
      return [];
    }
  }

  private extractInputText(values: InputValues): string {
    if (this.inputKey && values[this.inputKey]) {
      const val = values[this.inputKey];
      return typeof val === 'string' ? val : JSON.stringify(val);
    }

    // Try common input keys
    for (const key of ['input', 'question', 'query', 'text']) {
      if (values[key]) {
        const val = values[key];
        return typeof val === 'string' ? val : JSON.stringify(val);
      }
    }

    return '';
  }

  private async runExtraction(sources: ExtractionSource[]): Promise<void> {
    if (!this.extractionPipeline) return;
    if (sources.length === 0) return;

    try {
      await this.extractionPipeline.processSources(sources);
    } catch (error) {
      // Extraction failure should never break the conversation flow
      console.warn('Engram: Extraction pipeline failed:', (error as Error).message);
    }
  }

  private metadataForEpisodeKind(
    episodeKind: HumanEpisodeKind | 'assistant_reply',
  ): EpisodeWriteMetadata {
    const metadata = { ...this.episodeMetadata };
    if (metadata.idempotency_key) {
      metadata.idempotency_key = `${metadata.idempotency_key}:${episodeKind}`;
    }
    if (episodeKind === 'assistant_reply') {
      metadata.sender_id = null;
      metadata.sender_name = null;
    }
    return metadata;
  }

  private episodeToExtractionSource(
    episode: Awaited<ReturnType<EngramChatMessageHistory['addMessageAndGetEpisode']>>,
  ): ExtractionSource {
    return {
      content: episode.content,
      role: episode.role,
      episode_kind: episode.episode_kind,
      episode_uuid: episode.uuid,
      source_message_id: episode.source_message_id,
      sender_id: episode.sender_id,
      sender_name: episode.sender_name,
      trust_level: episode.trust_level,
      review_status: episode.review_status,
      reference_time: episode.reference_time,
    };
  }

  private transientExtractionSource(
    content: string,
    role: 'human' | 'ai',
    episodeKind: HumanEpisodeKind | 'assistant_reply',
  ): ExtractionSource {
    const metadata = this.metadataForEpisodeKind(episodeKind);
    return {
      content,
      role,
      episode_kind: episodeKind,
      source_message_id: metadata.source_message_id ?? null,
      sender_id: metadata.sender_id ?? null,
      sender_name: metadata.sender_name ?? null,
      trust_level: metadata.trust_level ?? 'standard',
      review_status: metadata.review_status ?? 'accepted',
    };
  }

  private extractSystemToolSources(
    inputValues: InputValues,
    outputValues: OutputValues,
  ): ExtractionSource[] {
    const sources: ExtractionSource[] = [];
    const seen = new Set<string>();
    const addSource = (
      value: unknown,
      role: 'system' | 'ai',
      episodeKind: 'system' | 'tool_output',
    ) => {
      if (value === undefined || value === null) return;
      const content = this.stringifyMessageValue(value);
      if (!content || seen.has(`${episodeKind}:${content}`)) return;
      seen.add(`${episodeKind}:${content}`);
      sources.push({
        content,
        role,
        episode_kind: episodeKind,
        source_message_id: this.episodeMetadata.source_message_id ?? null,
        trust_level: 'unverified',
        review_status: 'proposed',
      });
    };

    for (const key of ['system_message', 'systemMessage', 'system']) {
      addSource(inputValues[key], 'system', 'system');
    }
    for (const key of ['tool_output', 'toolOutput', 'observation', 'intermediateSteps']) {
      addSource(inputValues[key], 'ai', 'tool_output');
      addSource(outputValues[key], 'ai', 'tool_output');
    }
    return sources;
  }

  private stringifyMessageValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private isAcceptedAttributes(attributes: Record<string, unknown>): boolean {
    const metadata = extractionMetadataFromAttributes(attributes);
    return metadata === null || metadata.review_status === 'accepted';
  }
}
