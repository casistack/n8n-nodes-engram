import { CommunityDetector } from '../../../src/community/CommunityDetector';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';

describe('CommunityDetector', () => {
	let storage: GraphologyStorage;
	let detector: CommunityDetector;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
		detector = new CommunityDetector(storage);
	});

	afterEach(async () => {
		await storage.close();
	});

	it('should detect two distinct communities', async () => {
		// Cluster 1: Alice, Bob, Carol (fully connected)
		const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1', entity_type: 'person' });
		const bob = await storage.addEntity({ name: 'Bob', group_id: 'g1', entity_type: 'person' });
		const carol = await storage.addEntity({ name: 'Carol', group_id: 'g1', entity_type: 'person' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: alice.uuid, target_node_uuid: bob.uuid, name: 'KNOWS', fact: 'Alice knows Bob' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: bob.uuid, target_node_uuid: carol.uuid, name: 'KNOWS', fact: 'Bob knows Carol' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: alice.uuid, target_node_uuid: carol.uuid, name: 'KNOWS', fact: 'Alice knows Carol' });

		// Cluster 2: Acme, Widget Corp (connected)
		const acme = await storage.addEntity({ name: 'Acme', group_id: 'g1', entity_type: 'org' });
		const widget = await storage.addEntity({ name: 'Widget Corp', group_id: 'g1', entity_type: 'org' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: acme.uuid, target_node_uuid: widget.uuid, name: 'PARTNER', fact: 'Acme partners with Widget Corp' });

		const result = await detector.detect('g1');

		expect(result.communities).toHaveLength(2);
		expect(result.total_entities).toBe(5);
		expect(result.unclustered_entities).toBe(0);
		expect(result.detection_method).toBe('label_propagation');

		// Largest community first
		expect(result.communities[0].entity_count).toBe(3);
		expect(result.communities[1].entity_count).toBe(2);
	});

	it('should filter out communities smaller than minCommunitySize', async () => {
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		const c = await storage.addEntity({ name: 'C', group_id: 'g1' }); // Isolated
		await storage.addEdge({ group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid, name: 'LINK', fact: 'A to B' });

		const result = await detector.detect('g1', { minCommunitySize: 2 });

		expect(result.communities).toHaveLength(1);
		expect(result.communities[0].entity_count).toBe(2);
		expect(result.unclustered_entities).toBe(1);
	});

	it('should handle empty graph', async () => {
		const result = await detector.detect('g1');

		expect(result.communities).toHaveLength(0);
		expect(result.total_entities).toBe(0);
		expect(result.unclustered_entities).toBe(0);
	});

	it('should handle single entity', async () => {
		await storage.addEntity({ name: 'Alone', group_id: 'g1' });

		const result = await detector.detect('g1', { minCommunitySize: 2 });

		expect(result.communities).toHaveLength(0);
		expect(result.total_entities).toBe(1);
		expect(result.unclustered_entities).toBe(1);
	});

	it('should identify key entities by connectivity', async () => {
		// Hub-and-spoke: Hub connects to A, B, C
		const hub = await storage.addEntity({ name: 'Hub', group_id: 'g1' });
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		const c = await storage.addEntity({ name: 'C', group_id: 'g1' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: hub.uuid, target_node_uuid: a.uuid, name: 'L', fact: 'Hub to A' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: hub.uuid, target_node_uuid: b.uuid, name: 'L', fact: 'Hub to B' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: hub.uuid, target_node_uuid: c.uuid, name: 'L', fact: 'Hub to C' });

		const result = await detector.detect('g1', { minCommunitySize: 2 });

		expect(result.communities).toHaveLength(1);
		// Hub should be first key entity (most connections)
		expect(result.communities[0].key_entities[0]).toBe('Hub');
	});

	it('should skip expired edges when building adjacency', async () => {
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		await storage.addEdge({
			group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid,
			name: 'OLD', fact: 'A old link to B',
			expired_at: new Date().toISOString(),
		});

		const result = await detector.detect('g1', { minCommunitySize: 2 });

		// Expired edge should not connect A and B → no community
		expect(result.communities).toHaveLength(0);
		expect(result.unclustered_entities).toBe(2);
	});

	it('should generate community labels from key entities', async () => {
		const alice = await storage.addEntity({ name: 'Alice', group_id: 'g1' });
		const bob = await storage.addEntity({ name: 'Bob', group_id: 'g1' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: alice.uuid, target_node_uuid: bob.uuid, name: 'KNOWS', fact: 'Alice knows Bob' });

		const result = await detector.detect('g1');

		expect(result.communities[0].label).toContain('Alice');
		expect(result.communities[0].label).toContain('Bob');
	});

	it('should handle bridge between two clusters', async () => {
		// Cluster 1: A-B-C
		const a = await storage.addEntity({ name: 'A', group_id: 'g1' });
		const b = await storage.addEntity({ name: 'B', group_id: 'g1' });
		const c = await storage.addEntity({ name: 'C', group_id: 'g1' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: b.uuid, name: 'L', fact: 'A-B' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: b.uuid, target_node_uuid: c.uuid, name: 'L', fact: 'B-C' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: a.uuid, target_node_uuid: c.uuid, name: 'L', fact: 'A-C' });

		// Cluster 2: X-Y-Z
		const x = await storage.addEntity({ name: 'X', group_id: 'g1' });
		const y = await storage.addEntity({ name: 'Y', group_id: 'g1' });
		const z = await storage.addEntity({ name: 'Z', group_id: 'g1' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: x.uuid, target_node_uuid: y.uuid, name: 'L', fact: 'X-Y' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: y.uuid, target_node_uuid: z.uuid, name: 'L', fact: 'Y-Z' });
		await storage.addEdge({ group_id: 'g1', source_node_uuid: x.uuid, target_node_uuid: z.uuid, name: 'L', fact: 'X-Z' });

		// Single bridge edge
		await storage.addEdge({ group_id: 'g1', source_node_uuid: c.uuid, target_node_uuid: x.uuid, name: 'BRIDGE', fact: 'C bridges to X' });

		const result = await detector.detect('g1');

		// With a single bridge, label propagation may merge or keep separate
		// depending on topology. With 3 internal edges vs 1 bridge, communities
		// should likely remain separate or merge into one large group.
		// Either way, total entities should be 6
		const totalInCommunities = result.communities.reduce(
			(sum, c) => sum + c.entity_count, 0,
		);
		expect(totalInCommunities + result.unclustered_entities).toBe(6);
	});
});
