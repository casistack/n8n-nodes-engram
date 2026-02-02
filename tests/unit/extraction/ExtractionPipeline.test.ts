import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { ExtractionPipeline } from '../../../src/extraction/ExtractionPipeline';
import { LlmClient } from '../../../src/extraction/LlmClient';
import { contradictionUser } from '../../../src/extraction/prompts';

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

	it('should expire old edge when relationship type changes between same entities', async () => {
		// Pre-seed: Bob WORKS_AT Google
		const bob = await storage.addEntity({
			name: 'Bob',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const google = await storage.addEntity({
			name: 'Google',
			group_id: 'test-group',
			summary: 'A tech company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: bob.uuid,
			target_node_uuid: google.uuid,
			name: 'WORKS_AT',
			fact: 'Bob works at Google',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Bob', entity_type: 'person', summary: 'A person' },
					{ name: 'Google', entity_type: 'organization', summary: 'A tech company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Bob',
						target_entity: 'Google',
						name: 'WORKED_AT',
						fact: 'Bob worked at Google before quitting',
					},
				],
			})
			// 3. Cross-name dedup: WORKS_AT vs WORKED_AT → NOT duplicate (past tense = different state)
			.mockResolvedValueOnce({
				is_duplicate: false,
				merged_fact: '',
			})
			// 4. Contradiction detection (WORKS_AT vs WORKED_AT)
			.mockResolvedValueOnce({
				is_contradiction: true,
				explanation: 'Past tense WORKED_AT replaces current WORKS_AT',
			});

		await pipeline.process(
			'I actually quit Google.',
			'Thanks for the update!',
		);

		const edges = await storage.getEdgesBetween(bob.uuid, google.uuid);
		const expiredEdge = edges.find((e) => e.name === 'WORKS_AT');
		const newEdge = edges.find((e) => e.name === 'WORKED_AT');

		expect(expiredEdge).toBeDefined();
		expect(expiredEdge!.expired_at).not.toBeNull();
		expect(expiredEdge!.invalid_at).not.toBeNull();

		expect(newEdge).toBeDefined();
		expect(newEdge!.expired_at).toBeNull();
		expect(newEdge!.fact).toBe('Bob worked at Google before quitting');
	});

	it('should pass edge names to contradiction detector', async () => {
		// Pre-seed: Alice WORKS_AT Acme
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const acme = await storage.addEntity({
			name: 'Acme Corp',
			group_id: 'test-group',
			summary: 'A company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: alice.uuid,
			target_node_uuid: acme.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Acme Corp',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A person' },
					{ name: 'Acme Corp', entity_type: 'organization', summary: 'A company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Acme Corp',
						name: 'WORKED_AT',
						fact: 'Alice worked at Acme Corp',
					},
				],
			})
			// 3. Cross-name dedup: WORKS_AT vs WORKED_AT → NOT duplicate
			.mockResolvedValueOnce({
				is_duplicate: false,
				merged_fact: '',
			})
			// 4. Contradiction detection
			.mockResolvedValueOnce({
				is_contradiction: true,
				explanation: 'Status changed',
			});

		await pipeline.process('I left Acme.', 'Got it!');

		// Find the contradiction detection call (4th call, after cross-name dedup)
		const contradictionCall = mockChatJson.mock.calls[3];
		const userMessage = contradictionCall[0][1].content;
		expect(userMessage).toContain('Existing relationship type: WORKS_AT');
		expect(userMessage).toContain('New relationship type: WORKED_AT');
	});

	it('should expire old edge when same edge name points to different target', async () => {
		// Pre-seed: Sarah LIVES_IN London
		const sarah = await storage.addEntity({
			name: 'Sarah',
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
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: sarah.uuid,
			target_node_uuid: london.uuid,
			name: 'LIVES_IN',
			fact: 'Sarah lives in London',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Sarah', entity_type: 'person', summary: 'A person' },
					{ name: 'Berlin', entity_type: 'location', summary: 'Capital of Germany' },
				],
			})
			// 2. Dedup check: Berlin vs London (same type, different name -> LLM fallback)
			.mockResolvedValueOnce({
				is_duplicate: false,
				merged_summary: '',
			})
			// 3. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Sarah',
						target_entity: 'Berlin',
						name: 'LIVES_IN',
						fact: 'Sarah moved to Berlin',
					},
				],
			})
			// 4. Contradiction detection (cross-target: LIVES_IN London vs LIVES_IN Berlin)
			.mockResolvedValueOnce({
				is_contradiction: true,
				explanation: 'Sarah can only live in one place at a time',
			});

		await pipeline.process(
			'We just moved to Berlin!',
			'How exciting!',
		);

		// Old LIVES_IN London edge should be expired
		const londonEdges = await storage.getEdgesBetween(sarah.uuid, london.uuid);
		const expiredEdge = londonEdges.find((e) => e.name === 'LIVES_IN');
		expect(expiredEdge).toBeDefined();
		expect(expiredEdge!.expired_at).not.toBeNull();
		expect(expiredEdge!.invalid_at).not.toBeNull();

		// New LIVES_IN Berlin edge should be active
		const berlin = (await storage.listEntities('test-group')).find((e) => e.name === 'Berlin');
		expect(berlin).toBeDefined();
		const berlinEdges = await storage.getEdgesBetween(sarah.uuid, berlin!.uuid);
		const newEdge = berlinEdges.find((e) => e.name === 'LIVES_IN');
		expect(newEdge).toBeDefined();
		expect(newEdge!.expired_at).toBeNull();
		expect(newEdge!.fact).toBe('Sarah moved to Berlin');
	});

	it('should handle contradiction detection failure gracefully', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

		// Pre-seed: Bob WORKS_AT Google
		const bob = await storage.addEntity({
			name: 'Bob',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const google = await storage.addEntity({
			name: 'Google',
			group_id: 'test-group',
			summary: 'A tech company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: bob.uuid,
			target_node_uuid: google.uuid,
			name: 'WORKS_AT',
			fact: 'Bob works at Google',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Bob', entity_type: 'person', summary: 'A person' },
					{ name: 'Google', entity_type: 'organization', summary: 'A tech company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Bob',
						target_entity: 'Google',
						name: 'WORKED_AT',
						fact: 'Bob left Google',
					},
				],
			})
			// 3. Contradiction detection throws
			.mockRejectedValueOnce(new Error('LLM timeout'));

		await pipeline.process('I quit Google.', 'Noted!');

		// New edge should still be created despite contradiction failure
		const edges = await storage.getEdgesBetween(bob.uuid, google.uuid);
		const newEdge = edges.find((e) => e.name === 'WORKED_AT');
		expect(newEdge).toBeDefined();
		expect(newEdge!.fact).toBe('Bob left Google');

		// Warning should have been logged (from ContradictionDetector's internal catch)
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Contradiction detection failed'),
			expect.any(String),
		);

		warnSpy.mockRestore();
	});

	it('should update existing edge when duplicate fact extracted', async () => {
		// Pre-seed: Alice WORKS_AT Netflix as "senior engineer"
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const netflix = await storage.addEntity({
			name: 'Netflix',
			group_id: 'test-group',
			summary: 'A streaming company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: alice.uuid,
			target_node_uuid: netflix.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Netflix as a senior engineer',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A person' },
					{ name: 'Netflix', entity_type: 'organization', summary: 'A streaming company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Netflix',
						name: 'WORKS_AT',
						fact: 'Alice works at Netflix as VP of Engineering',
					},
				],
			})
			// 3. Edge dedup check (same pair, same name)
			.mockResolvedValueOnce({
				is_duplicate: true,
				merged_fact: 'Alice works at Netflix as VP of Engineering',
			});

		await pipeline.process(
			'I got promoted to VP of Engineering at Netflix!',
			'Congratulations on the promotion!',
		);

		// Should have 1 WORKS_AT edge (updated in-place), not 2
		const edges = await storage.getEdgesBetween(alice.uuid, netflix.uuid);
		const worksAtEdges = edges.filter((e) => e.name === 'WORKS_AT' && !e.expired_at);
		expect(worksAtEdges).toHaveLength(1);
		expect(worksAtEdges[0].fact).toBe('Alice works at Netflix as VP of Engineering');
	});

	it('should not deduplicate genuinely different facts with same edge name', async () => {
		// Pre-seed: Alice KNOWS Python
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const python = await storage.addEntity({
			name: 'Python',
			group_id: 'test-group',
			summary: 'A programming language',
			entity_type: 'concept',
		});
		const java = await storage.addEntity({
			name: 'Java',
			group_id: 'test-group',
			summary: 'A programming language',
			entity_type: 'concept',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: alice.uuid,
			target_node_uuid: python.uuid,
			name: 'KNOWS',
			fact: 'Alice knows Python',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A person' },
					{ name: 'Java', entity_type: 'concept', summary: 'A programming language' },
				],
			})
			// 2. Entity dedup: Java vs Python (same type 'concept', different name → LLM fallback)
			//    Java vs Alice skipped (different entity_type: concept vs person)
			//    Java vs Java → exact name match (no LLM call)
			.mockResolvedValueOnce({
				is_duplicate: false,
				merged_summary: '',
			})
			// 3. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Java',
						name: 'KNOWS',
						fact: 'Alice knows Java',
					},
				],
			})
			// No edge dedup call — different target, no existing KNOWS between Alice and Java
			// 4. Cross-target contradiction: KNOWS Python vs KNOWS Java
			.mockResolvedValueOnce({
				is_contradiction: false,
				explanation: 'Knowing Java does not contradict knowing Python',
			});

		await pipeline.process(
			'I also know Java.',
			'Nice, Java is a great language!',
		);

		// Both edges should exist — different target entities
		const pythonEdges = await storage.getEdgesBetween(alice.uuid, python.uuid);
		expect(pythonEdges.filter((e) => e.name === 'KNOWS')).toHaveLength(1);

		const javaEdges = await storage.getEdgesBetween(alice.uuid, java.uuid);
		expect(javaEdges.filter((e) => e.name === 'KNOWS')).toHaveLength(1);
	});

	it('should skip edge creation for exact fact match', async () => {
		// Pre-seed: Bob WORKS_AT Google with exact same fact
		const bob = await storage.addEntity({
			name: 'Bob',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const google = await storage.addEntity({
			name: 'Google',
			group_id: 'test-group',
			summary: 'A tech company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: bob.uuid,
			target_node_uuid: google.uuid,
			name: 'WORKS_AT',
			fact: 'Bob works at Google',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Bob', entity_type: 'person', summary: 'A person' },
					{ name: 'Google', entity_type: 'organization', summary: 'A tech company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Bob',
						target_entity: 'Google',
						name: 'WORKS_AT',
						fact: 'Bob works at Google',
					},
				],
			});
		// No LLM dedup call — exact match fast path in EdgeDeduplicator

		await pipeline.process(
			'Bob works at Google.',
			'Yes, Bob is at Google.',
		);

		// Should still have exactly 1 WORKS_AT edge (no duplicate created)
		const edges = await storage.getEdgesBetween(bob.uuid, google.uuid);
		const worksAtEdges = edges.filter((e) => e.name === 'WORKS_AT');
		expect(worksAtEdges).toHaveLength(1);
		expect(worksAtEdges[0].fact).toBe('Bob works at Google');

		// Verify no LLM edge dedup call was made (only 2 calls: entity + relationship extraction)
		expect(mockChatJson).toHaveBeenCalledTimes(2);
	});

	it('should merge cross-name duplicate edges (WORKS_AT exists, HOLDS_POSITION extracted)', async () => {
		// Pre-seed: Alice WORKS_AT Netflix
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const netflix = await storage.addEntity({
			name: 'Netflix',
			group_id: 'test-group',
			summary: 'A streaming company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: alice.uuid,
			target_node_uuid: netflix.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Netflix as a senior engineer',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Alice', entity_type: 'person', summary: 'A person' },
					{ name: 'Netflix', entity_type: 'organization', summary: 'A streaming company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Alice',
						target_entity: 'Netflix',
						name: 'HOLDS_POSITION',
						fact: 'Alice holds a VP of Engineering position at Netflix',
					},
				],
			})
			// 3. No same-name match (HOLDS_POSITION !== WORKS_AT) → skip same-name dedup
			// 4. Cross-name dedup: WORKS_AT vs HOLDS_POSITION
			.mockResolvedValueOnce({
				is_duplicate: true,
				merged_fact: 'Alice works at Netflix as VP of Engineering',
			});

		await pipeline.process(
			'I now hold the VP of Engineering position at Netflix!',
			'Congratulations on the new role!',
		);

		// Should have 1 active edge (WORKS_AT with updated fact), not 2
		const edges = await storage.getEdgesBetween(alice.uuid, netflix.uuid);
		const activeEdges = edges.filter((e) => !e.expired_at);
		expect(activeEdges).toHaveLength(1);
		expect(activeEdges[0].name).toBe('WORKS_AT'); // Kept existing name
		expect(activeEdges[0].fact).toBe('Alice works at Netflix as VP of Engineering');
	});

	it('should keep both edges when cross-name comparison says NOT duplicate', async () => {
		// Pre-seed: Bob WORKS_AT Google
		const bob = await storage.addEntity({
			name: 'Bob',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const google = await storage.addEntity({
			name: 'Google',
			group_id: 'test-group',
			summary: 'A tech company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: bob.uuid,
			target_node_uuid: google.uuid,
			name: 'WORKS_AT',
			fact: 'Bob works at Google',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Bob', entity_type: 'person', summary: 'A person' },
					{ name: 'Google', entity_type: 'organization', summary: 'A tech company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Bob',
						target_entity: 'Google',
						name: 'MANAGES',
						fact: 'Bob manages the AI team at Google',
					},
				],
			})
			// 3. Cross-name dedup: WORKS_AT vs MANAGES → NOT duplicate
			.mockResolvedValueOnce({
				is_duplicate: false,
				merged_fact: '',
			})
			// 4. Contradiction Pass 1: WORKS_AT vs MANAGES same pair → no contradiction
			.mockResolvedValueOnce({
				is_contradiction: false,
				explanation: 'Managing and working at are compatible relationships',
			});

		await pipeline.process(
			'I manage the AI team at Google.',
			'That must be a big responsibility!',
		);

		// Both edges should exist
		const edges = await storage.getEdgesBetween(bob.uuid, google.uuid);
		const activeEdges = edges.filter((e) => !e.expired_at);
		expect(activeEdges).toHaveLength(2);
		expect(activeEdges.map((e) => e.name).sort()).toEqual(['MANAGES', 'WORKS_AT']);
	});

	it('should fall through gracefully when cross-name dedup LLM fails', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

		// Pre-seed: Carol WORKS_AT Acme Corp
		const carol = await storage.addEntity({
			name: 'Carol',
			group_id: 'test-group',
			summary: 'A person',
			entity_type: 'person',
		});
		const acme = await storage.addEntity({
			name: 'Acme Corp',
			group_id: 'test-group',
			summary: 'A company',
			entity_type: 'organization',
		});
		await storage.addEdge({
			group_id: 'test-group',
			source_node_uuid: carol.uuid,
			target_node_uuid: acme.uuid,
			name: 'WORKS_AT',
			fact: 'Carol works at Acme Corp',
		});

		mockChatJson
			// 1. Entity extraction
			.mockResolvedValueOnce({
				entities: [
					{ name: 'Carol', entity_type: 'person', summary: 'A person' },
					{ name: 'Acme Corp', entity_type: 'organization', summary: 'A company' },
				],
			})
			// 2. Relationship extraction
			.mockResolvedValueOnce({
				relationships: [
					{
						source_entity: 'Carol',
						target_entity: 'Acme Corp',
						name: 'EMPLOYED_BY',
						fact: 'Carol is employed by Acme Corp',
					},
				],
			})
			// 3. Cross-name dedup throws (LLM failure)
			.mockRejectedValueOnce(new Error('LLM timeout'))
			// 4. Contradiction Pass 1: WORKS_AT vs EMPLOYED_BY → no contradiction
			.mockResolvedValueOnce({
				is_contradiction: false,
				explanation: 'Same employment, different wording',
			});

		await pipeline.process(
			'Carol is employed by Acme Corp.',
			'Got it!',
		);

		// New edge should still be created (fell through to creation)
		const edges = await storage.getEdgesBetween(carol.uuid, acme.uuid);
		const activeEdges = edges.filter((e) => !e.expired_at);
		expect(activeEdges).toHaveLength(2); // Both exist since dedup failed

		// Warning should have been logged
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Cross-name edge deduplication failed'),
			expect.any(String),
		);

		warnSpy.mockRestore();
	});
});

describe('contradictionUser prompt', () => {
	it('should produce valid prompt without edge names', () => {
		const result = contradictionUser(
			'Alice lives in London',
			'Alice lives in Tokyo',
			'Alice',
			'London',
		);
		expect(result).not.toContain('undefined');
		expect(result).toContain('Existing fact: Alice lives in London');
		expect(result).toContain('New fact: Alice lives in Tokyo');
		expect(result).not.toContain('relationship type');
	});

	it('should include edge names when provided', () => {
		const result = contradictionUser(
			'Bob works at Google',
			'Bob worked at Google before quitting',
			'Bob',
			'Google',
			'WORKS_AT',
			'WORKED_AT',
		);
		expect(result).toContain('Existing relationship type: WORKS_AT');
		expect(result).toContain('New relationship type: WORKED_AT');
		expect(result).toContain('Existing fact: Bob works at Google');
		expect(result).toContain('New fact: Bob worked at Google before quitting');
	});
});
