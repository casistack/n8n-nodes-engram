import { GraphTraverser } from '../../../src/traversal/GraphTraverser';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('GraphTraverser', () => {
	let storage: GraphologyStorage;
	let traverser: GraphTraverser;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		traverser = new GraphTraverser();
	});

	afterEach(async () => {
		await storage.close();
	});

	async function buildLinearGraph() {
		// A --e1--> B --e2--> C --e3--> D
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		const c = await storage.addEntity({ name: 'C', group_id: 'g1' });
		const d = await storage.addEntity({ name: 'D', group_id: 'g1' });
		const e1 = await storage.addEdge({
			group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid,
			name: 'CONNECTS', fact: 'A connects to B',
		});
		const e2 = await storage.addEdge({
			group_id: 'g1', source_node_uuid: b.uuid, target_node_uuid: c.uuid,
			name: 'CONNECTS', fact: 'B connects to C',
		});
		const e3 = await storage.addEdge({
			group_id: 'g1', source_node_uuid: c.uuid, target_node_uuid: d.uuid,
			name: 'CONNECTS', fact: 'C connects to D',
		});
		return { a, b, c, d, e1, e2, e3 };
	}

	it('should traverse 1 hop from a seed entity', async () => {
		const { a, b } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 1 });

		expect(result.entities).toHaveLength(2);
		const names = result.entities.map((e) => e.name).sort();
		expect(names).toEqual(['A', 'B']);
		expect(result.seed_entities).toEqual([a.uuid]);
		expect(result.edges.length).toBeGreaterThanOrEqual(1);
	});

	it('should traverse 2 hops from a seed entity', async () => {
		const { a } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 2 });

		const names = result.entities.map((e) => e.name).sort();
		expect(names).toEqual(['A', 'B', 'C']);
	});

	it('should traverse the full chain with sufficient hops', async () => {
		const { a } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 5 });

		const names = result.entities.map((e) => e.name).sort();
		expect(names).toEqual(['A', 'B', 'C', 'D']);
	});

	it('should respect maxEntities cap', async () => {
		const { a } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid], {
			maxHops: 10,
			maxEntities: 2,
		});

		expect(result.entities).toHaveLength(2);
	});

	it('should handle cycles without infinite loop', async () => {
		// A <--> B (bidirectional cycle)
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		await storage.addEdge({
			group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid,
			name: 'KNOWS', fact: 'A knows B',
		});
		await storage.addEdge({
			group_id: 'g1', source_node_uuid: b.uuid, target_node_uuid: a.uuid,
			name: 'KNOWS', fact: 'B knows A',
		});

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 10 });

		expect(result.entities).toHaveLength(2);
	});

	it('should skip expired edges by default', async () => {
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		await storage.addEdge({
			group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid,
			name: 'OLD', fact: 'A old link to B',
			expired_at: new Date().toISOString(),
		});

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 2 });

		// Should only find A (B unreachable via expired edge)
		expect(result.entities).toHaveLength(1);
		expect(result.entities[0].name).toBe('A');
	});

	it('should include expired edges when requested', async () => {
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		await storage.addEdge({
			group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid,
			name: 'OLD', fact: 'A old link to B',
			expired_at: new Date().toISOString(),
		});

		const result = await traverser.traverse(storage, [a.uuid], {
			maxHops: 2,
			includeExpiredEdges: true,
		});

		expect(result.entities).toHaveLength(2);
	});

	it('should handle disconnected components', async () => {
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		// No edges between A and B

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 5 });

		expect(result.entities).toHaveLength(1);
		expect(result.entities[0].name).toBe('A');
	});

	it('should support multiple seed entities', async () => {
		const { a, d } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid, d.uuid], { maxHops: 1 });

		const names = result.entities.map((e) => e.name).sort();
		// A reaches B, D reaches C
		expect(names).toEqual(['A', 'B', 'C', 'D']);
	});

	it('should assign correct hop levels in paths', async () => {
		const { a } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 3 });

		const hopMap = new Map(result.paths.map((p) => [p.entity.name, p.hop]));
		expect(hopMap.get('A')).toBe(0);
		expect(hopMap.get('B')).toBe(1);
		expect(hopMap.get('C')).toBe(2);
		expect(hopMap.get('D')).toBe(3);
	});

	it('should generate formatted context string', async () => {
		const { a } = await buildLinearGraph();

		const result = await traverser.traverse(storage, [a.uuid], { maxHops: 1 });

		expect(result.context).toContain('Graph context (BFS traversal):');
		expect(result.context).toContain('Starting entities:');
		expect(result.context).toContain('1 hop away:');
		expect(result.context).toContain('A connects to B');
	});

	it('should return empty result for non-existent seed', async () => {
		const result = await traverser.traverse(storage, ['non-existent-uuid'], { maxHops: 2 });

		expect(result.entities).toHaveLength(0);
		expect(result.edges).toHaveLength(0);
		expect(result.context).toBe('');
	});

	it('should return empty result for empty seed list', async () => {
		const result = await traverser.traverse(storage, [], { maxHops: 2 });

		expect(result.entities).toHaveLength(0);
	});

	it('should apply edge filters before traversal enrichment', async () => {
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const accepted = await storage.addEntity({ name: 'Accepted', group_id: 'g1' });
		const rejected = await storage.addEntity({ name: 'Rejected', group_id: 'g1' });
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: a.uuid,
			target_node_uuid: accepted.uuid,
			name: 'ACCEPTED',
			fact: 'Accepted traversal fact',
		});
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: a.uuid,
			target_node_uuid: rejected.uuid,
			name: 'REJECTED',
			fact: 'Rejected traversal fact',
		});

		const result = await traverser.traverse(storage, [a.uuid], {
			maxHops: 1,
			edgeFilter: (edge) => edge.name !== 'REJECTED',
		});

		expect(result.entities.map((entity) => entity.name).sort()).toEqual(['A', 'Accepted']);
		expect(result.context).not.toContain('Rejected traversal fact');
	});
});
