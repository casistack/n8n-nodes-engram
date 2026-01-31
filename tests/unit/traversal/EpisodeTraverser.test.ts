import { EpisodeTraverser } from '../../../src/traversal/EpisodeTraverser';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

const now = () => new Date().toISOString();

describe('EpisodeTraverser', () => {
	let storage: GraphologyStorage;
	let traverser: EpisodeTraverser;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		traverser = new EpisodeTraverser();
	});

	afterEach(async () => {
		await storage.close();
	});

	it('should traverse from entities linked to recent episodes', async () => {
		// Create entities
		const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1', entity_type: 'person' });
		const bob = await storage.addEntity({ name: 'Bob', group_id: 'g1', entity_type: 'person' });
		const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1', entity_type: 'org' });

		// Create episodes
		const ep1 = await storage.addEpisode({
			group_id: 'g1', content: 'Alice works at Acme', role: 'human', reference_time: now(),
		});

		// Create edges linked to episode
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: alice.uuid,
			target_node_uuid: acme.uuid,
			name: 'WORKS_AT',
			fact: 'Alice works at Acme',
			episodes: [ep1.uuid],
		});
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: bob.uuid,
			target_node_uuid: acme.uuid,
			name: 'WORKS_AT',
			fact: 'Bob works at Acme',
			// Not linked to any episode
		});

		const result = await traverser.traverseFromRecentEpisodes(storage, 'g1', {
			episodeCount: 5,
			maxHops: 1,
		});

		// Should start from Alice and Acme (linked to ep1), then reach Bob via Acme
		const names = result.entities.map((e) => e.name).sort();
		expect(names).toContain('Alice');
		expect(names).toContain('Acme');
	});

	it('should return empty result for group with no episodes', async () => {
		const result = await traverser.traverseFromRecentEpisodes(storage, 'g1');

		expect(result.entities).toHaveLength(0);
		expect(result.edges).toHaveLength(0);
		expect(result.context).toBe('');
	});

	it('should fallback to recent entities when no episode-linked edges exist', async () => {
		// Create entities without episode-linked edges
		const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
		const bob = await storage.addEntity({ name: 'Bob', group_id: 'g1' });
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: alice.uuid,
			target_node_uuid: bob.uuid,
			name: 'KNOWS',
			fact: 'Alice knows Bob',
			// No episodes array
		});

		// Create episode (not referenced by any edge)
		await storage.addEpisode({
			group_id: 'g1', content: 'Hello', role: 'human', reference_time: now(),
		});

		const result = await traverser.traverseFromRecentEpisodes(storage, 'g1', {
			maxHops: 1,
		});

		// Should fall back to recent entities
		expect(result.entities.length).toBeGreaterThanOrEqual(1);
	});

	it('should respect maxHops and maxEntities options', async () => {
		// Build a chain: A -> B -> C -> D -> E
		const entities = [];
		for (const name of ['A', 'B', 'C', 'D', 'E']) {
			entities.push(await storage.addEntity({ name, group_id: 'g1' }));
		}

		const ep = await storage.addEpisode({ group_id: 'g1', content: 'test', role: 'human', reference_time: now() });

		// Link first edge to episode
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: entities[0].uuid,
			target_node_uuid: entities[1].uuid,
			name: 'NEXT', fact: 'A to B',
			episodes: [ep.uuid],
		});
		for (let i = 1; i < entities.length - 1; i++) {
			await storage.addEdge({
				group_id: 'g1',
				source_node_uuid: entities[i].uuid,
				target_node_uuid: entities[i + 1].uuid,
				name: 'NEXT', fact: `${entities[i].name} to ${entities[i + 1].name}`,
			});
		}

		const result = await traverser.traverseFromRecentEpisodes(storage, 'g1', {
			maxHops: 1,
			maxEntities: 3,
		});

		expect(result.entities.length).toBeLessThanOrEqual(3);
	});

	it('should handle multiple episodes correctly', async () => {
		const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
		const bob = await storage.addEntity({ name: 'Bob', group_id: 'g1' });
		const carol = await storage.addEntity({ name: 'Carol', group_id: 'g1' });

		const ep1 = await storage.addEpisode({ group_id: 'g1', content: 'msg1', role: 'human', reference_time: now() });
		const ep2 = await storage.addEpisode({ group_id: 'g1', content: 'msg2', role: 'ai', reference_time: now() });

		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: alice.uuid,
			target_node_uuid: bob.uuid,
			name: 'KNOWS', fact: 'Alice knows Bob',
			episodes: [ep1.uuid],
		});
		await storage.addEdge({
			group_id: 'g1',
			source_node_uuid: bob.uuid,
			target_node_uuid: carol.uuid,
			name: 'KNOWS', fact: 'Bob knows Carol',
			episodes: [ep2.uuid],
		});

		const result = await traverser.traverseFromRecentEpisodes(storage, 'g1', {
			episodeCount: 2,
			maxHops: 0,
		});

		// With maxHops: 0, should only return seed entities (from both episodes)
		const names = result.entities.map((e) => e.name).sort();
		expect(names).toContain('Alice');
		expect(names).toContain('Bob');
		expect(names).toContain('Carol');
	});
});
