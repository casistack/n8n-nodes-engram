import { ExtractionDiagnostics } from '../extraction/ExtractionDiagnostics';
import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import {
  MemoryPolicySchema,
  type MemoryPolicyInput,
  type MemoryWriteOutcome,
  type MemoryDeliveryOutcome,
  type HistoryReadDiagnostics,
} from '../schemas';
import { selectHistory } from './HistorySelection';
import { isToolCall, messageType } from './MessagePolicy';
import type { AppendEpisodeResult, IGraphStorage } from '../storage/IGraphStorage';
import type { CreateEpisodicNode, EpisodicNode } from '../schemas';
import type { CompositionalRuntimeReaderV3 } from '../schemas/CompositionalRuntimeReaderV3.schema';
import {
  getCompositionalRuntimeHistoryDataV3,
  isLiveCompositionalRuntimeReaderV3,
} from '../search/CompositionalRuntimeReaderV3';

export type EpisodeWriteMetadata = Partial<
  Pick<
    CreateEpisodicNode,
    | 'episode_kind'
    | 'source_type'
    | 'source_message_id'
    | 'idempotency_key'
    | 'conversation_id'
    | 'sender_id'
    | 'sender_name'
    | 'quoted_message_id'
    | 'trust_level'
    | 'confidence'
    | 'review_status'
    | 'source_workflow_id'
    | 'source_execution_id'
    | 'attributes'
  >
>;

export type HumanEpisodeKind = 'active_human' | 'passive_human';

export interface EpisodeMessageWrite {
  message: BaseMessage;
  metadata?: EpisodeWriteMetadata;
}

/**
 * Chat message history backed by Engram's graph storage.
 * Stores each message as an EpisodicNode, chained via previous_episode_uuid.
 */
export class EngramChatMessageHistory extends BaseChatMessageHistory {
  lc_namespace = ['engram', 'memory'];

  private storage: IGraphStorage;
  private groupId: string;
  private contextWindow: number;
  private metadata: EpisodeWriteMetadata;
  private humanEpisodeKind: HumanEpisodeKind;
  private policy: ReturnType<typeof MemoryPolicySchema.parse>;
  private turnWriter?: (messages: BaseMessage[]) => Promise<MemoryDeliveryOutcome>;
  private deliveryOnly = false;
  private excludedSourceId?: string;
  private readGuard?: () => Promise<void>;
  private compositionalReadProvider?: () => Promise<CompositionalRuntimeReaderV3>;
  private snapshotReadProvider?: () => Promise<{
    messages: BaseMessage[];
    history: HistoryReadDiagnostics;
  }>;
  excludeCurrentSource(uuid: string): void {
    this.excludedSourceId = uuid;
  }

  constructor(params: {
    storage: IGraphStorage;
    groupId: string;
    contextWindow?: number;
    metadata?: EpisodeWriteMetadata;
    humanEpisodeKind?: HumanEpisodeKind;
    policy?: MemoryPolicyInput;
  }) {
    super();
    this.storage = params.storage;
    this.groupId = params.groupId;
    this.contextWindow = params.contextWindow ?? 10;
    this.metadata = params.metadata ?? {};
    this.policy = MemoryPolicySchema.parse(params.policy ?? {});
    if (
      (this.policy.historyFilter !== 'off' || this.policy.finalTurnWrites) &&
      (!Number.isInteger(this.contextWindow) ||
        this.contextWindow < 1 ||
        this.contextWindow > 10000)
    )
      throw new Error('Context window must be an integer between 1 and 10000');
    this.humanEpisodeKind = params.humanEpisodeKind ?? 'active_human';
  }

  setTurnWriter(
    writer: (messages: BaseMessage[]) => Promise<MemoryDeliveryOutcome>,
    deliveryOnly = false,
  ): void {
    this.turnWriter = writer;
    this.deliveryOnly = deliveryOnly;
  }

  /** Optional current-parent validation for captured-turn context reads. */
  setReadGuard(guard: () => Promise<void>): void {
    this.readGuard = guard;
  }

  /** Internal provider must perform the fixed current-parent check before returning its reader. */
  setCompositionalReadProvider(provider: () => Promise<CompositionalRuntimeReaderV3>): void {
    this.compositionalReadProvider = provider;
  }

  /** Internal fixed native read delegate; when present it owns the whole conversation read. */
  setSnapshotReadProvider(
    provider: () => Promise<{ messages: BaseMessage[]; history: HistoryReadDiagnostics }>,
  ): void {
    this.snapshotReadProvider = provider;
  }

  async getMessages(): Promise<BaseMessage[]> {
    return (await this.getMessagesWithDiagnostics()).messages;
  }

