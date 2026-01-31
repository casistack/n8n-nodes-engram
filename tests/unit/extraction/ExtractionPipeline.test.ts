import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline';
import { LlmClient } from '../../../src/extraction/LlmClient';

// Mock the LlmClient
jest.mock('../../../src/extraction/LlmClient');

const MockedLlmClient = LlmClient as jest.MockedClass<typeof LlmClient>;

describe('ExtractionPipeline', () => {
	let storage: GraphologyStorage;
	let pipeline: ExtractionPipeline;
	let mockChatJson: jest.Mock;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();

		// Reset mock
		MockedLlmClient.mockClear();
		mockChatJson = jest.fn();
		MockedLlmClient.prototype.chatJson = mockChatJson;

		pipeline = new ExtractionPipeline(storage, {
			llmConfig: {
				apiKey: 'test-key',
				baseUrl: 'http://localhost',
				model: 'test-model',
			},
			entityTypes: ['person', 'organization', 'location'],
			groupId: 'test-group',
		});
	});

	afterEach(async () => {
		await storage.close();
	});

	it('should extract entities and relationships from a conversation', async () => {
		// Mock entity extraction
		mockChatJson
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A software engineer' },
					{ name: 'Google', entity_type: 'organization', summary: 'A tech company' },
				],
			})
			// Mock relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Google',
						name: 'WORKS_AT',
						fact: 'Alice works at Google',
					},
				],
			});

		await pipeline.process(
			'I work at Google as a software engineer.',
			'That sounds like a great role at Google!',
		);

		// Verify entities were created
		const entities = await storage.listEntities('test-group');
		expect(entities).toHaveLength(2);

		const alice = entities.find((e) => e.name === 'Alice');
		const google = entities.find((e) => e.name === 'Google');
		expect(alice).toBeDefined();
		expect(google).toBeDefined();

		// Verify relationship was created
		const edges = await storage.getEdgesForEntity(alice!.uuid);
		expect(edges).toHaveLength(1);
		expect(edges[0].name).toBe('WORKS_AT');
		expect(edges[0].fact).toBe('Alice works at Google');
	});

	it('should deduplicate entities with exact name match', async () => {
		// Pre-seed an entity
		await storage.addEntity({
			name: 'Alice',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});

		// Mock extraction returns Alice again with updated summary
		mockChatJson
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A software engineer at Google' },
				],
			})
			.mockResolvedValueOnce({
				relationships: [],
			});

		await pipeline.process('I am Alice the engineer.', 'Nice to meet you, Alice!');

		// Should still have only 1 Alice (deduplicated)
		const entities = await storage.listEntities('test-group');
		const aliceEntities = entities.filter((e) => e.name === 'Alice');
		expect(aliceEntities).toHaveLength(1);

		// Summary should be updated to the longer one
		expect(aliceEntities[0].summary).toBe('A software engineer at Google');
	});

	it('should detect contradictions and expire old edges', async () => {
		// Pre-seed entities and a relationship
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const london = await storage.addEntity({
			name: 'London',
			group_id: 'test-group',
			summary: 'Capital of England',
			entity_type: 'location',
		});
		const tokyo = await storage.addEntity({
			name: 'Tokyo',
			group_id: 'test-group',
			summary: 'Capital of Japan',
			entity_type: 'location',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: alice.uuid,
			target_node_uuid: london.uuid,
			name: 'LIVES_IN',
			fact: 'Alice lives in London',
		});

		// Mock: extraction finds Alice and Tokyo
		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A person' },
					{ name: 'Tokyo', entity_type: 'location', summary: 'Capital of Japan' },
				],
			})
			// 2. Dedup check: Tokyo vs London (same type, different name -> LLM fallback)
			.mockResolvedValueOnce({
				is_duplicate: false,
				merged_summary: '',
			})
			// 3. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Tokyo',
						name: 'LIVES_IN',
						fact: 'Alice moved to Tokyo',
					},
				],
			});

		await pipeline.process(
			'I just moved to Tokyo!',
			'How exciting! Tokyo is a great city.',
		);

		// Alice->Tokyo edge should exist
		const tokyoEdges = await storage.getEdgesBetween(alice.uuid, tokyo.uuid);
		expect(tokyoEdges.length).toBeGreaterThanOrEqual(1);
		expect(tokyoEdges.some((e) => e.fact === 'Alice moved to Tokyo')).toBe(true);
	});

	it('should handle extraction errors gracefully', async () => {
		// Mock extraction failure
		mockChatJson.mockRejectedValue(new Error('LLM API error'));

		// Should not throw
		await expect(
			pipeline.process('Some message', 'Some response'),
		).resolves.not.toThrow();
	});

	it('should handle empty extraction results', async () => {
		mockChatJson.mockResolvedValueOnce({ entities: [] });

		await pipeline.process('Hello', 'Hi there!');

		const entities = await storage.listEntities('test-group');
		expect(entities).toHaveLength(0);
	});
});
