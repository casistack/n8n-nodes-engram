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
  ExtractionBudgetError,
  reportExtractionError,
} from '../extraction/ExtractionDiagnostics';
import type { ExtractionOutcome } from '../schemas';
import type { CreateEpisodicNode, EpisodicNode } from '../schemas/EpisodicNode.schema';
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
import type { AppendEpisodeResult, IGraphStorage } from '../storage/IGraphStorage';
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
import {
  CreateEpisodicNodeSchema,
  extractionMetadataFromAttributes,
  type ExtractionThresholdPolicy,
} from '../schemas';
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
  assertOwnedEpisodeReplay,
  WRITE_OWNER_V2_ATTRIBUTE,
} from '../storage/AutomaticIdentity';
import { canonical } from '../extraction/QueueState';
import { COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE } from '../schemas/CompositionalAutomaticCaptureV3.schema';
import { types as utilTypes } from 'util';
import {
  MemoryCaptureLifecycleSchema,
  MemoryProcessingAttemptHashSchema,
  ReplaySafeMemoryWriteDiagnosticsSchema,
  type ReplaySafeMemoryWriteDiagnostics,
  type MemoryCaptureLifecycle,
  REPLAY_SAFE_AUDIT_LIMITS,
} from '../schemas/ReplaySafeMemory.schema';
import {
  BoundedAutomaticCaptureJsonError,
  cloneBoundedAutomaticCaptureJson,
} from '../storage/BoundedAutomaticCaptureJson';
import {
  prepareReplaySafeAudits,
  readReplaySafeMessageData,
  readReplaySafeMessageRole,
} from './ReplaySafeAudits';
import { prepareReplaySafeAssistantIntent } from './ReplaySafeAssistantIntent';
import {
  loadCompositionalRuntimeReaderV3,
  getCompositionalRuntimeNamespaceDataV3,
  getCompositionalRuntimeAutomaticReadContextV3,
  isLiveCompositionalRuntimeReaderV3,
  getCompositionalRuntimeRequestAllowanceV3,
} from '../search/CompositionalRuntimeReaderV3';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import { validateCompositionalMemoryParentV3 } from './CompositionalMemoryParentV3';
import { projectCompositionalCaptureReceiptSummaryV3 } from './CompositionalHumanCaptureV3';
import { RequestBudget } from '../extraction/RequestBudget';
import {
  closeAutonomousPersonalNativeMemoryAdapterV4,
  consumeAutonomousPersonalNativeMemoryAdapterV4,
  getAutonomousPersonalNativeMemoryAdapterAccessV4,
  AutonomousPersonalNativeMemoryAdapterV4Error,
  type AutonomousPersonalNativeMemoryAdapterAccessV4,
  type PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
} from './AutonomousPersonalNativeMemoryAdapterV4';
import {
  openAutonomousPersonalMemoryReadV4,
  readAutonomousPersonalConversationV4,
  type AutonomousPersonalMemoryReadFailureReasonV4,
} from './AutonomousPersonalMemoryReadV4';
import { createAutonomousPersonalNativeMemoryWorkV4 } from '../utils/AutonomousPersonalNativeMemoryWorkV4';
import { prepareAutonomousPersonalAssistantFinalIntentV4 } from './AutonomousPersonalAssistantFinalIntentV4';
import {
  closeAutonomousPersonalAssistantFinalInvocationV4,
  issueAutonomousPersonalAssistantFinalInvocationV4,
} from '../storage/AutonomousPersonalAssistantFinalInvocationV4';
import type { AutomaticAssistantFinalWriterResultV2 } from '../schemas/AutomaticAssistantCapture.schema';
import type { AutonomousPersonalCaptureReceiptSummaryV4 } from '../schemas/AutonomousPersonalCaptureReceiptSummaryV4.schema';

/** One load's query request, bound to the original reader rather than a new network window. */
class CompositionalMemoryQueryBudget extends RequestBudget {
  constructor(
    private readonly reader: CompositionalRuntimeReaderV3,
    deadlineAt: number,
  ) {
    super(1, 5000, 256 * 1024, 256 * 1024, undefined, deadlineAt);
  }
  check(): void {
    try {
      if (!isLiveCompositionalRuntimeReaderV3(this.reader))
        throw new ExtractionBudgetError('deadline');
      super.check();
    } catch (error) {
      this.controller.abort();
      throw error;
    }
  }
}

export interface NativeAdminLegacyCaptureGuard {
  /** Current Native Admin execution ID; null means execution identity is unavailable. */
  executionId: string | null;
}

function assertNativeAdminSourceMatches(
  existing: EpisodicNode,
  incoming: CreateEpisodicNode,
): void {
  try {
    // Keep the library's exact owner/envelope/content comparison; it deliberately omits
    // source_execution_id so ordinary library replay remains execution-independent.
    assertOwnedEpisodeReplay(existing, CreateEpisodicNodeSchema.parse(incoming));
  } catch {
    throw new Error('Engram automatic: legacy_source_conflict');
  }
}

function assertNativeAdminSameExecution(
  existing: EpisodicNode,
  currentExecutionId: string | null,
): void {
  if (
    !currentExecutionId ||
    currentExecutionId.trim().length === 0 ||
    !existing.source_execution_id ||
    existing.source_execution_id !== currentExecutionId
  ) {
    throw new Error('Engram automatic: legacy_cross_execution_duplicate');
  }
}

type NativeMemoryAuditStateV4 = {
  attemptedFinal: boolean;
  finalConfirmed: boolean;
  finalResult: ReplaySafeMemoryWriteDiagnostics['finalAssistant'] | null;
  finalIntentHash: string | null;
  finalObservationHash: string | null;
  pendingAudits: EpisodeMessageWrite[];
  pendingAuditBytes: number;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
};

type OwnedNativeMessageV4 = BaseMessage & {
  readonly additional_kwargs: Record<string, unknown>;
  readonly tool_calls?: unknown[];
  readonly tool_call_id?: string;
  readonly name?: string;
};

const nativeMemoryStatesV4 = new WeakMap<object, NativeMemoryAuditStateV4>();

const denyNativeHistoryStorageOperationV4 = (): never => {
  throw nativeMemoryFailure('unsupported_operation');
};

/** Native public history never retains the real backend owner or a target identifier. */
const nativeHistoryStorageDenyV4 = new Proxy(Object.create(null) as object, {
  get: (_target, property) => {
    if (property === 'then' || typeof property === 'symbol') return undefined;
    return denyNativeHistoryStorageOperationV4;
  },
  set: () => false,
}) as IGraphStorage;

function clearNativeMemoryAuditStateV4(state: NativeMemoryAuditStateV4): void {
  state.pendingAudits = [];
  state.pendingAuditBytes = 0;
  state.finalResult = null;
  state.finalIntentHash = null;
  state.finalObservationHash = null;
  state.finalConfirmed = false;
  state.attemptedFinal = true;
  const signal = state.abortSignal;
  const listener = state.abortListener;
  state.abortSignal = null;
  state.abortListener = null;
  if (signal && listener) {
    try {
      signal.removeEventListener('abort', listener);
    } catch {
      // Native adapter cleanup remains idempotent and does not expose host errors.
    }
  }
}

function clearNativeMemoryAuditStateForReferenceV4(
  reference: WeakRef<NativeMemoryAuditStateV4>,
): void {
  const state = reference.deref();
  if (state) clearNativeMemoryAuditStateV4(state);
}

function createNativeMemoryAuditCleanupListenerV4(
  reference: WeakRef<NativeMemoryAuditStateV4>,
): () => void {
  return () => clearNativeMemoryAuditStateForReferenceV4(reference);
}

function nativeMemoryFailure(reason: string): Error {
  return new Error(`Engram native Memory: ${reason}`);
}

function nativeReadFailure(reason: AutonomousPersonalMemoryReadFailureReasonV4): Error {
  return nativeMemoryFailure(reason);
}

function nativeMemoryWork(
  access: AutonomousPersonalNativeMemoryAdapterAccessV4,
  deadlineMs: number,
) {
  const signal = access.signal;
  const available = access.nativeCancellationAvailable;
  if (available && !signal) throw nativeMemoryFailure('invalid_adapter');
  return createAutonomousPersonalNativeMemoryWorkV4(
    { getExecutionCancelSignal: () => (available ? (signal ?? undefined) : undefined) },
    deadlineMs,
  );
}

