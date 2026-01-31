import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { generateUuid } from '../utils/uuid';
import { nowIso, isOlderThanDays } from '../utils/temporal';
import { cosineSimilarity } from '../embeddings/cosine';
import type {
	IGraphStorage,
	EntitySearchResult,
	EdgeSearchResult,
	ListOptions,
	EntitySearchOptions,
	EdgeSearchOptions,
	VectorSearchOptions,
	RetentionPolicy,
} from './IGraphStorage';
import type {
	EntityNode,
	CreateEntityNode,
	EntityEdge,
	CreateEntityEdge,
	EpisodicNode,
	CreateEpisodicNode,
	GraphData,
	GraphStats,
} from '../schemas';

export class Neo4jStorage implements IGraphStorage {
	private driver: Driver;
	private database: string;
	private initialized = false;
	private vectorIndexCreated = false;

	constructor(
		uri: string,
		username: string,
		password: string,
		database?: string,
	) {
		// Force IPv4 — Neo4j listens on 127.0.0.1 but Node.js 17+ resolves localhost to IPv6 ::1
		const resolvedUri = uri.replace('://localhost:', '://127.0.0.1:');
		this.driver = neo4j.driver(resolvedUri, neo4j.auth.basic(username, password));
		this.database = database ?? 'neo4j';
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		// Verify connectivity
		await this.driver.verifyConnectivity();

		// Create indexes and constraints
		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				// Entity indexes
				await tx.run(
					'CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.uuid)',
				);
				await tx.run(
					'CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.group_id)',
				);
				await tx.run(
					'CREATE INDEX IF NOT EXISTS FOR (e:Entity) ON (e.name)',
				);

				// Episode indexes
				await tx.run(
					'CREATE INDEX IF NOT EXISTS FOR (ep:Episode) ON (ep.uuid)',
				);
				await tx.run(
					'CREATE INDEX IF NOT EXISTS FOR (ep:Episode) ON (ep.group_id)',
				);

				// Full-text search indexes
				await tx.run(
					'CREATE FULLTEXT INDEX entitySearch IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.summary, e.entity_type]',
				);
				await tx.run(
					'CREATE FULLTEXT INDEX edgeSearch IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON EACH [r.name, r.fact]',
				);
			});
		} finally {
			await session.close();
		}

		this.initialized = true;
	}

	async close(): Promise<void> {
		await this.driver.close();
	}

	private getSession(): Session {
		return this.driver.session({ database: this.database });
	}

	// ===== Entity Operations =====

	async addEntity(input: CreateEntityNode): Promise<EntityNode> {
		const now = nowIso();
		const entity: EntityNode = {
			uuid: generateUuid(),
			name: input.name,
			group_id: input.group_id,
			summary: input.summary ?? '',
			entity_type: input.entity_type ?? 'unknown',
			name_embedding: input.name_embedding ?? null,
			attributes: input.attributes ?? {},
			created_at: now,
			updated_at: now,
		};

		// Lazily create vector index when first embedding is stored
		if (entity.name_embedding && entity.name_embedding.length > 0) {
			await this.ensureVectorIndex(entity.name_embedding.length);
		}

		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				await tx.run(
					`CREATE (e:Entity {
						uuid: $uuid,
						name: $name,
						group_id: $group_id,
						summary: $summary,
						entity_type: $entity_type,
						name_embedding: $name_embedding,
						attributes: $attributes,
						created_at: $created_at,
						updated_at: $updated_at
					})`,
					{
						...entity,
						attributes: JSON.stringify(entity.attributes),
						name_embedding: entity.name_embedding,
					},
				);
			});
		} finally {
			await session.close();
		}

		return entity;
	}

	async getEntity(uuid: string): Promise<EntityNode | null> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run('MATCH (e:Entity {uuid: $uuid}) RETURN e', { uuid });
			});

			if (result.records.length === 0) return null;
			return this.recordToEntity(result.records[0].get('e').properties);
		} finally {
			await session.close();
		}
	}

	async getEntityByName(name: string, groupId: string): Promise<EntityNode | null> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					'MATCH (e:Entity {group_id: $groupId}) WHERE toLower(e.name) = toLower($name) RETURN e LIMIT 1',
					{ name, groupId },
				);
			});

			if (result.records.length === 0) return null;
			return this.recordToEntity(result.records[0].get('e').properties);
		} finally {
			await session.close();
		}
	}

	async updateEntity(uuid: string, updates: Partial<EntityNode>): Promise<EntityNode> {
		const session = this.getSession();
		try {
			const setClauses: string[] = ['e.updated_at = $updated_at'];
			const params: Record<string, unknown> = {
				uuid,
				updated_at: nowIso(),
			};

			if (updates.name !== undefined) {
				setClauses.push('e.name = $name');
				params.name = updates.name;
			}
			if (updates.summary !== undefined) {
				setClauses.push('e.summary = $summary');
				params.summary = updates.summary;
			}
			if (updates.entity_type !== undefined) {
				setClauses.push('e.entity_type = $entity_type');
				params.entity_type = updates.entity_type;
			}
			if (updates.attributes !== undefined) {
				setClauses.push('e.attributes = $attributes');
				params.attributes = JSON.stringify(updates.attributes);
			}
			if (updates.name_embedding !== undefined) {
				setClauses.push('e.name_embedding = $name_embedding');
				params.name_embedding = updates.name_embedding;
				// Lazily create vector index when first embedding is stored
				if (updates.name_embedding && updates.name_embedding.length > 0) {
					await this.ensureVectorIndex(updates.name_embedding.length);
				}
			}

			const result = await session.executeWrite(async (tx) => {
				return tx.run(
					`MATCH (e:Entity {uuid: $uuid}) SET ${setClauses.join(', ')} RETURN e`,
					params,
				);
			});

			if (result.records.length === 0) {
				throw new Error(`Entity not found: ${uuid}`);
			}

			return this.recordToEntity(result.records[0].get('e').properties);
		} finally {
			await session.close();
		}
	}

	async deleteEntity(uuid: string): Promise<void> {
		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				await tx.run('MATCH (e:Entity {uuid: $uuid}) DETACH DELETE e', { uuid });
			});
		} finally {
			await session.close();
		}
	}

	async listEntities(groupId: string, options?: ListOptions): Promise<EntityNode[]> {
		const session = this.getSession();
		try {
			let query = 'MATCH (e:Entity {group_id: $groupId})';
			const params: Record<string, unknown> = { groupId };

			if (options?.entity_type) {
				query += ' WHERE e.entity_type = $entity_type';
				params.entity_type = options.entity_type;
			}

			query += ' RETURN e ORDER BY e.created_at DESC';

			if (options?.offset) {
				query += ' SKIP $offset';
				params.offset = neo4j.int(options.offset);
			}
			if (options?.limit) {
				query += ' LIMIT $limit';
				params.limit = neo4j.int(options.limit);
			}

			const result = await session.executeRead(async (tx) => {
				return tx.run(query, params);
			});

			return result.records.map((r) => this.recordToEntity(r.get('e').properties));
		} finally {
			await session.close();
		}
	}

	// ===== Edge Operations =====

	async addEdge(input: CreateEntityEdge): Promise<EntityEdge> {
		const now = nowIso();
		const edge: EntityEdge = {
			uuid: generateUuid(),
			group_id: input.group_id,
			source_node_uuid: input.source_node_uuid,
			target_node_uuid: input.target_node_uuid,
			name: input.name,
			fact: input.fact,
			fact_embedding: input.fact_embedding ?? null,
			episodes: input.episodes ?? [],
			valid_at: input.valid_at ?? null,
			invalid_at: input.invalid_at ?? null,
			expired_at: input.expired_at ?? null,
			attributes: input.attributes ?? {},
			created_at: now,
			updated_at: now,
		};

		// Lazily create vector index when first embedding is stored
		if (edge.fact_embedding && edge.fact_embedding.length > 0) {
			await this.ensureVectorIndex(edge.fact_embedding.length);
		}

		const session = this.getSession();
		try {
			const result = await session.executeWrite(async (tx) => {
				return tx.run(
					`MATCH (source:Entity {uuid: $source_node_uuid})
					 MATCH (target:Entity {uuid: $target_node_uuid})
					 CREATE (source)-[r:RELATES_TO {
						uuid: $uuid,
						group_id: $group_id,
						source_node_uuid: $source_node_uuid,
						target_node_uuid: $target_node_uuid,
						name: $name,
						fact: $fact,
						fact_embedding: $fact_embedding,
						episodes: $episodes,
						valid_at: $valid_at,
						invalid_at: $invalid_at,
						expired_at: $expired_at,
						attributes: $attributes,
						created_at: $created_at,
						updated_at: $updated_at
					 }]->(target)
					 RETURN r`,
					{
						...edge,
						attributes: JSON.stringify(edge.attributes),
					},
				);
			});

			if (result.records.length === 0) {
				throw new Error(
					`Cannot create edge: source entity (${input.source_node_uuid}) or target entity (${input.target_node_uuid}) not found`,
				);
			}
		} finally {
			await session.close();
		}

		return edge;
	}

	async getEdge(uuid: string): Promise<EntityEdge | null> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					'MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() RETURN r',
					{ uuid },
				);
			});

			if (result.records.length === 0) return null;
			return this.recordToEdge(result.records[0].get('r').properties);
		} finally {
			await session.close();
		}
	}

	async getEdgesBetween(sourceUuid: string, targetUuid: string): Promise<EntityEdge[]> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`MATCH (s:Entity {uuid: $sourceUuid})-[r:RELATES_TO]->(t:Entity {uuid: $targetUuid})
					 RETURN r
					 UNION
					 MATCH (s:Entity {uuid: $targetUuid})-[r:RELATES_TO]->(t:Entity {uuid: $sourceUuid})
					 RETURN r`,
					{ sourceUuid, targetUuid },
				);
			});

			return result.records.map((rec) => this.recordToEdge(rec.get('r').properties));
		} finally {
			await session.close();
		}
	}

	async getEdgesForEntity(entityUuid: string): Promise<EntityEdge[]> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`MATCH (e:Entity {uuid: $entityUuid})-[r:RELATES_TO]->()
					 RETURN r
					 UNION
					 MATCH (e:Entity {uuid: $entityUuid})<-[r:RELATES_TO]-()
					 RETURN r`,
					{ entityUuid },
				);
			});

			return result.records.map((rec) => this.recordToEdge(rec.get('r').properties));
		} finally {
			await session.close();
		}
	}

	async updateEdge(uuid: string, updates: Partial<EntityEdge>): Promise<EntityEdge> {
		const session = this.getSession();
		try {
			const setClauses: string[] = ['r.updated_at = $updated_at'];
			const params: Record<string, unknown> = {
				uuid,
				updated_at: nowIso(),
			};

			if (updates.name !== undefined) {
				setClauses.push('r.name = $name');
				params.name = updates.name;
			}
			if (updates.fact !== undefined) {
				setClauses.push('r.fact = $fact');
				params.fact = updates.fact;
			}
			if (updates.valid_at !== undefined) {
				setClauses.push('r.valid_at = $valid_at');
				params.valid_at = updates.valid_at;
			}
			if (updates.invalid_at !== undefined) {
				setClauses.push('r.invalid_at = $invalid_at');
				params.invalid_at = updates.invalid_at;
			}
			if (updates.expired_at !== undefined) {
				setClauses.push('r.expired_at = $expired_at');
				params.expired_at = updates.expired_at;
			}
			if (updates.episodes !== undefined) {
				setClauses.push('r.episodes = $episodes');
				params.episodes = updates.episodes;
			}
			if (updates.attributes !== undefined) {
				setClauses.push('r.attributes = $attributes');
				params.attributes = JSON.stringify(updates.attributes);
			}
			if (updates.fact_embedding !== undefined) {
				setClauses.push('r.fact_embedding = $fact_embedding');
				params.fact_embedding = updates.fact_embedding;
				if (updates.fact_embedding && updates.fact_embedding.length > 0) {
					await this.ensureVectorIndex(updates.fact_embedding.length);
				}
			}

			const result = await session.executeWrite(async (tx) => {
				return tx.run(
					`MATCH ()-[r:RELATES_TO {uuid: $uuid}]->()
					 SET ${setClauses.join(', ')}
					 RETURN r`,
					params,
				);
			});

			if (result.records.length === 0) {
				throw new Error(`Edge not found: ${uuid}`);
			}

			return this.recordToEdge(result.records[0].get('r').properties);
		} finally {
			await session.close();
		}
	}

	async deleteEdge(uuid: string): Promise<void> {
		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				await tx.run(
					'MATCH ()-[r:RELATES_TO {uuid: $uuid}]->() DELETE r',
					{ uuid },
				);
			});
		} finally {
			await session.close();
		}
	}

	// ===== Episode Operations =====

	async addEpisode(input: CreateEpisodicNode): Promise<EpisodicNode> {
		const episode: EpisodicNode = {
			uuid: generateUuid(),
			group_id: input.group_id,
			content: input.content,
			role: input.role,
			source_type: input.source_type ?? 'message',
			reference_time: input.reference_time,
			previous_episode_uuid: input.previous_episode_uuid ?? null,
			created_at: nowIso(),
		};

		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				await tx.run(
					`CREATE (ep:Episode {
						uuid: $uuid,
						group_id: $group_id,
						content: $content,
						role: $role,
						source_type: $source_type,
						reference_time: $reference_time,
						previous_episode_uuid: $previous_episode_uuid,
						created_at: $created_at
					})`,
					episode,
				);

				// Chain to previous episode
				if (episode.previous_episode_uuid) {
					await tx.run(
						`MATCH (prev:Episode {uuid: $prevUuid})
						 MATCH (curr:Episode {uuid: $currUuid})
						 CREATE (prev)-[:NEXT_EPISODE]->(curr)`,
						{
							prevUuid: episode.previous_episode_uuid,
							currUuid: episode.uuid,
						},
					);
				}
			});
		} finally {
			await session.close();
		}

		return episode;
	}

	async getEpisode(uuid: string): Promise<EpisodicNode | null> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run('MATCH (ep:Episode {uuid: $uuid}) RETURN ep', { uuid });
			});

			if (result.records.length === 0) return null;
			return this.recordToEpisode(result.records[0].get('ep').properties);
		} finally {
			await session.close();
		}
	}

	async getRecentEpisodes(groupId: string, limit: number): Promise<EpisodicNode[]> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`MATCH (ep:Episode {group_id: $groupId})
					 RETURN ep
					 ORDER BY ep.created_at DESC
					 LIMIT $limit`,
					{ groupId, limit: neo4j.int(limit) },
				);
			});

			const episodes = result.records.map((r) =>
				this.recordToEpisode(r.get('ep').properties),
			);

			// Return in chronological order (oldest first)
			return episodes.reverse();
		} finally {
			await session.close();
		}
	}

	async getEpisodeCount(groupId: string): Promise<number> {
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					'MATCH (ep:Episode {group_id: $groupId}) RETURN count(ep) as cnt',
					{ groupId },
				);
			});

			return result.records[0]?.get('cnt').toNumber() ?? 0;
		} finally {
			await session.close();
		}
	}

	// ===== Search =====

	/** Escape Lucene special characters so user input doesn't cause parse errors */
	private sanitizeLuceneQuery(query: string): string {
		// Lucene special chars: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
		const sanitized = query.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (ch) => `\\${ch}`);
		return sanitized.trim();
	}

	async searchEntities(
		query: string,
		groupId: string,
		options?: EntitySearchOptions,
	): Promise<EntitySearchResult[]> {
		const safeQuery = this.sanitizeLuceneQuery(query);
		if (!safeQuery) return [];

		const limit = options?.limit ?? 10;
		const session = this.getSession();
		try {
			let cypher = `CALL db.index.fulltext.queryNodes('entitySearch', $query)
				YIELD node, score
				WHERE node.group_id = $groupId`;

			const params: Record<string, unknown> = { query: safeQuery, groupId };

			if (options?.entity_type) {
				cypher += ' AND node.entity_type = $entityType';
				params.entityType = options.entity_type;
			}

			cypher += ' RETURN node, score ORDER BY score DESC LIMIT $limit';
			params.limit = neo4j.int(limit);

			const result = await session.executeRead(async (tx) => {
				return tx.run(cypher, params);
			});

			const maxScore = result.records.length > 0 ? (result.records[0].get('score') as number) : 1;

			return result.records
				.filter((r) => {
					const score = (r.get('score') as number) / (maxScore || 1);
					return score >= (options?.min_score ?? 0);
				})
				.map((r) => ({
					entity: this.recordToEntity(r.get('node').properties),
					score: (r.get('score') as number) / (maxScore || 1),
				}));
		} finally {
			await session.close();
		}
	}

	async searchEdges(
		query: string,
		groupId: string,
		options?: EdgeSearchOptions,
	): Promise<EdgeSearchResult[]> {
		const safeQuery = this.sanitizeLuceneQuery(query);
		if (!safeQuery) return [];

		const limit = options?.limit ?? 10;
		const includeExpired = options?.include_expired ?? false;
		const session = this.getSession();
		try {
			let cypher = `CALL db.index.fulltext.queryRelationships('edgeSearch', $query)
				YIELD relationship, score
				WHERE relationship.group_id = $groupId`;

			if (!includeExpired) {
				cypher += ' AND relationship.expired_at IS NULL';
			}

			cypher += ` WITH relationship, score
				ORDER BY score DESC LIMIT $limit
				MATCH (source:Entity {uuid: relationship.source_node_uuid})
				MATCH (target:Entity {uuid: relationship.target_node_uuid})
				RETURN relationship, source, target, score`;

			const params: Record<string, unknown> = {
				query: safeQuery,
				groupId,
				limit: neo4j.int(limit),
			};

			const result = await session.executeRead(async (tx) => {
				return tx.run(cypher, params);
			});

			const maxScore = result.records.length > 0 ? (result.records[0].get('score') as number) : 1;

			return result.records
				.filter((r) => {
					const score = (r.get('score') as number) / (maxScore || 1);
					return score >= (options?.min_score ?? 0);
				})
				.map((r) => ({
					edge: this.recordToEdge(r.get('relationship').properties),
					sourceEntity: this.recordToEntity(r.get('source').properties),
					targetEntity: this.recordToEntity(r.get('target').properties),
					score: (r.get('score') as number) / (maxScore || 1),
				}));
		} finally {
			await session.close();
		}
	}

	// ===== Vector Search =====

	/**
	 * Lazily create Neo4j vector indexes on first embedding insert.
	 * Wrapped in try/catch — older Neo4j versions gracefully skip.
	 */
	private async ensureVectorIndex(dimensions: number): Promise<void> {
		if (this.vectorIndexCreated) return;

		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				// Entity name embedding vector index (Neo4j 5.11+)
				await tx.run(
					`CREATE VECTOR INDEX entityNameEmbedding IF NOT EXISTS
					 FOR (e:Entity)
					 ON (e.name_embedding)
					 OPTIONS {indexConfig: {
						\`vector.dimensions\`: $dimensions,
						\`vector.similarity_function\`: 'cosine'
					 }}`,
					{ dimensions: neo4j.int(dimensions) },
				);
				// Note: Neo4j does not support vector indexes on relationships.
				// Edge fact_embedding uses brute-force cosine similarity in searchEdgesByVector().
			});
			this.vectorIndexCreated = true;
		} catch (error) {
			// Neo4j < 5.11 doesn't support vector indexes — log and continue
			console.warn(
				'Engram: Could not create vector indexes (Neo4j may not support them):',
				(error as Error).message,
			);
		} finally {
			await session.close();
		}
	}

	async searchEntitiesByVector(
		vector: number[],
		groupId: string,
		options?: VectorSearchOptions,
	): Promise<EntitySearchResult[]> {
		const limit = options?.limit ?? 10;
		const minScore = options?.min_score ?? 0;

		// Try native vector index first
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`CALL db.index.vector.queryNodes('entityNameEmbedding', $topK, $vector)
					 YIELD node, score
					 WHERE node.group_id = $groupId AND score >= $minScore
					 RETURN node, score
					 ORDER BY score DESC
					 LIMIT $limit`,
					{
						vector,
						groupId,
						topK: neo4j.int(limit * 2),
						minScore,
						limit: neo4j.int(limit),
					},
				);
			});

			return result.records.map((r) => ({
				entity: this.recordToEntity(r.get('node').properties),
				score: r.get('score') as number,
			}));
		} catch {
			// Vector index doesn't exist — fall back to brute-force
			return this.bruteForceEntityVectorSearch(vector, groupId, options);
		} finally {
			await session.close();
		}
	}

	async searchEdgesByVector(
		vector: number[],
		groupId: string,
		options?: VectorSearchOptions,
	): Promise<EdgeSearchResult[]> {
		const limit = options?.limit ?? 10;
		const minScore = options?.min_score ?? 0;

		// Brute-force approach for edges — Neo4j vector indexes on relationships
		// are less reliably supported across versions
		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`MATCH (source:Entity)-[r:RELATES_TO]->(target:Entity)
					 WHERE r.group_id = $groupId
					   AND r.fact_embedding IS NOT NULL
					   AND r.expired_at IS NULL
					 RETURN r, source, target`,
					{ groupId },
				);
			});

			const scored: EdgeSearchResult[] = [];
			for (const rec of result.records) {
				const edgeProps = rec.get('r').properties;
				const embedding = edgeProps.fact_embedding as number[] | null;
				if (!embedding || embedding.length !== vector.length) continue;

				try {
					const score = cosineSimilarity(vector, embedding);
					if (score < minScore) continue;

					scored.push({
						edge: this.recordToEdge(edgeProps),
						sourceEntity: this.recordToEntity(rec.get('source').properties),
						targetEntity: this.recordToEntity(rec.get('target').properties),
						score,
					});
				} catch {
					// Skip edges with incompatible embedding dimensions
				}
			}

			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit);
		} finally {
			await session.close();
		}
	}

	private async bruteForceEntityVectorSearch(
		vector: number[],
		groupId: string,
		options?: VectorSearchOptions,
	): Promise<EntitySearchResult[]> {
		const limit = options?.limit ?? 10;
		const minScore = options?.min_score ?? 0;

		const session = this.getSession();
		try {
			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`MATCH (e:Entity {group_id: $groupId})
					 WHERE e.name_embedding IS NOT NULL
					 RETURN e`,
					{ groupId },
				);
			});

			const scored: EntitySearchResult[] = [];
			for (const rec of result.records) {
				const entity = this.recordToEntity(rec.get('e').properties);
				if (!entity.name_embedding || entity.name_embedding.length !== vector.length) continue;

				try {
					const score = cosineSimilarity(vector, entity.name_embedding);
					if (score >= minScore) {
						scored.push({ entity, score });
					}
				} catch {
					// Skip entities with incompatible embedding dimensions
				}
			}

			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit);
		} finally {
			await session.close();
		}
	}

	// ===== Graph Management =====

	async clearGroup(groupId: string): Promise<void> {
		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				// Delete edges first
				await tx.run(
					`MATCH ()-[r:RELATES_TO {group_id: $groupId}]->()
					 DELETE r`,
					{ groupId },
				);
				// Delete nodes (entities + episodes)
				await tx.run(
					`MATCH (n)
					 WHERE n.group_id = $groupId AND (n:Entity OR n:Episode)
					 DETACH DELETE n`,
					{ groupId },
				);
			});
		} finally {
			await session.close();
		}
	}

	async clearAll(): Promise<void> {
		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				await tx.run('MATCH (n) WHERE n:Entity OR n:Episode DETACH DELETE n');
			});
		} finally {
			await session.close();
		}
	}

	async exportGraph(groupId?: string): Promise<GraphData> {
		const entities: EntityNode[] = [];
		const edges: EntityEdge[] = [];
		const episodes: EpisodicNode[] = [];

		const session = this.getSession();
		try {
			const entityQuery = groupId
				? 'MATCH (e:Entity {group_id: $groupId}) RETURN e'
				: 'MATCH (e:Entity) RETURN e';

			const entityResult = await session.executeRead(async (tx) => {
				return tx.run(entityQuery, groupId ? { groupId } : {});
			});
			for (const r of entityResult.records) {
				entities.push(this.recordToEntity(r.get('e').properties));
			}

			const edgeQuery = groupId
				? 'MATCH ()-[r:RELATES_TO {group_id: $groupId}]->() RETURN r'
				: 'MATCH ()-[r:RELATES_TO]->() RETURN r';

			const edgeResult = await session.executeRead(async (tx) => {
				return tx.run(edgeQuery, groupId ? { groupId } : {});
			});
			for (const r of edgeResult.records) {
				edges.push(this.recordToEdge(r.get('r').properties));
			}

			const episodeQuery = groupId
				? 'MATCH (ep:Episode {group_id: $groupId}) RETURN ep'
				: 'MATCH (ep:Episode) RETURN ep';

			const episodeResult = await session.executeRead(async (tx) => {
				return tx.run(episodeQuery, groupId ? { groupId } : {});
			});
			for (const r of episodeResult.records) {
				episodes.push(this.recordToEpisode(r.get('ep').properties));
			}
		} finally {
			await session.close();
		}

		return {
			version: '1.0',
			exported_at: nowIso(),
			group_id: groupId,
			entities,
			edges,
			episodes,
		};
	}

	async importGraph(data: GraphData): Promise<void> {
		const session = this.getSession();
		try {
			await session.executeWrite(async (tx) => {
				// Import entities
				for (const entity of data.entities) {
					await tx.run(
						`MERGE (e:Entity {uuid: $uuid})
						 SET e += {
							name: $name,
							group_id: $group_id,
							summary: $summary,
							entity_type: $entity_type,
							name_embedding: $name_embedding,
							attributes: $attributes,
							created_at: $created_at,
							updated_at: $updated_at
						 }`,
						{
							...entity,
							attributes: JSON.stringify(entity.attributes),
						},
					);
				}

				// Import episodes
				for (const episode of data.episodes) {
					await tx.run(
						`MERGE (ep:Episode {uuid: $uuid})
						 SET ep += {
							group_id: $group_id,
							content: $content,
							role: $role,
							source_type: $source_type,
							reference_time: $reference_time,
							previous_episode_uuid: $previous_episode_uuid,
							created_at: $created_at
						 }`,
						episode,
					);
				}

				// Import edges
				for (const edge of data.edges) {
					await tx.run(
						`MATCH (source:Entity {uuid: $source_node_uuid})
						 MATCH (target:Entity {uuid: $target_node_uuid})
						 MERGE (source)-[r:RELATES_TO {uuid: $uuid}]->(target)
						 SET r += {
							group_id: $group_id,
							source_node_uuid: $source_node_uuid,
							target_node_uuid: $target_node_uuid,
							name: $name,
							fact: $fact,
							fact_embedding: $fact_embedding,
							episodes: $episodes,
							valid_at: $valid_at,
							invalid_at: $invalid_at,
							expired_at: $expired_at,
							attributes: $attributes,
							created_at: $created_at,
							updated_at: $updated_at
						 }`,
						{
							...edge,
							attributes: JSON.stringify(edge.attributes),
						},
					);
				}

				// Recreate episode chains
				for (const episode of data.episodes) {
					if (episode.previous_episode_uuid) {
						await tx.run(
							`MATCH (prev:Episode {uuid: $prevUuid})
							 MATCH (curr:Episode {uuid: $currUuid})
							 MERGE (prev)-[:NEXT_EPISODE]->(curr)`,
							{
								prevUuid: episode.previous_episode_uuid,
								currUuid: episode.uuid,
							},
						);
					}
				}
			});
		} finally {
			await session.close();
		}
	}

	async getStats(groupId?: string): Promise<GraphStats> {
		const session = this.getSession();
		try {
			const where = groupId ? ' WHERE n.group_id = $groupId' : '';
			const params = groupId ? { groupId } : {};

			const result = await session.executeRead(async (tx) => {
				return tx.run(
					`MATCH (n)
					 ${where}
					 WITH n
					 WHERE n:Entity OR n:Episode
					 RETURN
						sum(CASE WHEN n:Entity THEN 1 ELSE 0 END) as entityCount,
						sum(CASE WHEN n:Episode THEN 1 ELSE 0 END) as episodeCount,
						collect(DISTINCT n.group_id) as groupIds,
						collect(CASE WHEN n:Entity THEN n.entity_type ELSE null END) as entityTypes,
						min(CASE WHEN n:Episode THEN n.created_at ELSE null END) as oldestEpisode,
						max(CASE WHEN n:Episode THEN n.created_at ELSE null END) as newestEpisode`,
					params,
				);
			});

			// Count edges separately
			const edgeResult = await session.executeRead(async (tx) => {
				const edgeWhere = groupId
					? 'WHERE r.group_id = $groupId'
					: '';
				return tx.run(
					`MATCH ()-[r:RELATES_TO]->() ${edgeWhere} RETURN count(r) as edgeCount`,
					params,
				);
			});

			const record = result.records[0];
			const entityTypesList = (record.get('entityTypes') as string[]).filter(Boolean);
			const entityTypes: Record<string, number> = {};
			for (const t of entityTypesList) {
				entityTypes[t] = (entityTypes[t] ?? 0) + 1;
			}

			return {
				entity_count: record.get('entityCount').toNumber(),
				edge_count: edgeResult.records[0].get('edgeCount').toNumber(),
				episode_count: record.get('episodeCount').toNumber(),
				group_ids: record.get('groupIds') as string[],
				entity_types: entityTypes,
				oldest_episode: record.get('oldestEpisode') ?? null,
				newest_episode: record.get('newestEpisode') ?? null,
			};
		} finally {
			await session.close();
		}
	}

	// ===== Retention =====

	async applyRetention(groupId: string, policy: RetentionPolicy): Promise<number> {
		if (policy.type === 'forever') return 0;

		const session = this.getSession();
		try {
			if (policy.type === 'days' && policy.value) {
				const cutoffDate = new Date(
					Date.now() - policy.value * 24 * 60 * 60 * 1000,
				).toISOString();

				const result = await session.executeWrite(async (tx) => {
					return tx.run(
						`MATCH (ep:Episode {group_id: $groupId})
						 WHERE ep.created_at < $cutoffDate
						 DETACH DELETE ep
						 RETURN count(*) as removed`,
						{ groupId, cutoffDate },
					);
				});

				return result.records[0]?.get('removed')?.toNumber() ?? 0;
			}

			if (policy.type === 'max_episodes' && policy.value) {
				const result = await session.executeWrite(async (tx) => {
					return tx.run(
						`MATCH (ep:Episode {group_id: $groupId})
						 WITH ep ORDER BY ep.created_at DESC
						 SKIP $maxEpisodes
						 WITH collect(ep) as toDelete, count(ep) as cnt
						 UNWIND toDelete as ep
						 DETACH DELETE ep
						 RETURN cnt as removed`,
						{ groupId, maxEpisodes: neo4j.int(policy.value!) },
					);
				});

				return result.records[0]?.get('removed')?.toNumber() ?? 0;
			}

			return 0;
		} finally {
			await session.close();
		}
	}

	// ===== Record Conversion Helpers =====

	private recordToEntity(props: Record<string, unknown>): EntityNode {
		return {
			uuid: props.uuid as string,
			name: props.name as string,
			group_id: props.group_id as string,
			summary: (props.summary as string) ?? '',
			entity_type: (props.entity_type as string) ?? 'unknown',
			name_embedding: (props.name_embedding as number[] | null) ?? null,
			attributes: this.parseJsonField(props.attributes, {}),
			created_at: props.created_at as string,
			updated_at: props.updated_at as string,
		};
	}

	private recordToEdge(props: Record<string, unknown>): EntityEdge {
		return {
			uuid: props.uuid as string,
			group_id: props.group_id as string,
			source_node_uuid: props.source_node_uuid as string,
			target_node_uuid: props.target_node_uuid as string,
			name: props.name as string,
			fact: props.fact as string,
			fact_embedding: (props.fact_embedding as number[] | null) ?? null,
			episodes: (props.episodes as string[]) ?? [],
			valid_at: (props.valid_at as string | null) ?? null,
			invalid_at: (props.invalid_at as string | null) ?? null,
			expired_at: (props.expired_at as string | null) ?? null,
			attributes: this.parseJsonField(props.attributes, {}),
			created_at: props.created_at as string,
			updated_at: props.updated_at as string,
		};
	}

	private recordToEpisode(props: Record<string, unknown>): EpisodicNode {
		return {
			uuid: props.uuid as string,
			group_id: props.group_id as string,
			content: props.content as string,
			role: props.role as 'human' | 'ai' | 'system',
			source_type: (props.source_type as 'message' | 'document' | 'api') ?? 'message',
			reference_time: props.reference_time as string,
			previous_episode_uuid: (props.previous_episode_uuid as string | null) ?? null,
			created_at: props.created_at as string,
		};
	}

	private parseJsonField(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
		if (typeof value === 'string') {
			try {
				return JSON.parse(value) as Record<string, unknown>;
			} catch {
				return fallback;
			}
		}
		if (typeof value === 'object' && value !== null) {
			return value as Record<string, unknown>;
		}
		return fallback;
	}
}
