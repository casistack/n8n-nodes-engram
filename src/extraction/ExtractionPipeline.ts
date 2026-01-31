import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EntityNode } from '../schemas';
import { LlmClient, type LlmClientConfig } from './LlmClient';
import { EntityExtractor } from './EntityExtractor';
import { RelationshipExtractor } from './RelationshipExtractor';
import { EntityDeduplicator } from './EntityDeduplicator';
import { ContradictionDetector } from './ContradictionDetector';
import { EmbeddingService, type EmbeddingConfig } from '../embeddings';
import { nowIso } from '../utils/temporal';

export interface ExtractionPipelineConfig {
	llmConfig: LlmClientConfig;
	entityTypes: string[];
	groupId: string;
	/** Optional embedding config — when provided, generates name_embedding / fact_embedding */
	embeddingConfig?: EmbeddingConfig;
}

/**
 * Orchestrates the full extraction pipeline:
 * 1. Extract entities from conversation
 * 2. Deduplicate against existing entities
 * 3. Persist new/updated entities
 * 4. Extract relationships
 * 5. Detect contradictions with existing facts
 * 6. Persist new edges (expire contradicted ones)
 */
export class ExtractionPipeline {
	private storage: IGraphStorage;
	private entityExtractor: EntityExtractor;
	private relationshipExtractor: RelationshipExtractor;
	private deduplicator: EntityDeduplicator;
	private contradictionDetector: ContradictionDetector;
	private embeddingService: EmbeddingService | null = null;
	private entityTypes: string[];
	private groupId: string;

	constructor(storage: IGraphStorage, config: ExtractionPipelineConfig) {
		const llm = new LlmClient(config.llmConfig);
		this.storage = storage;
		this.entityExtractor = new EntityExtractor(llm);
		this.relationshipExtractor = new RelationshipExtractor(llm);
		this.deduplicator = new EntityDeduplicator(llm);
		this.contradictionDetector = new ContradictionDetector(llm);
		this.entityTypes = config.entityTypes;
		this.groupId = config.groupId;

		if (config.embeddingConfig) {
			this.embeddingService = new EmbeddingService(config.embeddingConfig);
		}
	}

	async process(
		humanMessage: string,
		aiMessage: string,
		episodeUuid?: string,
	): Promise<void> {
		// Step 1: Get existing entity names for dedup context
		const existingEntities = await this.storage.listEntities(this.groupId);
		const existingNames = existingEntities.map((e) => e.name);

		// Step 2: Extract entities
		const extractedEntities = await this.entityExtractor.extract(
			humanMessage,
			aiMessage,
			this.entityTypes,
			existingNames,
		);

		if (extractedEntities.length === 0) return;

		// Step 3: Deduplicate and persist entities
		const resolvedEntities = new Map<string, EntityNode>();

		for (const extracted of extractedEntities) {
			const resolved = await this.resolveEntity(
				extracted,
				existingEntities,
			);
			resolvedEntities.set(extracted.name.toLowerCase(), resolved);
		}

		// Step 4: Extract relationships
		const allEntityNames = [
			...new Set([
				...existingNames,
				...[...resolvedEntities.values()].map((e) => e.name),
			]),
		];

		const extractedRelationships = await this.relationshipExtractor.extract(
			humanMessage,
			aiMessage,
			allEntityNames,
		);

		// Step 5: Persist relationships with contradiction detection
		for (const rel of extractedRelationships) {
			await this.persistRelationship(
				rel,
				resolvedEntities,
				existingEntities,
				episodeUuid,
			);
		}
	}

	private async resolveEntity(
		extracted: { name: string; entity_type: string; summary: string },
		existingEntities: EntityNode[],
	): Promise<EntityNode> {
		// Check for duplicates among existing entities
		for (const existing of existingEntities) {
			const { isDuplicate, mergedSummary } =
				await this.deduplicator.isDuplicate(extracted, {
					name: existing.name,
					summary: existing.summary,
					entity_type: existing.entity_type,
				});

			if (isDuplicate) {
				// Update the existing entity with merged info
				if (mergedSummary && mergedSummary !== existing.summary) {
					return await this.storage.updateEntity(existing.uuid, {
						summary: mergedSummary,
					});
				}
				return existing;
			}
		}

		// New entity - create it (with optional name embedding)
		let nameEmbedding: number[] | undefined;
		if (this.embeddingService) {
			try {
				const result = await this.embeddingService.embed(extracted.name);
				nameEmbedding = result.embedding;
			} catch (error) {
				console.warn('Engram: Failed to generate entity name embedding:', (error as Error).message);
			}
		}

		return await this.storage.addEntity({
			name: extracted.name,
			group_id: this.groupId,
			summary: extracted.summary,
			entity_type: extracted.entity_type,
			name_embedding: nameEmbedding ?? null,
		});
	}

	private async persistRelationship(
		rel: {
			source_entity: string;
			target_entity: string;
			name: string;
			fact: string;
		},
		resolvedEntities: Map<string, EntityNode>,
		existingEntities: EntityNode[],
		episodeUuid?: string,
	): Promise<void> {
		// Find source and target entity UUIDs
		const sourceEntity = this.findEntity(
			rel.source_entity,
			resolvedEntities,
			existingEntities,
		);
		const targetEntity = this.findEntity(
			rel.target_entity,
			resolvedEntities,
			existingEntities,
		);

		if (!sourceEntity || !targetEntity) return;

		// Check for contradictions with existing edges between these entities
		const existingEdges = await this.storage.getEdgesBetween(
			sourceEntity.uuid,
			targetEntity.uuid,
		);

		for (const existingEdge of existingEdges) {
			if (existingEdge.expired_at) continue; // Already expired

			const resolution = await this.contradictionDetector.detect(
				existingEdge.fact,
				rel.fact,
				sourceEntity.name,
				targetEntity.name,
			);

			if (resolution.isContradiction && resolution.expiredAt) {
				// Expire the contradicted edge
				await this.storage.updateEdge(existingEdge.uuid, {
					expired_at: resolution.expiredAt,
					invalid_at: resolution.expiredAt,
				});
			}
		}

		// Create the new edge (with optional fact embedding)
		let factEmbedding: number[] | undefined;
		if (this.embeddingService) {
			try {
				const result = await this.embeddingService.embed(rel.fact);
				factEmbedding = result.embedding;
			} catch (error) {
				console.warn('Engram: Failed to generate edge fact embedding:', (error as Error).message);
			}
		}

		await this.storage.addEdge({
			group_id: this.groupId,
			source_node_uuid: sourceEntity.uuid,
			target_node_uuid: targetEntity.uuid,
			name: rel.name.toUpperCase().replace(/\s+/g, '_'),
			fact: rel.fact,
			fact_embedding: factEmbedding ?? null,
			valid_at: nowIso(),
			episodes: episodeUuid ? [episodeUuid] : [],
		});
	}

	private findEntity(
		name: string,
		resolvedEntities: Map<string, EntityNode>,
		existingEntities: EntityNode[],
	): EntityNode | undefined {
		const normalized = name.toLowerCase().trim();

		// Check resolved entities first
		const resolved = resolvedEntities.get(normalized);
		if (resolved) return resolved;

		// Fall back to existing entities
		return existingEntities.find(
			(e) => e.name.toLowerCase().trim() === normalized,
		);
	}
}