function ownNativeMessageBatchV4(
  value: unknown,
  check: () => void,
): { readonly messages: BaseMessage[]; readonly roles: string[] } {
  const invalid = (): never => {
    throw nativeMemoryFailure('invalid_current_turn');
  };
  try {
    check();
    if (utilTypes.isProxy(value) || !Array.isArray(value) || value.length > 1000) invalid();
    const entries = value as unknown[];
    const messages: BaseMessage[] = [];
    const roles: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      check();
      const entry = Object.getOwnPropertyDescriptor(entries, String(index));
      if (entry === undefined) return invalid();
      if (!Object.prototype.hasOwnProperty.call(entry, 'value')) return invalid();
      const entryValue: unknown = entry.value;
      if (!entryValue || typeof entryValue !== 'object') return invalid();
      const original = entryValue as BaseMessage;
      if (utilTypes.isProxy(original)) invalid();
      const role = readReplaySafeMessageRole(original);
      const rawContent = readReplaySafeMessageData(original, 'content');
      if (rawContent === undefined || rawContent === null) invalid();
      const content = cloneBoundedAutomaticCaptureJson<{ value: unknown }>(
        { value: rawContent },
        'beginRequest',
      ).value;
      if (
        (role === 'human' || role === 'ai') &&
        typeof content === 'string' &&
        (content.length > 65_536 || Buffer.byteLength(content, 'utf8') > 65_536)
      )
        invalid();
      if (role === 'ai' && typeof content !== 'string' && !Array.isArray(content)) invalid();

      const rawAdditional = readReplaySafeMessageData(original, 'additional_kwargs');
      const additional = cloneBoundedAutomaticCaptureJson(
        rawAdditional === undefined || rawAdditional === null ? {} : rawAdditional,
        'beginRequest',
      );
      if (!additional || typeof additional !== 'object' || Array.isArray(additional)) invalid();

      const rawCalls = readReplaySafeMessageData(original, 'tool_calls');
      const calls =
        rawCalls === undefined || rawCalls === null
          ? undefined
          : cloneBoundedAutomaticCaptureJson<{ value: unknown }>(
              { value: rawCalls },
              'beginRequest',
            ).value;
      if (calls !== undefined && !Array.isArray(calls)) invalid();

      const readOptionalString = (key: string, maximum: number): string | undefined => {
        const raw = readReplaySafeMessageData(original, key);
        if (raw === undefined || raw === null || raw === '') return undefined;
        if (
          typeof raw !== 'string' ||
          raw.length > maximum ||
          Buffer.byteLength(raw, 'utf8') > maximum
        )
          invalid();
        return raw as string;
      };
      const id = readOptionalString('id', 512);
      const toolCallId = readOptionalString('tool_call_id', 512);
      const name = readOptionalString('name', 512);
      const owned = Object.freeze({
        content,
        additional_kwargs: additional as Record<string, unknown>,
        ...(calls === undefined ? {} : { tool_calls: calls as unknown[] }),
        ...(id === undefined ? {} : { id }),
        ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
        ...(name === undefined ? {} : { name }),
        _getType: () => role,
      }) as unknown as OwnedNativeMessageV4;
      messages.push(owned);
      roles.push(role);
      check();
    }
    check();
    return { messages, roles };
  } catch (error) {
    check();
    if (error instanceof BoundedAutomaticCaptureJsonError) {
      throw nativeMemoryFailure(
        error.reason === 'invalid_json' ? 'invalid_current_turn' : 'capacity',
      );
    }
    if (error instanceof Error && error.message.startsWith('Engram native Memory:')) throw error;
    throw nativeMemoryFailure('invalid_current_turn');
  }
}

function nativeCreationSummaryMessageV4(
  summary: AutonomousPersonalCaptureReceiptSummaryV4,
): SystemMessage {
  if (summary.kind === 'cancelled') {
    return new SystemMessage(
      'Engram creation summary: capture was cancelled before completion; no claim coverage was established.',
    );
  }
  const counts = summary.counts;
  const coverage = `Acceptance coverage: ${summary.acceptedCoverage}. Interpretation coverage: ${summary.interpretationCoverage}. Source coverage: ${summary.sourceCoverage.status}.`;
  const outcomes =
    summary.selection.kind === 'occurrences'
      ? ` Occurrences: ${counts.occurrenceCount}; accepted ${counts.byState.accepted}; proposed ${counts.byState.proposed}; rejected ${counts.byState.rejected}; not selected ${counts.byState.not_selected}; newly created ${counts.createdOccurrenceCount}; references ${counts.referenceOccurrenceCount}; distinct persisted claims ${counts.distinctPersistedClaimCount}.`
      : '';
  return new SystemMessage(
    `Engram creation summary (creation-time outcomes, not current fact approval): ${coverage}${outcomes} Retained conversation history is separate from claims. Counts do not identify the underlying text; make saving claims only to the extent these coverage fields support.`,
  );
}

export interface EngramChatMemoryInput extends BaseChatMemoryInput {
  automaticPreferenceInterpreter?: 'literalV1' | 'compositionalV2';
  /** Trusted native/application processing identity, independently derived from the current execution. */
  expectedHumanProcessingAttemptHash?: string;
  captureLifecycle?: MemoryCaptureLifecycle;
  processingAttemptHash?: string;
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
  private nativeAdapterMode = false;
  private binding?: QueueBinding;
  private settings?: ExtractionSettings;
  private fields: EngramChatMemoryInput;
  private captureLifecycle: MemoryCaptureLifecycle;
  private compositionalMode = false;
  private compositionalEmbeddingConfig?: EmbeddingConfig;
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

