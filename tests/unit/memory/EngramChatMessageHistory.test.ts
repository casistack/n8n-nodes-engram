import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { EngramChatMessageHistory } from '../../../src/memory/EngramChatMessageHistory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('EngramChatMessageHistory', () => {
	let storage: GraphologyStorage;
	let history: EngramChatMessageHistory;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		history = new EngramChatMessageHistory({
			storage,
			groupId: 'test-session',
			contextWindow: 10,
		});
	});

	afterEach(async () => {
		await storage.close();
	});

	it('should start with empty messages', async () => {
		const messages = await history.getMessages();
		expect(messages).toEqual([]);
	});

	it('should add and retrieve a user message', async () => {
		await history.addUserMessage('Hello, who am I?');
		const messages = await history.getMessages();

		expect(messages).toHaveLength(1);
		expect(messages[0]).toBeInstanceOf(HumanMessage);
		expect(messages[0].content).toBe('Hello, who am I?');
	});

	it('should add and retrieve an AI message', async () => {
		await history.addAIChatMessage('You are Alice.');
		const messages = await history.getMessages();

		expect(messages).toHaveLength(1);
		expect(messages[0]).toBeInstanceOf(AIMessage);
		expect(messages[0].content).toBe('You are Alice.');
	});

	it('should add a BaseMessage directly', async () => {
		await history.addMessage(new SystemMessage('You are a helpful assistant.'));
		const messages = await history.getMessages();

		expect(messages).toHaveLength(1);
		expect(messages[0]).toBeInstanceOf(SystemMessage);
		expect(messages[0].content).toBe('You are a helpful assistant.');
	});

	it('should maintain conversation order', async () => {
		await history.addUserMessage('Hi');
		await history.addAIChatMessage('Hello! How can I help?');
		await history.addUserMessage('Tell me about Berlin');
		await history.addAIChatMessage('Berlin is the capital of Germany.');

		const messages = await history.getMessages();

		expect(messages).toHaveLength(4);
		expect(messages[0].content).toBe('Hi');
		expect(messages[1].content).toBe('Hello! How can I help?');
		expect(messages[2].content).toBe('Tell me about Berlin');
		expect(messages[3].content).toBe('Berlin is the capital of Germany.');
	});

	it('should respect context window limit', async () => {
		const smallHistory = new EngramChatMessageHistory({
			storage,
			groupId: 'test-session-small',
			contextWindow: 3,
		});

		await smallHistory.addUserMessage('Message 1');
		await smallHistory.addAIChatMessage('Response 1');
		await smallHistory.addUserMessage('Message 2');
		await smallHistory.addAIChatMessage('Response 2');
		await smallHistory.addUserMessage('Message 3');

		const messages = await smallHistory.getMessages();

		// Should only return the 3 most recent in chronological order
		expect(messages).toHaveLength(3);
		expect(messages[0].content).toBe('Message 2');
		expect(messages[1].content).toBe('Response 2');
		expect(messages[2].content).toBe('Message 3');
	});

	it('should chain episodes via previous_episode_uuid', async () => {
		await history.addUserMessage('First');
		await history.addAIChatMessage('Second');

		const episodes = await storage.getRecentEpisodes('test-session', 10);
		expect(episodes).toHaveLength(2);
		expect(episodes[0].previous_episode_uuid).toBeNull();
		expect(episodes[1].previous_episode_uuid).toBe(episodes[0].uuid);
	});

	it('should clear all messages for the group', async () => {
		await history.addUserMessage('To be cleared');
		await history.addAIChatMessage('Also cleared');

		await history.clear();
		const messages = await history.getMessages();
		expect(messages).toEqual([]);
	});

	it('should isolate messages by group_id', async () => {
		const historyA = new EngramChatMessageHistory({
			storage,
			groupId: 'user-alice',
		});
		const historyB = new EngramChatMessageHistory({
			storage,
			groupId: 'user-bob',
		});

		await historyA.addUserMessage('I am Alice');
		await historyB.addUserMessage('I am Bob');

		const aliceMessages = await historyA.getMessages();
		const bobMessages = await historyB.getMessages();

		expect(aliceMessages).toHaveLength(1);
		expect(aliceMessages[0].content).toBe('I am Alice');
		expect(bobMessages).toHaveLength(1);
		expect(bobMessages[0].content).toBe('I am Bob');
	});
});
