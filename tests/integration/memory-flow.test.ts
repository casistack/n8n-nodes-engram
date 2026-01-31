/**
 * Integration test: End-to-end memory flow
 *
 * Tests the full lifecycle of Engram memory as used by an n8n AI agent:
 * 1. Save conversation context (human + AI messages)
 * 2. Load memory variables (facts + history)
 * 3. Search the knowledge graph
 * 4. Verify episode chaining
 * 5. Context window limits
 * 6. Retention policies
 */
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import { EngramChatMemory } from '../../src/memory/EngramChatMemory';
import { HybridSearchEngine } from '../../src/search/HybridSearchEngine';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';

describe('Memory Flow Integration', () => {
	let storage: GraphologyStorage;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
	});

	afterEach(async () => {
		await storage.close();
	});

	describe('basic conversation memory', () => {
		it('should save and retrieve a multi-turn conversation', async () => {
			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-1',
				returnMessages: true,
			});

			// Turn 1
			await memory.saveContext(
				{ input: 'Hello, my name is Alice' },
				{ output: 'Nice to meet you, Alice! How can I help?' },
			);

			// Turn 2
			await memory.saveContext(
				{ input: 'I work at Acme Corp as an engineer' },
				{ output: 'That sounds great! What kind of engineering?' },
			);

			// Load memory
			const vars = await memory.loadMemoryVariables({ input: 'Tell me about myself' });
			const messages = vars['chat_history'];

			expect(Array.isArray(messages)).toBe(true);
			// Should have 4 messages (2 turns × 2 messages)
			// May also have a SystemMessage with facts if search finds something
			const humanMessages = messages.filter((m: any) => m instanceof HumanMessage);
			const aiMessages = messages.filter((m: any) => m instanceof AIMessage);

			expect(humanMessages).toHaveLength(2);
			expect(aiMessages).toHaveLength(2);
			expect(humanMessages[0].content).toBe('Hello, my name is Alice');
			expect(humanMessages[1].content).toBe('I work at Acme Corp as an engineer');
			expect(aiMessages[0].content).toBe('Nice to meet you, Alice! How can I help?');
		});

		it('should return string format when returnMessages is false', async () => {
			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-str',
				returnMessages: false,
			});

			await memory.saveContext(
				{ input: 'Hi there' },
				{ output: 'Hello!' },
			);

			const vars = await memory.loadMemoryVariables({ input: 'next' });
			const result = vars['chat_history'];

			expect(typeof result).toBe('string');
			expect(result).toContain('Human: Hi there');
			expect(result).toContain('AI: Hello!');
		});
	});

	describe('context window', () => {
		it('should limit messages to context window size', async () => {
			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-window',
				contextWindow: 2, // Only 2 most recent episodes
				returnMessages: true,
			});

			// Create 5 turns
			for (let i = 1; i <= 5; i++) {
				await memory.saveContext(
					{ input: `Message ${i}` },
					{ output: `Response ${i}` },
				);
				// Small delay to ensure ordering
				await new Promise((r) => setTimeout(r, 5));
			}

			const vars = await memory.loadMemoryVariables({ input: 'check' });
			const messages = vars['chat_history'];
			const conversationMessages = messages.filter(
				(m: any) => m instanceof HumanMessage || m instanceof AIMessage,
			);

			// Context window of 2 means 2 most recent episodes
			expect(conversationMessages.length).toBeLessThanOrEqual(2);
		});
	});

	describe('episode chaining', () => {
		it('should chain episodes via previous_episode_uuid', async () => {
			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-chain',
				returnMessages: true,
			});

			await memory.saveContext(
				{ input: 'First message' },
				{ output: 'First response' },
			);
			await new Promise((r) => setTimeout(r, 5));

			await memory.saveContext(
				{ input: 'Second message' },
				{ output: 'Second response' },
			);

			// Verify episodes are chained
			const episodes = await storage.getRecentEpisodes('session-chain', 10);
			expect(episodes.length).toBe(4);

			// The second episode should reference the first
			// Episodes are returned in chronological order
			expect(episodes[0].previous_episode_uuid).toBeNull();
			expect(episodes[1].previous_episode_uuid).toBe(episodes[0].uuid);
			expect(episodes[2].previous_episode_uuid).toBe(episodes[1].uuid);
			expect(episodes[3].previous_episode_uuid).toBe(episodes[2].uuid);
		});
	});

	describe('knowledge graph with facts', () => {
		it('should return relevant facts in memory variables', async () => {
			// Pre-populate the graph with entities and facts
			const alice = await storage.addEntity({
				name: 'Alice',
				group_id: 'session-facts',
				summary: 'A software engineer',
				entity_type: 'person',
			});
			const acme = await storage.addEntity({
				name: 'Acme Corp',
				group_id: 'session-facts',
				summary: 'A technology company',
				entity_type: 'organization',
			});
			await storage.addEdge({
				group_id: 'session-facts',
				source_node_uuid: alice.uuid,
				target_node_uuid: acme.uuid,
				name: 'WORKS_AT',
				fact: 'Alice works at Acme Corp as a senior engineer',
			});

			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-facts',
				returnMessages: true,
				maxFactsPerQuery: 5,
				minRelevanceScore: 0,
			});

			// Save one turn to have history
			await memory.saveContext(
				{ input: 'Tell me about Alice' },
				{ output: 'What would you like to know?' },
			);

			// Load memory with a query about Alice
			const vars = await memory.loadMemoryVariables({
				input: 'Where does Alice work?',
			});
			const messages = vars['chat_history'];

			// Should include a SystemMessage with facts
			const systemMessages = messages.filter(
				(m: any) => m instanceof SystemMessage,
			);

			expect(systemMessages.length).toBeGreaterThan(0);
			const factsText = systemMessages[0].content as string;
			expect(factsText).toContain('Alice');
			expect(factsText).toContain('Acme Corp');
			expect(factsText).toContain('senior engineer');
		});

		it('should not return facts when query is empty', async () => {
			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-nofacts',
				returnMessages: true,
			});

			await memory.saveContext(
				{ input: 'Hello' },
				{ output: 'Hi!' },
			);

			const vars = await memory.loadMemoryVariables({ input: '' });
			const messages = vars['chat_history'];

			// No SystemMessage since empty query
			const systemMessages = messages.filter(
				(m: any) => m instanceof SystemMessage,
			);
			expect(systemMessages).toHaveLength(0);
		});
	});

	describe('group isolation', () => {
		it('should isolate data between sessions/groups', async () => {
			const memory1 = new EngramChatMemory({
				storage,
				groupId: 'user-alice',
				returnMessages: true,
			});
			const memory2 = new EngramChatMemory({
				storage,
				groupId: 'user-bob',
				returnMessages: true,
			});

			await memory1.saveContext(
				{ input: 'I am Alice' },
				{ output: 'Hello Alice!' },
			);
			await memory2.saveContext(
				{ input: 'I am Bob' },
				{ output: 'Hello Bob!' },
			);

			const vars1 = await memory1.loadMemoryVariables({ input: 'who am I?' });
			const vars2 = await memory2.loadMemoryVariables({ input: 'who am I?' });

			const msgs1 = vars1['chat_history'].filter(
				(m: any) => m instanceof HumanMessage,
			);
			const msgs2 = vars2['chat_history'].filter(
				(m: any) => m instanceof HumanMessage,
			);

			expect(msgs1).toHaveLength(1);
			expect(msgs1[0].content).toBe('I am Alice');
			expect(msgs2).toHaveLength(1);
			expect(msgs2[0].content).toBe('I am Bob');
		});
	});

	describe('clear memory', () => {
		it('should clear all data for a session', async () => {
			const memory = new EngramChatMemory({
				storage,
				groupId: 'session-clear',
				returnMessages: true,
			});

			await memory.saveContext(
				{ input: 'Remember this' },
				{ output: 'Noted!' },
			);

			let vars = await memory.loadMemoryVariables({ input: 'check' });
			expect(vars['chat_history'].length).toBeGreaterThan(0);

			await memory.clear();

			vars = await memory.loadMemoryVariables({ input: 'check' });
			const conversationMessages = vars['chat_history'].filter(
				(m: any) => m instanceof HumanMessage || m instanceof AIMessage,
			);
			expect(conversationMessages).toHaveLength(0);
		});
	});

	describe('retention policies', () => {
		it('should enforce max_episodes retention', async () => {
			// Add 5 episodes
			for (let i = 0; i < 5; i++) {
				await storage.addEpisode({
					group_id: 'session-retention',
					content: `Episode ${i}`,
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				await new Promise((r) => setTimeout(r, 5));
			}

			const countBefore = await storage.getEpisodeCount('session-retention');
			expect(countBefore).toBe(5);

			const removed = await storage.applyRetention('session-retention', {
				type: 'max_episodes',
				value: 3,
			});

			expect(removed).toBe(2);
			const countAfter = await storage.getEpisodeCount('session-retention');
			expect(countAfter).toBe(3);

			// Verify the most recent 3 episodes remain
			const remaining = await storage.getRecentEpisodes('session-retention', 10);
			expect(remaining).toHaveLength(3);
			expect(remaining[remaining.length - 1].content).toBe('Episode 4');
		});
	});

	describe('search + memory combined flow', () => {
		it('should support full search + memory pipeline', async () => {
			// Build a knowledge graph
			const alice = await storage.addEntity({
				name: 'Alice',
				group_id: 'combined',
				summary: 'Software engineer specializing in TypeScript',
				entity_type: 'person',
			});
			const bob = await storage.addEntity({
				name: 'Bob',
				group_id: 'combined',
				summary: 'Data scientist working with machine learning',
				entity_type: 'person',
			});
			const acme = await storage.addEntity({
				name: 'Acme Corp',
				group_id: 'combined',
				summary: 'Technology company in Berlin',
				entity_type: 'organization',
			});

			await storage.addEdge({
				group_id: 'combined',
				source_node_uuid: alice.uuid,
				target_node_uuid: acme.uuid,
				name: 'WORKS_AT',
				fact: 'Alice works at Acme Corp as a senior TypeScript engineer',
			});
			await storage.addEdge({
				group_id: 'combined',
				source_node_uuid: bob.uuid,
				target_node_uuid: acme.uuid,
				name: 'WORKS_AT',
				fact: 'Bob works at Acme Corp leading the ML team',
			});

			// Use hybrid search
			const searchEngine = new HybridSearchEngine(storage);
			const searchResults = await searchEngine.search(
				'TypeScript engineer',
				'combined',
			);

			expect(searchResults.entities.length).toBeGreaterThan(0);
			expect(searchResults.edges.length).toBeGreaterThan(0);

			// Format as context
			const context = searchEngine.formatAsContext(searchResults);
			expect(context).toContain('Alice');

			// Create memory and verify facts surface
			const memory = new EngramChatMemory({
				storage,
				groupId: 'combined',
				returnMessages: true,
				minRelevanceScore: 0,
			});

			await memory.saveContext(
				{ input: 'Who is the TypeScript engineer?' },
				{ output: 'Let me check our records.' },
			);

			const vars = await memory.loadMemoryVariables({
				input: 'Tell me about TypeScript engineers at Acme',
			});
			const messages = vars['chat_history'];

			// Should have SystemMessage with facts + conversation history
			expect(messages.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('export and import', () => {
		it('should roundtrip data through export/import', async () => {
			// Build some data
			const entity = await storage.addEntity({
				name: 'TestEntity',
				group_id: 'export-test',
				summary: 'Test entity for export',
				entity_type: 'test',
			});
			await storage.addEpisode({
				group_id: 'export-test',
				content: 'Test episode',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			// Export
			const exported = await storage.exportGraph('export-test');
			expect(exported.entities).toHaveLength(1);
			expect(exported.episodes).toHaveLength(1);
			expect(exported.version).toBe('1.0');

			// Create fresh storage and import
			const storage2 = new GraphologyStorage();
			await storage2.initialize();

			await storage2.importGraph(exported);

			// Verify data
			const importedEntity = await storage2.getEntity(entity.uuid);
			expect(importedEntity).not.toBeNull();
			expect(importedEntity!.name).toBe('TestEntity');

			const importedEpisodes = await storage2.getRecentEpisodes('export-test', 10);
			expect(importedEpisodes).toHaveLength(1);
			expect(importedEpisodes[0].content).toBe('Test episode');

			await storage2.close();
		});
	});
});
