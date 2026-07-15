import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import { HybridSearchEngine } from '../../../src/search/HybridSearchEngine';

describe('HybridSearchEngine', () => {
	let storage: GraphologyStorage;
	let searchEngine: HybridSearchEngine;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		searchEngine = new HybridSearchEngine(storage);

		// Seed test data
		const alice = await storage.addEntity({
			name: 'Alice',
			group_id: 'test',
			summary: 'A software engineer who loves TypeScript',
			entity_type: 'person',
		});
		const bob = await storage.addEntity({
			name: 'Bob',
			group_id: 'test',
			summary: 'A data scientist working on machine learning',
			entity_type: 'person',
		});
		const acme = await storage.addEntity({
			name: 'Acme Corp',
			group_id: 'test',
			summary: 'A technology company based in Berlin',
			entity_type: 'organization',
		});

		await storage.addEdge({
			group_id: 'test',
			source_node_uuid: alice.uuid,
			target_node_uuid: acme.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Acme Corp as a senior engineer',
		});
		await storage.addEdge({
			group_id: 'test',
			source_node_uuid: bob.uuid,
			target_node_uuid: acme.uuid,
			name: 'WORKS_AT',
			fact: 'Bob works at Acme Corp in the data science team',
		});
	});

	afterEach(async () => {
		await storage.close();
	});

	it('should search both entities and edges', async () => {
		const results = await searchEngine.search('Alice engineer', 'test');

		expect(results.entities.length).toBeGreaterThan(0);
		expect(results.edges.length).toBeGreaterThan(0);
		expect(results.audit).toBeUndefined();
	});

	it('should return bounded and redacted diagnostics only when explicitly enabled', async () => {
		const results = await searchEngine.search('  Alice   sk-1234567890  ', 'test', {
			includeDiagnostics: true,
			diagnosticsCandidateLimit: 1,
		});

		expect(results.audit).toEqual(
			expect.objectContaining({
				normalized_query: 'Alice [REDACTED]',
				search_mode: 'text',
				candidate_limit: 1,
			}),
		);
		expect(results.audit!.candidate_decisions.length).toBeLessThanOrEqual(1);
		expect(JSON.stringify(results.audit)).not.toContain('sk-1234567890');
		expect(JSON.stringify(results.audit)).not.toContain('test-key');
	});

	it('should search entities by name', async () => {
		const entities = await searchEngine.searchEntities('Alice', 'test');

		expect(entities.length).toBeGreaterThan(0);
		expect(entities[0].entity.name).toBe('Alice');
	});

	it('should search edges by fact content', async () => {
		const edges = await searchEngine.searchEdges('data science', 'test');

		expect(edges.length).toBeGreaterThan(0);
		expect(edges[0].edge.fact).toContain('data science');
		expect(edges[0].sourceEntity.name).toBe('Bob');
		expect(edges[0].targetEntity.name).toBe('Acme Corp');
	});

	it('should attach explicit provenance to every hybrid-search fact', async () => {
		const results = await searchEngine.search('Alice works', 'test');
		expect(results.edges[0].provenance).toEqual([
			expect.objectContaining({
				source_episode_uuid: null,
				fact_review_status: 'accepted',
			}),
		]);
		const context = searchEngine.formatAsContext(results, 500, true);
		expect(context).toContain('confidence=unknown review=accepted');
		expect(context).toContain('episode=none');
	});

	it('should filter by group_id', async () => {
		// Add entity in different group
		await storage.addEntity({
			name: 'Charlie',
			group_id: 'other-group',
			summary: 'A designer',
			entity_type: 'person',
		});

		const results = await searchEngine.search('Charlie', 'test');
		expect(results.entities).toHaveLength(0);
	});

	it('should respect limit', async () => {
		const results = await searchEngine.search('works', 'test', { limit: 1 });
		expect(results.edges.length).toBeLessThanOrEqual(1);
	});

	it('should format search results as context string', async () => {
		const results = await searchEngine.search('Alice Acme', 'test');
		const context = searchEngine.formatAsContext(results);

		expect(context).toContain('Known');
		expect(context).toContain('Alice');
	});

	it('should handle empty query', async () => {
		const results = await searchEngine.search('', 'test');
		expect(results.entities).toHaveLength(0);
		expect(results.edges).toHaveLength(0);
	});

	it('should return empty for non-matching query', async () => {
		const results = await searchEngine.search('zzzznonexistent', 'test');
		expect(results.entities).toHaveLength(0);
		expect(results.edges).toHaveLength(0);
	});

	it('should exclude proposed and rejected extraction records when accepted-only is enabled', async () => {
		const alice = await storage.getEntityByName('Alice', 'test');
		const acme = await storage.getEntityByName('Acme Corp', 'test');
		await storage.addEdge({
			group_id: 'test',
			source_node_uuid: alice!.uuid,
			target_node_uuid: acme!.uuid,
			name: 'SECRET_PROJECT',
			fact: 'Alice may lead the secretproject initiative',
			attributes: {
				engram_extraction: {
					version: 2,
					source: 'llm',
					confidence: 0.5,
					review_status: 'proposed',
					threshold_decision: 'pending_review',
					extracted_at: '2026-07-15T10:00:00.000Z',
					episode_uuids: [],
				},
			},
		});
		await storage.addEntity({
			name: 'RejectedProject',
			group_id: 'test',
			summary: 'A rejected secretproject entity',
			attributes: {
				engram_extraction: {
					version: 2,
					source: 'llm',
					confidence: 0.1,
					review_status: 'rejected',
					threshold_decision: 'below_threshold',
					extracted_at: '2026-07-15T10:00:00.000Z',
					episode_uuids: [],
				},
			},
		});

		const unrestricted = await searchEngine.search('secretproject', 'test');
		expect(unrestricted.edges).toHaveLength(1);
		expect(unrestricted.entities).toHaveLength(1);

		const acceptedOnly = await searchEngine.search('secretproject', 'test', {
			acceptedOnly: true,
			includeDiagnostics: true,
		});
		expect(acceptedOnly.edges).toHaveLength(0);
		expect(acceptedOnly.entities).toHaveLength(0);
		expect(acceptedOnly.audit!.candidate_decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					included: false,
					reasons: ['review_status_filtered'],
				}),
			]),
		);
	});
});
