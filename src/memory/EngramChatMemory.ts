import { BaseChatMemory, type BaseChatMemoryInput } from 'langchain/memory';
import type { InputValues, MemoryVariables, OutputValues } from '@langchain/core/memory';
import { SystemMessage } from '@langchain/core/messages';
import type { IGraphStorage } from '../storage/IGraphStorage';
import { EngramChatMessageHistory } from './EngramChatMessageHistory';
import {
  ExtractionPipeline,
  type ExtractionPipelineConfig,
} from '../extraction/ExtractionPipeline';
import { HybridSearchEngine } from '../search/HybridSearchEngine';
import { EmbeddingService, type EmbeddingConfig } from '../embeddings';
import type { LlmClientConfig } from '../extraction/LlmClient';
import { GraphTraverser } from '../traversal/GraphTraverser';

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

  constructor(fields: EngramChatMemoryInput) {
    const history = new EngramChatMessageHistory({
      storage: fields.storage,
      groupId: fields.groupId,
      contextWindow: fields.contextWindow ?? 10,
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
    // Use the default BaseChatMemory implementation to save messages
    // This calls chatHistory.addUserMessage() and chatHistory.addAIChatMessage()
    await super.saveContext(inputValues, outputValues);

    // If extraction is enabled, extract entities and relationships
    // (Will be implemented in Phase 5 - Extraction Pipeline)
    if (this.enableExtraction) {
      await this.runExtraction(inputValues, outputValues);
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
      });

      if (results.edges.length === 0 && results.entities.length === 0) return [];

      let contextText = this.searchEngine.formatAsContext(results);

      // Enrich with shallow BFS traversal from matched entities
      if (this.enableTraversal && results.entities.length > 0) {
        try {
          const seedUuids = results.entities.map((r) => r.entity.uuid);
          const traverser = new GraphTraverser();
          const traversal = await traverser.traverse(this.storage, seedUuids, {
            maxHops: this.traversalHops,
            maxEntities: 20,
          });
          if (traversal.context) {
            contextText += '\n\n' + traversal.context;
          }
        } catch (err) {
          console.warn('Engram: Traversal enrichment failed:', (err as Error).message);
        }
      }

      if (!contextText) return [];

      return [new SystemMessage(`Relevant knowledge from memory:\n${contextText}`)];
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

  private async runExtraction(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
    if (!this.extractionPipeline) return;

    const humanText = this.extractInputText(inputValues);
    const aiText = this.extractOutputText(outputValues);

    if (!humanText && !aiText) return;

    try {
      await this.extractionPipeline.process(humanText, aiText);
    } catch (error) {
      // Extraction failure should never break the conversation flow
      console.warn('Engram: Extraction pipeline failed:', (error as Error).message);
    }
  }

  private extractOutputText(values: OutputValues): string {
    if (this.outputKey && values[this.outputKey]) {
      const val = values[this.outputKey];
      return typeof val === 'string' ? val : JSON.stringify(val);
    }

    for (const key of ['output', 'response', 'text', 'answer']) {
      if (values[key]) {
        const val = values[key];
        return typeof val === 'string' ? val : JSON.stringify(val);
      }
    }

    return '';
  }
}
