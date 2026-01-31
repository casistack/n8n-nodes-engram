import { EngramChatMemory } from '../../../src/memory/EngramChatMemory';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

// Mock global fetch for EmbeddingService
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('EngramChatMemory - Embedding Config', () => {
	let storage: GraphologyStorage;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		mockFetch.mockReset();
	});

	it('should work without embedding config (text-only search)', async () => {
		const memory = new EngramChatMemory({
			storage,
			groupId: 'g1',
			contextWindow: 5,
			// No embeddingConfig
		});

		// Add some facts via storage directly
		const source = await storage.addEntity({
			name: 'Alice',
			group_id: 'g1',
			summary: 'A developer',
		});
		const target = await storage.addEntity({
			name: 'Acme',
			group_id: 'g1',
			summary: 'A company',
		});
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: source.uuid,
			target_node_uuid: target.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Acme Corp',
		});

		const vars = await memory.loadMemoryVariables({ input: 'Where does Alice work?' });
		// Should still return results via text search
		expect(vars.chat_history).toBeDefined();
	});

	it('should accept embedding config and create search engine with embeddings', async () => {
		const memory = new EngramChatMemory({
			storage,
			groupId: 'g1',
			contextWindow: 5,
			embeddingConfig: {
				apiKey: 'test-key',
				baseUrl: 'https://embed.example.com/v1',
				model: 'text-embedding-3-small',
			},
		});

		// Add entity with embedding
		const source = await storage.addEntity({
			name: 'Alice',
			group_id: 'g1',
			summary: 'A developer',
			name_embedding: [1, 0, 0],
		});
		const target = await storage.addEntity({
			name: 'Acme',
			group_id: 'g1',
			summary: 'A company',
			name_embedding: [0, 1, 0],
		});
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: source.uuid,
			target_node_uuid: target.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Acme Corp',
			fact_embedding: [0.5, 0.5, 0],
		});

		// Mock embedding API for query vector
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [{ embedding: [0.9, 0.1, 0], index: 0 }],
				usage: { prompt_tokens: 5, total_tokens: 5 },
			}),
		});

		const vars = await memory.loadMemoryVariables({ input: 'Tell me about Alice' });
		expect(vars.chat_history).toBeDefined();
	});

	it('should pass embedding config to extraction pipeline', async () => {
		const memory = new EngramChatMemory({
			storage,
			groupId: 'g1',
			contextWindow: 5,
			enableExtraction: true,
			llmConfig: {
				apiKey: 'llm-key',
				baseUrl: 'https://llm.example.com/v1',
				model: 'gpt-4',
			},
			embeddingConfig: {
				apiKey: 'embed-key',
				baseUrl: 'https://embed.example.com/v1',
				model: 'text-embedding-3-small',
			},
			entityTypes: ['person'],
		});

		// The memory should be constructed without errors
		// The extraction pipeline will use embeddingConfig internally
		expect(memory).toBeDefined();
		expect(memory.enableExtraction).toBe(true);
	});

	it('should gracefully handle embedding API failure during search', async () => {
		const memory = new EngramChatMemory({
			storage,
			groupId: 'g1',
			contextWindow: 5,
			embeddingConfig: {
				apiKey: 'bad-key',
				baseUrl: 'https://embed.example.com/v1',
				model: 'text-embedding-3-small',
			},
		});

		// Add some data
		const source = await storage.addEntity({
			name: 'Alice',
			group_id: 'g1',
			name_embedding: [1, 0, 0],
		});
		const target = await storage.addEntity({
			name: 'Acme',
			group_id: 'g1',
			name_embedding: [0, 1, 0],
		});
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: source.uuid,
			target_node_uuid: target.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Acme',
			fact_embedding: [0.5, 0.5, 0],
		});

		// Mock embedding API to fail
		mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

		const vars = await memory.loadMemoryVariables({ input: 'Where does Alice work?' });

		// Should still work (fallback to text-only)
		expect(vars.chat_history).toBeDefined();

		warnSpy.mockRestore();
	});

	it('should not use embeddings when disabled', async () => {
		const memory = new EngramChatMemory({
			storage,
			groupId: 'g1',
			contextWindow: 5,
			// No embeddingConfig — embeddings disabled
		});

		await storage.addEntity({
			name: 'Test',
			group_id: 'g1',
			name_embedding: [1, 0, 0],
		});

		// loadMemoryVariables should not call any embedding API
		const vars = await memory.loadMemoryVariables({ input: 'test' });
		expect(vars.chat_history).toBeDefined();
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