  async getMessagesWithDiagnostics(): Promise<{
    messages: BaseMessage[];
    history: HistoryReadDiagnostics;
  }> {
    if (this.snapshotReadProvider) return this.snapshotReadProvider();
    if (this.readGuard) await this.readGuard();
    const filtering = this.policy.historyFilter !== 'off' || this.policy.finalTurnWrites;
    const limit =
      (filtering ? this.policy.maxHistoryScan + 1 : this.contextWindow) +
      (this.excludedSourceId ? 1 : 0);
    let snapshotReader: CompositionalRuntimeReaderV3 | undefined;
    let recent: readonly EpisodicNode[];
    const checkSnapshot = () => {
      if (snapshotReader && !isLiveCompositionalRuntimeReaderV3(snapshotReader))
        throw new Error('Engram compositional history: snapshot_not_authorized');
    };
    if (this.compositionalReadProvider) {
      snapshotReader = await this.compositionalReadProvider();
      checkSnapshot();
      const data = getCompositionalRuntimeHistoryDataV3(snapshotReader, {
        namespace: this.groupId,
        limit,
      });
      if (data.status !== 'history_data')
        throw new Error('Engram compositional history: snapshot_not_authorized');
      recent = data.episodes;
    } else {
      recent = await this.storage.getRecentEpisodes(this.groupId, limit);
    }
    // Detach immediately: mutations during later processing cannot change this read's evidence.
    const episodes = JSON.parse(JSON.stringify(recent)) as EpisodicNode[];
    checkSnapshot();
    if (this.excludedSourceId) {
      const index = episodes.findIndex((episode) => episode.uuid === this.excludedSourceId);
      if (index >= 0) episodes.splice(index, 1);
      if (!filtering && episodes.length > this.contextWindow)
        episodes.splice(0, episodes.length - this.contextWindow);
    }
    if (!filtering) {
      const result = {
        messages: episodes.map((ep) => this.episodeToMessage(ep)),
        history: {
          mode: 'off' as const,
          fetched: episodes.length,
          examined: episodes.length,
          pages: episodes.length ? 1 : 0,
          returned: episodes.length,
          excluded_provenance: 0,
          excluded_legacy: 0,
          legacy_candidates: 0,
          snapshot_overflow: false,
          scan_truncated: false,
        },
      };
      checkSnapshot();
      return result;
    }
    const result = selectHistory(episodes, this.contextWindow, this.policy);
    const formatted = {
      messages: result.episodes.map((ep) => this.episodeToMessage(ep)),
      history: result.diagnostics,
    };
    checkSnapshot();
    return formatted;
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    await this.addMessagesWithDelivery(messages);
  }

  async addMessagesWithOutcome(messages: BaseMessage[]): Promise<MemoryWriteOutcome> {
    if (this.deliveryOnly) throw new Error('Engram queue: use_delivery_outcome');
    return (await this.addMessagesWithDelivery(messages)) as MemoryWriteOutcome;
  }

  async addMessagesWithDelivery(messages: BaseMessage[]): Promise<MemoryDeliveryOutcome> {
    if (this.turnWriter) return this.turnWriter(messages);
    const results = await this.appendMessageWrites(messages.map((message) => ({ message })));
    return {
      extraction: new ExtractionDiagnostics().finish('disabled'),
      written: results.filter((r) => r.created).length,
      duplicates: results.filter((r) => !r.created).length,
      audit: 0,
      skipped: 0,
    };
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.addMessages([message]);
  }

  async addMessageAndGetEpisodeUuid(message: BaseMessage): Promise<string> {
    return (await this.addMessageAndGetEpisode(message)).uuid;
  }

  async addMessageAndGetEpisode(
    message: BaseMessage,
    metadata: EpisodeWriteMetadata = {},
  ): Promise<EpisodicNode> {
    return (await this.addMessagesAndGetEpisodes([{ message, metadata }]))[0];
  }

  async addMessagesAndGetEpisodes(writes: EpisodeMessageWrite[]): Promise<EpisodicNode[]> {
    return (await this.appendMessageWrites(writes)).map((result) => result.episode);
  }

  async appendMessageWrites(writes: EpisodeMessageWrite[]): Promise<AppendEpisodeResult[]> {
    if (writes.length === 0) return [];
    const inputs = this.prepareMessageWrites(writes);
    return this.storage.appendEpisodes(inputs);
  }

  prepareMessageWrites(writes: EpisodeMessageWrite[]): CreateEpisodicNode[] {
    return writes.map(({ message, metadata = {} }) =>
      this.messageToEpisodeInput(message, metadata),
    );
  }

  private messageToEpisodeInput(
    message: BaseMessage,
    metadata: EpisodeWriteMetadata,
  ): CreateEpisodicNode {
    const role = this.messageToRole(message);
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

    const originalType = messageType(message);
    const tool = originalType === 'tool' || originalType === 'function' || isToolCall(message);
    const episodeKind =
      metadata.episode_kind ??
      (tool
        ? 'tool_output'
        : role === 'human'
          ? this.humanEpisodeKind
          : role === 'ai'
            ? 'assistant_reply'
            : 'system');
    return {
      trust_level: tool ? 'unverified' : 'standard',
      review_status: tool ? 'proposed' : 'accepted',
      ...this.metadata,
      ...metadata,
      group_id: this.groupId,
      content,
      role,
      episode_kind: episodeKind,
      reference_time: new Date().toISOString(),
    };
  }

  async addUserMessage(message: string): Promise<void> {
    await this.addMessage(new HumanMessage(message));
  }

  async addAIMessage(message: string): Promise<void> {
    await this.addMessage(new AIMessage(message));
  }

  // Alias for backward compatibility with langchain 0.2.x
  async addAIChatMessage(message: string): Promise<void> {
    await this.addAIMessage(message);
  }

  async clear(): Promise<void> {
    await this.storage.clearGroup(this.groupId);
  }

  private episodeToMessage(episode: EpisodicNode): BaseMessage {
    switch (episode.role) {
      case 'human':
        return new HumanMessage(episode.content);
      case 'ai':
        return new AIMessage(episode.content);
      case 'system':
        return new SystemMessage(episode.content);
      default:
        return new HumanMessage(episode.content);
    }
  }

  private messageToRole(message: BaseMessage): 'human' | 'ai' | 'system' {
    const type = message._getType();
    switch (type) {
      case 'human':
        return 'human';
      case 'ai':
        return 'ai';
      case 'system':
        return 'system';
      case 'tool':
      case 'function':
        return 'ai';
      default:
        return 'system';
    }
  }
}
