import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('EngramChatMemory', () => {
	let storage: GraphologyStorage;
	let memory: EngramChatMemory;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		memory = new EngramChatMemory({
			storage,
			groupId: 'test-session',
			contextWindow: 10,
			maxFactsPerQuery: 5,
			minRelevanceScore: 0.3,
		});
	});

	afterEach(async () => {
		await storage.close();
	});

	describe('memoryKeys', () => {
		it('should return default memory key', () => {
			expect(memory.memoryKeys).toEqual(['chat_history']);
		});

		it('should use custom memory key', async () => {
			const customMemory = new EngramChatMemory({
				storage,
				groupId: 'test',
				memoryKey: 'custom_history',
			});
			expect(customMemory.memoryKeys).toEqual(['custom_history']);
		});
	});

	describe('loadMemoryVariables', () => {
		it('should return empty array for fresh memory', async () => {
			const result = await memory.loadMemoryVariables({});
			expect(result.chat_history).toEqual([]);
		});

		it('should return messages after saveContext', async () => {
			await memory.saveContext(
				{ input: 'Hello' },
				{ output: 'Hi there!' },
			);

			const result = await memory.loadMemoryVariables({});
			const messages = result.chat_history;

			expect(messages).toHaveLength(2);
			expect(messages[0]).toBeInstanceOf(HumanMessage);
			expect(messages[0].content).toBe('Hello');
			expect(messages[1]).toBeInstanceOf(AIMessage);
			expect(messages[1].content).toBe('Hi there!');
		});

		it('should include relevant facts as SystemMessage when graph has data', async () => {
			// Seed graph with entities and edges
			const alice = await storage.addEntity({
				name: 'Alice',
				group_id: 'test-session',
				summary: 'A software engineer',
				entity_type: 'person',
			});
			const company = await storage.addEntity({
				name: 'Acme Corp',
				group_id: 'test-session',
				summary: 'A tech company',
				entity_type: 'organization',
			});
			await storage.addEdge({
				group_id: 'test-session',
				source_node_uuid: alice.uuid,
				target_node_uuid: company.uuid,
				name: 'WORKS_AT',
				fact: 'Alice works at Acme Corp as a senior engineer',
			});

			// Now query with relevant text
			const result = await memory.loadMemoryVariables({
				input: 'Where does Alice work?',
			});

			const messages = result.chat_history;
			// Should have a SystemMessage with facts
			const systemMessages = messages.filter(
				(m: any) => m instanceof SystemMessage,
			);
			expect(systemMessages.length).toBeGreaterThanOrEqual(1);
			expect(systemMessages[0].content).toContain('Alice');
			expect(systemMessages[0].content).toContain('Acme Corp');
		});

		it('should return string format when returnMessages is false', async () => {
			const stringMemory = new EngramChatMemory({
				storage,
				groupId: 'test-string',
				returnMessages: false,
			});

			await stringMemory.saveContext(
				{ input: 'Hello' },
				{ output: 'Hi!' },
			);

			const result = await stringMemory.loadMemoryVariables({});
			expect(typeof result.chat_history).toBe('string');
			expect(result.chat_history).toContain('Human: Hello');
			expect(result.chat_history).toContain('AI: Hi!');
		});
	});

	describe('saveContext', () => {
		it('should save human and AI messages as episodes', async () => {
			await memory.saveContext(
				{ input: 'What is TypeScript?' },
				{ output: 'TypeScript is a typed superset of JavaScript.' },
			);

			const episodes = await storage.getRecentEpisodes('test-session', 10);
			expect(episodes).toHaveLength(2);
			expect(episodes[0].role).toBe('human');
			expect(episodes[0].content).toBe('What is TypeScript?');
			expect(episodes[1].role).toBe('ai');
			expect(episodes[1].content).toBe(
				'TypeScript is a typed superset of JavaScript.',
			);
		});

		it('should chain multiple conversation turns', async () => {
			await memory.saveContext(
				{ input: 'Turn 1' },
				{ output: 'Response 1' },
			);
			await memory.saveContext(
				{ input: 'Turn 2' },
				{ output: 'Response 2' },
			);

			const episodes = await storage.getRecentEpisodes('test-session', 10);
			expect(episodes).toHaveLength(4);

			// Each should chain to the previous
			expect(episodes[0].previous_episode_uuid).toBeNull();
			expect(episodes[1].previous_episode_uuid).toBe(episodes[0].uuid);
			expect(episodes[2].previous_episode_uuid).toBe(episodes[1].uuid);
			expect(episodes[3].previous_episode_uuid).toBe(episodes[2].uuid);
		});
	});

	describe('clear', () => {
		it('should clear all messages', async () => {
			await memory.saveContext(
				{ input: 'Hello' },
				{ output: 'World' },
			);

			await memory.clear();

			const result = await memory.loadMemoryVariables({});
			expect(result.chat_history).toEqual([]);
		});
	});

	describe('group isolation', () => {
		it('should isolate memory by group_id', async () => {
			const memoryA = new EngramChatMemory({
				storage,
				groupId: 'group-a',
			});
			const memoryB = new EngramChatMemory({
				storage,
				groupId: 'group-b',
			});

			await memoryA.saveContext(
				{ input: 'I am in group A' },
				{ output: 'Noted, group A' },
			);
			await memoryB.saveContext(
				{ input: 'I am in group B' },
				{ output: 'Noted, group B' },
			);

			const resultA = await memoryA.loadMemoryVariables({});
			const resultB = await memoryB.loadMemoryVariables({});

			expect(resultA.chat_history).toHaveLength(2);
			expect(resultA.chat_history[0].content).toBe('I am in group A');

			expect(resultB.chat_history).toHaveLength(2);
			expect(resultB.chat_history[0].content).toBe('I am in group B');
		});
	});
});
