import { HybridSearchEngine } from '../../../src/search/HybridSearchEngine';
import { EmbeddingService } from '../../../src/embeddings/EmbeddingService';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

// Mock fetch for EmbeddingService
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('HybridSearchEngine - RRF Merge', () => {
	let storage: GraphologyStorage;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		mockFetch.mockReset();
	});

	describe('text-only mode (no embedding service)', () => {
		it('should work without embedding service', async () => {
			const engine = new HybridSearchEngine(storage);

			await storage.addEntity({
				name: 'Alice',
				group_id: 'g1',
				summary: 'A developer',
			});

			const results = await engine.search('Alice', 'g1');
			expect(results.entities.length).toBeGreaterThanOrEqual(1);
			expect(results.entities[0].entity.name).toBe('Alice');
		});
	});

	describe('hybrid mode (with embedding service)', () => {
		let engine: HybridSearchEngine;

		beforeEach(async () => {
			// Create entities with both text fields and embeddings
			await storage.addEntity({
				name: 'Alice Smith',
				group_id: 'g1',
				summary: 'A software developer',
				entity_type: 'person',
				name_embedding: [1, 0, 0],
			});
			await storage.addEntity({
				name: 'Bob Jones',
				group_id: 'g1',
				summary: 'A project manager',
				entity_type: 'person',
				name_embedding: [0, 1, 0],
			});
			await storage.addEntity({
				name: 'Charlie Dev',
				group_id: 'g1',
				summary: 'A developer and designer',
				entity_type: 'person',
				name_embedding: [0.9, 0.1, 0],
			});

			const embeddingService = new EmbeddingService({
				apiKey: 'test-key',
				baseUrl: 'https://api.example.com/v1',
				model: 'test-model',
			});

			engine = new HybridSearchEngine(storage, embeddingService);
		});

		it('should merge text and vector results with RRF', async () => {
			// Mock the embedding API to return a vector similar to Alice
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [0.95, 0.05, 0], index: 0 }],
					usage: { prompt_tokens: 5, total_tokens: 5 },
				}),
			});

			const results = await engine.search('developer', 'g1');

			// Should have results from both text search ("developer" in summary)
			// and vector search (similar to Alice's embedding)
			expect(results.entities.length).toBeGreaterThan(0);
		});

		it('should fall back to text-only when embedding API fails', async () => {
			// Mock embedding failure
			mockFetch.mockRejectedValueOnce(new Error('API down'));

			// Add a console.warn spy to verify fallback logging
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

			const results = await engine.search('Alice', 'g1');

			// Should still get text results
			expect(results.entities.length).toBeGreaterThanOrEqual(1);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('Embedding search failed'),
				expect.any(String),
			);

			warnSpy.mockRestore();
		});

		it('should deduplicate entities appearing in both text and vector results', async () => {
			// Mock embedding for "Alice" — vector very similar to Alice entity
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [1, 0, 0], index: 0 }],
					usage: { prompt_tokens: 5, total_tokens: 5 },
				}),
			});

			const results = await engine.search('Alice Smith', 'g1');

			// Alice should appear only once (deduplicated by UUID) with boosted RRF score
			const aliceResults = results.entities.filter(
				(r) => r.entity.name === 'Alice Smith',
			);
			expect(aliceResults).toHaveLength(1);

			// Her score should be higher than entities only in one result set
			// because she appears in both text and vector results
			if (results.entities.length > 1) {
				expect(aliceResults[0].score).toBeGreaterThanOrEqual(
					results.entities[results.entities.length - 1].score,
				);
			}
		});
	});

	describe('hybrid search with edges', () => {
		it('should search edges with vector support', async () => {
			const source = await storage.addEntity({
				name: 'Alice',
				group_id: 'g1',
			});
			const target = await storage.addEntity({
				name: 'Acme',
				group_id: 'g1',
			});
			await storage.addEdge({
				group_id: 'g1',
				source_node_uuid: source.uuid,
				target_node_uuid: target.uuid,
				name: 'WORKS_AT',
				fact: 'Alice works at Acme Corp',
				fact_embedding: [1, 0, 0],
			});

			const embeddingService = new EmbeddingService({
				apiKey: 'key',
				baseUrl: 'https://api.example.com/v1',
				model: 'model',
			});
			const engine = new HybridSearchEngine(storage, embeddingService);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [0.9, 0.1, 0], index: 0 }],
					usage: { prompt_tokens: 5, total_tokens: 5 },
				}),
			});

			const results = await engine.search('works', 'g1');
			expect(results.edges.length).toBeGreaterThanOrEqual(1);
			expect(results.edges[0].edge.fact).toContain('Alice works at Acme');
		});
	});

	describe('formatAsContext', () => {
		it('should format entities and edges into context string', () => {
			const engine = new HybridSearchEngine(storage);

			const context = engine.formatAsContext({
				entities: [
					{
						entity: {
							uuid: '1',
							name: 'Alice',
							group_id: 'g1',
							summary: 'A developer',
							entity_type: 'person',
							name_embedding: null,
							attributes: {},
							created_at: '',
							updated_at: '',
						},
						score: 0.9,
					},
				],
				edges: [
					{
						edge: {
							uuid: '2',
							group_id: 'g1',
							source_node_uuid: '1',
							target_node_uuid: '3',
							name: 'WORKS_AT',
							fact: 'Alice works at Acme',
							fact_embedding: null,
							episodes: [],
							valid_at: null,
							invalid_at: null,
							expired_at: null,
							attributes: {},
							created_at: '',
							updated_at: '',
						},
						sourceEntity: {
							uuid: '1',
							name: 'Alice',
							group_id: 'g1',
							summary: '',
							entity_type: 'person',
							name_embedding: null,
							attributes: {},
							created_at: '',
							updated_at: '',
						},
						targetEntity: {
							uuid: '3',
							name: 'Acme',
							group_id: 'g1',
							summary: '',
							entity_type: 'organization',
							name_embedding: null,
							attributes: {},
							created_at: '',
							updated_at: '',
						},
						score: 0.8,
					},
				],
			});

			expect(context).toContain('Known entities:');
			expect(context).toContain('Alice (person): A developer');
			expect(context).toContain('Known facts:');
			expect(context).toContain('Alice -> Acme: Alice works at Acme');
		});
	});
});
