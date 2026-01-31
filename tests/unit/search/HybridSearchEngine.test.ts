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
});
