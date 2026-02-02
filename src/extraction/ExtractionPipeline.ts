import type { IGraphStorage } from '../storage/IGraphStorage';
import type { EntityNode } from '../schemas';
import { LlmClient, type LlmClientConfig } from './LlmClient';
import { EntityExtractor } from './EntityExtractor';
import { RelationshipExtractor } from './RelationshipExtractor';
import { EntityDeduplicator } from './EntityDeduplicator';
import { ContradictionDetector } from './ContradictionDetector';
import { EdgeDeduplicator } from './EdgeDeduplicator';
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
  private edgeDeduplicator: EdgeDeduplicator;
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
    this.edgeDeduplicator = new EdgeDeduplicator(llm);
    this.entityTypes = config.entityTypes;
    this.groupId = config.groupId;

    if (config.embeddingConfig) {
      this.embeddingService = new EmbeddingService(config.embeddingConfig);
    }
  }

  async process(humanMessage: string, aiMessage: string, episodeUuid?: string): Promise<void> {
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
      const resolved = await this.resolveEntity(extracted, existingEntities);
      resolvedEntities.set(extracted.name.toLowerCase(), resolved);
    }

    // Step 4: Extract relationships
    const allEntityNames = [
      ...new Set([...existingNames, ...[...resolvedEntities.values()].map((e) => e.name)]),
    ];

    const extractedRelationships = await this.relationshipExtractor.extract(
      humanMessage,
      aiMessage,
      allEntityNames,
    );

    // Step 5: Persist relationships with contradiction detection
    for (const rel of extractedRelationships) {
      await this.persistRelationship(rel, resolvedEntities, existingEntities, episodeUuid);
    }
  }

  private async resolveEntity(
    extracted: { name: string; entity_type: string; summary: string },
    existingEntities: EntityNode[],
  ): Promise<EntityNode> {
    // Check for duplicates among existing entities
    for (const existing of existingEntities) {
      const { isDuplicate, mergedSummary } = await this.deduplicator.isDuplicate(extracted, {
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

  private async expireContradictedEdges(
    edges: import('../schemas').EntityEdge[],
    newFact: string,
    sourceEntityName: string,
    targetEntityName: string,
    newEdgeName: string,
  ): Promise<void> {
    for (const existingEdge of edges) {
      if (existingEdge.expired_at) continue; // Already expired

      const resolution = await this.contradictionDetector.detect(
        existingEdge.fact,
        newFact,
        sourceEntityName,
        targetEntityName,
        existingEdge.name,
        newEdgeName,
      );

      if (resolution.isContradiction && resolution.expiredAt) {
        await this.storage.updateEdge(existingEdge.uuid, {
          expired_at: resolution.expiredAt,
          invalid_at: resolution.expiredAt,
        });
      }
    }
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
    const sourceEntity = this.findEntity(rel.source_entity, resolvedEntities, existingEntities);
    const targetEntity = this.findEntity(rel.target_entity, resolvedEntities, existingEntities);

    if (!sourceEntity || !targetEntity) return;

    const normalizedNewEdgeName = rel.name.toUpperCase().replace(/\s+/g, '_');

    // --- Fetch edges between this pair ONCE (reused by dedup + contradiction) ---
    let samePairEdges: import('../schemas').EntityEdge[] = [];
    try {
      samePairEdges = await this.storage.getEdgesBetween(sourceEntity.uuid, targetEntity.uuid);
    } catch (error) {
      console.warn(
        'Engram: Failed to fetch edges between',
        sourceEntity.name,
        'and',
        targetEntity.name + ':',
        (error as Error).message,
      );
      // If we can't fetch existing edges, skip dedup/contradiction and just create
    }

    // --- Same-Name Edge Deduplication ---
    // Check if an equivalent edge already exists between the same pair with the same name.
    // If so, update in-place rather than creating a duplicate.
    try {
      const existingMatchingEdge = samePairEdges.find(
        (e) => e.name === normalizedNewEdgeName && !e.expired_at,
      );

      if (existingMatchingEdge) {
        const { isDuplicate, mergedFact } = await this.edgeDeduplicator.isDuplicate(
          existingMatchingEdge.fact,
          rel.fact,
          normalizedNewEdgeName,
          sourceEntity.name,
          targetEntity.name,
        );

        if (isDuplicate) {
          const updates = await this.buildEdgeUpdates(
            existingMatchingEdge,
            mergedFact || rel.fact,
            episodeUuid,
          );
          if (Object.keys(updates).length > 0) {
            await this.storage.updateEdge(existingMatchingEdge.uuid, updates);
          }
          return; // Deduplicated — skip contradiction detection and creation
        }
      }
    } catch (error) {
      console.warn(
        'Engram: Edge deduplication failed for',
        sourceEntity.name,
        '->',
        targetEntity.name + ':',
        (error as Error).message,
      );
      // Fall through to cross-name dedup, then contradiction detection + creation
    }

    // --- Cross-Name Edge Deduplication ---
    // Check if an edge with a DIFFERENT name but the same semantic meaning
    // already exists between this pair. Example: WORKS_AT already exists,
    // HOLDS_POSITION is extracted — they describe the same employment relationship.
    // If found, update the existing edge's fact and return early.
    try {
      const crossNameCandidates = samePairEdges.filter(
        (e) => e.name !== normalizedNewEdgeName && !e.expired_at,
      );

      if (crossNameCandidates.length > 0) {
        // Check first active candidate (simplest, lowest risk)
        const candidate = crossNameCandidates[0];
        const { isDuplicate, mergedFact } = await this.edgeDeduplicator.isDuplicateCrossName(
          candidate.fact,
          rel.fact,
          candidate.name,
          normalizedNewEdgeName,
          sourceEntity.name,
          targetEntity.name,
        );

        if (isDuplicate) {
          const updates = await this.buildEdgeUpdates(
            candidate,
            mergedFact || rel.fact,
            episodeUuid,
          );
          if (Object.keys(updates).length > 0) {
            await this.storage.updateEdge(candidate.uuid, updates);
          }
          return; // Cross-name deduplicated — skip contradiction detection and creation
        }
      }
    } catch (error) {
      console.warn(
        'Engram: Cross-name edge deduplication failed for',
        sourceEntity.name,
        '->',
        targetEntity.name + ':',
        (error as Error).message,
      );
      // Fall through to contradiction detection + creation
    }

    // --- Contradiction Detection ---
    try {
      // Pass 1: Check edges between the same entity pair (any edge name).
      // Catches type changes like WORKS_AT → WORKED_AT on the same pair.
      // Reuses samePairEdges fetched above (no duplicate storage call).
      await this.expireContradictedEdges(
        samePairEdges,
        rel.fact,
        sourceEntity.name,
        targetEntity.name,
        normalizedNewEdgeName,
      );

      // Pass 2: Check outgoing edges from source with the same edge name
      // but pointing to a DIFFERENT target.
      // Catches e.g. LIVES_IN London → LIVES_IN Berlin.
      const checkedUuids = new Set(samePairEdges.map((e) => e.uuid));
      const allSourceEdges = await this.storage.getEdgesForEntity(sourceEntity.uuid);
      const crossTargetEdges = allSourceEdges.filter(
        (e) =>
          e.source_node_uuid === sourceEntity.uuid &&
          e.name === normalizedNewEdgeName &&
          e.target_node_uuid !== targetEntity.uuid &&
          !e.expired_at &&
          !checkedUuids.has(e.uuid),
      );
      await this.expireContradictedEdges(
        crossTargetEdges,
        rel.fact,
        sourceEntity.name,
        targetEntity.name,
        normalizedNewEdgeName,
      );
    } catch (error) {
      console.warn(
        'Engram: Contradiction detection failed for edge between',
        sourceEntity.name,
        'and',
        targetEntity.name + ':',
        (error as Error).message,
      );
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
      name: normalizedNewEdgeName,
      fact: rel.fact,
      fact_embedding: factEmbedding ?? null,
      valid_at: nowIso(),
      episodes: episodeUuid ? [episodeUuid] : [],
    });
  }

  /**
   * Build an updates object for an edge dedup merge (same-name or cross-name).
   * Updates fact + embedding + episodes as needed.
   */
  private async buildEdgeUpdates(
    existingEdge: import('../schemas').EntityEdge,
    effectiveFact: string,
    episodeUuid?: string,
  ): Promise<Record<string, unknown>> {
    const updates: Record<string, unknown> = {};

    if (effectiveFact !== existingEdge.fact) {
      updates.fact = effectiveFact;

      // Regenerate fact embedding if service available
      if (this.embeddingService) {
        try {
          const result = await this.embeddingService.embed(effectiveFact);
          updates.fact_embedding = result.embedding;
        } catch (error) {
          console.warn('Engram: Failed to regenerate edge embedding:', (error as Error).message);
        }
      }
    }

    // Merge episode if provided
    if (episodeUuid) {
      const existingEpisodes = existingEdge.episodes || [];
      if (!existingEpisodes.includes(episodeUuid)) {
        updates.episodes = [...existingEpisodes, episodeUuid];
      }
    }

    return updates;
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
    return existingEntities.find((e) => e.name.toLowerCase().trim() === normalized);
  }
}
