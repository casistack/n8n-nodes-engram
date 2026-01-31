import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

// Mock global fetch for both LLM and Embedding API calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockLlmResponse(content: string) {
	return {
		ok: true,
		json: async () => ({
			choices: [{ message: { content } }],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		}),
	};
}

function mockEmbeddingResponse(embedding: number[]) {
	return {
		ok: true,
		json: async () => ({
			data: [{ embedding, index: 0 }],
			usage: { prompt_tokens: 5, total_tokens: 5 },
		}),
	};
}

describe('ExtractionPipeline - Embedding Support', () => {
	let storage: GraphologyStorage;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		mockFetch.mockReset();
	});

	it('should generate name_embedding when embedding config is provided', async () => {
		const pipeline = new ExtractionPipeline(storage, {
			llmConfig: {
				apiKey: 'llm-key',
				baseUrl: 'https://llm.example.com/v1',
				model: 'gpt-4',
			},
			entityTypes: ['person'],
			groupId: 'g1',
			embeddingConfig: {
				apiKey: 'embed-key',
				baseUrl: 'https://embed.example.com/v1',
				model: 'text-embedding-3-small',
			},
		});

		// Mock entity extraction LLM call
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A developer' },
				],
			})),
		);

		// No dedup mock needed — no existing entities in storage, so dedup loop runs 0 times

		// Mock embedding API call for entity name
		mockFetch.mockResolvedValueOnce(
			mockEmbeddingResponse([0.1, 0.2, 0.3]),
		);

		// Mock relationship extraction LLM call (no relationships)
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({ relationships: [] })),
		);

		await pipeline.process('Tell me about Alice', 'Alice is a developer');

		// Verify the entity was created with an embedding
		const entities = await storage.listEntities('g1');
		expect(entities).toHaveLength(1);
		expect(entities[0].name).toBe('Alice');
		expect(entities[0].name_embedding).toEqual([0.1, 0.2, 0.3]);
	});

	it('should not generate embeddings when embedding config is not provided', async () => {
		const pipeline = new ExtractionPipeline(storage, {
			llmConfig: {
				apiKey: 'llm-key',
				baseUrl: 'https://llm.example.com/v1',
				model: 'gpt-4',
			},
			entityTypes: ['person'],
			groupId: 'g1',
			// No embeddingConfig
		});

		// Mock entity extraction
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({
				entities: [{ name: 'Bob', entity_type: 'person', summary: 'A manager' }],
			})),
		);

		// No dedup mock needed — no existing entities in storage

		// Mock relationship extraction (no rels)
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({ relationships: [] })),
		);

		await pipeline.process('Tell me about Bob', 'Bob is a manager');

		const entities = await storage.listEntities('g1');
		expect(entities).toHaveLength(1);
		expect(entities[0].name_embedding).toBeNull();
	});

	it('should generate fact_embedding on edge creation', async () => {
		// Pre-create entities (with summaries so fast-path dedup works)
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'g1',
			entity_type: 'person',
			summary: 'A developer',
		});
		const acme = await storage.addEntity({
			name: 'Acme Corp',
			group_id: 'g1',
			entity_type: 'organization',
			summary: 'A company',
		});

		const pipeline = new ExtractionPipeline(storage, {
			llmConfig: {
				apiKey: 'llm-key',
				baseUrl: 'https://llm.example.com/v1',
				model: 'gpt-4',
			},
			entityTypes: ['person', 'organization'],
			groupId: 'g1',
			embeddingConfig: {
				apiKey: 'embed-key',
				baseUrl: 'https://embed.example.com/v1',
				model: 'text-embedding-3-small',
			},
		});

		// Mock entity extraction (returns existing entities)
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A developer' },
					{ name: 'Acme Corp', entity_type: 'organization', summary: 'A company' },
				],
			})),
		);

		// No dedup mocks needed — EntityDeduplicator uses fast-path exact name match
		// (no LLM call) for Alice→Alice and Acme Corp→Acme Corp.
		// Cross-type comparisons (e.g. Acme Corp vs Alice) are skipped by type mismatch.

		// Mock relationship extraction
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Acme Corp',
						name: 'works at',
						fact: 'Alice works at Acme Corp',
					},
				],
			})),
		);

		// No contradiction mock needed — no pre-existing edges between Alice and Acme Corp

		// Mock embedding API call for fact
		mockFetch.mockResolvedValueOnce(
			mockEmbeddingResponse([0.4, 0.5, 0.6]),
		);

		await pipeline.process(
			'Alice works at Acme Corp',
			'Yes, Alice is employed at Acme Corp.',
		);

		// Verify edge was created with fact_embedding
		const edges = await storage.getEdgesBetween(alice.uuid, acme.uuid);
		expect(edges.length).toBeGreaterThanOrEqual(1);
		const newEdge = edges.find((e) => e.fact_embedding !== null);
		expect(newEdge).toBeDefined();
		expect(newEdge!.fact_embedding).toEqual([0.4, 0.5, 0.6]);
	});

	it('should gracefully handle embedding API failure', async () => {
		const pipeline = new ExtractionPipeline(storage, {
			llmConfig: {
				apiKey: 'llm-key',
				baseUrl: 'https://llm.example.com/v1',
				model: 'gpt-4',
			},
			entityTypes: ['person'],
			groupId: 'g1',
			embeddingConfig: {
				apiKey: 'bad-key',
				baseUrl: 'https://embed.example.com/v1',
				model: 'text-embedding-3-small',
			},
		});

		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

		// Mock entity extraction
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({
				entities: [{ name: 'Carol', entity_type: 'person', summary: 'A tester' }],
			})),
		);

		// No dedup mock needed — no existing entities in storage

		// Mock embedding API failure
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => 'Invalid API key',
		});

		// Mock relationship extraction (no rels)
		mockFetch.mockResolvedValueOnce(
			mockLlmResponse(JSON.stringify({ relationships: [] })),
		);

		await pipeline.process('Tell me about Carol', 'Carol is a tester');

		// Entity should still be created, just without embedding
		const entities = await storage.listEntities('g1');
		expect(entities).toHaveLength(1);
		expect(entities[0].name).toBe('Carol');
		expect(entities[0].name_embedding).toBeNull();

		// Should have logged a warning
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Failed to generate entity name embedding'),
			expect.any(String),
		);

		warnSpy.mockRestore();
	});
});
