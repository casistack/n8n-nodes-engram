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
import neo4j from 'neo4j-driver';

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

			it('should append episodes with an atomic per-group chain', async () => {
				const first = await storage.appendEpisode({
					group_id: 'append-chain',
					content: 'First',
					role: 'human',
					episode_kind: 'active_human',
					reference_time: new Date().toISOString(),
				});
				const second = await storage.appendEpisode({
					group_id: 'append-chain',
					content: 'Second',
					role: 'ai',
					episode_kind: 'assistant_reply',
					reference_time: new Date().toISOString(),
				});

				expect(first.created).toBe(true);
				expect(first.episode.previous_episode_uuid).toBeNull();
				expect(second.created).toBe(true);
				expect(second.episode.previous_episode_uuid).toBe(first.episode.uuid);
			});

			it('should preserve addEpisode explicit-chain compatibility', async () => {
				await storage.addEpisode({
					group_id: 'compatibility-chain',
					content: 'First unchained episode',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				const second = await storage.addEpisode({
					group_id: 'compatibility-chain',
					content: 'Second unchained episode',
					role: 'human',
					reference_time: new Date().toISOString(),
				});

				expect(second.previous_episode_uuid).toBeNull();
			});

			it('should deduplicate retries by source message and episode kind', async () => {
				const input = {
					group_id: 'source-dedup',
					content: 'Delivered once',
					role: 'human' as const,
					episode_kind: 'active_human' as const,
					source_message_id: 'message-42',
					reference_time: new Date().toISOString(),
				};

				const results = await Promise.all(
					Array.from({ length: 8 }, () => storage.appendEpisode(input)),
				);

				expect(new Set(results.map((result) => result.episode.uuid)).size).toBe(1);
				expect(results.filter((result) => result.created)).toHaveLength(1);
				expect(await storage.getEpisodeCount('source-dedup')).toBe(1);

				const differentKind = await storage.appendEpisode({
					...input,
					role: 'ai',
					episode_kind: 'assistant_reply',
				});
				expect(differentKind.created).toBe(true);
				expect(await storage.getEpisodeCount('source-dedup')).toBe(2);
			});

			it('should deduplicate caller idempotency keys within a group', async () => {
				const first = await storage.appendEpisode({
					group_id: 'key-dedup',
					content: 'Original content',
					role: 'human',
					idempotency_key: 'request-7',
					reference_time: new Date().toISOString(),
				});
				const retry = await storage.appendEpisode({
					group_id: 'key-dedup',
					content: 'Retry content must not overwrite the original',
					role: 'human',
					idempotency_key: 'request-7',
					reference_time: new Date().toISOString(),
				});

				expect(first.created).toBe(true);
				expect(retry.created).toBe(false);
				expect(retry.episode.uuid).toBe(first.episode.uuid);
				expect(retry.episode.content).toBe('Original content');

				const otherGroup = await storage.appendEpisode({
					group_id: 'other-key-dedup-group',
					content: 'Same key in another group',
					role: 'human',
					idempotency_key: 'request-7',
					reference_time: new Date().toISOString(),
				});
				expect(otherGroup.created).toBe(true);
			});

			it('should reject idempotency identifiers that resolve to different episodes', async () => {
				await storage.appendEpisode({
					group_id: 'dedup-conflict',
					content: 'First',
					role: 'human',
					episode_kind: 'active_human',
					source_message_id: 'source-a',
					idempotency_key: 'key-a',
					reference_time: new Date().toISOString(),
				});
				await storage.appendEpisode({
					group_id: 'dedup-conflict',
					content: 'Second',
					role: 'human',
					episode_kind: 'active_human',
					source_message_id: 'source-b',
					idempotency_key: 'key-b',
					reference_time: new Date().toISOString(),
				});

				await expect(
					storage.appendEpisode({
						group_id: 'dedup-conflict',
						content: 'Conflicting retry',
						role: 'human',
						episode_kind: 'active_human',
						source_message_id: 'source-a',
						idempotency_key: 'key-b',
						reference_time: new Date().toISOString(),
					}),
				).rejects.toThrow('resolve to different existing episodes');
			});

			it('should serialize parallel distinct appends into one chain', async () => {
				await Promise.all(
					Array.from({ length: 12 }, (_, index) =>
						storage.appendEpisode({
							group_id: 'parallel-chain',
							content: `Episode ${index}`,
							role: 'human',
							episode_kind: 'active_human',
							source_message_id: `message-${index}`,
							reference_time: new Date().toISOString(),
						}),
					),
				);

				const episodes = await storage.getRecentEpisodes('parallel-chain', 20);
				expect(episodes).toHaveLength(12);
				expect(episodes[0].previous_episode_uuid).toBeNull();
				for (let index = 1; index < episodes.length; index++) {
					expect(episodes[index].previous_episode_uuid).toBe(episodes[index - 1].uuid);
				}
			});

			it('should list and count episodes with provenance filters and pagination', async () => {
				for (let index = 0; index < 5; index++) {
					await storage.appendEpisode({
						group_id: 'filtered-episodes',
						content: `Episode ${index}`,
						role: index % 2 === 0 ? 'human' : 'system',
						episode_kind: index % 2 === 0 ? 'active_human' : 'monitor_summary',
						trust_level: index % 2 === 0 ? 'trusted' : 'unverified',
						review_status: index < 3 ? 'accepted' : 'proposed',
						sender_id: index % 2 === 0 ? 'human-1' : 'monitor-1',
						sender_name: index % 2 === 0 ? 'Alice' : 'Monitor',
						source_workflow_id: index % 2 === 0 ? 'chat-workflow' : 'monitor-workflow',
						reference_time: new Date(Date.UTC(2026, 6, 1 + index)).toISOString(),
					});
				}

				const page = await storage.listEpisodes('filtered-episodes', {
					episode_kind: 'active_human',
					trust_level: 'trusted',
					sender_name: 'alice',
					sort_by: 'reference_time',
					sort_order: 'asc',
					offset: 1,
					limit: 1,
				});

				expect(page).toHaveLength(1);
				expect(page[0].content).toBe('Episode 2');
				expect(
					await storage.getEpisodeCount('filtered-episodes', {
						episode_kind: 'monitor_summary',
						source_workflow_id: 'monitor-workflow',
					}),
				).toBe(2);
			});

			it('should batch-load unique episodes by UUID', async () => {
				const first = await storage.appendEpisode({
					group_id: 'episode-batch',
					content: 'First',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				const second = await storage.appendEpisode({
					group_id: 'episode-batch',
					content: 'Second',
					role: 'ai',
					reference_time: new Date().toISOString(),
				});

				const episodes = await storage.getEpisodes([
					second.episode.uuid,
					first.episode.uuid,
					second.episode.uuid,
					'00000000-0000-4000-8000-000000000099',
				]);

				expect(new Set(episodes.map((episode) => episode.uuid))).toEqual(
					new Set([first.episode.uuid, second.episode.uuid]),
				);
			});

			it('should update mutable episode governance without changing identity fields', async () => {
				const created = await storage.appendEpisode({
					group_id: 'episode-update',
					content: 'Original',
					role: 'human',
					episode_kind: 'active_human',
					source_message_id: 'message-1',
					trust_level: 'unverified',
					reference_time: new Date().toISOString(),
				});

				const updated = await storage.updateEpisode(created.episode.uuid, {
					content: 'Reviewed content',
					sender_name: 'Alice',
					trust_level: 'trusted',
					confidence: 0.9,
					review_status: 'accepted',
					attributes: { reviewed_by: 'operator-1' },
				});

				expect(updated).toEqual(
					expect.objectContaining({
						content: 'Reviewed content',
						trust_level: 'trusted',
						confidence: 0.9,
						review_status: 'accepted',
						source_message_id: 'message-1',
						episode_kind: 'active_human',
					}),
				);
				expect(updated.updated_at).not.toBeNull();
			});

			it('should repair chains and unlink fact provenance when deleting an episode', async () => {
				const first = await storage.appendEpisode({
					group_id: 'delete-chain',
					content: 'First',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				const middle = await storage.appendEpisode({
					group_id: 'delete-chain',
					content: 'Middle',
					role: 'ai',
					reference_time: new Date().toISOString(),
				});
				const last = await storage.appendEpisode({
					group_id: 'delete-chain',
					content: 'Last',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				const source = await storage.addEntity({ name: 'Alice', group_id: 'delete-chain' });
				const target = await storage.addEntity({ name: 'London', group_id: 'delete-chain' });
				const edge = await storage.addEdge({
					group_id: 'delete-chain',
					source_node_uuid: source.uuid,
					target_node_uuid: target.uuid,
					name: 'VISITED',
					fact: 'Alice visited London',
					episodes: [first.episode.uuid, middle.episode.uuid],
				});

				const result = await storage.deleteEpisode(middle.episode.uuid);
				const repairedLast = await storage.getEpisode(last.episode.uuid);
				const updatedEdge = await storage.getEdge(edge.uuid);

				expect(result).toEqual(
					expect.objectContaining({
						deleted: true,
						repaired_successor_count: 1,
						linked_edge_count: 1,
						updated_edge_count: 1,
					}),
				);
				expect(repairedLast?.previous_episode_uuid).toBe(first.episode.uuid);
				expect(updatedEdge?.episodes).toEqual([first.episode.uuid]);
			});

			it('should delete facts whose last evidence is removed when requested', async () => {
				const episode = await storage.appendEpisode({
					group_id: 'orphan-cleanup',
					content: 'Only evidence',
					role: 'human',
					reference_time: new Date().toISOString(),
				});
				const source = await storage.addEntity({ name: 'Alice', group_id: 'orphan-cleanup' });
				const target = await storage.addEntity({ name: 'Paris', group_id: 'orphan-cleanup' });
				const edge = await storage.addEdge({
					group_id: 'orphan-cleanup',
					source_node_uuid: source.uuid,
					target_node_uuid: target.uuid,
					name: 'VISITED',
					fact: 'Alice visited Paris',
					episodes: [episode.episode.uuid],
				});

				const result = await storage.deleteEpisode(episode.episode.uuid, {
					fact_cleanup: 'delete_orphaned',
				});
				expect(result.deleted_edge_count).toBe(1);
				expect(await storage.getEdge(edge.uuid)).toBeNull();
			});

			it('should dry-run and execute bounded filtered episode purges', async () => {
				for (let index = 0; index < 4; index++) {
					await storage.appendEpisode({
						group_id: 'purge-group',
						content: `Monitor ${index}`,
						role: 'system',
						episode_kind: 'monitor_summary',
						trust_level: 'unverified',
						reference_time: new Date().toISOString(),
					});
				}
				await storage.appendEpisode({
					group_id: 'purge-group',
					content: 'Keep human',
					role: 'human',
					episode_kind: 'active_human',
					reference_time: new Date().toISOString(),
				});

				const dryRun = await storage.purgeEpisodes(
					'purge-group',
					{ episode_kind: 'monitor_summary' },
					{ dry_run: true, limit: 2 },
				);
				expect(dryRun).toEqual(
					expect.objectContaining({ matched_count: 2, deleted_count: 0, truncated: true }),
				);
				expect(await storage.getEpisodeCount('purge-group')).toBe(5);

				const purge = await storage.purgeEpisodes(
					'purge-group',
					{ episode_kind: 'monitor_summary' },
					{ limit: 10 },
				);
				expect(purge.deleted_count).toBe(4);
				expect(purge.truncated).toBe(false);
				expect(await storage.getEpisodeCount('purge-group')).toBe(1);
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
				expect(exported.version).toBe('2.0');
				expect(exported.group_id).toBe('exp');

				// Clear and reimport
				await storage.clearAll();
				await storage.importGraph(exported);

				const reimported = await storage.getEntity(entity.uuid);
				expect(reimported).not.toBeNull();
				expect(reimported!.name).toBe('Export');
			});

			it('should migrate and round-trip legacy episode provenance', async () => {
				const timestamp = '2026-06-21T12:00:00.000Z';
				const firstUuid = '00000000-0000-4000-8000-000000000091';
				const secondUuid = '00000000-0000-4000-8000-000000000092';
				await storage.importGraph({
					version: '1.0',
					exported_at: timestamp,
					group_id: 'legacy-roundtrip',
					entities: [],
					edges: [],
					episodes: [
						{
							uuid: firstUuid,
							group_id: 'legacy-roundtrip',
							content: 'First legacy episode',
							role: 'human',
							reference_time: timestamp,
							created_at: timestamp,
						},
						{
							uuid: secondUuid,
							group_id: 'legacy-roundtrip',
							content: 'Second legacy episode',
							role: 'ai',
							reference_time: timestamp,
							previous_episode_uuid: firstUuid,
							created_at: timestamp,
						},
					],
				});

				const migrated = await storage.exportGraph('legacy-roundtrip');
				expect(migrated.version).toBe('2.0');
				expect(migrated.episodes).toHaveLength(2);
				expect(migrated.episodes.find((episode) => episode.uuid === firstUuid)).toEqual(
					expect.objectContaining({
						episode_kind: 'legacy',
						trust_level: 'unverified',
						review_status: 'proposed',
						previous_episode_uuid: null,
					}),
				);
				expect(migrated.episodes.find((episode) => episode.uuid === secondUuid)).toEqual(
					expect.objectContaining({
						episode_kind: 'legacy',
						trust_level: 'unverified',
						review_status: 'proposed',
						previous_episode_uuid: firstUuid,
					}),
				);

				await storage.clearAll();
				await storage.importGraph(migrated);
				const restored = await storage.exportGraph('legacy-roundtrip');
				expect([...restored.episodes].sort((a, b) => a.uuid.localeCompare(b.uuid))).toEqual(
					[...migrated.episodes].sort((a, b) => a.uuid.localeCompare(b.uuid)),
				);
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

	describe('Neo4jStorage schema migration', () => {
		jest.setTimeout(30000);

		it('should dry-run and apply additive legacy defaults in bounded batches', async () => {
			const { Neo4jStorage } = await import('../../src/storage/Neo4jStorage');
			const storage = new Neo4jStorage(neo4jUri, neo4jUser, neo4jPassword, neo4jDatabase);
			await storage.initialize();
			const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
			const session = driver.session({ database: neo4jDatabase });

			try {
				await session.run(
					`CREATE (:Episode {
						uuid: '00000000-0000-4000-8000-000000000201',
						group_id: 'migration-test', content: 'First', role: 'human',
						reference_time: '2026-06-21T12:00:00.000Z',
						created_at: '2026-06-21T12:00:00.000Z'
					}), (:Episode {
						uuid: '00000000-0000-4000-8000-000000000202',
						group_id: 'migration-test', content: 'Second', role: 'ai',
						reference_time: '2026-06-21T12:01:00.000Z',
						created_at: '2026-06-21T12:01:00.000Z'
					})`,
				);

				expect(await storage.getMigrationStatus()).toEqual(
					expect.objectContaining({
						backend: 'neo4j',
						migration_required: true,
						legacy_episode_count: 2,
					}),
				);
				expect(await storage.migrateStorageSchema({ dry_run: true, limit: 1 })).toEqual({
					backend: 'neo4j',
					dry_run: true,
					matched_count: 2,
					migrated_count: 0,
					remaining_count: 2,
					backup_required: false,
					additive_only: true,
				});

				const firstBatch = await storage.migrateStorageSchema({ dry_run: false, limit: 1 });
				expect(firstBatch).toEqual(
					expect.objectContaining({
						matched_count: 2,
						migrated_count: 1,
						remaining_count: 1,
					}),
				);
				const secondBatch = await storage.migrateStorageSchema({ dry_run: false, limit: 10 });
				expect(secondBatch).toEqual(
					expect.objectContaining({ migrated_count: 1, remaining_count: 0 }),
				);

				const migrated = await session.run(
					`MATCH (ep:Episode {group_id: 'migration-test'})
					 RETURN ep.episode_kind AS kind, ep.trust_level AS trust,
					        ep.review_status AS review, ep.source_type AS source_type`,
				);
				expect(migrated.records).toHaveLength(2);
				for (const record of migrated.records) {
					expect(record.toObject()).toEqual({
						kind: 'legacy',
						trust: 'unverified',
						review: 'proposed',
						source_type: 'message',
					});
				}
			} finally {
				await storage.clearAll();
				await storage.close();
				await session.close();
				await driver.close();
			}
		});
	});
} else {
	describe('Neo4jStorage (remote)', () => {
		it.skip('skipped - set NEO4J_TEST_URI to enable', () => {});
	});
}
