import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EpisodicNode } from '../schemas';

/**
 * Chat message history backed by Engram's graph storage.
 * Stores each message as an EpisodicNode, chained via previous_episode_uuid.
 */
export class EngramChatMessageHistory extends BaseChatMessageHistory {
	lc_namespace = ['engram', 'memory'];

	private storage: IGraphStorage;
	private groupId: string;
	private lastEpisodeUuid: string | null = null;
	private contextWindow: number;

	constructor(params: {
		storage: IGraphStorage;
		groupId: string;
		contextWindow?: number;
	}) {
		super();
		this.storage = params.storage;
		this.groupId = params.groupId;
		this.contextWindow = params.contextWindow ?? 10;
	}

	async getMessages(): Promise<BaseMessage[]> {
		const episodes = await this.storage.getRecentEpisodes(
			this.groupId,
			this.contextWindow,
		);

		// Track the last episode for chaining
		if (episodes.length > 0) {
			this.lastEpisodeUuid = episodes[episodes.length - 1].uuid;
		}

		return episodes.map((ep) => this.episodeToMessage(ep));
	}

	async addMessage(message: BaseMessage): Promise<void> {
		const role = this.messageToRole(message);
		const content =
			typeof message.content === 'string'
				? message.content
				: JSON.stringify(message.content);

		const episode = await this.storage.addEpisode({
			group_id: this.groupId,
			content,
			role,
			reference_time: new Date().toISOString(),
			previous_episode_uuid: this.lastEpisodeUuid,
		});

		this.lastEpisodeUuid = episode.uuid;
	}

	async addUserMessage(message: string): Promise<void> {
		await this.addMessage(new HumanMessage(message));
	}

	async addAIChatMessage(message: string): Promise<void> {
		await this.addMessage(new AIMessage(message));
	}

	async clear(): Promise<void> {
		await this.storage.clearGroup(this.groupId);
		this.lastEpisodeUuid = null;
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
