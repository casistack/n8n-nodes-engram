import { StorageAccumulator } from '../storage/StorageDiagnostics';
import { governedContext } from '../search/GovernedContext';
import {
  GraphEvidenceBudgetsSchema,
  type GraphEvidenceBudgetsInput,
} from '../schemas/ExtractionPolicy.schema';
import { performance } from 'perf_hooks';
import {
  ExtractionPolicySchema,
  RetrievalModeSchema,
  ExplicitTimestampSchema,
  QueueBindingSchema,
  QueueLimitsSchema,
  type ExtractionPolicyInput,
  type QueueBinding,
  type MemoryDeliveryOutcome,
} from '../schemas';
import {
  queueBinding,
  runBoundedExtraction,
  type ExtractionSettings,
} from '../extraction/DurableExtraction';
import { StagedGraph } from '../extraction/StagedGraph';
import { queueStats } from '../extraction/QueueState';
import {
  CurrentHumanQuerySchema,
  MemoryPolicySchema,
  type MemoryPolicyInput,
  type MemoryPolicy,
  type MemoryWriteOutcome,
  type MemoryLoadDiagnostics,
} from '../schemas';
import { finalAssistantIndices, messageType, messageHasText } from './MessagePolicy';
import { contentHash } from './HistorySelection';
import type { BaseMessage } from '@langchain/core/messages';
import {
  ExtractionDiagnostics,
  ExtractionError,
  reportExtractionError,
} from '../extraction/ExtractionDiagnostics';
import type { ExtractionOutcome } from '../schemas';
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
  type EpisodeMessageWrite,
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
import {
  AutomaticRuntimeSchema,
  type AutomaticRuntimeInput,
} from '../schemas/AutomaticRuntime.schema';
import { AutomaticWriteOwnerSchema } from '../schemas/AutomaticClaim.schema';
import { compileAutomaticPolicy, captureEnvelope } from '../extraction/AutomaticEvidence';
import { AUTOMATIC_ENVELOPE, AUTOMATIC_OWNER } from '../extraction/AutomaticClaims';
import {
  findAutomaticBinding,
  assertAutomaticBinding,
  assertAutomaticBindingIdentity,
} from '../storage/AutomaticIdentity';
import { canonical } from '../extraction/QueueState';

export interface EngramChatMemoryInput extends BaseChatMemoryInput {
  automaticMemory?: AutomaticRuntimeInput;
  storage: IGraphStorage;
  groupId: string;
  policy?: MemoryPolicyInput;
  currentHumanQuery?: string;
  extractionPolicy?: ExtractionPolicyInput;
  extractionExecution?: 'synchronous' | 'durable';
  extractionRouteId?: string;
  retrievalMode?: 'legacy' | 'current' | 'historical' | 'asOf';
  retrievalAt?: string;
  graphEvidenceBudgets?: GraphEvidenceBudgetsInput;
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

