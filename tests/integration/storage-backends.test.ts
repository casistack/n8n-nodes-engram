/**
 * Integration test: Storage backend parity
 *
 * Tests that the GraphologyStorage (embedded) backend implements
 * the full IGraphStorage contract correctly. This serves as the
 * conformance suite that any backend (including Neo4j) must pass.
 *
 * Neo4j tests are skipped by default since they require a running
 * Neo4j instance. Set NEO4J_TEST_URI environment variable to enable.
 */
import { GraphologyStorage } from '../../src/storage/GraphologyStorage';
import type { IGraphStorage } from '../../src/storage/IGraphStorage';

/**
 * Runs the full IGraphStorage conformance suite against a storage backend.
 */
function runStorageConformanceSuite(
	name: string,
	createBackend: () => Promise<IGraphStorage>,
) {
	describe(`${name} - IGraphStorage conformance`, () => {
		let storage: IGraphStorage;

		beforeEach(async () => {
			storage = await createBackend();
			await storage.initialize();
		});

		afterEach(async () => {
			await storage.clearAll();
			await storage.close();
		});

		// ===== Entity CRUD =====

		describe('entity operations', () => {
			it('should add and retrieve an entity', async () => {
				const entity = await storage.addEntity({
					name: 'Alice',
					group_id: 'test',
					summary: 'A person',
					entity_type: 'person',
				});

				expect(entity.uuid).toBeDefined();
				expect(entity.name).toBe('Alice');
				expect(entity.group_id).toBe('test');
				expect(entity.entity_type).toBe('person');
				expect(entity.created_at).toBeDefined();

				const retrieved = await storage.getEntity(entity.uuid);
				expect(retrieved).not.toBeNull();
				expect(retrieved!.name).toBe('Alice');
			});

			it('should return null for non-existent entity', async () => {
				const result = await storage.getEntity('nonexistent-uuid');
				expect(result).toBeNull();
			});

			it('should find entity by name and group', async () => {
				await storage.addEntity({
					name: 'Bob',
					group_id: 'grp1',
					summary: 'A developer',
					entity_type: 'person',
				});

				const found = await storage.getEntityByName('Bob', 'grp1');
				expect(found).not.toBeNull();
				expect(found!.name).toBe('Bob');

				// Case insensitive
				const foundLower = await storage.getEntityByName('bob', 'grp1');
				expect(foundLower).not.toBeNull();

				// Wrong group
				const notFound = await storage.getEntityByName('Bob', 'grp2');
				expect(notFound).toBeNull();
			});

			it('should update an entity', async () => {
				const entity = await storage.addEntity({
					name: 'Charlie',
					group_id: 'test',
					summary: 'Original summary',
					entity_type: 'person',
				});

				await new Promise((r) => setTimeout(r, 5));

				const updated = await storage.updateEntity(entity.uuid, {
					summary: 'Updated summary',
				});

				expect(updated.summary).toBe('Updated summary');
				expect(updated.name).toBe('Charlie');
				expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
					new Date(entity.created_at).getTime(),
				);
			});

			it('should delete an entity', async () => {
				const entity = await storage.addEntity({
					name: 'DeleteMe',
					group_id: 'test',
					summary: 'To be deleted',
					entity_type: 'test',
				});

				await storage.deleteEntity(entity.uuid);
				const result = await storage.getEntity(entity.uuid);
				expect(result).toBeNull();
			});

			it('should list entities for a group', async () => {
				await storage.addEntity({ name: 'E1', group_id: 'list-test', entity_type: 'a' });
				await storage.addEntity({ name: 'E2', group_id: 'list-test', entity_type: 'b' });
				await storage.addEntity({ name: 'E3', group_id: 'other', entity_type: 'a' });

				const entities = await storage.listEntities('list-test');
				expect(entities).toHaveLength(2);

				// Filter by type
				const typeFiltered = await storage.listEntities('list-test', {
					entity_type: 'a',
				});
				expect(typeFiltered).toHaveLength(1);
				expect(typeFiltered[0].name).toBe('E1');

				// Limit
				const limited = await storage.listEntities('list-test', { limit: 1 });
				expect(limited).toHaveLength(1);
			});
		});

		// ===== Edge CRUD =====

		describe('edge operations', () => {
			let sourceUuid: string;
			let targetUuid: string;

			beforeEach(async () => {
				const source = await storage.addEntity({
					name: 'Source',
					group_id: 'test',
					entity_type: 'test',
				});
				const target = await storage.addEntity({
					name: 'Target',
					group_id: 'test',
					entity_type: 'test',
				});
				sourceUuid = source.uuid;
				targetUuid = target.uuid;
			});

			it('should add and retrieve an edge', async () => {
				const edge = await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: targetUuid,
					name: 'RELATES_TO',
					fact: 'Source relates to Target',
				});

				expect(edge.uuid).toBeDefined();
				expect(edge.name).toBe('RELATES_TO');
				expect(edge.source_node_uuid).toBe(sourceUuid);
				expect(edge.target_node_uuid).toBe(targetUuid);

				const retrieved = await storage.getEdge(edge.uuid);
				expect(retrieved).not.toBeNull();
				expect(retrieved!.fact).toBe('Source relates to Target');
			});

			it('should get edges between two entities', async () => {
				await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: targetUuid,
					name: 'KNOWS',
					fact: 'First relationship',
				});
				await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: targetUuid,
					name: 'WORKS_WITH',
					fact: 'Second relationship',
				});

				const edges = await storage.getEdgesBetween(sourceUuid, targetUuid);
				expect(edges).toHaveLength(2);
			});

			it('should get all edges for an entity', async () => {
				const third = await storage.addEntity({
					name: 'Third',
					group_id: 'test',
					entity_type: 'test',
				});

				await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: targetUuid,
					name: 'KNOWS',
					fact: 'Edge 1',
				});
				await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: third.uuid,
					name: 'LIKES',
					fact: 'Edge 2',
				});

				const edges = await storage.getEdgesForEntity(sourceUuid);
				expect(edges).toHaveLength(2);
			});

			it('should update an edge', async () => {
				const edge = await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: targetUuid,
					name: 'TEST',
					fact: 'Original fact',
				});

				await new Promise((r) => setTimeout(r, 5));

				const updated = await storage.updateEdge(edge.uuid, {
					fact: 'Updated fact',
					expired_at: new Date().toISOString(),
				});

				expect(updated.fact).toBe('Updated fact');
				expect(updated.expired_at).not.toBeNull();
			});

			it('should delete an edge', async () => {
				const edge = await storage.addEdge({
					group_id: 'test',
					source_node_uuid: sourceUuid,
					target_node_uuid: targetUuid,
					name: 'TEMP',
					fact: 'Temporary',
				});

				await storage.deleteEdge(edge.uuid);
				const result = await storage.getEdge(edge.uuid);
				expect(result).toBeNull();
			});
		});

		// ===== Episode Operations =====

		describe('episode operations', () => {
			it('should add and retrieve an episode', async () => {
				const episode = await storage.addEpisode({
					group_id: 'test',
					content: 'Hello world',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				expect(episode.uuid).toBeDefined();
				expect(episode.content).toBe('Hello world');
				expect(episode.role).toBe('human');

				const retrieved = await storage.getEpisode(episode.uuid);
				expect(retrieved).not.toBeNull();
				expect(retrieved!.content).toBe('Hello world');
			});

			it('should get recent episodes in chronological order', async () => {
				for (let i = 1; i <= 5; i++) {
					await storage.addEpisode({
						group_id: 'test',
						content: `Episode ${i}`,
						role: 'human',
						reference_time: new Date().toISOString(),
					});
					await new Promise((r) => setTimeout(r, 5));
				}

				const recent = await storage.getRecentEpisodes('test', 3);
				expect(recent).toHaveLength(3);
				// Chronological order (oldest first)
				expect(recent[0].content).toBe('Episode 3');
				expect(recent[1].content).toBe('Episode 4');
				expect(recent[2].content).toBe('Episode 5');
			});

			it('should count episodes per group', async () => {
				await storage.addEpisode({
					group_id: 'grp1',
					content: 'ep1',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				await storage.addEpisode({
					group_id: 'grp1',
					content: 'ep2',
					role: 'ai',
					reference_time: new Date().toISOString(),
				});
				await storage.addEpisode({
					group_id: 'grp2',
					content: 'ep3',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				expect(await storage.getEpisodeCount('grp1')).toBe(2);
				expect(await storage.getEpisodeCount('grp2')).toBe(1);
			});

			it('should chain episodes via previous_episode_uuid', async () => {
				const ep1 = await storage.addEpisode({
					group_id: 'test',
					content: 'First',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				const ep2 = await storage.addEpisode({
					group_id: 'test',
					content: 'Second',
					role: 'ai',
					reference_time: new Date().toISOString(),
					previous_episode_uuid: ep1.uuid,
				});

				expect(ep2.previous_episode_uuid).toBe(ep1.uuid);
			});
		});

		// ===== Search =====

		describe('search operations', () => {
			beforeEach(async () => {
				const alice = await storage.addEntity({
					name: 'Alice',
					group_id: 'search-test',
					summary: 'Software engineer who codes in TypeScript',
					entity_type: 'person',
				});
				const bob = await storage.addEntity({
					name: 'Bob',
					group_id: 'search-test',
					summary: 'Data scientist working with Python and ML',
					entity_type: 'person',
				});
				const acme = await storage.addEntity({
					name: 'Acme Corp',
					group_id: 'search-test',
					summary: 'Technology company in Berlin',
					entity_type: 'organization',
				});

				await storage.addEdge({
					group_id: 'search-test',
					source_node_uuid: alice.uuid,
					target_node_uuid: acme.uuid,
					name: 'WORKS_AT',
					fact: 'Alice works at Acme Corp as a TypeScript engineer',
				});
				await storage.addEdge({
					group_id: 'search-test',
					source_node_uuid: bob.uuid,
					target_node_uuid: acme.uuid,
					name: 'WORKS_AT',
					fact: 'Bob leads the machine learning team at Acme Corp',
				});
			});

			it('should search entities by text', async () => {
				const results = await storage.searchEntities(
					'TypeScript engineer',
					'search-test',
				);
				expect(results.length).toBeGreaterThan(0);
				expect(results[0].entity.name).toBe('Alice');
				expect(results[0].score).toBeGreaterThan(0);
			});

			it('should search edges by fact content', async () => {
				const results = await storage.searchEdges(
					'machine learning',
					'search-test',
				);
				expect(results.length).toBeGreaterThan(0);
				expect(results[0].edge.fact).toContain('machine learning');
				expect(results[0].sourceEntity.name).toBe('Bob');
				expect(results[0].targetEntity.name).toBe('Acme Corp');
			});

			it('should filter search by group_id', async () => {
				const results = await storage.searchEntities('Alice', 'wrong-group');
				expect(results).toHaveLength(0);
			});
		});

		// ===== Graph Management =====

		describe('graph management', () => {
			it('should clear all data for a group', async () => {
				await storage.addEntity({ name: 'Keep', group_id: 'keep' });
				await storage.addEntity({ name: 'Remove', group_id: 'remove' });
				await storage.addEpisode({
					group_id: 'remove',
					content: 'bye',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				await storage.clearGroup('remove');

				const kept = await storage.listEntities('keep');
				expect(kept).toHaveLength(1);

				const removed = await storage.listEntities('remove');
				expect(removed).toHaveLength(0);

				const epCount = await storage.getEpisodeCount('remove');
				expect(epCount).toBe(0);
			});

			it('should clear all data', async () => {
				await storage.addEntity({ name: 'E1', group_id: 'g1' });
				await storage.addEntity({ name: 'E2', group_id: 'g2' });

				await storage.clearAll();

				const stats = await storage.getStats();
				expect(stats.entity_count).toBe(0);
				expect(stats.episode_count).toBe(0);
			});

			it('should export and import graph data', async () => {
				const entity = await storage.addEntity({
					name: 'Export',
					group_id: 'exp',
					summary: 'Exportable entity',
					entity_type: 'test',
				});
				await storage.addEpisode({
					group_id: 'exp',
					content: 'episode data',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				const exported = await storage.exportGraph('exp');
				expect(exported.entities).toHaveLength(1);
				expect(exported.episodes).toHaveLength(1);
				expect(exported.version).toBe('1.0');
				expect(exported.group_id).toBe('exp');

				// Clear and reimport
				await storage.clearAll();
				await storage.importGraph(exported);

				const reimported = await storage.getEntity(entity.uuid);
				expect(reimported).not.toBeNull();
				expect(reimported!.name).toBe('Export');
			});

			it('should return accurate stats', async () => {
				await storage.addEntity({ name: 'P1', group_id: 'stats', entity_type: 'person' });
				await storage.addEntity({ name: 'P2', group_id: 'stats', entity_type: 'person' });
				await storage.addEntity({ name: 'O1', group_id: 'stats', entity_type: 'org' });
				await storage.addEpisode({
					group_id: 'stats',
					content: 'ep',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				const stats = await storage.getStats('stats');
				expect(stats.entity_count).toBe(3);
				expect(stats.episode_count).toBe(1);
				expect(stats.group_ids).toContain('stats');
				expect(stats.entity_types['person']).toBe(2);
				expect(stats.entity_types['org']).toBe(1);
			});
		});

		// ===== Retention =====

		describe('retention policies', () => {
			it('should not remove anything with "forever" policy', async () => {
				await storage.addEpisode({
					group_id: 'ret',
					content: 'keep',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				const removed = await storage.applyRetention('ret', { type: 'forever' });
				expect(removed).toBe(0);
				expect(await storage.getEpisodeCount('ret')).toBe(1);
			});

			it('should enforce max_episodes retention', async () => {
				for (let i = 0; i < 5; i++) {
					await storage.addEpisode({
						group_id: 'ret-max',
						content: `ep${i}`,
						role: 'human',
						reference_time: new Date().toISOString(),
					});
					await new Promise((r) => setTimeout(r, 5));
				}

				const removed = await storage.applyRetention('ret-max', {
					type: 'max_episodes',
					value: 3,
				});
				expect(removed).toBe(2);
				expect(await storage.getEpisodeCount('ret-max')).toBe(3);
			});
		});
	});
}

// Run conformance suite against embedded backend
runStorageConformanceSuite('GraphologyStorage (embedded)', async () => {
	return new GraphologyStorage();
});

// Neo4j conformance suite - only runs if NEO4J_TEST_URI is set
const neo4jUri = process.env.NEO4J_TEST_URI;
if (neo4jUri) {
	const neo4jUser = process.env.NEO4J_TEST_USERNAME ?? 'neo4j';
	const neo4jPassword = process.env.NEO4J_TEST_PASSWORD ?? 'password';
	const neo4jDatabase = process.env.NEO4J_TEST_DATABASE ?? 'neo4j';

	runStorageConformanceSuite('Neo4jStorage (remote)', async () => {
		const { Neo4jStorage } = await import('../../src/storage/Neo4jStorage');
		return new Neo4jStorage(neo4jUri, neo4jUser, neo4jPassword, neo4jDatabase);
	});
} else {
	describe('Neo4jStorage (remote)', () => {
		it.skip('skipped - set NEO4J_TEST_URI to enable', () => {});
	});
}
