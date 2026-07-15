import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphologyStorage } from '../../../src/storage/GraphologyStorage';
import type { EntityNode, EntityEdge, EpisodicNode } from '../../../src/schemas';

describe('GraphologyStorage', () => {
	let storage: GraphologyStorage;

	beforeEach(async () => {
		storage = new GraphologyStorage();
		await storage.initialize();
	});

	afterEach(async () => {
		await storage.close();
	});

	// ===== Entity Operations =====

	describe('Entity Operations', () => {
		it('should add and retrieve an entity', async () => {
			const entity = await storage.addEntity({
				name: 'Alice',
				group_id: 'test-group',
				summary: 'A software engineer',
				entity_type: 'person',
			});

			expect(entity.uuid).toBeDefined();
			expect(entity.name).toBe('Alice');
			expect(entity.group_id).toBe('test-group');
			expect(entity.summary).toBe('A software engineer');
			expect(entity.entity_type).toBe('person');
			expect(entity.created_at).toBeDefined();

			const retrieved = await storage.getEntity(entity.uuid);
			expect(retrieved).toEqual(entity);
		});

		it('should return null for non-existent entity', async () => {
			const result = await storage.getEntity('00000000-0000-4000-8000-000000000000');
			expect(result).toBeNull();
		});

		it('should find entity by name and group', async () => {
			await storage.addEntity({
				name: 'Tokyo',
				group_id: 'group-1',
				entity_type: 'location',
			});

			const found = await storage.getEntityByName('Tokyo', 'group-1');
			expect(found).not.toBeNull();
			expect(found!.name).toBe('Tokyo');

			// Case-insensitive
			const foundLower = await storage.getEntityByName('tokyo', 'group-1');
			expect(foundLower).not.toBeNull();

			// Wrong group
			const notFound = await storage.getEntityByName('Tokyo', 'group-2');
			expect(notFound).toBeNull();
		});

		it('should update an entity', async () => {
			const entity = await storage.addEntity({
				name: 'Bob',
				group_id: 'test',
				entity_type: 'person',
			});

			// Small delay to ensure different timestamps
			await new Promise((r) => setTimeout(r, 5));

			const updated = await storage.updateEntity(entity.uuid, {
				summary: 'A data scientist',
			});

			expect(updated.summary).toBe('A data scientist');
			expect(updated.name).toBe('Bob');
			expect(updated.updated_at).not.toBe(entity.updated_at);
		});

		it('should delete an entity', async () => {
			const entity = await storage.addEntity({
				name: 'ToDelete',
				group_id: 'test',
			});

			await storage.deleteEntity(entity.uuid);
			const result = await storage.getEntity(entity.uuid);
			expect(result).toBeNull();
		});

		it('should list entities filtered by group', async () => {
			await storage.addEntity({ name: 'A', group_id: 'g1', entity_type: 'person' });
			await storage.addEntity({ name: 'B', group_id: 'g1', entity_type: 'location' });
			await storage.addEntity({ name: 'C', group_id: 'g2', entity_type: 'person' });

			const g1Entities = await storage.listEntities('g1');
			expect(g1Entities).toHaveLength(2);

			const g1People = await storage.listEntities('g1', { entity_type: 'person' });
			expect(g1People).toHaveLength(1);
			expect(g1People[0].name).toBe('A');

			const g2Entities = await storage.listEntities('g2');
			expect(g2Entities).toHaveLength(1);
		});

		it('should support pagination', async () => {
			for (let i = 0; i < 5; i++) {
				await storage.addEntity({ name: `Entity${i}`, group_id: 'test' });
			}

			const page1 = await storage.listEntities('test', { limit: 2, offset: 0 });
			expect(page1).toHaveLength(2);

			const page2 = await storage.listEntities('test', { limit: 2, offset: 2 });
			expect(page2).toHaveLength(2);

			const page3 = await storage.listEntities('test', { limit: 2, offset: 4 });
			expect(page3).toHaveLength(1);
		});
	});

	// ===== Edge Operations =====

	describe('Edge Operations', () => {
		let alice: EntityNode;
		let tokyo: EntityNode;

		beforeEach(async () => {
			alice = await storage.addEntity({
				name: 'Alice',
				group_id: 'test',
				entity_type: 'person',
			});
			tokyo = await storage.addEntity({
				name: 'Tokyo',
				group_id: 'test',
				entity_type: 'location',
			});
		});

		it('should add and retrieve an edge', async () => {
			const edge = await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo',
			});

			expect(edge.uuid).toBeDefined();
			expect(edge.name).toBe('LIVES_IN');
			expect(edge.fact).toBe('Alice lives in Tokyo');

			const retrieved = await storage.getEdge(edge.uuid);
			expect(retrieved).toEqual(edge);
		});

		it('should throw when adding edge with missing nodes', async () => {
			await expect(
				storage.addEdge({
					group_id: 'test',
					source_node_uuid: alice.uuid,
					target_node_uuid: '00000000-0000-4000-8000-000000000000',
					name: 'KNOWS',
					fact: 'Test',
				}),
			).rejects.toThrow('source');
		});

		it('should find edges between two entities', async () => {
			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo',
			});
			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'WORKS_IN',
				fact: 'Alice works in Tokyo',
			});

			const edges = await storage.getEdgesBetween(alice.uuid, tokyo.uuid);
			expect(edges).toHaveLength(2);
		});

		it('should find all edges for an entity', async () => {
			const london = await storage.addEntity({
				name: 'London',
				group_id: 'test',
				entity_type: 'location',
			});

			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo',
			});
			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: london.uuid,
				name: 'VISITED',
				fact: 'Alice visited London',
			});

			const edges = await storage.getEdgesForEntity(alice.uuid);
			expect(edges).toHaveLength(2);
		});

		it('should update an edge', async () => {
			const edge = await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo',
				valid_at: '2025-01-01T00:00:00.000Z',
			});

			const updated = await storage.updateEdge(edge.uuid, {
				invalid_at: '2025-12-01T00:00:00.000Z',
				expired_at: new Date().toISOString(),
			});

			expect(updated.invalid_at).toBe('2025-12-01T00:00:00.000Z');
			expect(updated.expired_at).not.toBeNull();
			expect(updated.fact).toBe('Alice lives in Tokyo');
		});

		it('should delete an edge', async () => {
			const edge = await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo',
			});

			await storage.deleteEdge(edge.uuid);
			expect(await storage.getEdge(edge.uuid)).toBeNull();
		});
	});

	// ===== Episode Operations =====

	describe('Episode Operations', () => {
		it('should add and retrieve episodes', async () => {
			const ep = await storage.addEpisode({
				group_id: 'session-1',
				content: 'Hello, how are you?',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			expect(ep.uuid).toBeDefined();
			expect(ep.content).toBe('Hello, how are you?');
			expect(ep.role).toBe('human');

			const retrieved = await storage.getEpisode(ep.uuid);
			expect(retrieved).toEqual(ep);
		});

		it('should chain episodes via previous_episode_uuid', async () => {
			const ep1 = await storage.addEpisode({
				group_id: 'session-1',
				content: 'Hello',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			const ep2 = await storage.addEpisode({
				group_id: 'session-1',
				content: 'Hi there!',
				role: 'ai',
				reference_time: new Date().toISOString(),
				previous_episode_uuid: ep1.uuid,
			});

			expect(ep2.previous_episode_uuid).toBe(ep1.uuid);
		});

		it('should get recent episodes in chronological order', async () => {
			for (let i = 0; i < 5; i++) {
				await storage.addEpisode({
					group_id: 'session-1',
					content: `Message ${i}`,
					role: i % 2 === 0 ? 'human' : 'ai',
					reference_time: new Date().toISOString(),
				});
			}

			const recent = await storage.getRecentEpisodes('session-1', 3);
			expect(recent).toHaveLength(3);
			// Should be in chronological order (oldest first)
			expect(recent[0].content).toBe('Message 2');
			expect(recent[2].content).toBe('Message 4');
		});

		it('should count episodes per group', async () => {
			await storage.addEpisode({
				group_id: 'g1',
				content: 'A',
				role: 'human',
				reference_time: new Date().toISOString(),
			});
			await storage.addEpisode({
				group_id: 'g1',
				content: 'B',
				role: 'ai',
				reference_time: new Date().toISOString(),
			});
			await storage.addEpisode({
				group_id: 'g2',
				content: 'C',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			expect(await storage.getEpisodeCount('g1')).toBe(2);
			expect(await storage.getEpisodeCount('g2')).toBe(1);
		});
	});

	// ===== Search =====

	describe('Search', () => {
		it('should search entities by text', async () => {
			await storage.addEntity({
				name: 'Alice Johnson',
				group_id: 'test',
				summary: 'Software engineer at Acme Corp',
				entity_type: 'person',
			});
			await storage.addEntity({
				name: 'Bob Smith',
				group_id: 'test',
				summary: 'Data scientist at Tech Inc',
				entity_type: 'person',
			});
			await storage.addEntity({
				name: 'Acme Corp',
				group_id: 'test',
				summary: 'Technology company',
				entity_type: 'organization',
			});

			const results = await storage.searchEntities('Alice', 'test');
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].entity.name).toBe('Alice Johnson');
		});

		it('should search edges by fact text', async () => {
			const alice = await storage.addEntity({
				name: 'Alice',
				group_id: 'test',
				entity_type: 'person',
			});
			const tokyo = await storage.addEntity({
				name: 'Tokyo',
				group_id: 'test',
				entity_type: 'location',
			});

			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo since December 2025',
			});

			const results = await storage.searchEdges('where does Alice live', 'test');
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].edge.fact).toContain('Tokyo');
		});

		it('should filter by group_id in search', async () => {
			await storage.addEntity({
				name: 'Shared Name',
				group_id: 'g1',
				entity_type: 'concept',
			});
			await storage.addEntity({
				name: 'Shared Name',
				group_id: 'g2',
				entity_type: 'concept',
			});

			const g1Results = await storage.searchEntities('Shared', 'g1');
			expect(g1Results).toHaveLength(1);
			expect(g1Results[0].entity.group_id).toBe('g1');
		});

		it('should exclude expired edges by default', async () => {
			const a = await storage.addEntity({ name: 'A', group_id: 'test' });
			const b = await storage.addEntity({ name: 'B', group_id: 'test' });

			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: a.uuid,
				target_node_uuid: b.uuid,
				name: 'RELATED_TO',
				fact: 'A is related to B in some unique way',
				expired_at: new Date().toISOString(),
			});

			const results = await storage.searchEdges('related unique', 'test');
			expect(results).toHaveLength(0);

			const withExpired = await storage.searchEdges('related unique', 'test', {
				include_expired: true,
			});
			expect(withExpired).toHaveLength(1);
		});
	});

	// ===== Graph Management =====

	describe('Graph Management', () => {
		it('should clear a specific group', async () => {
			await storage.addEntity({ name: 'A', group_id: 'g1' });
			await storage.addEntity({ name: 'B', group_id: 'g2' });

			await storage.clearGroup('g1');

			expect(await storage.listEntities('g1')).toHaveLength(0);
			expect(await storage.listEntities('g2')).toHaveLength(1);
		});

		it('should clear all data', async () => {
			await storage.addEntity({ name: 'A', group_id: 'g1' });
			await storage.addEntity({ name: 'B', group_id: 'g2' });

			await storage.clearAll();

			expect(await storage.listEntities('g1')).toHaveLength(0);
			expect(await storage.listEntities('g2')).toHaveLength(0);
		});

		it('should export and import graph data', async () => {
			const alice = await storage.addEntity({
				name: 'Alice',
				group_id: 'test',
				entity_type: 'person',
			});
			const tokyo = await storage.addEntity({
				name: 'Tokyo',
				group_id: 'test',
				entity_type: 'location',
			});
			await storage.addEdge({
				group_id: 'test',
				source_node_uuid: alice.uuid,
				target_node_uuid: tokyo.uuid,
				name: 'LIVES_IN',
				fact: 'Alice lives in Tokyo',
			});
			await storage.addEpisode({
				group_id: 'test',
				content: 'Hello',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			const exported = await storage.exportGraph();
			expect(exported.entities).toHaveLength(2);
			expect(exported.edges).toHaveLength(1);
			expect(exported.episodes).toHaveLength(1);

			// Import into fresh storage
			const newStorage = new GraphologyStorage();
			await newStorage.initialize();
			await newStorage.importGraph(exported);

			const stats = await newStorage.getStats();
			expect(stats.entity_count).toBe(2);
			expect(stats.edge_count).toBe(1);
			expect(stats.episode_count).toBe(1);

			await newStorage.close();
		});

		it('should persist embedded storage with atomic replacement files cleaned up', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-persist-'));
			const persistPath = path.join(tempDir, 'engram.json');

			try {
				const persistentStorage = new GraphologyStorage(persistPath);
				await persistentStorage.initialize();
				await persistentStorage.addEntity({
					name: 'Persistent Alice',
					group_id: 'persist-group',
					entity_type: 'person',
				});
				await persistentStorage.close();

				const persisted = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as {
					entities: Array<{ name: string }>;
				};
				expect(persisted.entities).toHaveLength(1);
				expect(persisted.entities[0].name).toBe('Persistent Alice');
				expect(fs.existsSync(`${persistPath}.lock`)).toBe(false);
				expect(fs.readdirSync(tempDir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should back up, verify, and atomically migrate legacy snapshots during initialization', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-legacy-persist-'));
			const persistPath = path.join(tempDir, 'engram.json');
			const backupPath = `${persistPath}.pre-schema-2.0.backup.json`;
			const episodeUuid = '00000000-0000-4000-8000-000000000095';
			const timestamp = '2026-06-21T12:00:00.000Z';

			try {
				const legacyPayload = JSON.stringify({
						version: '1.0',
						exported_at: timestamp,
						entities: [],
						edges: [],
						episodes: [
							{
								uuid: episodeUuid,
								group_id: 'legacy-persist',
								content: 'Legacy persisted episode',
								role: 'human',
								reference_time: timestamp,
								created_at: timestamp,
							},
						],
					});
				fs.writeFileSync(persistPath, legacyPayload, 'utf-8');

				const persistentStorage = new GraphologyStorage(persistPath);
				await persistentStorage.initialize();
				expect(await persistentStorage.getEpisode(episodeUuid)).toEqual(
					expect.objectContaining({
						episode_kind: 'legacy',
						trust_level: 'unverified',
						review_status: 'proposed',
					}),
				);
				expect(fs.readFileSync(backupPath, 'utf-8')).toBe(legacyPayload);
				expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
				expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8')).version).toBe('2.0');
				expect(await persistentStorage.getMigrationStatus()).toEqual(
					expect.objectContaining({
						source_version: '1.0',
						automatic_migration_completed: true,
						legacy_episode_count: 1,
						backup: {
							created: true,
							verified: true,
							path: backupPath,
						},
					}),
				);
				await persistentStorage.close();

				const restartedStorage = new GraphologyStorage(persistPath);
				await restartedStorage.initialize();
				expect(await restartedStorage.getMigrationStatus()).toEqual(
					expect.objectContaining({
						source_version: '1.0',
						automatic_migration_completed: true,
						legacy_episode_count: 1,
						backup: expect.objectContaining({ created: false, verified: true }),
					}),
				);
				await restartedStorage.close();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should serialize concurrent automatic migration and create one backup', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-migration-race-'));
			const persistPath = path.join(tempDir, 'engram.json');
			const timestamp = '2026-06-21T12:00:00.000Z';
			fs.writeFileSync(
				persistPath,
				JSON.stringify({
					version: '1.0',
					exported_at: timestamp,
					entities: [],
					edges: [],
					episodes: [],
				}),
				'utf-8',
			);
			const first = new GraphologyStorage(persistPath);
			const second = new GraphologyStorage(persistPath);

			try {
				await Promise.all([first.initialize(), second.initialize()]);
				expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8')).version).toBe('2.0');
				expect(
					fs.readdirSync(tempDir).filter((file) => file.endsWith('.pre-schema-2.0.backup.json')),
				).toHaveLength(1);
				expect(fs.existsSync(`${persistPath}.lock`)).toBe(false);
			} finally {
				await Promise.all([first.close(), second.close()]);
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should leave legacy storage untouched when an existing backup does not match', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-migration-conflict-'));
			const persistPath = path.join(tempDir, 'engram.json');
			const backupPath = `${persistPath}.pre-schema-2.0.backup.json`;
			const source = JSON.stringify({
				version: '1.0',
				exported_at: '2026-06-21T12:00:00.000Z',
				entities: [],
				edges: [],
				episodes: [],
			});
			fs.writeFileSync(persistPath, source, 'utf-8');
			fs.writeFileSync(
				backupPath,
				JSON.stringify({
					version: '1.0',
					exported_at: '2026-06-22T12:00:00.000Z',
					entities: [],
					edges: [],
					episodes: [],
				}),
				'utf-8',
			);

			try {
				const persistentStorage = new GraphologyStorage(persistPath);
				await expect(persistentStorage.initialize()).rejects.toThrow(
					'Existing migration backup does not match source storage',
				);
				expect(fs.readFileSync(persistPath, 'utf-8')).toBe(source);
				expect(fs.existsSync(`${persistPath}.lock`)).toBe(false);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should fail closed without replacing a corrupt persisted graph', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-migration-corrupt-'));
			const persistPath = path.join(tempDir, 'engram.json');
			const source = '{"version":"1.0","episodes":[';
			fs.writeFileSync(persistPath, source, 'utf-8');

			try {
				const persistentStorage = new GraphologyStorage(persistPath);
				await expect(persistentStorage.initialize()).rejects.toThrow(
					'Failed to load or migrate embedded storage',
				);
				expect(fs.readFileSync(persistPath, 'utf-8')).toBe(source);
				expect(fs.existsSync(`${persistPath}.pre-schema-2.0.backup.json`)).toBe(false);
				expect(fs.existsSync(`${persistPath}.lock`)).toBe(false);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should not report an unrelated existing sidecar as a verified migration backup', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-migration-stale-backup-'));
			const persistPath = path.join(tempDir, 'engram.json');
			const backupPath = `${persistPath}.pre-schema-2.0.backup.json`;
			fs.writeFileSync(
				persistPath,
				JSON.stringify({
					version: '2.0',
					exported_at: '2026-07-15T12:00:00.000Z',
					entities: [],
					edges: [],
					episodes: [],
				}),
				'utf-8',
			);
			fs.writeFileSync(
				backupPath,
				JSON.stringify({
					version: '1.0',
					exported_at: '2026-06-21T12:00:00.000Z',
					entities: [],
					edges: [],
					episodes: [],
				}),
				'utf-8',
			);

			try {
				const persistentStorage = new GraphologyStorage(persistPath);
				await persistentStorage.initialize();
				expect(await persistentStorage.getMigrationStatus()).toEqual(
					expect.objectContaining({
						source_version: '2.0',
						automatic_migration_completed: false,
						backup: { created: false, verified: false, path: backupPath },
					}),
				);
				await persistentStorage.close();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should serialize mutations across storage instances without lost writes or forked chains', async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-concurrent-'));
			const persistPath = path.join(tempDir, 'engram.json');
			const firstStorage = new GraphologyStorage(persistPath);
			const secondStorage = new GraphologyStorage(persistPath);

			try {
				await Promise.all([firstStorage.initialize(), secondStorage.initialize()]);

				await Promise.all(
					Array.from({ length: 12 }, (_, index) => {
						const target = index % 2 === 0 ? firstStorage : secondStorage;
						return target.appendEpisode({
							group_id: 'shared-group',
							content: `Concurrent episode ${index}`,
							role: 'human',
							episode_kind: 'active_human',
							source_message_id: `message-${index}`,
							reference_time: new Date().toISOString(),
						});
					}),
				);

				const retryInput = {
					group_id: 'shared-group',
					content: 'One retry-safe message',
					role: 'human' as const,
					episode_kind: 'active_human' as const,
					source_message_id: 'retry-message',
					reference_time: new Date().toISOString(),
				};
				const retryResults = await Promise.all([
					firstStorage.appendEpisode(retryInput),
					secondStorage.appendEpisode(retryInput),
					firstStorage.appendEpisode(retryInput),
					secondStorage.appendEpisode(retryInput),
				]);
				expect(new Set(retryResults.map((result) => result.episode.uuid)).size).toBe(1);
				expect(retryResults.filter((result) => result.created)).toHaveLength(1);

				await Promise.all(
					Array.from({ length: 10 }, (_, index) => {
						const target = index % 2 === 0 ? firstStorage : secondStorage;
						return target.addEntity({
							name: `Concurrent entity ${index}`,
							group_id: 'shared-group',
						});
					}),
				);

				const reader = new GraphologyStorage(persistPath);
				await reader.initialize();
				const episodes = await reader.getRecentEpisodes('shared-group', 20);
				const entities = await reader.listEntities('shared-group');

				expect(episodes).toHaveLength(13);
				expect(entities).toHaveLength(10);
				expect(episodes[0].previous_episode_uuid).toBeNull();
				for (let index = 1; index < episodes.length; index++) {
					expect(episodes[index].previous_episode_uuid).toBe(episodes[index - 1].uuid);
				}
				expect(fs.existsSync(`${persistPath}.lock`)).toBe(false);
				expect(fs.readdirSync(tempDir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);

				await reader.close();
				await Promise.all([firstStorage.close(), secondStorage.close()]);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should return correct stats', async () => {
			await storage.addEntity({
				name: 'Alice',
				group_id: 'test',
				entity_type: 'person',
			});
			await storage.addEntity({
				name: 'Bob',
				group_id: 'test',
				entity_type: 'person',
			});
			await storage.addEntity({
				name: 'Acme',
				group_id: 'test',
				entity_type: 'organization',
			});
			await storage.addEpisode({
				group_id: 'test',
				content: 'Hello',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			const stats = await storage.getStats('test');
			expect(stats.entity_count).toBe(3);
			expect(stats.episode_count).toBe(1);
			expect(stats.entity_types).toEqual({ person: 2, organization: 1 });
			expect(stats.group_ids).toContain('test');
		});
	});

	// ===== Retention =====

	describe('Retention', () => {
		it('should retain all with forever policy', async () => {
			await storage.addEpisode({
				group_id: 'test',
				content: 'Old',
				role: 'human',
				reference_time: new Date().toISOString(),
			});

			const removed = await storage.applyRetention('test', { type: 'forever' });
			expect(removed).toBe(0);
			expect(await storage.getEpisodeCount('test')).toBe(1);
		});

		it('should enforce max_episodes policy', async () => {
			for (let i = 0; i < 10; i++) {
				await storage.addEpisode({
					group_id: 'test',
					content: `Message ${i}`,
					role: 'human',
					reference_time: new Date().toISOString(),
				});
			}

			const removed = await storage.applyRetention('test', {
				type: 'max_episodes',
				value: 5,
			});
			expect(removed).toBe(5);
			expect(await storage.getEpisodeCount('test')).toBe(5);
		});
	});
});