  private queueMode = false;
  private snapshotRead = false;
  private binding?: QueueBinding;
  private settings?: ExtractionSettings;
  private fields: EngramChatMemoryInput;
  private policy: MemoryPolicy;
  private currentHumanQuery: string;
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
      policy: fields.policy,
    });

    super({
      chatHistory: history,
      returnMessages: fields.returnMessages ?? true,
      inputKey: fields.inputKey ?? 'input',
      outputKey: fields.outputKey ?? 'output',
    });

    const retrievalMode = RetrievalModeSchema.parse(fields.retrievalMode);
    GraphEvidenceBudgetsSchema.parse(fields.graphEvidenceBudgets);
    if (retrievalMode === 'asOf' && !ExplicitTimestampSchema.safeParse(fields.retrievalAt).success)
      throw new Error('Engram retrieval: as_of_requires_timestamp');
    this.fields = { ...fields, retrievalMode };
    const extractionPolicy = ExtractionPolicySchema.parse(fields.extractionPolicy);
    const automatic = fields.automaticMemory
      ? AutomaticRuntimeSchema.parse(fields.automaticMemory)
      : undefined;
    const automaticPolicy = compileAutomaticPolicy({ profileId: automatic?.profileId });
    if (extractionPolicy.quality !== 'legacy' && extractionPolicy.mode !== 'bounded')
      throw new Error('Knowledge Selection requires bounded extraction');
    if (
      extractionPolicy.mode === 'bounded' &&
      fields.enableExtraction &&
      ((fields.extractHuman !== false && fields.storeHumanEpisodes === false) ||
        (fields.extractAi !== false && fields.storeAiEpisodes === false) ||
        fields.extractSystemTool)
    )
      throw new Error(
        fields.extractionExecution === 'durable'
          ? 'Engram queue: unsupported_configuration'
          : 'Bounded extraction requires persisted eligible human/final assistant sources',
      );
    this.queueMode = fields.extractionExecution === 'durable';
    if (
      fields.extractionExecution &&
      !['synchronous', 'durable'].includes(fields.extractionExecution)
    )
      throw new Error('Invalid extraction execution');
    if (fields.llmConfig)
      this.settings = {
        llm: fields.llmConfig,
        embeddings: fields.embeddingConfig,
        policy: extractionPolicy,
        types: fields.entityTypes ?? ['person', 'organization', 'location', 'concept', 'event'],
        threshold: fields.extractionThresholdPolicy,
        ...(automaticPolicy.profileId !== 'existing' ? { automaticPolicy } : {}),
      };
    this.policy = MemoryPolicySchema.parse(fields.policy ?? {});
    if (
      automaticPolicy.profileId !== 'existing' &&
      (!fields.enableExtraction ||
        !this.settings ||
        !this.policy.finalTurnWrites ||
        extractionPolicy.mode !== 'bounded' ||
        fields.storeHumanEpisodes === false ||
        fields.extractAi ||
        fields.extractSystemTool ||
        !fields.storage.readExtractionSnapshot ||
        !fields.storage.appendAutomaticEpisodes ||
        (fields.extractionExecution === 'durable' &&
          !fields.storage.appendAutomaticEpisodesWithExtraction) ||
        automatic?.actor.namespace !== fields.groupId)
    )
      throw new Error(
        'Engram automatic: requires bounded extraction, final turns, persisted human sources and matching actor namespace',
      );
    if (this.queueMode) {
      if (
        !fields.enableExtraction ||
        !this.settings ||
        extractionPolicy.mode !== 'bounded' ||
        !this.policy.finalTurnWrites ||
        fields.extractSystemTool ||
        (fields.extractHuman !== false && fields.storeHumanEpisodes === false) ||
        (fields.extractAi !== false && fields.storeAiEpisodes === false) ||
        !fields.storage.supportsDurableExtraction?.() ||
        !fields.storage.appendEpisodesWithExtraction ||
        !fields.extractionRouteId
      )
        throw new Error(
          'Engram queue: unsupported_configuration (requires Bounded resolution, Final Turns, persistent eligible sources, and a matching worker route)',
        );
      this.binding = QueueBindingSchema.parse(
        queueBinding(fields.extractionRouteId, this.settings),
      );
    }
    this.currentHumanQuery = CurrentHumanQuerySchema.parse(fields.currentHumanQuery ?? '');
    this.storage = fields.storage;
    this.groupId = fields.groupId;
    this.memoryKey = fields.memoryKey ?? 'chat_history';
    this.contextWindow = fields.contextWindow ?? 10;
    this.maxFactsPerQuery = fields.maxFactsPerQuery ?? 10;
    this.minRelevanceScore = fields.minRelevanceScore ?? 0.5;
    this.enableExtraction = fields.enableExtraction ?? false;
    this.engramHistory = history;
    if (this.policy.finalTurnWrites)
      history.setTurnWriter((messages) => this.saveMessagesWithDelivery(messages), this.queueMode);
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
    return (await this.loadMemoryVariablesWithDiagnostics(values)).variables;
  }

  async loadMemoryVariablesWithDiagnostics(
    values: InputValues,
  ): Promise<{ variables: MemoryVariables; diagnostics: MemoryLoadDiagnostics }> {
    if (this.fields.automaticMemory?.capturedSourceId) {
      await this.validateCapturedHuman(this.extractInputText(values) || this.currentHumanQuery);
      this.engramHistory.excludeCurrentSource(this.fields.automaticMemory.capturedSourceId);
    }
    if (
      !this.snapshotRead &&
      (this.queueMode || (this.fields.retrievalMode && this.fields.retrievalMode !== 'legacy'))
    ) {
      if (!this.storage.readExtractionSnapshot)
        throw new Error('Engram retrieval: snapshot_required');
      const snapshot = await this.storage.readExtractionSnapshot!(this.groupId);
      const reader = new EngramChatMemory({
        ...this.fields,
        storage: new StagedGraph(snapshot, this.groupId, false).storage,
        extractionExecution: 'synchronous',
        enableExtraction: false,
        automaticMemory: undefined,
      });
      if (this.fields.automaticMemory?.capturedSourceId)
        reader.engramHistory.excludeCurrentSource(this.fields.automaticMemory.capturedSourceId);
      reader.snapshotRead = true;
      const result = await reader.loadMemoryVariablesWithDiagnostics(values);
      result.diagnostics.queue = { version: 1, ...queueStats(snapshot, this.groupId) };
      return result;
    }
    const { messages, history } = await this.engramHistory.getMessagesWithDiagnostics();
    const provided = this.extractInputText(values);
    const configured = Object.keys(values).length === 0 ? this.currentHumanQuery : '';
    const currentInput = provided || configured;
    const mode = this.fields.retrievalMode;
    const governed =
      mode && mode !== 'legacy'
        ? await governedContext(this.storage, this.searchEngine, currentInput, this.groupId, {
            mode,
            at: this.fields.retrievalAt,
            evidenceBudgets: this.fields.graphEvidenceBudgets,
            limit: this.maxFactsPerQuery,
            minScore: this.minRelevanceScore,
            tokenBudget: this.contextTokenBudget,
            traversal: this.enableTraversal,
            hops: this.traversalHops,
            acceptedOnly: this.acceptedOnlyRetrieval,
            filters: this.retrievalFilters,
          })
        : null;
    const factMessages = governed
      ? governed.context
        ? [new SystemMessage(governed.context)]
        : []
      : await this.getRelevantFacts(currentInput);
    const diagnostics: MemoryLoadDiagnostics = {
      history,
      retrieval: {
        query_source: provided.trim() ? 'input' : configured.trim() ? 'configured' : 'none',
        query_available: currentInput.trim().length > 0,
        fact_messages: factMessages.length,
        ...(governed ? { selection: governed.audit } : {}),
      },
    };

    // Combine: facts first (as system context), then conversation history
    const allMessages = [...factMessages, ...messages];

    if (this.returnMessages) {
      return { variables: { [this.memoryKey]: allMessages }, diagnostics };
    }

    // Format as string if returnMessages is false
    const formatted = allMessages
      .map((m) => {
        const type = m._getType();
        const prefix = type === 'human' ? 'Human' : type === 'ai' ? 'AI' : 'System';
        return `${prefix}: ${m.content}`;
      })
      .join('\n');

    return { variables: { [this.memoryKey]: formatted }, diagnostics };
  }

  async saveContext(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
    await this.saveContextWithDelivery(inputValues, outputValues);
  }

  async saveContextWithDelivery(
    inputValues: InputValues,
    outputValues: OutputValues,
  ): Promise<{ extraction: ExtractionOutcome } | MemoryDeliveryOutcome> {
    if (!this.queueMode)
      return { extraction: await this.saveContextWithOutcome(inputValues, outputValues) };
    const { humanInput, aiOutput } = this.contextPair(inputValues, outputValues);
    if (inputValues[this.inputKey || 'input'] === undefined)
      throw new Error('Engram queue: explicit_human_input_required');
    const messages: BaseMessage[] = [new HumanMessage(humanInput), new AIMessage(aiOutput)];
    for (const source of this.extractSystemToolSources(inputValues, outputValues)) {
      const audit = new SystemMessage(source.content);
      audit.additional_kwargs.engram_tool_audit = true;
      messages.splice(messages.length - 1, 0, audit);
    }
    return this.saveMessagesWithDelivery(messages);
  }

  private contextPair(inputValues: InputValues, outputValues: OutputValues) {
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
    return { humanInput, aiOutput };
  }

  async saveContextWithOutcome(
    inputValues: InputValues,
    outputValues: OutputValues,
  ): Promise<ExtractionOutcome> {
    if (this.queueMode) throw new Error('Engram queue: use_delivery_outcome');
    const { humanInput, aiOutput } = this.contextPair(inputValues, outputValues);

    if (this.policy.finalTurnWrites) {
      const messages: BaseMessage[] = [new HumanMessage(humanInput), new AIMessage(aiOutput)];
      // Explicit system/tool fields are audit inputs, never new human facts.
      for (const source of this.extractSystemToolSources(inputValues, outputValues)) {
        const audit = new SystemMessage(source.content);
        audit.additional_kwargs.engram_tool_audit = true;
        messages.splice(messages.length - 1, 0, audit);
      }
      return (await this.saveMessagesWithOutcome(messages)).extraction;
    }

    const humanText = this.stringifyMessageValue(humanInput);
    const aiText = this.stringifyMessageValue(aiOutput);
    const writes: EpisodeMessageWrite[] = [];
    const humanEpisodeIndex = this.storeHumanEpisodes ? writes.length : null;
    if (this.storeHumanEpisodes) {
      writes.push({
        message: new HumanMessage(humanInput),
        metadata: this.metadataForEpisodeKind(this.humanEpisodeKind),
      });
    }
    const aiEpisodeIndex = this.storeAiEpisodes ? writes.length : null;
    if (this.storeAiEpisodes) {
      writes.push({
        message: new AIMessage(aiOutput),
        metadata: this.metadataForEpisodeKind('assistant_reply'),
      });
    }

    const storedEpisodes = await this.engramHistory.addMessagesAndGetEpisodes(writes);
    const humanEpisode =
      humanEpisodeIndex === null ? null : (storedEpisodes[humanEpisodeIndex] ?? null);
    const aiEpisode = aiEpisodeIndex === null ? null : (storedEpisodes[aiEpisodeIndex] ?? null);

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
      return this.runExtraction(sources);
    }
    return new ExtractionDiagnostics().finish('disabled');
  }

  /** Both native bulk tool saves and final-only saves share this policy and extraction owner. */
  async saveMessagesWithOutcome(messages: BaseMessage[]): Promise<MemoryWriteOutcome> {
    if (this.queueMode) throw new Error('Engram queue: use_delivery_outcome');
    return (await this.saveMessagesWithDelivery(messages)) as MemoryWriteOutcome;
  }

  async saveMessagesWithDelivery(messages: BaseMessage[]): Promise<MemoryDeliveryOutcome> {
    if (messages.length > 1000) throw new Error('Memory write cannot exceed 1000 messages');
    const finals = finalAssistantIndices(messages);
    const writes: EpisodeMessageWrite[] = [];
    const candidates: Array<{
      message: BaseMessage;
      metadata: EpisodeWriteMetadata;
      writeIndex: number | null;
      extract: boolean;
    }> = [];
    const automatic = this.fields.automaticMemory
      ? AutomaticRuntimeSchema.parse(this.fields.automaticMemory)
      : undefined;
    const automaticPolicy = compileAutomaticPolicy({ profileId: automatic?.profileId });
    const automaticEnabled = automaticPolicy.profileId !== 'existing';
    let automaticBlocked: 'missing_binding' | 'invalid_envelope' | undefined;
    const automaticGraph = automaticEnabled
      ? await this.storage.readExtractionSnapshot!(this.groupId)
      : undefined;
    let actorBinding =
      automatic && automaticGraph
        ? findAutomaticBinding(
            automaticGraph,
            this.groupId,
            automatic.actor.issuer,
            automatic.actor.actorReference,
          )
        : null;
    if (actorBinding && automatic && automaticGraph) {
      try {
        assertAutomaticBindingIdentity(
          automaticGraph,
          this.groupId,
          automatic.actor.issuer,
          automatic.actor.actorReference,
          {
            bindingId: actorBinding.bindingId,
            revision: actorBinding.revision,
            subjectId: actorBinding.subjectId,
            fingerprint: actorBinding.fingerprint,
          },
        );
      } catch {
        actorBinding = null;
      }
    }
    const humanMessages = messages.filter((message) => messageType(message) === 'human');
    if (automaticEnabled && humanMessages.length > 1)
      throw new Error('Engram automatic: one_current_human_required');
    if (automaticEnabled && (!actorBinding || actorBinding.state !== 'active'))
      automaticBlocked = 'missing_binding';
    if (automaticEnabled && automatic?.capturedSourceId) {
      const source = automaticGraph!.episodes.find(
        (ep) => ep.uuid === automatic.capturedSourceId && ep.group_id === this.groupId,
      );
      const owner = AutomaticWriteOwnerSchema.parse(source?.attributes[AUTOMATIC_OWNER]);
      const current = humanMessages[0];
      const currentContent = current
        ? this.stringifyMessageValue(current.content)
        : this.currentHumanQuery;
      if (
        !source ||
        !currentContent ||
        source.content !== currentContent ||
        owner.store !== automatic.storeIdentity ||
        owner.turn !== automatic.turnId ||
        owner.actor !== automatic.actor.actorReference ||
        owner.issuer !== automatic.actor.issuer ||
        canonical(owner.policy) !== canonical(automaticPolicy) ||
        owner.role !== 'human'
      )
        throw new Error('Engram automatic: capture_reference_mismatch');
      if (owner.binding)
        assertAutomaticBinding(
          automaticGraph!,
          source.attributes[AUTOMATIC_ENVELOPE] as Parameters<typeof assertAutomaticBinding>[1],
        );
      else if (source.attributes[AUTOMATIC_ENVELOPE] !== undefined)
        throw new Error('Engram automatic: capture_reference_mismatch');
      else automaticBlocked = 'missing_binding';
      await this.validateCapturedHuman(currentContent);
    }
    let skipped = 0;
    let auditCount = 0;
    let humanPosition = -1;
    let turnIdentity: string | null =
      this.episodeMetadata.idempotency_key ?? this.episodeMetadata.source_message_id ?? null;
    for (const [index, message] of messages.entries()) {
      const type = messageType(message);
      const human = type === 'human';
      if (human) {
        humanPosition++;
        turnIdentity =
          this.episodeMetadata.idempotency_key ??
          message.id ??
          this.episodeMetadata.source_message_id ??
          null;
      }
      const assistant = type === 'ai' && finals.has(index);
      if (automaticEnabled && human && automatic?.capturedSourceId) {
        skipped++;
        continue;
      }
      const audit = !human && !assistant;
      if (audit && !this.policy.storeToolAudit && !this.extractSystemTool) {
        skipped++;
        continue;
      }
      // Unknown/native tool roles can only be audit inputs. No JSON-content heuristics here.
      const kind = human ? this.humanEpisodeKind : assistant ? 'assistant_reply' : 'tool_output';
      const metadata: EpisodeWriteMetadata =
        human || assistant
          ? this.metadataForEpisodeKind(human ? this.humanEpisodeKind : 'assistant_reply')
          : {
              ...this.episodeMetadata,
              sender_id: null,
              sender_name: null,
              quoted_message_id: null,
              source_message_id: null,
              trust_level: 'unverified',
              review_status: 'proposed',
            };
      metadata.episode_kind = kind;
      // Preserve raw source IDs in provenance; isolate audit identities sharing tool_output kind.
      if (message.id)
        metadata.source_message_id = audit ? `${type}:${contentHash(message.id)}` : message.id;
      else if (assistant) metadata.source_message_id = null;
      if (turnIdentity)
        metadata.idempotency_key = `turn:${contentHash(turnIdentity)}:${Math.max(0, humanPosition)}:${audit ? `audit:${index}` : kind}`;
      else if (message.id) metadata.idempotency_key = `message:${type}:${contentHash(message.id)}`;
      else metadata.idempotency_key = null;
      metadata.attributes = {
        ...this.episodeMetadata.attributes,
        ...(audit ? { engram_audit: true } : {}),
        engram_message: {
          original_role: type,
          original_message_id: message.id ?? null,
          tool_call_id:
            'tool_call_id' in message && typeof message.tool_call_id === 'string'
              ? message.tool_call_id
              : null,
        },
      };
      if (automaticEnabled && automatic && (human || assistant)) {
        const content = this.stringifyMessageValue(message.content);
        const bindingRef =
          actorBinding?.state === 'active'
            ? {
                bindingId: actorBinding.bindingId,
                revision: actorBinding.revision,
                subjectId: actorBinding.subjectId,
                fingerprint: actorBinding.fingerprint,
              }
            : null;
        metadata.idempotency_key = `automatic:${contentHash(automatic.turnId)}:${human ? 'human' : 'assistant'}`;
        metadata.attributes[AUTOMATIC_OWNER] = AutomaticWriteOwnerSchema.parse({
          version: 1,
          store: automatic.storeIdentity,
          namespace: this.groupId,
          turn: automatic.turnId,
          role: human ? 'human' : 'assistant',
          actor: automatic.actor.actorReference,
          issuer: automatic.actor.issuer,
          binding: bindingRef,
          policy: automaticPolicy,
          contentHash: contentHash(content),
        });
        if (human && bindingRef) {
          const capture = captureEnvelope(
            automatic.rawHumanContent ?? content,
            content,
            automatic.actor,
            bindingRef,
            automatic.explicitIntent,
            automaticPolicy,
          );
          if (!capture.ok) {
            automaticBlocked = 'invalid_envelope';
            const owner = AutomaticWriteOwnerSchema.parse(metadata.attributes[AUTOMATIC_OWNER]);
            metadata.attributes[AUTOMATIC_OWNER] = { ...owner, binding: null };
          } else metadata.attributes[AUTOMATIC_ENVELOPE] = capture.envelope;
        }
      }
      const store = audit
        ? this.policy.storeToolAudit
        : human
          ? this.storeHumanEpisodes
          : this.storeAiEpisodes;
      const writeIndex = store ? writes.length : null;
      if (store) writes.push({ message, metadata });
      else skipped++;
      if (audit && store) auditCount++;
      candidates.push({
        message,
        metadata,
        writeIndex,
        extract: automaticEnabled
          ? human && this.extractHuman && !automaticBlocked
          : human
            ? this.extractHuman
            : assistant
              ? this.extractAi
              : this.extractSystemTool,
      });
    }
    const enqueueStarted = performance.now();
    const enqueueStorage = new StorageAccumulator();
    const appendQueue = () =>
      (automaticEnabled
        ? this.storage.appendAutomaticEpisodesWithExtraction!
        : this.storage.appendEpisodesWithExtraction!
      ).call(
        this.storage,
        this.engramHistory.prepareMessageWrites(writes),
        candidates
          .filter(
            (candidate) =>
              candidate.extract &&
              candidate.writeIndex !== null &&
              messageHasText(candidate.message),
          )
          .map((candidate) => candidate.writeIndex!),
        this.binding!,
        QueueLimitsSchema.parse({}),
      );
    const queued =
      this.queueMode && writes.length > 0
        ? this.storage.withExtractionDiagnostics
          ? await this.storage.withExtractionDiagnostics(
              (value) => enqueueStorage.observe(value),
              appendQueue,
            )
          : await appendQueue()
        : null;
    const results = queued
      ? queued.results
      : automaticEnabled
        ? await this.storage.appendAutomaticEpisodes!(
            this.engramHistory.prepareMessageWrites(writes),
          )
        : await this.engramHistory.appendMessageWrites(writes);
    if (queued && queued.jobs.length)
      return {
        delivery: {
          version: 1,
          status: 'queued',
          durable: true,
          enqueue_ms: performance.now() - enqueueStarted,
          jobs: queued.jobs.map((job) => ({ uuid: job.uuid, state: job.state })),
          graph_fresh: queued.queue.graph_fresh,
          storage_breakdown: enqueueStorage.snapshot(),
        },
        written: results.filter((result) => result.created).length,
        duplicates: results.filter((result) => !result.created).length,
        audit: auditCount,
        skipped,
      };
    const sources: ExtractionSource[] = [];
    for (const candidate of candidates) {
      if (!candidate.extract || !messageHasText(candidate.message)) continue;
      const result = candidate.writeIndex === null ? null : results[candidate.writeIndex];
      // Existing records are not re-extracted by a second entry point/replayed turn.
      if (result && !result.created) continue;
      if (result) sources.push(this.episodeToExtractionSource(result.episode));
      else {
        const kind = candidate.metadata.episode_kind!;
        sources.push({
          content: this.stringifyMessageValue(candidate.message.content),
          role:
            messageType(candidate.message) === 'human'
              ? 'human'
              : messageType(candidate.message) === 'system'
                ? 'system'
                : 'ai',
          episode_kind: kind,
          source_message_id: candidate.metadata.source_message_id ?? null,
          sender_id: candidate.metadata.sender_id ?? null,
          sender_name: candidate.metadata.sender_name ?? null,
          reference_time: new Date().toISOString(),
          trust_level: candidate.metadata.trust_level ?? 'standard',
          review_status: candidate.metadata.review_status ?? 'accepted',
        });
      }
    }
    const extraction = automaticBlocked
      ? new ExtractionDiagnostics().finish('no_sources')
      : this.enableExtraction
        ? await this.runExtraction(sources)
        : new ExtractionDiagnostics().finish('disabled');
    if (automaticBlocked)
      extraction.automatic = {
        version: 1,
        policy: automaticPolicy,
        sourceIds: automatic?.capturedSourceId
          ? [automatic.capturedSourceId]
          : results
              .filter((result) => result.episode.role === 'human')
              .map((result) => result.episode.uuid),
        persisted: false,
        commitAt: null,
        coverageComplete: true,
        items: [
          { state: 'deferred', persisted: false, mutation: 'none', reasons: [automaticBlocked] },
        ],
      };
    return {
      extraction,
      written: results.filter((result) => result.created).length,
      duplicates: results.filter((result) => !result.created).length,
      audit: auditCount,
      skipped,
    };
  }

  async clear(): Promise<void> {
    await this.engramHistory.clear();
  }

  private async validateCapturedHuman(content: string): Promise<void> {
    const config = AutomaticRuntimeSchema.parse(this.fields.automaticMemory);
    if (!config.capturedSourceId || !content)
      throw new Error('Engram automatic: current_capture_input_required');
    const graph = await this.storage.readExtractionSnapshot!(this.groupId);
    const source = graph.episodes.find(
      (ep) => ep.uuid === config.capturedSourceId && ep.group_id === this.groupId,
    );
    const owner = AutomaticWriteOwnerSchema.parse(source?.attributes[AUTOMATIC_OWNER]);
    const policy = compileAutomaticPolicy({ profileId: config.profileId });
    if (
      !source ||
      source.content !== content ||
      source.role !== 'human' ||
      owner.role !== 'human' ||
      owner.namespace !== this.groupId ||
      owner.store !== config.storeIdentity ||
      owner.turn !== config.turnId ||
      owner.actor !== config.actor.actorReference ||
      owner.issuer !== config.actor.issuer ||
      owner.contentHash !== contentHash(content) ||
      canonical(owner.policy) !== canonical(policy)
    )
      throw new Error('Engram automatic: capture_reference_mismatch');
    if (owner.binding) {
      const expected = captureEnvelope(
        config.rawHumanContent ?? content,
        content,
        config.actor,
        owner.binding,
        config.explicitIntent,
        policy,
      );
      if (
        !expected.ok ||
        canonical(expected.envelope) !== canonical(source.attributes[AUTOMATIC_ENVELOPE])
      )
        throw new Error('Engram automatic: capture_reference_mismatch');
      assertAutomaticBinding(graph, expected.envelope);
    } else if (source.attributes[AUTOMATIC_ENVELOPE] !== undefined)
      throw new Error('Engram automatic: capture_reference_mismatch');
  }

  /**
   * Search the knowledge graph for facts relevant to the current input.
   * Uses HybridSearchEngine which merges text + vector results via RRF when embeddings are enabled.
   */
  private async getRelevantFacts(query: string): Promise<SystemMessage[]> {
    if (!query.trim()) return [];

    try {
      const automatic = { conflicts: { remaining: 128 }, sources: { remaining: 512, deferred: 0 } };
      const results = await this.searchEngine.search(query, this.groupId, {
        automaticBudget: automatic,
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
              undefined,
              automatic,
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

  private async runExtraction(sources: ExtractionSource[]): Promise<ExtractionOutcome> {
    if (!sources.length) return new ExtractionDiagnostics().finish('no_sources');
    const extractionPolicy = ExtractionPolicySchema.parse(this.fields.extractionPolicy);
    const diagnostics = new ExtractionDiagnostics({
      backend: this.storage.extractionBackend?.() ?? 'unknown',
      resolution: extractionPolicy.mode,
      quality: extractionPolicy.quality,
      execution: 'synchronous',
    });
    if (
      this.settings &&
      ExtractionPolicySchema.parse(this.fields.extractionPolicy).mode === 'bounded'
    ) {
      try {
        return await runBoundedExtraction(this.storage, this.groupId, sources, this.settings);
      } catch (error) {
        reportExtractionError(
          error instanceof ExtractionError && error.kind === 'budget_exhausted'
            ? 'entities'
            : 'persistence',
          error instanceof ExtractionError ? error : new ExtractionError('storage'),
          diagnostics,
        );
        return diagnostics.finish();
      }
    }
    if (!this.extractionPipeline) return diagnostics.finish('missing_configuration');
    if (!sources.some((source) => source.content.trim())) return diagnostics.finish('no_sources');
    try {
      const operation = () => this.extractionPipeline!.processSources(sources, diagnostics);
      if (this.storage.withExtractionDiagnostics)
        await this.storage.withExtractionDiagnostics(
          (value) => diagnostics.observeStorage(value),
          operation,
        );
      else await operation();
    } catch (error) {
      reportExtractionError('persistence', error, diagnostics);
    }
    return diagnostics.finish();
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
      quoted_message_id: episode.quoted_message_id,
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