  constructor(
    fields: EngramChatMemoryInput,
    nativeAdapterToken?: PrivateAutonomousPersonalNativeMemoryAdapterTokenV4,
  ) {
    const history = new EngramChatMessageHistory({
      storage: nativeAdapterToken === undefined ? fields.storage : nativeHistoryStorageDenyV4,
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

    this.nativeAdapterMode = nativeAdapterToken !== undefined;
    if (nativeAdapterToken !== undefined) {
      if (!consumeAutonomousPersonalNativeMemoryAdapterV4(fields.storage, nativeAdapterToken, this))
        throw new AutonomousPersonalNativeMemoryAdapterV4Error('unsupported_configuration');
      nativeMemoryStatesV4.set(this, {
        attemptedFinal: false,
        finalConfirmed: false,
        finalResult: null,
        finalIntentHash: null,
        finalObservationHash: null,
        pendingAudits: [],
        pendingAuditBytes: 0,
        abortSignal: null,
        abortListener: null,
      });
      const nativeState = nativeMemoryStatesV4.get(this)!;
      const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(this);
      if (!access)
        throw new AutonomousPersonalNativeMemoryAdapterV4Error('unsupported_configuration');
      const signal = access.nativeCancellationAvailable ? access.signal : null;
      if (access.nativeCancellationAvailable && !signal)
        throw new AutonomousPersonalNativeMemoryAdapterV4Error('unsupported_configuration');
      if (signal) {
        const reference = new WeakRef(nativeState);
        const listener = createNativeMemoryAuditCleanupListenerV4(reference);
        nativeState.abortSignal = signal;
        nativeState.abortListener = listener;
        signal.addEventListener('abort', listener, { once: true });
        access.checkOpen();
      }
    }

    const retrievalMode = RetrievalModeSchema.parse(fields.retrievalMode);
    GraphEvidenceBudgetsSchema.parse(fields.graphEvidenceBudgets);
    if (retrievalMode === 'asOf' && !ExplicitTimestampSchema.safeParse(fields.retrievalAt).success)
      throw new Error('Engram retrieval: as_of_requires_timestamp');
    this.fields = {
      ...fields,
      ...(this.nativeAdapterMode ? { llmConfig: undefined } : {}),
      retrievalMode,
    };
    if (
      fields.automaticPreferenceInterpreter !== undefined &&
      !['literalV1', 'compositionalV2'].includes(fields.automaticPreferenceInterpreter)
    )
      throw new Error('Engram replay-safe memory: unsupported_configuration');
    this.compositionalMode = fields.automaticPreferenceInterpreter === 'compositionalV2';
    this.captureLifecycle = MemoryCaptureLifecycleSchema.parse(
      fields.captureLifecycle === undefined ? 'legacy' : fields.captureLifecycle,
    );
    const extractionPolicy = ExtractionPolicySchema.parse(fields.extractionPolicy);
    const automatic = fields.automaticMemory
      ? AutomaticRuntimeSchema.parse(fields.automaticMemory)
      : undefined;
    const automaticPolicy = compileAutomaticPolicy({ profileId: automatic?.profileId });
    if (this.compositionalMode && this.captureLifecycle !== 'replaySafeV2')
      throw new Error('Engram replay-safe memory: unsupported_configuration');
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
    if (fields.llmConfig && !this.compositionalMode && !this.nativeAdapterMode)
      this.settings = {
        llm: fields.llmConfig,
        embeddings: fields.embeddingConfig,
        policy: extractionPolicy,
        types: fields.entityTypes ?? ['person', 'organization', 'location', 'concept', 'event'],
        threshold: fields.extractionThresholdPolicy,
        ...(automaticPolicy.profileId !== 'existing' ? { automaticPolicy } : {}),
      };
    this.policy = MemoryPolicySchema.parse(fields.policy ?? {});
    if (this.nativeAdapterMode) {
      const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(this);
      const initial = access?.initialSnapshot;
      const nativeConfig = initial?.config;
      const runtime = automatic;
      const wrapperMatches =
        nativeConfig?.sourceMapping.mode === 'application_region'
          ? runtime?.actor.applicationOwnedWrapper === true &&
            runtime.actor.humanRegion?.start === nativeConfig.sourceMapping.humanRegion.start &&
            runtime.actor.humanRegion?.end === nativeConfig.sourceMapping.humanRegion.end
          : runtime?.actor.applicationOwnedWrapper !== true && !runtime?.actor.humanRegion;
      if (
        !access ||
        !nativeConfig ||
        fields.captureLifecycle !== 'replaySafeV2' ||
        !fields.storage.saveAssistantFinalV4 ||
        fields.llmConfig !== undefined ||
        !runtime ||
        runtime.profileId !== nativeConfig.profileId ||
        runtime.explicitIntent !== nativeConfig.explicitIntent ||
        runtime.storeIdentity !== nativeConfig.storeHash ||
        runtime.turnId !== nativeConfig.turn ||
        runtime.capturedSourceId !== nativeConfig.sourceId ||
        runtime.actor.namespace !== nativeConfig.namespace ||
        runtime.actor.issuer !== nativeConfig.issuer ||
        runtime.actor.actorReference !== nativeConfig.actorReference ||
        (runtime.rawHumanContent ?? '') !== (nativeConfig.rawHumanContent ?? '') ||
        !wrapperMatches ||
        fields.groupId !== nativeConfig.namespace ||
        (fields.currentHumanQuery ?? '') !== nativeConfig.currentHumanQuery ||
        this.policy.finalTurnWrites !== true ||
        this.policy.historyFilter === 'off' ||
        (fields.acceptedOnlyRetrieval ?? false) !== true ||
        (fields.humanEpisodeKind ?? 'active_human') !== 'active_human' ||
        fields.storeHumanEpisodes === false ||
        fields.storeAiEpisodes === false ||
        fields.extractAi === true ||
        fields.extractSystemTool === true ||
        fields.extractionExecution === 'durable' ||
        this.queueMode ||
        extractionPolicy.mode !== 'bounded' ||
        extractionPolicy.deadline_ms !== nativeConfig.invocationDeadlineMs
      ) {
        throw new AutonomousPersonalNativeMemoryAdapterV4Error('unsupported_configuration');
      }
      access.checkOpen();
    }
    if (
      this.captureLifecycle === 'legacy' &&
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
    if (this.captureLifecycle === 'replaySafeV2') {
      if (
        !automatic ||
        automaticPolicy.profileId === 'existing' ||
        !automatic.capturedSourceId ||
        automatic.actor.namespace !== fields.groupId ||
        this.queueMode ||
        !this.policy.finalTurnWrites ||
        this.policy.historyFilter === 'off' ||
        extractionPolicy.mode !== 'bounded' ||
        fields.extractAi !== false ||
        fields.extractSystemTool ||
        fields.storeAiEpisodes === false ||
        fields.storeHumanEpisodes === false ||
        (!this.nativeAdapterMode && !fields.storage.saveAssistantFinalV2) ||
        (!this.nativeAdapterMode &&
          !this.compositionalMode &&
          !fields.storage.getAutomaticCaptureOutcomeV2) ||
        (!this.nativeAdapterMode &&
          !this.compositionalMode &&
          !fields.storage.readExtractionSnapshot) ||
        (!this.nativeAdapterMode &&
          this.compositionalMode &&
          !fields.storage.readCompositionalRetrievalSnapshotV3) ||
        !fields.storage.supportsDurableExtraction?.()
      )
        throw new Error('Engram replay-safe memory: unsupported_configuration');
      MemoryProcessingAttemptHashSchema.parse(fields.processingAttemptHash);
      if (this.compositionalMode)
        MemoryProcessingAttemptHashSchema.parse(fields.expectedHumanProcessingAttemptHash);
      this.fields.automaticMemory = this.compositionalMode
        ? AutomaticRuntimeSchema.parse(JSON.parse(JSON.stringify(automatic)))
        : automatic;
      this.fields.extractionPolicy = extractionPolicy;
      this.fields.policy = this.policy;
      this.fields.graphEvidenceBudgets = GraphEvidenceBudgetsSchema.parse(
        fields.graphEvidenceBudgets,
      );
    }
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
    if (this.compositionalMode && this.currentHumanQuery.length > 65536)
      throw new Error('Engram replay-safe memory: current_input_required');
    if (this.captureLifecycle === 'replaySafeV2') {
      if (!this.currentHumanQuery)
        throw new Error('Engram replay-safe memory: current_input_required');
      history.excludeCurrentSource(automatic!.capturedSourceId!);
      if (this.compositionalMode)
        history.setCompositionalReadProvider(() =>
          this.createCompositionalReader(this.currentHumanQuery),
        );
      else if (!this.nativeAdapterMode)
        history.setReadGuard(() => this.validateCapturedHuman(this.currentHumanQuery));
    }
    this.storage = fields.storage;
    this.groupId = fields.groupId;
    this.memoryKey = fields.memoryKey ?? 'chat_history';
    this.contextWindow = fields.contextWindow ?? 10;
    this.maxFactsPerQuery = fields.maxFactsPerQuery ?? 10;
    this.minRelevanceScore = fields.minRelevanceScore ?? 0.5;
    this.enableExtraction =
      this.compositionalMode || this.nativeAdapterMode ? false : (fields.enableExtraction ?? false);
    this.engramHistory = history;
    if (this.nativeAdapterMode) {
      history.setSnapshotReadProvider(() => this.readNativeConversationWithFreshFrameV4());
    }
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
    this.retrievalFilters =
      this.captureLifecycle === 'replaySafeV2'
        ? { ...fields.retrievalFilters }
        : (fields.retrievalFilters ?? {});
    if (this.captureLifecycle === 'replaySafeV2')
      this.fields.retrievalFilters = this.retrievalFilters;
    this.contextTokenBudget = fields.contextTokenBudget;
    this.includeProvenanceInContext = fields.includeProvenanceInContext ?? false;
    if (
      this.contextTokenBudget !== undefined &&
      (!Number.isInteger(this.contextTokenBudget) || this.contextTokenBudget < 1)
    ) {
      throw new Error('Context token budget must be a positive integer');
    }

    // Create embedding service if config provided
    const embeddingService =
      fields.embeddingConfig && !this.compositionalMode && !this.nativeAdapterMode
        ? new EmbeddingService(fields.embeddingConfig)
        : undefined;
    if (this.compositionalMode && fields.embeddingConfig)
      this.compositionalEmbeddingConfig = { ...fields.embeddingConfig };

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

  private nativeAccessV4(): AutonomousPersonalNativeMemoryAdapterAccessV4 {
    if (!this.nativeAdapterMode) throw nativeMemoryFailure('invalid_adapter');
    const access = getAutonomousPersonalNativeMemoryAdapterAccessV4(this);
    if (!access) {
      const state = nativeMemoryStatesV4.get(this);
      if (state) clearNativeMemoryAuditStateV4(state);
      nativeMemoryStatesV4.delete(this);
      throw nativeMemoryFailure('invalid_adapter');
    }
    try {
      access.checkOpen();
    } catch (error) {
      const state = nativeMemoryStatesV4.get(this);
      if (state) clearNativeMemoryAuditStateV4(state);
      nativeMemoryStatesV4.delete(this);
      throw error;
    }
    return access;
  }

  /** Called by the native Memory node before closing its one-use adapter. */
  closeNativeMemoryV4(): void {
    if (!this.nativeAdapterMode) return;
    const state = nativeMemoryStatesV4.get(this);
    if (state) clearNativeMemoryAuditStateV4(state);
    nativeMemoryStatesV4.delete(this);
    closeAutonomousPersonalNativeMemoryAdapterV4(this);
  }

  private async assertNativeParentCurrentV4(
    check: () => void,
    candidateSourceBody?: string,
  ): Promise<boolean> {
    check();
    const opened = await openAutonomousPersonalMemoryReadV4(this, this.fields.embeddingConfig);
    if (opened.kind !== 'read_ready') {
      check();
      throw nativeReadFailure(opened.reason);
    }
    const frame = opened.frame;
    try {
      check();
      frame.check();
      if (
        frame.owner !== this.storage ||
        frame.config?.namespace !== this.groupId ||
        frame.config?.currentHumanQuery !== this.currentHumanQuery
      )
        throw nativeMemoryFailure('final_not_authorized');
      let exactSourceBodyMatch = false;
      if (candidateSourceBody !== undefined) {
        const storage = frame.storage;
        const config = frame.config;
        if (!storage || !config) throw nativeMemoryFailure('invalid_frame');
        check();
        frame.check();
        const source = await storage.getEpisode(config.sourceId);
        check();
        frame.check();
        exactSourceBodyMatch = Boolean(
          source &&
          source.uuid === config.sourceId &&
          source.group_id === config.namespace &&
          source.content === candidateSourceBody,
        );
      }
      check();
      frame.check();
      return exactSourceBodyMatch;
    } finally {
      frame.close();
    }
  }

  private async readNativeConversationWithFreshFrameV4(): Promise<{
    messages: BaseMessage[];
    history: Awaited<ReturnType<EngramChatMessageHistory['getMessagesWithDiagnostics']>>['history'];
  }> {
    this.nativeAccessV4();
    const opened = await openAutonomousPersonalMemoryReadV4(this, this.fields.embeddingConfig);
    if (opened.kind !== 'read_ready') throw nativeReadFailure(opened.reason);
    const frame = opened.frame;
    try {
      frame.check();
      let result: Awaited<ReturnType<typeof readAutonomousPersonalConversationV4>>;
      try {
        result = await readAutonomousPersonalConversationV4(frame, {
          contextWindow: this.contextWindow,
          humanEpisodeKind: this.humanEpisodeKind,
          policy: this.policy,
        });
      } catch (error) {
        frame.check();
        throw error;
      }
      frame.check();
      return result;
    } finally {
      frame.close();
    }
  }

  private async loadNativeMemoryVariablesV4(
    values: InputValues,
  ): Promise<{ variables: MemoryVariables; diagnostics: MemoryLoadDiagnostics }> {
    const access = this.nativeAccessV4();
    const initial = access.initialSnapshot;
    const expectedQuery = initial?.config.currentHumanQuery;
    if (!initial || typeof expectedQuery !== 'string') throw nativeMemoryFailure('invalid_adapter');

    let currentInput = expectedQuery;
    let provided = '';
    try {
      if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        utilTypes.isProxy(values)
      )
        throw nativeMemoryFailure('current_input_required');
      if (Object.keys(values).length > 0) {
        const candidate = readReplaySafeMessageData(values, this.inputKey || 'input');
        if (typeof candidate !== 'string' || candidate !== expectedQuery)
          throw nativeMemoryFailure('current_input_required');
        provided = candidate;
        currentInput = candidate;
      }
    } catch (error) {
      access.checkOpen();
      if (error instanceof Error && error.message.startsWith('Engram native Memory:')) throw error;
      throw nativeMemoryFailure('current_input_required');
    }

    const opened = await openAutonomousPersonalMemoryReadV4(this, this.fields.embeddingConfig);
    if (opened.kind !== 'read_ready') throw nativeReadFailure(opened.reason);
    const frame = opened.frame;
    try {
      frame.check();
      const storage = frame.storage;
      const engine = frame.engine;
      const config = frame.config;
      const receiptSummary = frame.receiptSummary;
      const reader = frame.compatibilityReader;
      if (!storage || !engine || !config || !receiptSummary || !reader)
        throw nativeMemoryFailure('invalid_frame');
      if (
        config.namespace !== this.groupId ||
        config.currentHumanQuery !== expectedQuery ||
        currentInput !== config.currentHumanQuery
      )
        throw nativeMemoryFailure('current_input_required');

      let governed;
      try {
        frame.check();
        const configuredMode = this.fields.retrievalMode ?? 'legacy';
        governed = await governedContext(storage, engine, currentInput, config.namespace, {
          mode: configuredMode === 'legacy' ? 'current' : configuredMode,
          at: this.fields.retrievalAt === '' ? undefined : this.fields.retrievalAt,
          evidenceBudgets: this.fields.graphEvidenceBudgets,
          limit: this.maxFactsPerQuery,
          minScore: this.minRelevanceScore,
          tokenBudget: this.contextTokenBudget,
          traversal: this.enableTraversal,
          hops: this.traversalHops,
          acceptedOnly: this.acceptedOnlyRetrieval,
          filters: this.retrievalFilters,
          compositionalReader: reader,
        });
      } catch (error) {
        frame.check();
        throw error;
      }
      frame.check();

      const perLoadHistory = new EngramChatMessageHistory({
        storage,
        groupId: config.namespace,
        contextWindow: this.contextWindow,
        humanEpisodeKind: this.humanEpisodeKind,
        policy: this.policy,
      });
      perLoadHistory.setSnapshotReadProvider(() =>
        readAutonomousPersonalConversationV4(frame, {
          contextWindow: this.contextWindow,
          humanEpisodeKind: this.humanEpisodeKind,
          policy: this.policy,
        }),
      );
      frame.check();
      let historyRead: Awaited<ReturnType<EngramChatMessageHistory['getMessagesWithDiagnostics']>>;
      try {
        historyRead = await perLoadHistory.getMessagesWithDiagnostics();
      } catch (error) {
        frame.check();
        throw error;
      }
      frame.check();

      const factMessages = governed.context ? [new SystemMessage(governed.context)] : [];
      const creationSummary = nativeCreationSummaryMessageV4(receiptSummary);
      frame.check();
      const allMessages = [...factMessages, creationSummary, ...historyRead.messages];
      const diagnostics: MemoryLoadDiagnostics = {
        history: historyRead.history,
        retrieval: {
          query_source: provided ? 'input' : 'configured',
          query_available: currentInput.trim().length > 0,
          fact_messages: factMessages.length,
          selection: governed.audit,
        },
      };
      let variables: MemoryVariables;
      if (this.returnMessages) variables = { [this.memoryKey]: allMessages };
      else {
        const formatted: string[] = [];
        for (const message of allMessages) {
          frame.check();
          const type = message._getType();
          const prefix = type === 'human' ? 'Human' : type === 'ai' ? 'AI' : 'System';
          formatted.push(`${prefix}: ${message.content}`);
        }
        variables = { [this.memoryKey]: formatted.join('\n') };
      }
      frame.check();
      return { variables, diagnostics };
    } finally {
      frame.close();
    }
  }

  private checkCompositionalParent(reader: CompositionalRuntimeReaderV3, content: string) {
    const result = validateCompositionalMemoryParentV3(reader, {
      version: 3,
      preferenceInterpreter: 'compositionalV2',
      namespace: this.groupId,
      runtime: this.fields.automaticMemory,
      currentHumanInput: content,
      expectedHumanProcessingAttemptHash: this.fields.expectedHumanProcessingAttemptHash,
      invocationDeadlineMs: ExtractionPolicySchema.parse(this.fields.extractionPolicy).deadline_ms,
    });
    if (result.status !== 'valid_parent_data')
      throw new Error(
        result.reason === 'budget_exhausted'
          ? 'Engram replay-safe memory: budget_exhausted'
          : 'Engram replay-safe memory: parent_not_authorized',
      );
    return result;
  }

  private async createCompositionalReader(content: string): Promise<CompositionalRuntimeReaderV3> {
    const loaded = await loadCompositionalRuntimeReaderV3(
      this.storage,
      { namespace: this.groupId },
      { budget: { remaining: 512, deferred: 0 } },
    );
    if (loaded.status !== 'ready')
      throw new Error(
        loaded.reason === 'budget_exhausted'
          ? 'Engram replay-safe memory: budget_exhausted'
          : 'Engram replay-safe memory: parent_not_authorized',
      );
    this.checkCompositionalParent(loaded.reader, content);
    return loaded.reader;
  }

  private async loadCompositionalMemoryVariables(
    values: InputValues,
  ): Promise<{ variables: MemoryVariables; diagnostics: MemoryLoadDiagnostics }> {
    if (!values || typeof values !== 'object' || Array.isArray(values) || utilTypes.isProxy(values))
      throw new Error('Engram replay-safe memory: current_input_required');
    const configured = Object.keys(values).length === 0;
    const current = configured
      ? this.currentHumanQuery
      : readReplaySafeMessageData(values, this.inputKey || 'input');
    if (typeof current !== 'string' || !current || current.length > 65536)
      throw new Error('Engram replay-safe memory: current_input_required');
    const reader = await this.createCompositionalReader(current);
    const parent = this.checkCompositionalParent(reader, current);
    const captureReceipt = projectCompositionalCaptureReceiptSummaryV3(
      parent.terminalReceipt,
      () => {
        if (!isLiveCompositionalRuntimeReaderV3(reader))
          throw new Error('Engram replay-safe memory: budget_exhausted');
      },
    );
    const namespace = getCompositionalRuntimeNamespaceDataV3(reader);
    if (namespace.status !== 'namespace_data')
      throw new Error('Engram replay-safe memory: budget_exhausted');
    const storage = new StagedGraph(namespace.graph, this.groupId, false).storage;
    if (!isLiveCompositionalRuntimeReaderV3(reader))
      throw new Error('Engram replay-safe memory: budget_exhausted');
    const historyReader = new EngramChatMessageHistory({
      storage,
      groupId: this.groupId,
      contextWindow: this.contextWindow,
      humanEpisodeKind: this.humanEpisodeKind,
      policy: this.policy,
    });
    historyReader.excludeCurrentSource(this.fields.automaticMemory!.capturedSourceId!);
    historyReader.setCompositionalReadProvider(async () => {
      this.checkCompositionalParent(reader, current);
      return reader;
    });
    const { messages, history } = await historyReader.getMessagesWithDiagnostics();
    let queryBudget: CompositionalMemoryQueryBudget | undefined;
    try {
      if (this.compositionalEmbeddingConfig) {
        const allowance = getCompositionalRuntimeRequestAllowanceV3(reader);
        if (!allowance) throw new Error('Engram replay-safe memory: budget_exhausted');
        queryBudget = new CompositionalMemoryQueryBudget(reader, allowance.deadlineAt);
      }
      const embeddings = this.compositionalEmbeddingConfig
        ? new EmbeddingService(this.compositionalEmbeddingConfig, undefined, queryBudget)
        : undefined;
      const engine = new HybridSearchEngine(storage, embeddings);
      const mode = this.fields.retrievalMode;
      const governed =
        mode && mode !== 'legacy'
          ? await governedContext(storage, engine, current, this.groupId, {
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
              compositionalReader: reader,
            })
          : null;
      const facts = governed
        ? governed.context
          ? [new SystemMessage(governed.context)]
          : []
        : await this.getRelevantFacts(current, { storage, engine, reader });
      if (!isLiveCompositionalRuntimeReaderV3(reader))
        throw new Error('Engram replay-safe memory: budget_exhausted');
      const diagnostics: MemoryLoadDiagnostics = {
        capture: {
          version: 3,
          source_id: parent.sourceId,
          operation_id: parent.operationId,
          receipt: captureReceipt,
        },
        history,
        retrieval: {
          query_source: configured ? 'configured' : 'input',
          query_available: current.trim().length > 0,
          fact_messages: facts.length,
          ...(governed ? { selection: governed.audit } : {}),
        },
      };
      const counts = captureReceipt.counts.byState;
      const distinctAcceptedClaims = new Set(
        captureReceipt.kind === 'committed' && captureReceipt.selection.kind === 'bundles'
          ? captureReceipt.selection.items
              .filter((item) => item.persisted && ['accepted', 'unchanged'].includes(item.state))
              .map((item) => item.claimId)
          : [],
      ).size;
      const receiptMessage = new SystemMessage(
        `Memory capture receipt for this turn: at capture commit, ${distinctAcceptedClaims} distinct accepted knowledge claims across ${counts.accepted + counts.unchanged} accepted statement occurrences; ${counts.proposed} proposed occurrences, ${counts.rejected} rejected, ${counts.not_selected} not selected. ` +
          `Accepted coverage: ${captureReceipt.acceptedCoverage}. ` +
          'These are creation-time outcomes; they do not establish current fact approval. A retained conversation is separate from accepted knowledge. Counts alone do not identify which parts were saved or confirm the whole message as knowledge. Acknowledge knowledge as saved only to the extent this receipt confirms; do not claim full saving for partial or unknown coverage.',
      );
      const all = [...facts, receiptMessage, ...messages];
      if (!isLiveCompositionalRuntimeReaderV3(reader))
        throw new Error('Engram replay-safe memory: budget_exhausted');
      if (this.returnMessages) return { variables: { [this.memoryKey]: all }, diagnostics };
      const formatted = all
        .map(
          (message) =>
            `${message._getType() === 'human' ? 'Human' : message._getType() === 'ai' ? 'AI' : 'System'}: ${message.content}`,
        )
        .join('\n');
      if (!isLiveCompositionalRuntimeReaderV3(reader))
        throw new Error('Engram replay-safe memory: budget_exhausted');
      return { variables: { [this.memoryKey]: formatted }, diagnostics };
    } finally {
      queryBudget?.dispose();
    }
  }

  async loadMemoryVariablesWithDiagnostics(
    values: InputValues,
  ): Promise<{ variables: MemoryVariables; diagnostics: MemoryLoadDiagnostics }> {
    if (this.nativeAdapterMode) return this.loadNativeMemoryVariablesV4(values);
    if (this.compositionalMode) return this.loadCompositionalMemoryVariables(values);
    if (
      this.captureLifecycle === 'replaySafeV2' &&
      (!values || typeof values !== 'object' || Array.isArray(values) || utilTypes.isProxy(values))
    )
      throw new Error('Engram replay-safe memory: current_input_required');
    if (this.fields.automaticMemory?.capturedSourceId) {
      const current =
        this.captureLifecycle === 'replaySafeV2'
          ? Object.keys(values).length === 0
            ? this.currentHumanQuery
            : readReplaySafeMessageData(values, this.inputKey || 'input')
          : this.extractInputText(values) || this.currentHumanQuery;
      if (typeof current !== 'string')
        throw new Error('Engram replay-safe memory: current_input_required');
      await this.validateCapturedHuman(current);
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
        captureLifecycle: undefined,
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
    if (this.captureLifecycle === 'replaySafeV2') {
      if (
        [inputValues, outputValues].some(
          (value) =>
            !value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value),
        )
      )
        throw new Error('Engram replay-safe memory: explicit_string_turn_required');
      const human = readReplaySafeMessageData(inputValues, this.inputKey || 'input');
      const assistant = readReplaySafeMessageData(outputValues, this.outputKey || 'output');
      if (typeof human !== 'string' || typeof assistant !== 'string')
        throw new Error('Engram replay-safe memory: explicit_string_turn_required');
      const messages: BaseMessage[] = [new HumanMessage(human)];
      if (this.policy.storeToolAudit) {
        for (const [values, keys] of [
          [
            inputValues,
            [
              'system_message',
              'systemMessage',
              'system',
              'tool_output',
              'toolOutput',
              'observation',
              'intermediateSteps',
            ],
          ],
          [outputValues, ['tool_output', 'toolOutput', 'observation', 'intermediateSteps']],
        ] as const) {
          for (const key of keys) {
            const value = readReplaySafeMessageData(values, key);
            if (value === undefined || value === null) continue;
            const bounded = cloneBoundedAutomaticCaptureJson({ value }, 'beginRequest') as {
              value: unknown;
            };
            messages.push(
              new SystemMessage(
                typeof bounded.value === 'string' ? bounded.value : JSON.stringify(bounded.value),
              ),
            );
          }
        }
      }
      messages.push(new AIMessage(assistant));
      return this.saveMessagesWithDelivery(messages);
    }
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
    if (this.captureLifecycle === 'replaySafeV2') {
      const outcome = await this.saveContextWithDelivery(inputValues, outputValues);
      if (!('extraction' in outcome))
        throw new Error('Engram replay-safe memory: unsupported_configuration');
      return outcome.extraction;
    }
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

  async saveMessagesWithDelivery(
    messages: BaseMessage[],
    nativeAdminGuard?: NativeAdminLegacyCaptureGuard,
  ): Promise<MemoryDeliveryOutcome> {
    if (this.nativeAdapterMode)
      return this.saveNativeReplaySafeMessagesV4(messages, nativeAdminGuard);
    if (this.captureLifecycle === 'replaySafeV2') {
      if (nativeAdminGuard) throw new Error('Engram replay-safe memory: unsupported_configuration');
      try {
        return await this.saveReplaySafeMessages(messages);
      } catch (error) {
        const fixed = new Set([
          'Engram replay-safe memory: invalid_current_turn',
          'Engram replay-safe memory: parent_not_authorized',
          'Engram replay-safe memory: final_not_authorized',
          'Engram replay-safe memory: budget_exhausted',
          'Engram automatic: capture_reference_mismatch',
        ]);
        throw new Error(
          error instanceof Error && fixed.has(error.message)
            ? error.message
            : 'Engram replay-safe memory: invalid_current_turn',
        );
      }
    }
    if (messages.length > 1000) throw new Error('Memory write cannot exceed 1000 messages');
    if (
      nativeAdminGuard &&
      (!nativeAdminGuard.executionId || nativeAdminGuard.executionId.trim().length === 0)
    ) {
      throw new Error('Engram automatic: legacy_cross_execution_duplicate');
    }
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
    const preparedWrites =
      automaticEnabled || this.queueMode || nativeAdminGuard
        ? this.engramHistory.prepareMessageWrites(writes)
        : undefined;
    let nativeAdminSourceIndex: number | undefined;
    if (nativeAdminGuard) {
      if (
        !automaticEnabled ||
        !automaticGraph ||
        messages.length !== 1 ||
        messageType(messages[0]) !== 'human' ||
        !preparedWrites ||
        preparedWrites.length !== 1
      ) {
        throw new Error('Engram automatic: legacy_source_conflict');
      }
      const incoming = preparedWrites[0];
      if (
        incoming.group_id !== this.groupId ||
        incoming.role !== 'human' ||
        incoming.episode_kind !== this.humanEpisodeKind ||
        !Object.prototype.hasOwnProperty.call(incoming.attributes ?? {}, AUTOMATIC_OWNER)
      ) {
        throw new Error('Engram automatic: legacy_source_conflict');
      }
      nativeAdminSourceIndex = 0;
      const locatorMatches = automaticGraph.episodes.filter(
        (episode) =>
          episode.group_id === incoming.group_id &&
          (episode.idempotency_key === incoming.idempotency_key ||
            (episode.role === 'human' &&
              incoming.source_message_id != null &&
              episode.source_message_id === incoming.source_message_id)),
      );
      if (locatorMatches.length > 1) throw new Error('Engram automatic: legacy_source_conflict');
      const existing = locatorMatches[0];
      if (existing) {
        assertNativeAdminSourceMatches(existing, incoming);
        assertNativeAdminSameExecution(existing, nativeAdminGuard.executionId);
      }
    }
    const enqueueStarted = performance.now();
    const enqueueStorage = new StorageAccumulator();
    const appendQueue = () =>
      (automaticEnabled
        ? this.storage.appendAutomaticEpisodesWithExtraction!
        : this.storage.appendEpisodesWithExtraction!
      ).call(
        this.storage,
        preparedWrites ?? this.engramHistory.prepareMessageWrites(writes),
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
    let results: AppendEpisodeResult[];
    let queued: Awaited<ReturnType<typeof appendQueue>> | null;
    try {
      queued =
        this.queueMode && writes.length > 0
          ? this.storage.withExtractionDiagnostics
            ? await this.storage.withExtractionDiagnostics(
                (value) => enqueueStorage.observe(value),
                appendQueue,
              )
            : await appendQueue()
          : null;
      results = queued
        ? queued.results
        : automaticEnabled
          ? await this.storage.appendAutomaticEpisodes!(
              preparedWrites ?? this.engramHistory.prepareMessageWrites(writes),
            )
          : await this.engramHistory.appendMessageWrites(writes);
    } catch (error) {
      if (
        nativeAdminGuard &&
        error instanceof Error &&
        (error.message.startsWith('Engram automatic memory:') ||
          error.message.includes('idempotency identifiers resolve to different existing episodes'))
      ) {
        throw new Error('Engram automatic: legacy_source_conflict');
      }
      throw error;
    }
    if (nativeAdminGuard && nativeAdminSourceIndex !== undefined) {
      const winner = results[nativeAdminSourceIndex];
      if (!winner) throw new Error('Engram automatic: legacy_source_conflict');
      assertNativeAdminSourceMatches(winner.episode, preparedWrites![nativeAdminSourceIndex]);
      if (!winner.created)
        assertNativeAdminSameExecution(winner.episode, nativeAdminGuard.executionId);
    }
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
    if (this.nativeAdapterMode) {
      this.nativeAccessV4();
      throw nativeMemoryFailure('unsupported_mode');
    }
    await this.engramHistory.clear();
  }

  private async validateCapturedHuman(content: string): Promise<void> {
    if (this.compositionalMode) {
      await this.createCompositionalReader(content);
      return;
    }
    const config = AutomaticRuntimeSchema.parse(this.fields.automaticMemory);
    if (!config.capturedSourceId || !content)
      throw new Error('Engram automatic: current_capture_input_required');
    const graph = await this.storage.readExtractionSnapshot!(this.groupId);
    const source = graph.episodes.find(
      (ep) => ep.uuid === config.capturedSourceId && ep.group_id === this.groupId,
    );
    if (this.captureLifecycle === 'replaySafeV2' && !source)
      throw new Error('Engram replay-safe memory: parent_not_authorized');
    if (source?.attributes[COMPOSITIONAL_CAPTURE_V3_OWNER_ATTRIBUTE] !== undefined)
      throw new Error('Engram replay-safe memory: unsupported_capture_version');
    if (
      source?.attributes[WRITE_OWNER_V2_ATTRIBUTE] !== undefined &&
      this.captureLifecycle !== 'replaySafeV2'
    )
      throw new Error('Engram replay-safe memory: capture_lifecycle_mismatch');
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
    if (this.captureLifecycle === 'replaySafeV2') {
      const result = await this.storage.getAutomaticCaptureOutcomeV2!({
        version: 2,
        namespace: this.groupId,
        issuer: config.actor.issuer,
        actorReference: config.actor.actorReference,
        turn: config.turnId,
        role: 'human',
      });
      if (
        result.status !== 'committed_replay' ||
        result.sourceId !== config.capturedSourceId ||
        result.currentAuthority !== 'active' ||
        result.should_process ||
        !result.receiptSummary?.persisted
      )
        throw new Error('Engram replay-safe memory: parent_not_authorized');
    }
  }

  private async flushNativePendingAuditsV4(
    state: NativeMemoryAuditStateV4,
    check: () => void,
  ): Promise<ReplaySafeMemoryWriteDiagnostics['audit']> {
    const requested = state.pendingAudits.length;
    if (requested === 0) {
      return {
        state: 'not_requested',
        requested: 0,
        confirmedNew: 0,
        confirmedExisting: 0,
        unconfirmed: 0,
        reason: null,
      };
    }
    if (!state.finalConfirmed) {
      return {
        state: 'failed',
        requested,
        confirmedNew: 0,
        confirmedExisting: 0,
        unconfirmed: 0,
        reason: 'interrupted',
      };
    }

    check();
    const opened = await openAutonomousPersonalMemoryReadV4(this, this.fields.embeddingConfig);
    if (opened.kind !== 'read_ready') {
      check();
      const reason =
        opened.reason === 'budget_exhausted' || opened.reason === 'resource_exhausted'
          ? ('budget_exhausted' as const)
          : ('authority_changed' as const);
      return {
        state: 'failed',
        requested,
        confirmedNew: 0,
        confirmedExisting: 0,
        unconfirmed: 0,
        reason,
      };
    }

    const frame = opened.frame;
    let attempted = false;
    try {
      check();
      frame.check();
      const owner = frame.owner;
      const config = frame.config;
      if (
        !owner ||
        owner !== this.storage ||
        !config ||
        config.namespace !== this.groupId ||
        frame.storage === null
      ) {
        return {
          state: 'failed',
          requested,
          confirmedNew: 0,
          confirmedExisting: 0,
          unconfirmed: 0,
          reason: 'authority_changed',
        };
      }

      const writes = this.engramHistory.prepareMessageWrites(state.pendingAudits);
      check();
      frame.check();
      attempted = true;
      const results = await owner.appendEpisodes(writes);
      check();
      frame.check();

      let confirmedNew = 0;
      let confirmedExisting = 0;
      for (let index = 0; index < Math.min(results.length, writes.length); index += 1) {
        check();
        const result = results[index];
        const expected = writes[index]!;
        const provenance = result?.episode?.attributes?.engram_message as
          | Record<string, unknown>
          | undefined;
        const expectedProvenance = expected.attributes?.engram_message as
          | Record<string, unknown>
          | undefined;
        if (
          !result ||
          typeof result.created !== 'boolean' ||
          !result.episode ||
          result.episode.group_id !== expected.group_id ||
          result.episode.role !== 'system' ||
          result.episode.episode_kind !== 'tool_output' ||
          result.episode.trust_level !== 'unverified' ||
          result.episode.review_status !== 'proposed' ||
          result.episode.source_execution_id !== null ||
          result.episode.source_workflow_id !== null ||
          result.episode.idempotency_key !== expected.idempotency_key ||
          result.episode.content !== expected.content ||
          result.episode.attributes.engram_audit !== true ||
          !provenance ||
          !expectedProvenance ||
          ['original_role', 'original_message_id', 'tool_call_id'].some(
            (key) => provenance[key] !== expectedProvenance[key],
          )
        )
          continue;
        if (result.created) confirmedNew += 1;
        else confirmedExisting += 1;
      }

      const confirmed = confirmedNew + confirmedExisting;
      const unconfirmed = requested - confirmed;
      if (unconfirmed > 0) {
        return {
          state: 'unknown',
          requested,
          confirmedNew,
          confirmedExisting,
          unconfirmed,
          reason: 'acknowledgement_unknown',
        };
      }
      state.pendingAudits = [];
      state.pendingAuditBytes = 0;
      return {
        state: 'complete',
        requested,
        confirmedNew,
        confirmedExisting,
        unconfirmed: 0,
        reason: null,
      };
    } catch (error) {
      check();
      return {
        state: attempted ? 'unknown' : 'failed',
        requested,
        confirmedNew: 0,
        confirmedExisting: 0,
        unconfirmed: attempted ? requested : 0,
        reason: attempted ? 'acknowledgement_unknown' : 'authority_changed',
      };
    } finally {
      frame.close();
    }
  }

  private async saveNativeReplaySafeMessagesV4(
    input: BaseMessage[],
    nativeAdminGuard?: NativeAdminLegacyCaptureGuard,
  ): Promise<MemoryDeliveryOutcome> {
    if (nativeAdminGuard) throw nativeMemoryFailure('unsupported_configuration');
    const access = this.nativeAccessV4();
    const state = nativeMemoryStatesV4.get(this);
    const initial = access.initialSnapshot;
    const owner = access.owner;
    if (!state || !initial || !owner || owner !== this.storage)
      throw nativeMemoryFailure('invalid_adapter');
    const config = initial.config;
    const nativeWork = nativeMemoryWork(access, config.invocationDeadlineMs);
    let trustedFailure: { readonly value: unknown } | null = null;
    const check = () => {
      if (trustedFailure) throw trustedFailure.value;
      try {
        access.checkOpen();
        nativeWork.check();
      } catch (error) {
        trustedFailure = { value: error };
        throw error;
      }
    };

    check();
    const attemptHash = MemoryProcessingAttemptHashSchema.safeParse(
      this.fields.processingAttemptHash,
    );
    if (!attemptHash.success || attemptHash.data !== initial.memoryAttemptHash)
      throw nativeMemoryFailure('unsupported_configuration');

    const { messages, roles } = ownNativeMessageBatchV4(input, check);
    const humanIndexes = roles.flatMap((role, index) => (role === 'human' ? [index] : []));
    if (humanIndexes.length > 1) throw nativeMemoryFailure('invalid_current_turn');
    const currentHuman = humanIndexes.length ? messages[humanIndexes[0]!] : undefined;
    const finalIndexes = finalAssistantIndices(messages);
    if (finalIndexes.size > 1) throw nativeMemoryFailure('invalid_current_turn');
    const selectedFinalIndex = [...finalIndexes][0];
    const auditCandidates = messages.flatMap((message, position) =>
      roles[position] !== 'human' && !finalIndexes.has(position) ? [{ message, position }] : [],
    );

    check();
    const preparedAudits = prepareReplaySafeAudits(
      this.policy.storeToolAudit ? auditCandidates : [],
      {
        version: 2,
        namespace: config.namespace,
        issuer: config.issuer,
        actorReference: config.actorReference,
        turn: config.turn,
        role: 'human',
      },
    );
    check();
    if (preparedAudits.kind !== 'prepared')
      throw nativeMemoryFailure(
        preparedAudits.reason === 'capacity' ? 'capacity' : 'invalid_current_turn',
      );

    let intent: ReturnType<typeof prepareAutonomousPersonalAssistantFinalIntentV4>;
    if (selectedFinalIndex !== undefined) {
      intent = prepareAutonomousPersonalAssistantFinalIntentV4(
        currentHuman,
        messages[selectedFinalIndex]!,
        attemptHash.data,
        config.invocationDeadlineMs,
      );
      if (intent.kind !== 'prepared')
        throw nativeMemoryFailure(
          intent.reason === 'capacity' ? 'capacity' : 'invalid_current_turn',
        );
    } else {
      intent = { kind: 'rejected', reason: 'invalid_input' };
    }
    check();

    const pendingAudits = [...state.pendingAudits];
    const pendingByKey = new Map<string, EpisodeMessageWrite>();
    for (const pending of pendingAudits) {
      const key = pending.metadata?.idempotency_key;
      if (typeof key !== 'string') throw nativeMemoryFailure('invalid_current_turn');
      pendingByKey.set(key, pending);
    }
    let pendingBytes = state.pendingAuditBytes;
    for (const write of preparedAudits.writes) {
      check();
      const key = write.metadata?.idempotency_key;
      if (typeof key !== 'string' || typeof write.message.content !== 'string')
        throw nativeMemoryFailure('invalid_current_turn');
      const existing = pendingByKey.get(key);
      if (existing) {
        if (
          existing.message.content !== write.message.content ||
          canonical(existing.metadata) !== canonical(write.metadata)
        )
          throw nativeMemoryFailure('invalid_current_turn');
        continue;
      }
      pendingByKey.set(key, write);
      pendingAudits.push(write);
      pendingBytes += Buffer.byteLength(write.message.content, 'utf8');
    }
    if (
      pendingAudits.length > REPLAY_SAFE_AUDIT_LIMITS.perSave ||
      pendingBytes > REPLAY_SAFE_AUDIT_LIMITS.aggregateBytes
    )
      throw nativeMemoryFailure('capacity');
    state.pendingAudits = pendingAudits;
    state.pendingAuditBytes = pendingBytes;

    let finalAssistant: ReplaySafeMemoryWriteDiagnostics['finalAssistant'] = {
      state: 'not_requested',
    };
    let written = 0;
    let duplicates = 0;
    let finalIntentHash: string | null = null;
    if (intent.kind === 'prepared') {
      finalIntentHash = contentHash(
        JSON.stringify({
          finalAssistant: intent.intent.finalAssistant,
          memoryAttemptHash: intent.intent.memoryAttemptHash,
          invocationDeadlineMs: intent.intent.invocationDeadlineMs,
        }),
      );
      if (state.attemptedFinal) {
        if (state.finalIntentHash !== finalIntentHash)
          throw nativeMemoryFailure('final_already_attempted');
        const observedHuman = currentHuman
          ? readReplaySafeMessageData(currentHuman, 'content')
          : undefined;
        const knownHuman =
          observedHuman === undefined ||
          observedHuman === config.currentHumanQuery ||
          (typeof observedHuman === 'string' &&
            state.finalObservationHash === contentHash(JSON.stringify(observedHuman)));
        const candidateFullWrapperBody =
          typeof observedHuman === 'string' &&
          config.sourceMapping.mode === 'application_region' &&
          !knownHuman
            ? observedHuman
            : undefined;
        if (!knownHuman && candidateFullWrapperBody === undefined)
          throw nativeMemoryFailure('invalid_current_turn');
        finalAssistant = state.finalResult ?? {
          state: 'unconfirmed',
          reason: 'acknowledgement_unknown',
        };
        if (state.finalConfirmed) {
          const exactStoredSourceMatch = await this.assertNativeParentCurrentV4(
            check,
            candidateFullWrapperBody,
          );
          if (candidateFullWrapperBody !== undefined && !exactStoredSourceMatch)
            throw nativeMemoryFailure('invalid_current_turn');
          duplicates += 1;
        } else if (!knownHuman) {
          // A stored wrapper body cannot replay an unconfirmed final attempt.
          throw nativeMemoryFailure('invalid_current_turn');
        }
        check();
      } else {
        const lineage = access.lineage;
        if (!lineage || typeof owner.saveAssistantFinalV4 !== 'function')
          throw nativeMemoryFailure('invalid_adapter');
        let invocation: Awaited<
          ReturnType<typeof issueAutonomousPersonalAssistantFinalInvocationV4>
        >;
        try {
          invocation = await issueAutonomousPersonalAssistantFinalInvocationV4(
            owner,
            lineage,
            intent.intent,
            () => access.readSnapshot(),
            nativeWork.work,
            check,
          );
        } catch (error) {
          check();
          throw error;
        }
        check();
        if (!invocation) throw nativeMemoryFailure('invalid_adapter');

        state.attemptedFinal = true;
        state.finalIntentHash = finalIntentHash;
        let saved: AutomaticAssistantFinalWriterResultV2;
        try {
          saved = await owner.saveAssistantFinalV4.call(owner, invocation);
        } catch (error) {
          check();
          finalAssistant = { state: 'unconfirmed', reason: 'acknowledgement_unknown' };
          state.finalResult = finalAssistant;
          check();
          void error;
          saved = {
            kind: 'decision',
            reason: 'acknowledgement_unknown',
            eligibleFirstCommit: false,
          };
        } finally {
          closeAutonomousPersonalAssistantFinalInvocationV4(owner, invocation);
        }

        if (saved.kind === 'decision') {
          if (
            [
              'authority_changed',
              'invalid_input',
              'conflict',
              'unsupported_mode',
              'fenced',
              'invalid_handle',
              'clock_regression',
              'cancelled_replay',
              'legacy_unconfirmed',
              'source_only_unconfirmed',
            ].includes(saved.reason)
          )
            throw nativeMemoryFailure('final_not_authorized');
          finalAssistant =
            saved.reason === 'in_progress'
              ? { state: 'deferred', reason: 'in_progress' }
              : saved.reason === 'acknowledgement_unknown'
                ? { state: 'unconfirmed', reason: 'acknowledgement_unknown' }
                : {
                    state: 'failed',
                    reason: (['capacity', 'budget_exhausted', 'interrupted'].includes(saved.reason)
                      ? saved.reason
                      : 'storage_error') as
                      | 'capacity'
                      | 'budget_exhausted'
                      | 'interrupted'
                      | 'storage_error',
                  };
          state.finalResult = finalAssistant;
        } else {
          if (saved.currentAuthority !== 'active')
            throw nativeMemoryFailure('final_not_authorized');
          finalAssistant = { state: 'persisted', terminalReceipt: saved.terminalReceipt };
          state.finalConfirmed = true;
          state.finalResult = finalAssistant;
          const observedHuman = currentHuman
            ? readReplaySafeMessageData(currentHuman, 'content')
            : undefined;
          state.finalObservationHash =
            typeof observedHuman === 'string' ? contentHash(JSON.stringify(observedHuman)) : null;
          if (saved.kind === 'committed_replay') duplicates += 1;
          else written += 1;
        }
        check();
      }
    }

    const audit = await this.flushNativePendingAuditsV4(state, check);
    written += audit.confirmedNew;
    duplicates += audit.confirmedExisting;
    check();
    const skipped = humanIndexes.length + (this.policy.storeToolAudit ? 0 : auditCandidates.length);
    return {
      extraction: new ExtractionDiagnostics().finish('disabled'),
      written,
      duplicates,
      audit: audit.confirmedNew + audit.confirmedExisting,
      skipped,
      replaySafe: ReplaySafeMemoryWriteDiagnosticsSchema.parse({
        version: 2,
        should_process: false,
        finalAssistant,
        audit,
      }),
    };
  }

  private async saveReplaySafeMessages(input: BaseMessage[]): Promise<MemoryWriteOutcome> {
    const fail = (): never => {
      throw new Error('Engram replay-safe memory: invalid_current_turn');
    };
    if (utilTypes.isProxy(input) || !Array.isArray(input) || input.length > 1000) fail();
    const runtime = AutomaticRuntimeSchema.parse(this.fields.automaticMemory);
    const policy = ExtractionPolicySchema.parse(this.fields.extractionPolicy);
    const expires = performance.now() + policy.deadline_ms;
    const check = () => {
      if (performance.now() >= expires)
        throw new Error('Engram replay-safe memory: budget_exhausted');
    };
    const messages: BaseMessage[] = [];
    const roles: string[] = [];
    for (let index = 0; index < input.length; index++) {
      check();
      const entry = Object.getOwnPropertyDescriptor(input, String(index));
      if (
        !entry ||
        !('value' in entry) ||
        !entry.value ||
        typeof entry.value !== 'object' ||
        utilTypes.isProxy(entry.value)
      )
        return fail();
      const message = entry.value as BaseMessage;
      const role = readReplaySafeMessageRole(message);
      const content = readReplaySafeMessageData(message, 'content');
      if (
        (role === 'human' || role === 'ai') &&
        typeof content === 'string' &&
        content.length > 65536
      )
        fail();
      if (role === 'ai')
        cloneBoundedAutomaticCaptureJson(
          {
            calls: readReplaySafeMessageData(message, 'tool_calls') ?? null,
            additional: readReplaySafeMessageData(message, 'additional_kwargs') ?? {},
            content: typeof content === 'string' ? content : (content ?? null),
          },
          'beginRequest',
        );
      for (const field of ['name', 'tool_call_id']) {
        const value = readReplaySafeMessageData(message, field);
        if (value !== undefined && (typeof value !== 'string' || value.length > 512)) fail();
      }
      messages.push(message);
      roles.push(role);
    }
    const humans = roles.flatMap((role, index) => (role === 'human' ? [index] : []));
    if (humans.length > 1) fail();
    const currentHuman = humans.length
      ? readReplaySafeMessageData(messages[humans[0]], 'content')
      : this.currentHumanQuery;
    if (typeof currentHuman !== 'string' || !currentHuman) return fail();
    const finals = finalAssistantIndices(messages);
    if (finals.size > 1) fail();
    const selected = [...finals][0];
    const audits = messages.flatMap((message, position) =>
      roles[position] !== 'human' && !finals.has(position) ? [{ message, position }] : [],
    );
    const preparedAudits = prepareReplaySafeAudits(this.policy.storeToolAudit ? audits : [], {
      version: 2,
      namespace: this.groupId,
      issuer: runtime.actor.issuer,
      actorReference: runtime.actor.actorReference,
      turn: runtime.turnId,
      role: 'human',
    });
    if (preparedAudits.kind === 'rejected' && preparedAudits.reason !== 'capacity') fail();
    const translated =
      selected === undefined
        ? null
        : prepareReplaySafeAssistantIntent(
            runtime,
            currentHuman,
            messages[selected],
            this.fields.processingAttemptHash!,
            policy.deadline_ms,
          );
    if (translated?.kind === 'rejected') fail();
    check();
    await this.validateCapturedHuman(currentHuman);
    let finalAssistant: ReplaySafeMemoryWriteDiagnostics['finalAssistant'] = {
      state: 'not_requested',
    };
    let written = 0;
    let duplicates = 0;
    if (translated?.kind === 'prepared') {
      check();
      let saved;
      const remainingMs = Math.floor(expires - performance.now());
      try {
        saved =
          remainingMs <= 0
            ? {
                kind: 'decision' as const,
                reason: 'budget_exhausted' as const,
                eligibleFirstCommit: false as const,
              }
            : await this.storage.saveAssistantFinalV2!(translated.intent, { remainingMs });
      } catch {
        saved = {
          kind: 'decision' as const,
          reason: 'acknowledgement_unknown' as const,
          eligibleFirstCommit: false as const,
        };
      }
      if (saved.kind === 'decision') {
        if (
          [
            'authority_changed',
            'invalid_input',
            'conflict',
            'unsupported_mode',
            'fenced',
            'invalid_handle',
            'clock_regression',
            'cancelled_replay',
            'legacy_unconfirmed',
            'source_only_unconfirmed',
          ].includes(saved.reason)
        )
          throw new Error('Engram replay-safe memory: final_not_authorized');
        finalAssistant =
          saved.reason === 'in_progress'
            ? { state: 'deferred', reason: 'in_progress' }
            : saved.reason === 'acknowledgement_unknown'
              ? { state: 'unconfirmed', reason: 'acknowledgement_unknown' }
              : {
                  state: 'failed',
                  reason: ['capacity', 'budget_exhausted', 'interrupted'].includes(saved.reason)
                    ? (saved.reason as 'capacity' | 'budget_exhausted' | 'interrupted')
                    : 'storage_error',
                };
      } else {
        if (saved.currentAuthority !== 'active')
          throw new Error('Engram replay-safe memory: final_not_authorized');
        finalAssistant = { state: 'persisted', terminalReceipt: saved.terminalReceipt };
        if (saved.kind === 'committed_replay') duplicates++;
        else written++;
      }
    }
    let audit: ReplaySafeMemoryWriteDiagnostics['audit'] = {
      state: 'not_requested',
      requested: 0,
      confirmedNew: 0,
      confirmedExisting: 0,
      unconfirmed: 0,
      reason: null,
    };
    if (preparedAudits.kind === 'rejected') {
      audit = {
        ...audit,
        state: 'failed',
        requested: preparedAudits.requested,
        reason: 'capacity',
      };
    } else if (preparedAudits.requested) {
      audit = { ...audit, requested: preparedAudits.requested };
      if (
        finalAssistant.state === 'failed' ||
        finalAssistant.state === 'unconfirmed' ||
        finalAssistant.state === 'deferred'
      ) {
        audit = { ...audit, state: 'failed', reason: 'interrupted' };
      } else {
        let attempted = false;
        try {
          check();
          await this.validateCapturedHuman(currentHuman);
          check();
          attempted = true;
          const results = await this.engramHistory.appendMessageWrites(preparedAudits.writes);
          if (!Array.isArray(results) || results.length > preparedAudits.requested)
            throw new Error('Engram replay-safe memory: acknowledgement_unknown');
          let created = 0;
          let existing = 0;
          for (let index = 0; index < results.length; index++) {
            const result = results[index];
            const expected = preparedAudits.writes[index];
            const provenance = result?.episode?.attributes?.engram_message as
              | Record<string, unknown>
              | undefined;
            const expectedProvenance = expected.metadata!.attributes!.engram_message as Record<
              string,
              unknown
            >;
            if (
              !result ||
              typeof result.created !== 'boolean' ||
              !result.episode ||
              !result.episode.attributes ||
              result.episode.group_id !== this.groupId ||
              result.episode.role !== 'system' ||
              result.episode.episode_kind !== 'tool_output' ||
              result.episode.trust_level !== 'unverified' ||
              result.episode.review_status !== 'proposed' ||
              result.episode.source_execution_id !== null ||
              result.episode.source_workflow_id !== null ||
              result.episode.idempotency_key !== expected.metadata!.idempotency_key ||
              result.episode.content !== expected.message.content ||
              result.episode.attributes.engram_audit !== true ||
              !provenance ||
              ['original_role', 'original_message_id', 'tool_call_id'].some(
                (key) => provenance[key] !== expectedProvenance[key],
              )
            )
              continue;
            if (result.created) created++;
            else existing++;
          }
          const confirmed = created + existing;
          // A missing or mismatched acknowledgement cannot establish absence
          // of a write. Keep every unverified requested audit explicitly unknown.
          const unknown = preparedAudits.requested - confirmed;
          audit = {
            ...audit,
            state: unknown ? 'unknown' : 'complete',
            confirmedNew: created,
            confirmedExisting: existing,
            unconfirmed: unknown,
            reason: unknown ? 'acknowledgement_unknown' : null,
          };
          written += created;
          duplicates += existing;
        } catch (error) {
          if (
            !attempted &&
            finalAssistant.state === 'not_requested' &&
            !(
              error instanceof Error &&
              error.message === 'Engram replay-safe memory: budget_exhausted'
            )
          )
            throw new Error('Engram replay-safe memory: parent_not_authorized');
          audit = {
            ...audit,
            state: attempted ? 'unknown' : 'failed',
            unconfirmed: attempted ? preparedAudits.requested : 0,
            reason: attempted
              ? 'acknowledgement_unknown'
              : error instanceof Error &&
                  error.message === 'Engram replay-safe memory: budget_exhausted'
                ? 'budget_exhausted'
                : 'authority_changed',
          };
        }
      }
    }
    return {
      extraction: new ExtractionDiagnostics().finish('disabled'),
      written,
      duplicates,
      audit: audit.confirmedNew + audit.confirmedExisting,
      skipped: humans.length + (this.policy.storeToolAudit ? 0 : audits.length),
      replaySafe: ReplaySafeMemoryWriteDiagnosticsSchema.parse({
        version: 2,
        should_process: false,
        finalAssistant,
        audit,
      }),
    };
  }

  /**
   * Search the knowledge graph for facts relevant to the current input.
   * Uses HybridSearchEngine which merges text + vector results via RRF when embeddings are enabled.
   */
  private async getRelevantFacts(
    query: string,
    read?: {
      storage: IGraphStorage;
      engine: HybridSearchEngine;
      reader: CompositionalRuntimeReaderV3;
    },
  ): Promise<SystemMessage[]> {
    if (!query.trim()) return [];

    try {
      const automatic = read
        ? getCompositionalRuntimeAutomaticReadContextV3(read.reader)
        : { conflicts: { remaining: 128 }, sources: { remaining: 512, deferred: 0 } };
      if (!automatic) throw new Error('Engram replay-safe memory: budget_exhausted');
      const engine = read?.engine ?? this.searchEngine,
        storage = read?.storage ?? this.storage;
      const results = await engine.search(query, this.groupId, {
        automaticBudget: automatic,
        limit: this.maxFactsPerQuery,
        minScore: this.minRelevanceScore,
        acceptedOnly: this.acceptedOnlyRetrieval,
        retrievalFilters: this.retrievalFilters,
        ...(read ? { compositionalReader: read.reader, hydrationBudget: automatic.sources } : {}),
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
      let contextText = engine.formatAsContext(
        results,
        searchBudget,
        this.includeProvenanceInContext,
      );

      // Enrich with shallow BFS traversal from matched entities
      if (this.enableTraversal && results.entities.length > 0) {
        try {
          const seedUuids = results.entities.map((r) => r.entity.uuid);
          const traverser = new GraphTraverser();
          const traversal = await traverser.traverse(storage, seedUuids, {
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
            const governedEdges = await engine.governTraversalEdges(
              traversal.edges,
              filters,
              undefined,
              automatic,
              ...(read ? ([read.reader] as const) : ([] as const)),
            );
            const traversalContext = engine.formatAsContext(
              { entities: [], edges: governedEdges },
              traversalBudget,
              this.includeProvenanceInContext,
            );
            if (traversalContext) {
              contextText += (contextText ? '\n\n' : '') + traversalContext;
            }
          }
        } catch (err) {
          if (read) throw new Error('Engram replay-safe memory: budget_exhausted');
          console.warn('Engram: Traversal enrichment failed:', (err as Error).message);
        }
      }

      if (!contextText) return [];

      if (read && !isLiveCompositionalRuntimeReaderV3(read.reader))
        throw new Error('Engram replay-safe memory: budget_exhausted');
      return [new SystemMessage(prefix + contextText)];
    } catch (error) {
      if (read) throw new Error('Engram replay-safe memory: budget_exhausted');
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
