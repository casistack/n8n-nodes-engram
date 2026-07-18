import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { IGraphStorage } from '../storage/IGraphStorage';
import type { CreateEpisodicNode, EpisodicNode } from '../schemas';

export type EpisodeWriteMetadata = Partial<
  Pick<
    CreateEpisodicNode,
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

  constructor(params: {
    storage: IGraphStorage;
    groupId: string;
    contextWindow?: number;
    metadata?: EpisodeWriteMetadata;
    humanEpisodeKind?: HumanEpisodeKind;
  }) {
    super();
    this.storage = params.storage;
    this.groupId = params.groupId;
    this.contextWindow = params.contextWindow ?? 10;
    this.metadata = params.metadata ?? {};
    this.humanEpisodeKind = params.humanEpisodeKind ?? 'active_human';
  }

  async getMessages(): Promise<BaseMessage[]> {
    const episodes = await this.storage.getRecentEpisodes(this.groupId, this.contextWindow);
    return episodes.map((ep) => this.episodeToMessage(ep));
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.addMessageAndGetEpisodeUuid(message);
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
    if (writes.length === 0) return [];
    const inputs = writes.map(({ message, metadata = {} }) =>
      this.messageToEpisodeInput(message, metadata),
    );
    const results = await this.storage.appendEpisodes(inputs);
    return results.map((result) => result.episode);
  }

  private messageToEpisodeInput(
    message: BaseMessage,
    metadata: EpisodeWriteMetadata,
  ): CreateEpisodicNode {
    const role = this.messageToRole(message);
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

    const episodeKind =
      role === 'human' ? this.humanEpisodeKind : role === 'ai' ? 'assistant_reply' : 'system';
    return {
      trust_level: 'standard',
      review_status: 'accepted',
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
      default:
        return 'human';
    }
  }
}
