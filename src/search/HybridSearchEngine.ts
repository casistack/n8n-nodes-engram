import type { IGraphStorage, EntitySearchResult, EdgeSearchResult } from '../storage/IGraphStorage';
import type { EmbeddingService } from '../embeddings';

export interface HybridSearchOptions {
	limit?: number;
	minScore?: number;
	entityType?: string;
	includeExpired?: boolean;
}

export interface HybridSearchResults {
	entities: EntitySearchResult[];
	edges: EdgeSearchResult[];
}

/**
 * Reciprocal Rank Fusion (RRF) constant.
 * Higher k gives more weight to lower-ranked results.
 * k=60 is the standard value from the original RRF paper.
 */
const RRF_K = 60;

/**
 * Orchestrates hybrid search across the knowledge graph.
 * Supports text search (MiniSearch/Lucene) and optional semantic search (embeddings).
 * When embeddings are enabled, merges results using Reciprocal Rank Fusion (RRF).
 */
export class HybridSearchEngine {
	private storage: IGraphStorage;
	private embeddingService: EmbeddingService | null;

	constructor(storage: IGraphStorage, embeddingService?: EmbeddingService) {
		this.storage = storage;
		this.embeddingService = embeddingService ?? null;
	}

	/**
	 * Search for relevant entities and edges matching the query.
	 * When embeddings are enabled, runs text + vector search in parallel and merges with RRF.
	 */
	async search(
		query: string,
		groupId: string,
		options?: HybridSearchOptions,
	): Promise<HybridSearchResults> {
		const limit = options?.limit ?? 10;
		const minScore = options?.minScore ?? 0;

		// Always run text search
		const textPromise = Promise.all([
			this.storage.searchEntities(query, groupId, {
				limit: limit * 2,
				min_score: minScore,
				entity_type: options?.entityType,
			}),
			this.storage.searchEdges(query, groupId, {
				limit: limit * 2,
				min_score: minScore,
				include_expired: options?.includeExpired ?? false,
			}),
		]);

		// If embeddings are available, run vector search in parallel
		if (this.embeddingService && this.storage.searchEntitiesByVector && this.storage.searchEdgesByVector) {
			try {
				const embeddingResult = await this.embeddingService.embed(query);
				const vector = embeddingResult.embedding;

				const [textResults, vectorResults] = await Promise.all([
					textPromise,
					Promise.all([
						this.storage.searchEntitiesByVector(vector, groupId, {
							limit: limit * 2,
							min_score: 0.3, // Lower threshold for vector — RRF handles ranking
						}),
						this.storage.searchEdgesByVector(vector, groupId, {
							limit: limit * 2,
							min_score: 0.3,
						}),
					]),
				]);

				const [textEntities, textEdges] = textResults;
				const [vectorEntities, vectorEdges] = vectorResults;

				// Merge with RRF
				const entities = this.mergeEntityResults(textEntities, vectorEntities, limit);
				const edges = this.mergeEdgeResults(textEdges, vectorEdges, limit);

				return { entities, edges };
			} catch (error) {
				// Embedding failed — fall back to text-only
				console.warn('Engram: Embedding search failed, using text-only:', (error as Error).message);
			}
		}

		// Text-only path
		const [entities, edges] = await textPromise;
		return {
			entities: entities.slice(0, limit),
			edges: edges.slice(0, limit),
		};
	}

	/**
	 * Search entities only.
	 */
	async searchEntities(
		query: string,
		groupId: string,
		options?: { limit?: number; min_score?: number; entity_type?: string },
	): Promise<EntitySearchResult[]> {
		return this.storage.searchEntities(query, groupId, options);
	}

	/**
	 * Search edges/relationships only.
	 */
	async searchEdges(
		query: string,
		groupId: string,
		options?: { limit?: number; min_score?: number; include_expired?: boolean },
	): Promise<EdgeSearchResult[]> {
		return this.storage.searchEdges(query, groupId, options);
	}

	/**
	 * Merge entity results from text and vector search using Reciprocal Rank Fusion.
	 */
	private mergeEntityResults(
		textResults: EntitySearchResult[],
		vectorResults: EntitySearchResult[],
		limit: number,
	): EntitySearchResult[] {
		const scores = new Map<string, { score: number; entity: EntitySearchResult }>();

		// Add text search RRF scores
		for (let i = 0; i < textResults.length; i++) {
			const r = textResults[i];
			const rrfScore = 1 / (RRF_K + i + 1);
			scores.set(r.entity.uuid, { score: rrfScore, entity: r });
		}

		// Add vector search RRF scores
		for (let i = 0; i < vectorResults.length; i++) {
			const r = vectorResults[i];
			const rrfScore = 1 / (RRF_K + i + 1);
			const existing = scores.get(r.entity.uuid);
			if (existing) {
				existing.score += rrfScore;
			} else {
				scores.set(r.entity.uuid, { score: rrfScore, entity: r });
			}
		}

		// Sort by combined RRF score
		const merged = [...scores.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((s) => ({
				entity: s.entity.entity,
				score: s.score,
			}));

		return merged;
	}

	/**
	 * Merge edge results from text and vector search using Reciprocal Rank Fusion.
	 */
	private mergeEdgeResults(
		textResults: EdgeSearchResult[],
		vectorResults: EdgeSearchResult[],
		limit: number,
	): EdgeSearchResult[] {
		const scores = new Map<string, { score: number; result: EdgeSearchResult }>();

		for (let i = 0; i < textResults.length; i++) {
			const r = textResults[i];
			const rrfScore = 1 / (RRF_K + i + 1);
			scores.set(r.edge.uuid, { score: rrfScore, result: r });
		}

		for (let i = 0; i < vectorResults.length; i++) {
			const r = vectorResults[i];
			const rrfScore = 1 / (RRF_K + i + 1);
			const existing = scores.get(r.edge.uuid);
			if (existing) {
				existing.score += rrfScore;
			} else {
				scores.set(r.edge.uuid, { score: rrfScore, result: r });
			}
		}

		return [...scores.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((s) => ({
				...s.result,
				score: s.score,
			}));
	}

	/**
	 * Get a formatted context string from search results.
	 * Useful for injecting into LLM prompts.
	 */
	formatAsContext(results: HybridSearchResults): string {
		const parts: string[] = [];

		if (results.entities.length > 0) {
			parts.push('Known entities:');
			for (const r of results.entities) {
				parts.push(
					'- ' + r.entity.name + ' (' + r.entity.entity_type + '): ' + r.entity.summary,
				);
			}
		}

		if (results.edges.length > 0) {
			if (parts.length > 0) parts.push('');
			parts.push('Known facts:');
			for (const r of results.edges) {
				parts.push(
					'- ' + r.sourceEntity.name + ' -> ' + r.targetEntity.name + ': ' + r.edge.fact,
				);
			}
		}

		return parts.join('\n');
	}
}
