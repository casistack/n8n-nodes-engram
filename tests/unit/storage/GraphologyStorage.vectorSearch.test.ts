import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('GraphologyStorage - Vector Search', () => {
	let storage: GraphologyStorage;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
	});

	describe('searchEntitiesByVector', () => {
		it('should find entities with similar embeddings', async () => {
			await storage.addEntity({
				name: 'Alice',
				group_id: 'g1',
				entity_type: 'person',
				name_embedding: [1, 0, 0],
			});
			await storage.addEntity({
				name: 'Bob',
				group_id: 'g1',
				entity_type: 'person',
				name_embedding: [0.9, 0.1, 0],
			});
			await storage.addEntity({
				name: 'Charlie',
				group_id: 'g1',
				entity_type: 'person',
				name_embedding: [0, 0, 1],
			});

			const results = await storage.searchEntitiesByVector(
				[1, 0, 0],
				'g1',
			);

			// Alice should be first (exact match), Bob second (similar), Charlie last (orthogonal)
			expect(results.length).toBeGreaterThanOrEqual(2);
			expect(results[0].entity.name).toBe('Alice');
			expect(results[0].score).toBeCloseTo(1.0, 5);
			expect(results[1].entity.name).toBe('Bob');
		});

		it('should skip entities without embeddings', async () => {
			await storage.addEntity({
				name: 'WithEmbedding',
				group_id: 'g1',
				name_embedding: [1, 0, 0],
			});
			await storage.addEntity({
				name: 'WithoutEmbedding',
				group_id: 'g1',
				name_embedding: null,
			});

			const results = await storage.searchEntitiesByVector([1, 0, 0], 'g1');

			expect(results).toHaveLength(1);
			expect(results[0].entity.name).toBe('WithEmbedding');
		});

		it('should filter by groupId', async () => {
			await storage.addEntity({
				name: 'Group1Entity',
				group_id: 'g1',
				name_embedding: [1, 0, 0],
			});
			await storage.addEntity({
				name: 'Group2Entity',
				group_id: 'g2',
				name_embedding: [1, 0, 0],
			});

			const results = await storage.searchEntitiesByVector([1, 0, 0], 'g1');

			expect(results).toHaveLength(1);
			expect(results[0].entity.name).toBe('Group1Entity');
		});

		it('should respect limit option', async () => {
			for (let i = 0; i < 5; i++) {
				await storage.addEntity({
					name: `Entity${i}`,
					group_id: 'g1',
					name_embedding: [1, 0, 0],
				});
			}

			const results = await storage.searchEntitiesByVector(
				[1, 0, 0],
				'g1',
				{ limit: 2 },
			);

			expect(results).toHaveLength(2);
		});

		it('should respect min_score option', async () => {
			await storage.addEntity({
				name: 'Similar',
				group_id: 'g1',
				name_embedding: [0.9, 0.1, 0],
			});
			await storage.addEntity({
				name: 'Different',
				group_id: 'g1',
				name_embedding: [0, 0, 1],
			});

			const results = await storage.searchEntitiesByVector(
				[1, 0, 0],
				'g1',
				{ min_score: 0.5 },
			);

			expect(results).toHaveLength(1);
			expect(results[0].entity.name).toBe('Similar');
		});

		it('should skip entities with mismatched embedding dimensions', async () => {
			await storage.addEntity({
				name: 'Dim3',
				group_id: 'g1',
				name_embedding: [1, 0, 0],
			});
			await storage.addEntity({
				name: 'Dim5',
				group_id: 'g1',
				name_embedding: [1, 0, 0, 0, 0],
			});

			// Query with 3 dimensions — should only match Dim3
			const results = await storage.searchEntitiesByVector([1, 0, 0], 'g1');

			expect(results).toHaveLength(1);
			expect(results[0].entity.name).toBe('Dim3');
		});
	});

	describe('searchEdgesByVector', () => {
		it('should find edges with similar fact embeddings', async () => {
			const source = await storage.addEntity({
				name: 'Alice',
				group_id: 'g1',
			});
			const target = await storage.addEntity({
				name: 'Acme Corp',
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
			await storage.addEdge({
				group_id: 'g1',
				source_node_uuid: source.uuid,
				target_node_uuid: target.uuid,
				name: 'LIKES',
				fact: 'Alice likes Acme Corp',
				fact_embedding: [0, 0, 1],
			});

			const results = await storage.searchEdgesByVector([1, 0, 0], 'g1');

			expect(results).toHaveLength(2);
			expect(results[0].edge.name).toBe('WORKS_AT');
			expect(results[0].score).toBeCloseTo(1.0, 5);
			expect(results[0].sourceEntity.name).toBe('Alice');
			expect(results[0].targetEntity.name).toBe('Acme Corp');
		});

		it('should skip edges without fact_embedding', async () => {
			const source = await storage.addEntity({ name: 'A', group_id: 'g1' });
			const target = await storage.addEntity({ name: 'B', group_id: 'g1' });

			await storage.addEdge({
				group_id: 'g1',
				source_node_uuid: source.uuid,
				target_node_uuid: target.uuid,
				name: 'REL',
				fact: 'some fact',
				fact_embedding: null,
			});

			const results = await storage.searchEdgesByVector([1, 0, 0], 'g1');
			expect(results).toHaveLength(0);
		});

		it('should skip edges with mismatched embedding dimensions', async () => {
			const source = await storage.addEntity({ name: 'A', group_id: 'g1' });
			const target = await storage.addEntity({ name: 'B', group_id: 'g1' });

			await storage.addEdge({
				group_id: 'g1',
				source_node_uuid: source.uuid,
				target_node_uuid: target.uuid,
				name: 'REL',
				fact: 'some fact',
				fact_embedding: [1, 0, 0, 0, 0],
			});

			const results = await storage.searchEdgesByVector([1, 0, 0], 'g1');
			expect(results).toHaveLength(0);
		});
	});
});
